import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { extname, join, relative, sep } from 'node:path';
import { setImmediate } from 'node:timers/promises';

import {
  type CatalogEntry,
  type CatalogFilters,
  type CatalogScope,
  CatalogStore,
  type CatalogVersion,
} from './catalog-store.js';
import { withAbort } from './concurrency.js';
import { ErrorCode, FsError, isNodeError, Problem } from './errors.js';
import {
  entryIdentity,
  type EntryIdentity,
  type GuardedFileSystem,
  sameEntryIdentity,
} from './fs.js';
import type { JobRunContext } from './job-manager.js';
import { emptySnapshotCounters } from './job-types.js';
import { resolveRealPath } from './path.js';
import { IS_WINDOWS } from './primitives.js';
import type { SnapshotConfig } from './snapshot-config.js';
import {
  type SnapshotWalkOptions,
  walkSnapshotRecords,
  writeSnapshotFromRecords,
} from './snapshot-pipeline.js';
import { sourceProvenance } from './source-provenance.js';

const profile = { includeHidden: false, includeIgnored: false, layout: 'tree-depth-v1' } as const;
type IndexStage = 'source' | 'storage' | 'policy';

async function isDeniedSystemDirectory(
  fs: GuardedFileSystem,
  path: string,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const { directory } = await fs.opendir(path, { signal });
    await directory.close();
    return false;
  } catch (error) {
    signal.throwIfAborted();
    return (
      Problem.fromUnknown(error, ErrorCode.IO_ERROR).code === ErrorCode.PERMISSION_DENIED ||
      (error instanceof FsError &&
        isNodeError(error.cause) &&
        ['EACCES', 'EPERM'].includes(error.cause.code ?? ''))
    );
  }
}

interface CatalogTarget {
  root: string;
  relativePath: string;
  identity: EntryIdentity;
  policy: string;
}

interface Request {
  id: string;
  target: CatalogTarget;
  fs: GuardedFileSystem;
  state: 'queued' | 'running';
  stage: IndexStage;
  completion: PromiseWithResolvers<boolean>;
}

export interface CatalogSnapshotPlan {
  readonly fingerprint: string;
  readonly target: CatalogTarget;
  readonly versionAtRequest?: string;
  readonly requestedAt: number;
  readonly maxAgeMs: number;
  readonly forceRefresh: boolean;
}

interface SearchCursor {
  version: string;
  query: string;
  after: string;
}

interface CatalogFailure {
  requestId: string;
  errorCode: ErrorCode;
  errorStage: IndexStage;
}

export class FileCatalog {
  static async open(scratch: string, config: SnapshotConfig): Promise<FileCatalog> {
    const store = await CatalogStore.open(scratch, config.scratchQuotaBytes);
    const catalog = new FileCatalog(store, config);
    try {
      await catalog.collect();
      return catalog;
    } catch (error) {
      store.close();
      throw error;
    }
  }

  private readonly pending = new Map<string, Request>();
  private readonly failed = new Map<string, CatalogFailure>();
  private readonly readers = new Map<string, number>();
  private readonly cursorKey = randomBytes(32);
  private readonly shutdown = new AbortController();
  private readonly store: CatalogStore;
  private readonly config: SnapshotConfig;
  private worker: Promise<void> | undefined;
  private closing: Promise<void> | undefined;

  private constructor(store: CatalogStore, config: SnapshotConfig) {
    this.store = store;
    this.config = config;
  }

  async close(): Promise<void> {
    this.closing ??= this.closeStore();
    return this.closing;
  }

  private async closeStore(): Promise<void> {
    this.shutdown.abort();
    await this.worker;
    this.store.close();
  }

