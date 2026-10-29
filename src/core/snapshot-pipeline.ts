import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { Readable } from 'node:stream';

import ignore from 'ignore';
import type { Ignore } from 'ignore';
import { ZipFile } from 'yazl';

import { ErrorCode, FsError, isFsError, isNodeError } from './errors.js';
import type { GuardedFileSystem } from './fs.js';
import type { JobRunContext } from './job-manager.js';
import type { SnapshotCounters, StoredArtifact } from './job-types.js';
import { toPosixRelative } from './path.js';
import { getMaxTextFileSize } from './util.js';

export const SNAPSHOT_CSV_HEADER = 'RootId,RelativePath,Name,Extension,Length,LastWriteTime\r\n';
const TREE_CSV_HEADER = 'Type,Depth,Name,Length,LastWriteTime\r\n';

export interface SnapshotTreeRecord {
  readonly type: 'D' | 'F' | 'U';
  readonly depth: number;
  readonly name: string;
  readonly length?: number;
  readonly lastWriteTime?: string;
}

type WalkRecord = SnapshotRecord | SnapshotTreeRecord;

export interface SnapshotRecord {
  readonly rootId: string;
  readonly relativePath: string;
  readonly name: string;
  readonly extension: string;
  readonly length: number;
  readonly lastWriteTime: string;
}

export interface SnapshotWalkOptions {
  readonly includeHidden: boolean;
  readonly includeIgnored: boolean;
  readonly layout?: 'tree-depth-v1';
}

interface IgnoreRule {
  readonly base: string;
  matcher: Ignore;
  testsSinceRefresh: number;
}

export interface SnapshotPipelineHooks {
  readonly beforeCompress?: (rawPath: string) => Promise<void>;
  readonly afterCompress?: () => void;
}

const IGNORE_CACHE_REFRESH_TESTS = 256;

function snapshotCounters(ctx: JobRunContext): SnapshotCounters {
  return ctx.job.counters as SnapshotCounters;
}

const DEFAULT_IGNORED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.vscode',
  '.idea',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.cache',
  '.yarn',
  'jspm_packages',
  'bower_components',
  'out',
  'tmp',
  '.temp',
]);

const DEFAULT_IGNORED_FILES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'npm-debug.log',
  'yarn-debug.log',
  'yarn-error.log',
]);

