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
import type { StoredArtifact } from './job-types.js';
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
    return error.code === ErrorCode.NOT_FOUND || error.code === ErrorCode.ACCESS_DENIED;
  }
  return (
    isNodeError(error) &&
    ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EBUSY'].includes(error.code ?? '')
  );
}

function classifyWalkError(ctx: JobRunContext, error: unknown, path: string): void {
  if (!isRecoverableWalkError(error)) throw error;
  const code = error instanceof FsError ? error.code : isNodeError(error) ? error.code : undefined;
  if (code === ErrorCode.NOT_FOUND || code === 'ENOENT') {
    ctx.job.counters.disappearedSkipped += 1;
  } else {
    ctx.job.counters.inaccessibleSkipped += 1;
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
    const localRule = options.includeIgnored
      ? undefined
      : await loadLocalIgnore(fs, absoluteDirectory, relativeDirectory, ctx);
    const rules = localRule ? [...inheritedRules, localRule] : inheritedRules;
    let directory;
    try {
      ({ directory } = await fs.opendir(absoluteDirectory, { signal: ctx.signal }));
    } catch (error) {
      classifyWalkError(ctx, error, absoluteDirectory);
      return;
    }
    ctx.job.counters.directoriesVisited += 1;
    try {
      for await (const entry of directory) {
        ctx.signal.throwIfAborted();
        ctx.job.counters.entriesSeen += 1;
        const absolutePath = join(absoluteDirectory, entry.name);
        const relativePath = toPosixRelative(root, absolutePath);
        if (ctx.runtime.job.state !== 'running') ctx.signal.throwIfAborted();
        if (ctx.isScratchPath(absolutePath)) {
          ctx.job.counters.scratchExcluded += 1;
          continue;
        }
        if (!options.includeHidden && entry.name.startsWith('.')) {
          ctx.job.counters.hiddenExcluded += 1;
          continue;
        }
        if (
          !options.includeIgnored &&
          (isDefaultIgnored(entry) || ignoredByRules(relativePath, entry.isDirectory(), rules))
        ) {
          ctx.job.counters.ignoredExcluded += 1;
          continue;
        }
        if (entry.isSymbolicLink()) {
          ctx.job.counters.symlinksSkipped += 1;
          continue;
        }
        if (entry.isDirectory()) {
          yield* walkDirectory(absolutePath, relativePath, rules, depth + 1);
          continue;
        }
        if (!entry.isFile()) {
          ctx.job.counters.specialSkipped += 1;
          continue;
        }
        try {
          const detail = await fs.statDetailed(absolutePath, { signal: ctx.signal });
          if (detail.isSymlink) {
            ctx.job.counters.symlinksSkipped += 1;
            continue;
          }
          if (!detail.stats.isFile()) {
            ctx.job.counters.specialSkipped += 1;
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
        } catch (error) {
          classifyWalkError(ctx, error, absolutePath);
        }
      }
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      classifyWalkError(ctx, error, absoluteDirectory);
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
    ctx.job.counters.rawCsvBytes += bytes.length;
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
    ctx.job.counters.rawCsvBytes + Buffer.byteLength(SNAPSHOT_CSV_HEADER) >
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
  ctx.job.counters.zipBytes += zipBytes;
  ctx.job.counters.parts += 1;
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
      if (ctx.job.counters.rawCsvBytes + row.length > ctx.config.maxJobRawBytes) {
        throw new FsError(ErrorCode.TOO_LARGE, 'Snapshot job raw CSV byte limit exceeded');
      }
      await writeBuffer(part, row, ctx);
      part.rows += 1;
      ctx.job.counters.filesWritten += 1;
      if (ctx.job.counters.filesWritten % 10_000 === 0) await ctx.checkpoint();
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