  private async target(
    fs: GuardedFileSystem,
    path: string,
    rootOnly = false,
  ): Promise<CatalogTarget | undefined> {
    const rootPaths = fs.pathGuard.getAllowedDirectories();
    const roots = await Promise.all(rootPaths.map((root) => resolveRealPath(root)));
    // Both paths have passed through realpath. Use exact components so that
    // case-sensitive directories on an otherwise case-insensitive OS stay distinct.
    const root = roots
      .filter(
        (candidate): candidate is string =>
          candidate !== null &&
          (candidate === path ||
            (!rootOnly && path.startsWith(candidate.endsWith(sep) ? candidate : candidate + sep))),
      )
      .sort((a, b) => b.length - a.length)[0];
    if (!root) return undefined;
    const [identity, policy] = await Promise.all([
      fs.statDetailed(root).then(({ stats }) => entryIdentity(stats)),
      this.policy(fs),
    ]);
    return {
      root,
      relativePath: relative(root, path).split(sep).join('/'),
      identity,
      policy,
    };
  }

  private async policy(fs: GuardedFileSystem): Promise<string> {
    return `1:${String(this.config.maxWalkDepth)}:${await fs.pathGuard.snapshotPolicyFingerprint()}`;
  }

  private matches(
    version: CatalogVersion | undefined,
    target: CatalogTarget,
  ): version is CatalogVersion {
    return (
      version?.root === target.root &&
      version.policy === target.policy &&
      sameEntryIdentity(version.identity, target.identity)
    );
  }

  async describeRoots(fs: GuardedFileSystem, paths: readonly string[]) {
    const policy = this.policy(fs).catch(() => undefined);
    return Promise.all(
      paths.map(async (path) => {
        const root = (await resolveRealPath(path).catch(() => undefined)) ?? path;
        const version = this.store.active(root);
        const identity = version
          ? await fs
              .statDetailed(root)
              .then(({ stats }) => entryIdentity(stats))
              .catch(() => undefined)
          : undefined;
        const indexed =
          version !== undefined &&
          identity !== undefined &&
          version.policy === (await policy) &&
          sameEntryIdentity(version.identity, identity);
        const request = this.pending.get(root);
        const failure = this.failed.get(root);
        const policyExcluded = indexed
          ? this.store.scope(version.id, '')?.counters.policyExcluded
          : undefined;
        return {
          indexed,
          ...(indexed ? { version: version.id, indexedAt: version.endedAt } : {}),
          ...(policyExcluded ? { policyExcluded } : {}),
          state: request?.state ?? (failure ? ('failed' as const) : ('idle' as const)),
          ...(request ? { requestId: request.id } : failure),
        };
      }),
    );
  }

  async request(fs: GuardedFileSystem, path: string) {
    const target = await this.target(fs, path, true);
    if (!target)
      throw new FsError(ErrorCode.INVALID_INPUT, 'Select an allowed root from list_roots', path);
    const existing = this.pending.get(target.root);
    const request = existing ?? this.enqueue(fs, target);
    return {
      requestId: request.id,
      state: request.state,
      message: existing ? ('Already requested' as const) : ('Requested' as const),
    };
  }

  private enqueue(fs: GuardedFileSystem, target: CatalogTarget): Request {
    this.shutdown.signal.throwIfAborted();
    if (!this.hasQueueRoom()) {
      throw new FsError(ErrorCode.TOO_LARGE, 'Catalog indexing queue is full');
    }
    const request: Request = {
      id: randomUUID(),
      target,
      fs,
      state: 'queued',
      stage: 'source',
      completion: Promise.withResolvers<boolean>(),
    };
    this.failed.delete(target.root);
    this.pending.set(target.root, request);
    this.worker ??= this.drain();
    return request;
  }

  private hasQueueRoom(): boolean {
    return this.pending.size < 1 + this.config.maxQueuedJobs;
  }

  private async collect(): Promise<void> {
    for (const id of this.store.discardable()) {
      if (this.readers.has(id)) continue;
      while (!this.shutdown.signal.aborted && this.store.discardBatch(id)) await setImmediate();
    }
  }

  private async drain(): Promise<void> {
    // Set worker before processing even if the first request fails synchronously.
    await setImmediate();
    for (const request of this.pending.values()) {
      let success = false;
      try {
        this.shutdown.signal.throwIfAborted();
        request.state = 'running';
        await this.build(request);
        success = true;
      } catch (error) {
        const { code: errorCode } = Problem.fromUnknown(error, ErrorCode.IO_ERROR);
        this.failed.set(request.target.root, {
          requestId: request.id,
          errorCode,
          errorStage: request.stage,
        });
      } finally {
        this.pending.delete(request.target.root);
        request.completion.resolve(success);
      }
      // Garbage collection is recoverable on next scan/startup. A committed
      // generation remains usable if cleanup is interrupted or disk I/O fails.
      if (!this.shutdown.signal.aborted) await this.collect().catch(() => undefined);
    }
    this.worker = undefined;
  }

