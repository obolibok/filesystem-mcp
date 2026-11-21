import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import { ErrorCode, FsError, isNodeError } from './errors.js';
import type { EntryIdentity } from './fs.js';
import type { SnapshotCounters } from './job-types.js';
import type { SourceProvenance } from './source-provenance.js';

export interface CatalogVersion {
  id: string;
  root: string;
  policy: string;
  identity: EntryIdentity;
  startedAt: string;
  endedAt: string;
  provenance: SourceProvenance;
}

export interface CatalogEntry {
  ordinal: number;
  path: string;
  name: string;
  depth: number;
  extension: string | null;
  length: number | null;
  mtime: string | null;
}

export interface CatalogScope {
  first: number;
  last: number;
  depth: number;
  inheritedIgnore: boolean;
  counters: SnapshotCounters;
}

export interface CatalogFilters {
  name?: string | undefined;
  namePrefix?: string | undefined;
  extension?: string | undefined;
  modifiedFrom?: string | undefined;
  modifiedBefore?: string | undefined;
}

interface ScopeRow extends Omit<CatalogScope, 'inheritedIgnore' | 'counters'> {
  inheritedIgnore: number;
  counters: string;
}

const schema = `
  CREATE TABLE generations (id TEXT PRIMARY KEY, version TEXT) STRICT;
  CREATE TABLE active (root TEXT PRIMARY KEY, id TEXT NOT NULL REFERENCES generations(id)) STRICT;
  CREATE TABLE entries (
    id TEXT NOT NULL REFERENCES generations(id), ordinal INTEGER NOT NULL,
    path TEXT NOT NULL, name TEXT NOT NULL, depth INTEGER NOT NULL,
    extension TEXT, length INTEGER, mtime TEXT,
    PRIMARY KEY (id, path)
  ) STRICT, WITHOUT ROWID;
  CREATE UNIQUE INDEX entries_ordinal ON entries (id, ordinal);
  CREATE INDEX entries_name ON entries (id, name, path);
  CREATE INDEX entries_ext ON entries (id, extension, path);
  CREATE INDEX entries_mtime ON entries (id, mtime, path);
  CREATE TABLE scopes (
    id TEXT NOT NULL REFERENCES generations(id), path TEXT NOT NULL,
    first INTEGER NOT NULL, last INTEGER NOT NULL, depth INTEGER NOT NULL,
    inheritedIgnore INTEGER NOT NULL, counters TEXT NOT NULL,
    PRIMARY KEY (id, path)
  ) STRICT, WITHOUT ROWID;
  PRAGMA user_version = 1;
`;

