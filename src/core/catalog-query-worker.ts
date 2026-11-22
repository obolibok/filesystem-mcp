import { randomBytes } from 'node:crypto';
import { constants, DatabaseSync } from 'node:sqlite';

import type { CatalogQueryReply, CatalogQueryRequest, QueryValue } from './catalog-query.js';

const MAX_REPLY_BYTES = 128 * 1024;
const MAX_COLUMNS = 32;
const functions = new Set([
  'abs',
  'avg',
  'coalesce',
  'count',
  'date',
  'datetime',
  'glob',
  'ifnull',
  'instr',
  'length',
  'like',
  'lower',
  'ltrim',
  'max',
  'min',
  'nullif',
  'replace',
  'round',
  'rtrim',
  'strftime',
  'substr',
  'substring',
  'sum',
  'total',
  'trim',
  'upper',
]);

function quoted(db: DatabaseSync, value: string | number): string {
  const literal = db.prepare('SELECT quote(?) AS literal').get(value)?.['literal'];
  if (typeof literal !== 'string') throw new Error('Invalid query scope');
  return literal;
}

function installScope(db: DatabaseSync, request: CatalogQueryRequest): void {
  // Only this server-created view can read the stored catalogue tables. Its
  // private name cannot be supplied by a caller or requested as a column.
  const source = `scope_${randomBytes(16).toString('hex')}`;
  db.exec(`
    CREATE TEMP VIEW ${source} AS
      SELECT a.root AS root_path, a.configured_root, e.path AS relative_path,
             e.name, e.extension, e.length AS size_bytes, e.created_at, e.mtime AS modified_at
      FROM main.entries AS e JOIN main.active AS a ON a.id = e.id
      WHERE a.root = ${quoted(db, request.root)} AND e.id = ${quoted(db, request.generation)}
        AND e.ordinal > ${quoted(db, request.first)} AND e.ordinal <= ${quoted(db, request.last)}
        AND e.mtime IS NOT NULL;
    CREATE TEMP VIEW files AS SELECT * FROM ${source};
  `);
  db.setAuthorizer((action, object, column, database, origin) => {
    if (action === constants.SQLITE_SELECT) return constants.SQLITE_OK;
    if (action === constants.SQLITE_FUNCTION && column && functions.has(column.toLowerCase())) {
      return constants.SQLITE_OK;
    }
    if (action === constants.SQLITE_READ) {
      if (
        database === 'temp' &&
        (object === 'files' || (object === source && origin === 'files'))
      ) {
        return constants.SQLITE_OK;
      }
      if (
        database === 'main' &&
        origin === source &&
        (object === 'entries' || object === 'active')
      ) {
        return constants.SQLITE_OK;
      }
    }
    return constants.SQLITE_DENY;
  });
}

function valueForWire(raw: unknown): QueryValue {
  if (typeof raw === 'bigint') {
    const number = Number(raw);
    return Number.isSafeInteger(number) ? number : raw.toString();
  }
  if (raw === null || typeof raw === 'string') return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  throw new Error('Unsupported result value');
}

function runSql(db: DatabaseSync, request: CatalogQueryRequest): CatalogQueryReply {
  try {
    const sql = request.sql.trim();
    if (!/^(select|with)\b/iu.test(sql)) return { result: 'invalid' };
    const statement = db.prepare(sql);
    if (!sql.startsWith(statement.sourceSQL) || sql.slice(statement.sourceSQL.length).trim()) {
      return { result: 'invalid' };
    }
    statement.setReturnArrays(true);
    statement.setReadBigInts(true);
    const columns = statement.columns().map((column) => column.name);
    if (columns.length === 0 || columns.length > MAX_COLUMNS) return { result: 'invalid' };
    let bytes = Buffer.byteLength(JSON.stringify(columns));
    const rows: QueryValue[][] = [];
    for (const raw of statement.iterate(...request.params) as unknown as Iterable<unknown[]>) {
      if (rows.length >= request.limit) return { result: 'ok', columns, rows, truncated: true };
      const row = raw.map(valueForWire);
      bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
      if (bytes > MAX_REPLY_BYTES) return { result: 'ok', columns, rows, truncated: true };
      rows.push(row);
    }
    return { result: 'ok', columns, rows, truncated: false };
  } catch {
    return { result: 'invalid' };
  }
}

function query(request: CatalogQueryRequest): CatalogQueryReply {
  const db = new DatabaseSync(request.databasePath, { readOnly: true });
  try {
    db.exec(
      'PRAGMA hard_heap_limit = 67108864; PRAGMA temp_store = MEMORY; PRAGMA trusted_schema = OFF; BEGIN',
    );
    const active = db.prepare('SELECT id FROM active WHERE root = ?').get(request.root);
    if (active?.['id'] !== request.generation) return { result: 'stale' };
    installScope(db, request);
    return runSql(db, request);
  } finally {
    db.close();
  }
}

process.once('message', (request: CatalogQueryRequest) => {
  let response: CatalogQueryReply;
  try {
    response = query(request);
  } catch {
    response = { result: 'unavailable' };
  }
  process.send?.(response, () => {
    process.disconnect();
  });
});