  private async build(request: Request): Promise<void> {
    const { id, fs, target } = request;
    const signal = AbortSignal.any([
      this.shutdown.signal,
      AbortSignal.timeout(this.config.maxJobMs),
    ]);
    const { root } = target;
    const provenance = await sourceProvenance.capture(root);
    signal.throwIfAborted();
    const startedAt = new Date().toISOString();
    request.stage = 'storage';
    this.store.begin(id);
    request.stage = 'source';
    const counters = emptySnapshotCounters();
    let firstSourceError: Error | undefined;
    let policyExcluded = 0;
    let ordinal = 0;
    const entries: CatalogEntry[] = [];
    const scopes = new Map<string, CatalogScope>();
    const directories = [{ path: '', ordinal: 0, exclusionsAtStart: 0 }];
    const flush = (): void => {
      request.stage = 'storage';
      this.store.append(id, entries, scopes);
      request.stage = 'source';
      entries.length = 0;
      scopes.clear();
    };
    const records = walkSnapshotRecords(fs, root, profile, {
      counters,
      signal,
      maxWalkDepth: this.config.maxWalkDepth,
      sourceRootId: id,
      skipRedirectedDirectories: true,
      isScratchPath: () => false, // The guard keeps the entire scratch outside every allowed root.
      addError: (error) => {
        counters.errors += 1;
        firstSourceError ??=
          error instanceof Error
            ? error
            : new FsError(ErrorCode.IO_ERROR, 'Catalog walk was incomplete');
      },
      excludeEntry: async (entry, path, depth) => {
        const excluded =
          fs.pathGuard.isSensitive(path) ||
          (IS_WINDOWS &&
            depth === 0 &&
            entry.isDirectory() &&
            entry.name.toLowerCase() === 'system volume information' &&
            (await isDeniedSystemDirectory(fs, path, signal)));
        if (excluded) policyExcluded += 1;
        return excluded;
      },
      directoryFinished: (path, counts, inheritedIgnore) => {
        const directory = directories.pop();
        if (directory?.path !== path) throw new Error('Invalid catalog directory traversal');
        scopes.set(path, {
          first: directory.ordinal,
          last: ordinal,
          depth: directories.length,
          inheritedIgnore,
          counters: { ...counts, policyExcluded: policyExcluded - directory.exclusionsAtStart },
        });
      },
    });
    for await (const record of records) {
      if (!('type' in record) || record.type === 'U') {
        throw firstSourceError ?? new FsError(ErrorCode.IO_ERROR, 'Catalog walk was incomplete');
      }
      const parent = directories.at(-1);
      if (!parent || record.depth !== directories.length - 1)
        throw new Error('Invalid catalog depth');
      const path = parent.path ? `${parent.path}/${record.name}` : record.name;
      ordinal += 1;
      const isFile = record.type === 'F';
      entries.push({
        ordinal,
        path,
        name: record.name,
        depth: record.depth,
        extension: isFile ? extname(record.name) : null,
        length: record.length ?? null,
        mtime: record.lastWriteTime ?? null,
      });
      if (!isFile) directories.push({ path, ordinal, exclusionsAtStart: policyExcluded });
      if (entries.length + scopes.size >= 256) flush();
    }
    const endedAt = new Date().toISOString();
    if (counters.errors)
      throw firstSourceError ?? new FsError(ErrorCode.IO_ERROR, 'Catalog walk was incomplete');
    flush();
    request.stage = 'policy';
    const current = await this.target(fs, root, true);
    signal.throwIfAborted();
    const version = {
      id,
      root,
      identity: target.identity,
      policy: target.policy,
      startedAt,
      endedAt,
      provenance,
    };
    if (!current || !this.matches(version, current)) {
      throw new FsError(ErrorCode.ACCESS_DENIED, 'Catalog source changed during indexing');
    }
    request.stage = 'storage';
    this.store.publish(version);
  }