export class CatalogStore {
  static async open(scratch: string, maxBytes: number): Promise<CatalogStore> {
    const path = join(scratch, 'catalog.sqlite');
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try {
        const info = await lstat(path + suffix);
        if (!info.isFile() || info.nlink !== 1) {
          throw new FsError(
            ErrorCode.INVALID_INPUT,
            'Catalog database must use regular private files',
          );
        }
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
      }
    }
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path);
    const store = new CatalogStore(db);
    try {
      db.exec('PRAGMA locking_mode = EXCLUSIVE; PRAGMA synchronous = FULL;');
      store.transaction(() => {
        const version = db.prepare('PRAGMA user_version').get()?.['user_version'];
        if (version === 0) db.exec(schema);
        else if (version !== 1) throw new Error('Unsupported file catalog schema');
      });
      const pageSize = Number(db.prepare('PRAGMA page_size').get()?.['page_size']);
      db.exec(`PRAGMA max_page_count = ${String(Math.floor(maxBytes / pageSize))}`);
      // Prepare a write even on existing databases to retain the exclusive lock.
      store.transaction(() => {
        db.exec('UPDATE active SET id = id WHERE 0');
      });
      return store;
    } catch (error) {
      db.close();
      throw new FsError(
        ErrorCode.IO_ERROR,
        'Cannot open the local catalog database',
        undefined,
        error,
      );
    }
  }

  private readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  close(): void {
    this.db.close();
  }

  private transaction(work: () => void): void {
    this.db.exec('BEGIN EXCLUSIVE');
    try {
      work();
      this.db.exec('COMMIT');
    } catch (error) {
      // SQLite can already have rolled back after a full disk or I/O error.
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  begin(id: string): void {
    this.db.prepare('INSERT INTO generations (id) VALUES (?)').run(id);
  }

  append(
    id: string,
    entries: readonly CatalogEntry[],
    scopes: ReadonlyMap<string, CatalogScope>,
  ): void {
    const entry = this.db.prepare('INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const scope = this.db.prepare('INSERT INTO scopes VALUES (?, ?, ?, ?, ?, ?, ?)');
    this.transaction(() => {
      for (const row of entries) {
        entry.run(
          id,
          row.ordinal,
          row.path,
          row.name,
          row.depth,
          row.extension,
          row.length,
          row.mtime,
        );
      }
      for (const [path, row] of scopes) {
        scope.run(
          id,
          path,
          row.first,
          row.last,
          row.depth,
          Number(row.inheritedIgnore),
          JSON.stringify(row.counters),
        );
      }
    });
  }

  publish(version: CatalogVersion): void {
    this.transaction(() => {
      this.db
        .prepare('UPDATE generations SET version = ? WHERE id = ?')
        .run(JSON.stringify(version), version.id);
      this.db
        .prepare(
          'INSERT INTO active (root, id) VALUES (?, ?) ON CONFLICT(root) DO UPDATE SET id = excluded.id',
        )
        .run(version.root, version.id);
    });
  }

  active(root: string): CatalogVersion | undefined {
    const serialized = this.db
      .prepare('SELECT version FROM active JOIN generations USING(id) WHERE root = ?')
      .get(root)?.['version'];
    return typeof serialized === 'string' ? (JSON.parse(serialized) as CatalogVersion) : undefined;
  }

  scope(id: string, path: string): CatalogScope | undefined {
    const row = this.db
      .prepare(
        'SELECT first, last, depth, inheritedIgnore, counters FROM scopes WHERE id = ? AND path = ?',
      )
      .get(id, path) as ScopeRow | undefined;
    if (!row) return undefined;
    return {
      ...row,
      inheritedIgnore: Boolean(row.inheritedIgnore),
      counters: JSON.parse(row.counters) as SnapshotCounters,
    };
  }

  exportPage(id: string, after: number, last: number): CatalogEntry[] {
    return this.db
      .prepare(
        `SELECT ordinal, path, name, depth, extension, length, mtime
      FROM entries WHERE id = ? AND ordinal > ? AND ordinal <= ? ORDER BY ordinal LIMIT 256`,
      )
      .all(id, after, last) as unknown as CatalogEntry[];
  }

  search(
    id: string,
    scope: string,
    after: string,
    filters: CatalogFilters,
    limit: number,
  ): CatalogEntry[] {
    const where = ['id = ?', 'path > ?'];
    const params: SQLInputValue[] = [id, after];
    const constrain = (sql: string, ...args: SQLInputValue[]): void => {
      where.push(sql);
      params.push(...args);
    };
    if (scope) constrain('path >= ? AND path < ?', `${scope}/`, `${scope}0`);
    if (filters.name !== undefined) constrain('name = ?', filters.name);
    if (filters.namePrefix !== undefined) {
      constrain(
        'name >= ? AND substr(name, 1, length(?)) = ?',
        filters.namePrefix,
        filters.namePrefix,
        filters.namePrefix,
      );
    }
    if (filters.extension !== undefined) constrain('extension = ?', filters.extension);
    if (filters.modifiedFrom !== undefined) constrain('mtime >= ?', filters.modifiedFrom);
    if (filters.modifiedBefore !== undefined) constrain('mtime < ?', filters.modifiedBefore);
    return this.db
      .prepare(
        `SELECT ordinal, path, name, depth, extension, length, mtime FROM entries
      WHERE ${where.join(' AND ')} ORDER BY path COLLATE BINARY LIMIT ?`,
      )
      .all(...params, limit) as unknown as CatalogEntry[];
  }

  discardable(): string[] {
    return this.db
      .prepare('SELECT id FROM generations WHERE id NOT IN (SELECT id FROM active) ORDER BY id')
      .all()
      .map((row) => String(row['id']));
  }

  discardBatch(id: string): boolean {
    const entries = this.db
      .prepare(
        'DELETE FROM entries WHERE (id, path) IN (SELECT id, path FROM entries WHERE id = ? ORDER BY path LIMIT 512)',
      )
      .run(id);
    const scopes = this.db
      .prepare(
        'DELETE FROM scopes WHERE (id, path) IN (SELECT id, path FROM scopes WHERE id = ? ORDER BY path LIMIT 512)',
      )
      .run(id);
    if (entries.changes || scopes.changes) return true;
    this.db.prepare('DELETE FROM generations WHERE id = ?').run(id);
    return false;
  }
}