function csvField(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function serializeTreeRecord(
  record: Omit<SnapshotTreeRecord, 'type'> & { type: 'D' | 'F' | 'C' | 'U' },
): Buffer {
  return Buffer.from(
    [
      record.type,
      String(record.depth),
      record.name,
      record.length === undefined ? '' : String(record.length),
      record.lastWriteTime ?? '',
    ]
      .map(csvField)
      .join(',') + '\r\n',
    'utf8',
  );
}

export function serializeSnapshotRecord(record: SnapshotRecord): Buffer {
  const line = [
    record.rootId,
    record.relativePath,
    record.name,
    record.extension,
    String(record.length),
    record.lastWriteTime,
  ]
    .map(csvField)
    .join(',');
  return Buffer.from(`${line}\r\n`, 'utf8');
}

function relativeToRule(rule: IgnoreRule, relativePath: string): string | undefined {
  if (rule.base === '') return relativePath;
  if (relativePath === rule.base) return '';
  const prefix = `${rule.base}/`;
  return relativePath.startsWith(prefix) ? relativePath.slice(prefix.length) : undefined;
}

function ignoredByRules(
  relativePath: string,
  isDirectory: boolean,
  rules: readonly IgnoreRule[],
): boolean {
  let ignored = false;
  for (const rule of rules) {
    const relative = relativeToRule(rule, relativePath);
    if (relative === undefined || relative === '') continue;
    const candidate = isDirectory ? `${relative}/` : relative;
    const result = rule.matcher.test(candidate);
    rule.testsSinceRefresh += 1;
    if (rule.testsSinceRefresh >= IGNORE_CACHE_REFRESH_TESTS) {
      // `ignore` memoizes every tested path. Re-wrap the already-compiled rules
      // through its public API so a long walk keeps only a bounded cache while
      // preserving exact nested/negation semantics.
      rule.matcher = ignore().add(rule.matcher);
      rule.testsSinceRefresh = 0;
    }
    if (result.ignored) ignored = true;
    if (result.unignored) ignored = false;
  }
  return ignored;
}

function isDefaultIgnored(entry: Dirent): boolean {
  return entry.isDirectory()
    ? DEFAULT_IGNORED_DIRECTORIES.has(entry.name)
    : DEFAULT_IGNORED_FILES.has(entry.name);
}

function isRecoverableWalkError(error: unknown): boolean {
  if (error instanceof FsError) {
    // PathGuard's sensitive-file denylist is a per-child exclusion. Other
    // ACCESS_DENIED errors (root policy, containment, unsafe aliases) remain
    // fatal, and the caller still never reads the denied child.
    if (error.code === ErrorCode.ACCESS_DENIED) {
      return (
        error.cause === undefined &&
        error.message === 'Sensitive file blocked. Set ALLOW_SENSITIVE=1 to override.'
      );
    }
    const nativeCause = error.cause;
    const nativeCode = isNodeError(nativeCause) ? nativeCause.code : undefined;
    if (
      nativeCode &&
      !['ENOENT', 'ENOTDIR', 'EISDIR', 'EACCES', 'EPERM', 'EBUSY'].includes(nativeCode)
    ) {
      return false;
    }
    if (
      error.code === ErrorCode.NOT_FOUND ||
      error.code === ErrorCode.NOT_DIRECTORY ||
      error.code === ErrorCode.NOT_FILE ||
      error.code === ErrorCode.PERMISSION_DENIED
    )
      return true;
    if (error.code !== ErrorCode.IO_ERROR) return false;
    // PathGuard preserves the native errno as a cause. A generic IO_ERROR is
    // still fatal; only a known transient failure of this child is skippable.
    return nativeCode === 'EBUSY';
  }
  return (
    isNodeError(error) &&
    ['ENOENT', 'ENOTDIR', 'EISDIR', 'EACCES', 'EPERM', 'EBUSY'].includes(error.code ?? '')
  );
}

function classifyWalkError(ctx: JobRunContext, error: unknown, path: string): void {
  ctx.signal.throwIfAborted();
  if (!isRecoverableWalkError(error)) throw error;
  const code = error instanceof FsError ? error.code : isNodeError(error) ? error.code : undefined;
  if (
    code === ErrorCode.NOT_FOUND ||
    code === ErrorCode.NOT_DIRECTORY ||
    code === ErrorCode.NOT_FILE ||
    code === 'ENOENT' ||
    code === 'ENOTDIR' ||
    code === 'EISDIR'
  ) {
    snapshotCounters(ctx).disappearedSkipped += 1;
  } else {
    snapshotCounters(ctx).inaccessibleSkipped += 1;
  }
  ctx.addError(error, path);
}

async function loadLocalIgnore(
  fs: GuardedFileSystem,
  directory: string,
  relativeDirectory: string,
  ctx: JobRunContext,
): Promise<IgnoreRule | undefined> {
  const path = join(directory, '.gitignore');
  try {
    const { content } = await fs.readEditableText(path, {
      signal: ctx.signal,
      tool: 'snapshot',
    });
    return {
      base: relativeDirectory,
      matcher: ignore().add(content),
      testsSinceRefresh: 0,
    };
  } catch (error) {
    if (
      (isFsError(error) && error.code === ErrorCode.NOT_FOUND) ||
      (isNodeError(error) && error.code === 'ENOENT')
    ) {
      return undefined;
    }
    classifyWalkError(ctx, error, path);
    return undefined;
  }
}

async function* walkSnapshotRecords(
  fs: GuardedFileSystem,
  root: string,
  options: SnapshotWalkOptions,
  ctx: JobRunContext,
): AsyncGenerator<WalkRecord> {
  async function* walkDirectory(
    absoluteDirectory: string,
    relativeDirectory: string,
    inheritedRules: readonly IgnoreRule[],
    depth: number,
  ): AsyncGenerator<WalkRecord> {
    const incomplete = (): SnapshotTreeRecord => ({
      type: 'U',
      depth: depth - 1,
      name: basename(absoluteDirectory),
    });
    ctx.signal.throwIfAborted();
    if (depth > ctx.config.maxWalkDepth) {
      throw new FsError(
        ErrorCode.TOO_LARGE,
        `Snapshot walk depth exceeds configured cap ${String(ctx.config.maxWalkDepth)}`,
        absoluteDirectory,
      );
    }
    let directory;
    try {
      ({ directory } = await fs.opendir(absoluteDirectory, { signal: ctx.signal }));
    } catch (error) {
      if (relativeDirectory === '') throw error;
      classifyWalkError(ctx, error, absoluteDirectory);
      if (options.layout) yield incomplete();
      return;
    }
    snapshotCounters(ctx).directoriesVisited += 1;
    try {
      const errorsBeforeIgnore = ctx.job.counters.errors;
      const localRule = options.includeIgnored
        ? undefined
        : await loadLocalIgnore(fs, absoluteDirectory, relativeDirectory, ctx);
      if (
        options.layout &&
        relativeDirectory !== '' &&
        ctx.job.counters.errors > errorsBeforeIgnore
      )
        yield incomplete();
      const rules = localRule ? [...inheritedRules, localRule] : inheritedRules;
      for (;;) {
        let entry;
        try {
          entry = await directory.read();
        } catch (error) {
          if (relativeDirectory === '') throw error;
          classifyWalkError(ctx, error, absoluteDirectory);
          if (options.layout) yield incomplete();
          return;
        }
        if (entry === null) break;
        ctx.signal.throwIfAborted();
        snapshotCounters(ctx).entriesSeen += 1;
        const absolutePath = join(absoluteDirectory, entry.name);
        const relativePath = toPosixRelative(root, absolutePath);
        if (ctx.runtime.job.state !== 'running') ctx.signal.throwIfAborted();
        if (ctx.isScratchPath(absolutePath)) {
          snapshotCounters(ctx).scratchExcluded += 1;
          continue;
        }
        if (!options.includeHidden && entry.name.startsWith('.')) {
          snapshotCounters(ctx).hiddenExcluded += 1;
          continue;
        }
        if (
          !options.includeIgnored &&
          (isDefaultIgnored(entry) || ignoredByRules(relativePath, entry.isDirectory(), rules))
        ) {
          snapshotCounters(ctx).ignoredExcluded += 1;
          continue;
        }
        if (entry.isSymbolicLink()) {
          snapshotCounters(ctx).symlinksSkipped += 1;
          continue;
        }
        if (entry.isDirectory()) {
          if (options.layout) yield { type: 'D', depth, name: entry.name };
          yield* walkDirectory(absolutePath, relativePath, rules, depth + 1);
          continue;
        }
        if (!entry.isFile()) {
          snapshotCounters(ctx).specialSkipped += 1;
          continue;
        }
        let detail;
        try {
          detail = await fs.statDetailed(absolutePath, { signal: ctx.signal });
        } catch (error) {
          classifyWalkError(ctx, error, absolutePath);
          continue;
        }
        if (detail.isSymlink) {
          snapshotCounters(ctx).symlinksSkipped += 1;
          ctx.addError(
            new FsError(
              ErrorCode.NOT_FILE,
              'File changed to symlink during snapshot',
              absolutePath,
            ),
            absolutePath,
          );
          continue;
        }
        if (!detail.stats.isFile()) {
          snapshotCounters(ctx).specialSkipped += 1;
          ctx.addError(
            new FsError(ErrorCode.NOT_FILE, 'File type changed during snapshot', absolutePath),
            absolutePath,
          );
          continue;
        }
        const record: SnapshotRecord = {
          rootId: ctx.job.sourceRootId,
          relativePath,
          name: entry.name,
          extension: extname(entry.name),
          length: detail.stats.size,
          lastWriteTime: detail.stats.mtime.toISOString(),
        };
        yield options.layout
          ? {
              type: 'F',
              depth,
              name: record.name,
              length: record.length,
              lastWriteTime: record.lastWriteTime,
            }
          : record;
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
  }

  yield* walkDirectory(root, '', [], 0);
}

interface OpenPart {
  readonly number: number;
  readonly rawPath: string;
  readonly handle: Awaited<ReturnType<typeof open>>;
  rows: number;
  rawBytes: number;
  closed: boolean;
  tree?: { files: number; directories: number; contextRecords: number; errorRecords: number };
}

async function writeBuffer(part: OpenPart, bytes: Buffer, ctx: JobRunContext): Promise<void> {
  ctx.reserveDisk(bytes.length);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      ctx.signal.throwIfAborted();
      const result = await part.handle.write(bytes, offset, bytes.length - offset);
      if (result.bytesWritten === 0) throw new Error('Snapshot spool write made no progress');
      offset += result.bytesWritten;
    }
    part.rawBytes += bytes.length;
    snapshotCounters(ctx).rawCsvBytes += bytes.length;
  } catch (error) {
    ctx.releaseDisk(bytes.length);
    throw error;
  }
}

async function openPart(
  number: number,
  ctx: JobRunContext,
  maxRawPartBytes: number,
  prefix?: Buffer,
): Promise<OpenPart> {
  if (number > ctx.config.maxParts) {
    throw new FsError(ErrorCode.TOO_LARGE, 'Snapshot part-count limit exceeded');
  }
  const header = prefix ?? Buffer.from(SNAPSHOT_CSV_HEADER, 'utf8');
  if (prefix && header.length > maxRawPartBytes) {
    throw new FsError(ErrorCode.TOO_LARGE, 'Tree root/header cannot fit in an empty snapshot part');
  }
  const rawPath = ctx.tempPath(`snapshot-${String(number).padStart(5, '0')}.csv`);
  const handle = await open(rawPath, 'wx', 0o600);
  const part: OpenPart = { number, rawPath, handle, rows: 0, rawBytes: 0, closed: false };
  if (prefix) {
    part.rows = 2;
    part.tree = { files: 0, directories: 0, contextRecords: 0, errorRecords: 0 };
  }
  if (snapshotCounters(ctx).rawCsvBytes + header.length > ctx.config.maxJobRawBytes) {
    await handle.close();
    throw new FsError(ErrorCode.TOO_LARGE, 'Snapshot job raw CSV byte limit exceeded');
  }
  try {
    await writeBuffer(part, header, ctx);
  } catch (error) {
    await handle.close();
    throw error;
  }
  return part;
}

async function finalizePart(
  part: OpenPart,
  ctx: JobRunContext,
  hooks: SnapshotPipelineHooks,
): Promise<StoredArtifact> {
  await part.handle.close();
  part.closed = true;
  await ctx.setPhase('compressing');
  await hooks.beforeCompress?.(part.rawPath);
  const zipPath = ctx.tempPath(`snapshot-${String(part.number).padStart(5, '0')}.zip`);
  const zipHandle = await open(zipPath, 'wx', 0o600);
  const hash = createHash('sha256');
  let zipBytes = 0;
  const zip = new ZipFile();
  const source = createReadStream(part.rawPath);
  const output = zip.outputStream as Readable;
  const onZipError = (error: Error): void => {
    output.destroy(error);
  };
  const onSourceError = (error: Error): void => {
    zip.emit('error', error);
  };
  zip.on('error', onZipError);
  source.on('error', onSourceError);
  zip.addReadStream(source, `snapshot-${String(part.number).padStart(5, '0')}.csv`, {
    mtime: new Date('1980-01-01T00:00:00.000Z'),
    mode: 0o600,
    compressionLevel: 6,
    size: part.rawBytes,
  });
  zip.end();
  const closedZipLimit = Math.min(
    ctx.config.maxZipBytes,
    ctx.config.maxDeliveryBytes,
    ctx.config.maxFileSizeBytes,
  );
  try {
    for await (const rawChunk of output as AsyncIterable<Buffer | Uint8Array>) {
      ctx.signal.throwIfAborted();
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      if (zipBytes + chunk.length > closedZipLimit) {
        throw new FsError(
          ErrorCode.TOO_LARGE,
          `Closed ZIP part would exceed effective deliverable cap ${String(closedZipLimit)} bytes`,
        );
      }
      ctx.reserveDisk(chunk.length);
      try {
        let offset = 0;
        while (offset < chunk.length) {
          const result = await zipHandle.write(chunk, offset, chunk.length - offset);
          if (result.bytesWritten === 0) throw new Error('Snapshot ZIP write made no progress');
          offset += result.bytesWritten;
        }
      } catch (error) {
        ctx.releaseDisk(chunk.length);
        throw error;
      }
      hash.update(chunk);
      zipBytes += chunk.length;
    }
  } finally {
    source.destroy();
    output.destroy();
    await zipHandle.close();
  }
  const artifact = await ctx.commitArtifact(zipPath, {
    kind: 'snapshot-part',
    name: `snapshot-${String(part.number).padStart(5, '0')}.zip`,
    mimeType: 'application/zip',
    size: zipBytes,
    sha256: hash.digest('hex'),
    rows: part.rows,
    rawBytes: part.rawBytes,
    ...(part.tree ?? {}),
  });
  snapshotCounters(ctx).zipBytes += zipBytes;
  snapshotCounters(ctx).parts += 1;
  await ctx.removeTemp(part.rawPath, part.rawBytes);
  hooks.afterCompress?.();
  return artifact;
}

export async function writeSnapshotFromRecords(
  records: AsyncIterable<WalkRecord>,
  ctx: JobRunContext,
  options: SnapshotWalkOptions,
  hooks: SnapshotPipelineHooks = {},
): Promise<string> {
  const startedAt = ctx.job.startedAt ?? new Date().toISOString();
  const parts: StoredArtifact[] = [];
  const tree = options.layout === 'tree-depth-v1';
  const maxRawPartBytes = tree
    ? (ctx.config.maxTreeRawPartBytes ?? ctx.config.maxRawPartBytes)
    : ctx.config.maxRawPartBytes;
  const rootRecord = Buffer.from(`${csvField(ctx.job.sourceRoot)}\r\n`, 'utf8');
  const prefix = tree ? Buffer.concat([rootRecord, Buffer.from(TREE_CSV_HEADER)]) : undefined;
  if (
    tree &&
    Math.max(rootRecord.length, Buffer.byteLength(TREE_CSV_HEADER)) > ctx.config.maxRecordBytes
  ) {
    throw new FsError(ErrorCode.TOO_LARGE, 'Tree root/header record exceeds configured cap');
  }
  const ancestors: string[] = [];
  if (tree)
    Object.assign(snapshotCounters(ctx), {
      directoriesWritten: 0,
      contextRecords: 0,
      errorRecords: 0,
    });
  let part = await openPart(1, ctx, maxRawPartBytes, prefix);
  try {
    await ctx.setPhase('walking');
    for await (const record of records) {
      ctx.signal.throwIfAborted();
      const node = 'type' in record ? record : undefined;
      if (tree !== Boolean(node))
        throw new FsError(ErrorCode.INVALID_INPUT, 'Snapshot record layout mismatch');
      if (node) {
        if (
          !Number.isSafeInteger(node.depth) ||
          node.depth < 0 ||
          node.depth > ctx.config.maxWalkDepth ||
          node.depth > ancestors.length
        ) {
          throw new FsError(ErrorCode.INVALID_INPUT, 'Invalid tree depth or missing ancestor');
        }
        ancestors.length = node.depth;
      }
      const row = node
        ? serializeTreeRecord(node)
        : serializeSnapshotRecord(record as SnapshotRecord);
      if (row.length > ctx.config.maxRecordBytes) {
        throw new FsError(
          ErrorCode.TOO_LARGE,
          `CSV record exceeds configured cap (${String(row.length)} bytes)`,
          node?.name ?? (record as SnapshotRecord).relativePath,
        );
      }
      if (
        (prefix?.length ?? Buffer.byteLength(SNAPSHOT_CSV_HEADER)) + row.length >
        maxRawPartBytes
      ) {
        throw new FsError(ErrorCode.TOO_LARGE, 'CSV record cannot fit in an empty snapshot part');
      }
      if (part.rawBytes + row.length > maxRawPartBytes) {
        const context = node
          ? ancestors.map((name, depth) => serializeTreeRecord({ type: 'C', depth, name }))
          : [];
        if (
          context.some((bytes) => bytes.length > ctx.config.maxRecordBytes) ||
          (prefix?.length ?? Buffer.byteLength(SNAPSHOT_CSV_HEADER)) +
            context.reduce((n, bytes) => n + bytes.length, 0) +
            row.length >
            maxRawPartBytes
        ) {
          throw new FsError(
            ErrorCode.TOO_LARGE,
            'Tree root/header/context and record cannot fit in an empty snapshot part',
          );
        }
        parts.push(await finalizePart(part, ctx, hooks));
        part = await openPart(part.number + 1, ctx, maxRawPartBytes, prefix);
        for (const bytes of context) {
          if (snapshotCounters(ctx).rawCsvBytes + bytes.length > ctx.config.maxJobRawBytes)
            throw new FsError(ErrorCode.TOO_LARGE, 'Snapshot job raw CSV byte limit exceeded');
          await writeBuffer(part, bytes, ctx);
          part.rows += 1;
          if (part.tree) part.tree.contextRecords += 1;
          snapshotCounters(ctx).contextRecords = (snapshotCounters(ctx).contextRecords ?? 0) + 1;
        }
        await ctx.setPhase('walking');
      }
      if (snapshotCounters(ctx).rawCsvBytes + row.length > ctx.config.maxJobRawBytes) {
        throw new FsError(ErrorCode.TOO_LARGE, 'Snapshot job raw CSV byte limit exceeded');
      }
      await writeBuffer(part, row, ctx);
      part.rows += 1;
      if (!node || node.type === 'F') {
        snapshotCounters(ctx).filesWritten += 1;
        if (part.tree) part.tree.files += 1;
      } else if (node.type === 'D') {
        snapshotCounters(ctx).directoriesWritten =
          (snapshotCounters(ctx).directoriesWritten ?? 0) + 1;
        if (part.tree) part.tree.directories += 1;
      } else {
        snapshotCounters(ctx).errorRecords = (snapshotCounters(ctx).errorRecords ?? 0) + 1;
        if (part.tree) part.tree.errorRecords += 1;
      }
      if (node && node.type !== 'F') ancestors.push(node.name);
      if ((tree ? part.rows : snapshotCounters(ctx).filesWritten) % 10_000 === 0)
        await ctx.checkpoint();
    }
    parts.push(await finalizePart(part, ctx, hooks));
  } finally {
    if (!part.closed) await part.handle.close().catch(() => undefined);
  }
  await ctx.setPhase('manifest');
  const endedAt = new Date().toISOString();
  const manifest = {
    schema: tree ? 'filesystem-mcp.snapshot-tree-manifest' : 'filesystem-mcp.snapshot-manifest',
    version: 1,
    ...(tree ? { layout: 'tree-depth-v1' } : {}),
    jobId: ctx.job.jobId,
    root: { id: ctx.job.sourceRootId, path: ctx.job.sourceRoot },
    ...(ctx.job.provenance ? { provenance: ctx.job.provenance } : {}),
    observed: { startedAt, endedAt, atomic: false },
    csv: {
      encoding: 'UTF-8',
      bom: false,
      newline: 'CRLF',
      quoting: 'RFC 4180',
      ...(tree
        ? {
            columns: ['Type', 'Depth', 'Name', 'Length', 'LastWriteTime'],
            firstRecord: 'One field: absolute sourceRoot',
            depth: '0 = children of sourceRoot; depth-first; basename at each depth',
            types: {
              F: 'file',
              D: 'directory in selected scope',
              C: 'ancestor context, not a new object',
              U: 'incomplete child directory, not a new object',
            },
            rows: 'All CSV records including root, header, C and U',
          }
        : {
            columns: ['RootId', 'RelativePath', 'Name', 'Extension', 'Length', 'LastWriteTime'],
            relativePathSeparator: '/',
          }),
      timestamp: 'ISO 8601 UTC',
    },
    policy: {
      includeHidden: options.includeHidden,
      includeIgnored: options.includeIgnored,
      symlinksFollowed: false,
      maxRecordBytes: ctx.config.maxRecordBytes,
      maxRawPartBytes,
      maxZipBytes: ctx.config.maxZipBytes,
      maxDeliveryBytes: ctx.config.maxDeliveryBytes,
      maxFileSizeBytes: ctx.config.maxFileSizeBytes,
      effectiveZipDeliveryBytes: Math.min(
        ctx.config.maxZipBytes,
        ctx.config.maxDeliveryBytes,
        ctx.config.maxFileSizeBytes,
      ),
      maxJobRawBytes: ctx.config.maxJobRawBytes,
      maxJobArtifactBytes: ctx.config.maxJobArtifactBytes,
      maxParts: ctx.config.maxParts,
      scratchExcluded: true,
      resultTtlMs: ctx.config.resultTtlMs,
    },
    complete: ctx.job.complete,
    counters: ctx.job.counters,
    errors: ctx.job.errors,
    parts: parts.map((artifact) => ({
      artifactId: artifact.artifactId,
      name: artifact.name,
      rows: artifact.rows,
      rawBytes: artifact.rawBytes,
      zipBytes: artifact.size,
      base64Bytes: 4 * Math.ceil(artifact.size / 3),
      sha256: artifact.sha256,
      ...(tree
        ? {
            files: artifact.files,
            directories: artifact.directories,
            contextRecords: artifact.contextRecords,
            errorRecords: artifact.errorRecords,
          }
        : {}),
    })),
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  if (
    bytes.length >
    Math.min(
      ctx.config.maxDeliveryBytes,
      ctx.config.maxZipBytes,
      ctx.config.maxFileSizeBytes,
      getMaxTextFileSize(),
    )
  ) {
    throw new FsError(ErrorCode.TOO_LARGE, 'Snapshot manifest exceeds delivery limit');
  }
  const manifestPath = ctx.tempPath('manifest.json');
  ctx.reserveDisk(bytes.length);
  await open(manifestPath, 'wx', 0o600).then(async (handle) => {
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
  });
  const artifact = await ctx.commitArtifact(manifestPath, {
    kind: 'manifest',
    name: tree ? 'snapshot-tree-manifest.json' : 'snapshot-manifest.json',
    mimeType: 'application/json',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  return artifact.artifactId;
}

export async function runSnapshotPipeline(
  fs: GuardedFileSystem,
  root: string,
  options: SnapshotWalkOptions,
  ctx: JobRunContext,
): Promise<string> {
  const records = walkSnapshotRecords(fs, root, options, ctx);
  return writeSnapshotFromRecords(records, ctx, options);
}