  async planSnapshot(
    fs: GuardedFileSystem,
    path: string,
    options: SnapshotWalkOptions,
    maxAgeMs: number,
    forceRefresh: boolean,
  ): Promise<CatalogSnapshotPlan | undefined> {
    if (options.includeHidden || options.includeIgnored) return undefined;
    const target = await this.target(fs, path);
    if (!target) return undefined;
    const version = this.store.active(target.root);
    if (this.matches(version, target)) {
      const scope = this.store.scope(version.id, target.relativePath);
      if (!scope || scope.inheritedIgnore || scope.counters.policyExcluded) return undefined;
      const age = Date.now() - Date.parse(version.startedAt);
      if (!forceRefresh && maxAgeMs > 0 && age >= 0 && age <= maxAgeMs)
        return {
          fingerprint: version.id,
          target,
          versionAtRequest: version.id,
          requestedAt: Date.now(),
          maxAgeMs,
          forceRefresh,
        };
    }
    return {
      fingerprint: `refresh:${version?.id ?? 'missing'}`,
      ...(version ? { versionAtRequest: version.id } : {}),
      target,
      requestedAt: Date.now(),
      maxAgeMs,
      forceRefresh,
    };
  }

  async exportSnapshot(
    plan: CatalogSnapshotPlan,
    fs: GuardedFileSystem,
    ctx: JobRunContext,
    options: SnapshotWalkOptions,
    setGeneration: (id: string) => void,
  ): Promise<string | undefined> {
    const source = await fs.pathGuard.validateExistingDirectory(ctx.job.sourceRoot, ctx.signal);
    if (source !== ctx.job.sourceRoot) return undefined;
    const target = await this.target(fs, ctx.job.sourceRoot);
    if (target?.root !== plan.target.root || target.relativePath !== plan.target.relativePath)
      return undefined;
    let version = this.store.active(target.root);
    const ageAtRequest = version ? plan.requestedAt - Date.parse(version.startedAt) : -1;
    const fresh =
      this.matches(version, target) &&
      ((version.id !== plan.versionAtRequest && Date.parse(version.endedAt) >= plan.requestedAt) ||
        (!plan.forceRefresh &&
          plan.maxAgeMs > 0 &&
          ageAtRequest >= 0 &&
          ageAtRequest <= plan.maxAgeMs));
    if (!fresh) {
      ctx.signal.throwIfAborted();
      const pending = this.pending.get(target.root);
      if (!pending && !this.hasQueueRoom()) return undefined;
      const request = pending ?? this.enqueue(fs, target);
      if (!(await withAbort(request.completion.promise, ctx.signal))) return undefined;
      await fs.pathGuard.assertNoSymlinkComponents(target.root, ctx.job.sourceRoot, ctx.signal);
      if ((await fs.pathGuard.snapshotPolicyFingerprint()) !== ctx.job.policyFingerprint)
        return undefined;
      version = this.store.active(target.root);
    }
    if (!this.matches(version, target)) return undefined;
    const scope = this.store.scope(version.id, target.relativePath);
    if (!scope || scope.inheritedIgnore || scope.counters.policyExcluded) return undefined;
    this.readers.set(version.id, (this.readers.get(version.id) ?? 0) + 1);
    try {
      setGeneration(version.id);
      ctx.job.observationStartedAt = version.startedAt;
      ctx.job.provenance = {
        ...version.provenance,
        root: { ...version.provenance.root, path: ctx.job.sourceRoot },
      };
      const { policyExcluded: _excluded, ...counters } = scope.counters;
      Object.assign(ctx.job.counters, counters);
      return await writeSnapshotFromRecords(
        this.records(version.id, scope, target.relativePath, ctx, options),
        ctx,
        options,
        {},
        version,
      );
    } finally {
      const readers = this.readers.get(version.id) ?? 1;
      if (readers <= 1) this.readers.delete(version.id);
      else this.readers.set(version.id, readers - 1);
    }
  }

