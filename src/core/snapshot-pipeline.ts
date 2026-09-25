import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { extname, join } from 'node:path';
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
}

interface IgnoreRule {
  readonly base: string;
  matcher: Ignore;
  testsSinceRefresh: number;
}

export interface SnapshotPipelineHooks {
  readonly beforeCompress?: (rawPath: string) => Promise<void>;
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
): AsyncGenerator<SnapshotRecord> {
  async function* walkDirectory(
    absoluteDirectory: string,
    relativeDirectory: string,
    inheritedRules: readonly IgnoreRule[],
    depth: number,
  ): AsyncGenerator<SnapshotRecord> {
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
      return;
    }
    snapshotCounters(ctx).directoriesVisited += 1;
    try {
      const localRule = options.includeIgnored
        ? undefined
        : await loadLocalIgnore(fs, absoluteDirectory, relativeDirectory, ctx);
      const rules = localRule ? [...inheritedRules, localRule] : inheritedRules;
      for (;;) {
        let entry;
        try {
          entry = await directory.read();
        } catch (error) {
          if (relativeDirectory === '') throw error;
          classifyWalkError(ctx, error, absoluteDirectory);
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
        yield {
          rootId: ctx.job.sourceRootId,
          relativePath,
          name: entry.name,
          extension: extname(entry.name),
          length: detail.stats.size,
          lastWriteTime: detail.stats.mtime.toISOString(),
        };
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

async function openPart(number: number, ctx: JobRunContext): Promise<OpenPart> {
  if (number > ctx.config.maxParts) {
    throw new FsError(ErrorCode.TOO_LARGE, 'Snapshot part-count limit exceeded');
  }
  const rawPath = ctx.tempPath(`snapshot-${String(number).padStart(5, '0')}.csv`);
  const handle = await open(rawPath, 'wx', 0o600);
  const part: OpenPart = { number, rawPath, handle, rows: 0, rawBytes: 0, closed: false };
  if (
    snapshotCounters(ctx).rawCsvBytes + Buffer.byteLength(SNAPSHOT_CSV_HEADER) >
    ctx.config.maxJobRawBytes
  ) {
    await handle.close();
    throw new FsError(ErrorCode.TOO_LARGE, 'Snapshot job raw CSV byte limit exceeded');
  }
  await writeBuffer(part, Buffer.from(SNAPSHOT_CSV_HEADER, 'utf8'), ctx);
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
  });
  snapshotCounters(ctx).zipBytes += zipBytes;
  snapshotCounters(ctx).parts += 1;
  await ctx.removeTemp(part.rawPath, part.rawBytes);
  return artifact;
}

export async function writeSnapshotFromRecords(
  records: AsyncIterable<SnapshotRecord>,
  ctx: JobRunContext,
  options: SnapshotWalkOptions,
  hooks: SnapshotPipelineHooks = {},
): Promise<string> {
  const startedAt = ctx.job.startedAt ?? new Date().toISOString();
  const parts: StoredArtifact[] = [];
  let part = await openPart(1, ctx);
  try {
    await ctx.setPhase('walking');
    for await (const record of records) {
      ctx.signal.throwIfAborted();
      const row = serializeSnapshotRecord(record);
      if (row.length > ctx.config.maxRecordBytes) {
        throw new FsError(
          ErrorCode.TOO_LARGE,
          `CSV record exceeds configured cap (${String(row.length)} bytes)`,
          record.relativePath,
        );
      }
      if (Buffer.byteLength(SNAPSHOT_CSV_HEADER) + row.length > ctx.config.maxRawPartBytes) {
        throw new FsError(ErrorCode.TOO_LARGE, 'CSV record cannot fit in an empty snapshot part');
      }
      if (part.rawBytes + row.length > ctx.config.maxRawPartBytes && part.rows > 0) {
        parts.push(await finalizePart(part, ctx, hooks));
        part = await openPart(part.number + 1, ctx);
        await ctx.setPhase('walking');
      }
      if (snapshotCounters(ctx).rawCsvBytes + row.length > ctx.config.maxJobRawBytes) {
        throw new FsError(ErrorCode.TOO_LARGE, 'Snapshot job raw CSV byte limit exceeded');
      }
      await writeBuffer(part, row, ctx);
      part.rows += 1;
      snapshotCounters(ctx).filesWritten += 1;
      if (snapshotCounters(ctx).filesWritten % 10_000 === 0) await ctx.checkpoint();
    }
    parts.push(await finalizePart(part, ctx, hooks));
  } finally {
    if (!part.closed) await part.handle.close().catch(() => undefined);
  }
  await ctx.setPhase('manifest');
  const endedAt = new Date().toISOString();
  const manifest = {
    schema: 'filesystem-mcp.snapshot-manifest',
    version: 1,
    jobId: ctx.job.jobId,
    root: { id: ctx.job.sourceRootId, path: ctx.job.sourceRoot },
    observed: { startedAt, endedAt, atomic: false },
    csv: {
      encoding: 'UTF-8',
      bom: false,
      newline: 'CRLF',
      quoting: 'RFC 4180',
      columns: ['RootId', 'RelativePath', 'Name', 'Extension', 'Length', 'LastWriteTime'],
      relativePathSeparator: '/',
      timestamp: 'ISO 8601 UTC',
    },
    policy: {
      includeHidden: options.includeHidden,
      includeIgnored: options.includeIgnored,
      symlinksFollowed: false,
      maxRecordBytes: ctx.config.maxRecordBytes,
      maxRawPartBytes: ctx.config.maxRawPartBytes,
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
    name: 'snapshot-manifest.json',
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