  private async *records(
    id: string,
    scope: CatalogScope,
    path: string,
    ctx: JobRunContext,
    options: SnapshotWalkOptions,
  ) {
    let after = scope.first;
    while (after < scope.last) {
      ctx.signal.throwIfAborted();
      const page = this.store.exportPage(id, after, scope.last);
      if (!page.length) throw new FsError(ErrorCode.IO_ERROR, 'Catalog export rows are missing');
      for (const entry of page) {
        if (entry.ordinal !== after + 1)
          throw new FsError(ErrorCode.IO_ERROR, 'Catalog export rows are missing');
        after = entry.ordinal;
        if (options.layout) {
          yield {
            type: entry.mtime === null ? ('D' as const) : ('F' as const),
            depth: entry.depth - scope.depth,
            name: entry.name,
            ...(entry.length !== null ? { length: entry.length } : {}),
            ...(entry.mtime !== null ? { lastWriteTime: entry.mtime } : {}),
          };
        } else if (entry.length !== null && entry.mtime !== null) {
          yield {
            rootId: ctx.job.sourceRootId,
            relativePath: entry.path.slice(path ? path.length + 1 : 0),
            name: entry.name,
            extension: entry.extension ?? '',
            length: entry.length,
            lastWriteTime: entry.mtime,
          };
        }
      }
      await setImmediate();
    }
  }

  private cursorMac(body: string): Buffer {
    return createHmac('sha256', this.cursorKey).update(body).digest();
  }

  private decodeCursor(token: string): SearchCursor {
    const [body, signature, trailing] = token.split('.');
    const mac = body && signature ? Buffer.from(signature, 'base64url') : undefined;
    if (
      !body ||
      trailing !== undefined ||
      mac?.length !== 32 ||
      !timingSafeEqual(mac, this.cursorMac(body))
    ) {
      throw new FsError(
        ErrorCode.INVALID_INPUT,
        'Invalid or expired catalog cursor. Restart the search.',
      );
    }
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SearchCursor;
  }

  async search(
    fs: GuardedFileSystem,
    path: string,
    filters: CatalogFilters,
    limit: number,
    cursor?: string,
  ) {
    const target = await this.target(fs, path);
    const version = target ? this.store.active(target.root) : undefined;
    if (!target || !this.matches(version, target)) {
      throw new FsError(ErrorCode.NOT_FOUND, 'No current catalog for this root. Call index_root.');
    }
    const scope = this.store.scope(version.id, target.relativePath);
    if (!scope) {
      throw new FsError(ErrorCode.NOT_FOUND, 'The path is outside the indexed scope.');
    }
    const query = JSON.stringify([
      target.root,
      target.relativePath,
      filters.name,
      filters.namePrefix,
      filters.extension,
      filters.modifiedFrom,
      filters.modifiedBefore,
      limit,
    ]);
    const continuation = cursor ? this.decodeCursor(cursor) : undefined;
    if (continuation && (continuation.version !== version.id || continuation.query !== query)) {
      throw new FsError(
        ErrorCode.INVALID_INPUT,
        'Catalog cursor expired or query changed. Restart the search.',
      );
    }
    const rows = this.store.search(
      version.id,
      target.relativePath,
      continuation?.after ?? '',
      filters,
      limit + 1,
    );
    const last = rows.length > limit ? rows[limit - 1] : undefined;
    const tokenBody = last
      ? Buffer.from(JSON.stringify({ version: version.id, query, after: last.path })).toString(
          'base64url',
        )
      : undefined;
    return {
      root: target.root,
      path,
      version: version.id,
      ...(scope.counters.policyExcluded ? { policyExcluded: scope.counters.policyExcluded } : {}),
      observed: { startedAt: version.startedAt, endedAt: version.endedAt },
      entries: rows.slice(0, limit).map((entry: CatalogEntry) => ({
        path: join(target.root, ...entry.path.split('/')),
        name: entry.name,
        kind: entry.mtime === null ? ('directory' as const) : ('file' as const),
        length: entry.length,
        extension: entry.extension,
        lastWriteTime: entry.mtime,
      })),
      ...(tokenBody
        ? { cursor: `${tokenBody}.${this.cursorMac(tokenBody).toString('base64url')}` }
        : {}),
    };
  }
}
