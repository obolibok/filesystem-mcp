import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

import { ZipFile } from 'yazl';

import { ErrorCode, FsError, isFsError, isNodeError } from './errors.js';
import type { GuardedFileSystem } from './fs.js';
import type { JobRunContext } from './job-manager.js';
import type { BundleCounters, StoredArtifact } from './job-types.js';
import { isSamePath } from './path-utils.js';

const CAPTURE_CHUNK_BYTES = 64 * 1024;
const ZIP_EPOCH = new Date('1980-01-01T00:00:00.000Z');

type OwnedPipelineStream = NodeJS.ReadWriteStream & { destroy(error?: Error): void };

interface BundleExpected {
  readonly size: number;
  readonly lastWriteTime: string;
}

export interface BundleSelection {
  readonly relativePath: string;
  readonly expected?: BundleExpected;
}

interface ObservedMetadata {
  readonly size: number;
  readonly lastWriteTime: string;
}

interface IncludedResult {
  readonly relativePath: string;
  readonly expected?: BundleExpected;
  readonly status: 'included';
  readonly observed: { readonly before: ObservedMetadata; readonly after: ObservedMetadata };
  readonly actual: { readonly size: number; readonly sha256: string };
  partArtifactId: string;
  partName: string;
  archiveEntry: string;
}

interface SkippedResult {
  readonly relativePath: string;
  readonly expected?: BundleExpected;
  readonly status: 'missing' | 'inaccessible' | 'changed' | 'special' | 'too_large';
  readonly observed?: { readonly before?: ObservedMetadata; readonly after?: ObservedMetadata };
  readonly reason: { readonly code: string; readonly message: string; readonly limit?: number };
}

type BundleFileResult = IncludedResult | SkippedResult;

interface StagedOriginal {
  readonly selection: BundleSelection;
  readonly result: IncludedResult;
  readonly tempPath: string;
  readonly validPath: string;
  readonly size: number;
}

export interface BundlePipelineHooks {
  readonly afterCaptureBeforeRestat?: (
    selection: BundleSelection,
    validPath: string,
  ) => Promise<void>;
  readonly beforeCaptureWrite?: (selection: BundleSelection, tempPath: string) => Promise<void>;
  readonly beforeCompress?: (
    files: readonly BundleSelection[],
    tempPaths: readonly string[],
  ) => Promise<void>;
  readonly onZipSource?: (source: Readable, selection: BundleSelection) => void;
  readonly onZipPipelineStream?: (
    stream: NodeJS.ReadWriteStream,
    selection: BundleSelection,
  ) => void;
  readonly writeZipChunk?: (
    handle: FileHandle,
    chunk: Buffer,
    offset: number,
    length: number,
  ) => Promise<{ bytesWritten: number }>;
}

class ClosedZipTooLargeError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super(`Closed bundle ZIP would exceed effective deliverable cap ${String(limit)} bytes`);
    this.limit = limit;
  }
}

function bundleCounters(ctx: JobRunContext): BundleCounters {
  return ctx.job.counters as BundleCounters;
}

function metadata(stats: Stats): ObservedMetadata {
  return { size: stats.size, lastWriteTime: stats.mtime.toISOString() };
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function expectedMatches(expected: BundleExpected, observed: ObservedMetadata): boolean {
  return expected.size === observed.size && expected.lastWriteTime === observed.lastWriteTime;
}

function classifyRecoverable(error: unknown): 'missing' | 'inaccessible' | 'special' | undefined {
  if (isFsError(error)) {
    if (error.code === ErrorCode.NOT_FOUND) return 'missing';
    if (error.code === ErrorCode.PERMISSION_DENIED) return 'inaccessible';
    if (error.code === ErrorCode.NOT_FILE || error.code === ErrorCode.NOT_DIRECTORY)
      return 'special';
    return undefined;
  }
  if (!isNodeError(error)) return undefined;
  if (error.code === 'ENOENT') return 'missing';
  if (error.code === 'ENOTDIR') return 'special';
  if (error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'EBUSY') {
    return 'inaccessible';
  }
  if (error.code === 'EISDIR') return 'special';
  return undefined;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function skipResult(
  ctx: JobRunContext,
  selection: BundleSelection,
  status: SkippedResult['status'],
  code: string,
  message: string,
  options: {
    observed?: SkippedResult['observed'];
    limit?: number;
  } = {},
): SkippedResult {
  const counters = bundleCounters(ctx);
  counters.skipped += 1;
  counters[status === 'too_large' ? 'tooLarge' : status] += 1;
  ctx.addError(new FsError(code as ErrorCode, message), selection.relativePath);
  return {
    relativePath: selection.relativePath,
    ...(selection.expected ? { expected: selection.expected } : {}),
    status,
    ...(options.observed ? { observed: options.observed } : {}),
    reason: {
      code,
      message,
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    },
  };
}

async function captureOriginal(
  fs: GuardedFileSystem,
  root: string,
  selection: BundleSelection,
  totalStagedBytes: number,
  ctx: JobRunContext,
  hooks: BundlePipelineHooks,
): Promise<StagedOriginal | SkippedResult> {
  const absolutePath = join(root, ...selection.relativePath.split('/'));
  if (ctx.isScratchPath(absolutePath)) {
    throw new FsError(
      ErrorCode.ACCESS_DENIED,
      'Bundle selectors cannot read job scratch',
      selection.relativePath,
    );
  }
  let opened: Awaited<ReturnType<GuardedFileSystem['openOriginal']>>;
  try {
    opened = await fs.openOriginal(absolutePath, {
      signal: ctx.signal,
      root,
      rejectPath: (path) => ctx.isScratchPath(path),
    });
  } catch (error) {
    const status = classifyRecoverable(error);
    if (!status) throw error;
    const code =
      status === 'missing'
        ? ErrorCode.NOT_FOUND
        : status === 'special'
          ? ErrorCode.NOT_FILE
          : ErrorCode.PERMISSION_DENIED;
    return skipResult(ctx, selection, status, code, error instanceof Error ? error.message : code);
  }

  const { handle, stats: before, validPath } = opened;
  const observedBefore = metadata(before);
  let output: FileHandle | undefined;
  let tempPath: string | undefined;
  let reservedBytes = 0;

  const closeOutput = async (): Promise<void> => {
    const current = output;
    output = undefined;
    if (current) await current.close();
  };

  const discardCapture = async (): Promise<void> => {
    const failures: unknown[] = [];
    try {
      await closeOutput();
    } catch (error) {
      failures.push(error);
    }
    if (tempPath) {
      const currentPath = tempPath;
      try {
        await ctx.removeTemp(currentPath, reservedBytes);
        tempPath = undefined;
        reservedBytes = 0;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Could not discard captured bundle scratch bytes');
    }
  };

  try {
    if (selection.expected && !expectedMatches(selection.expected, observedBefore)) {
      return skipResult(
        ctx,
        selection,
        'changed',
        ErrorCode.INVALID_INPUT,
        'Observed metadata does not match the requested precondition',
        { observed: { before: observedBefore } },
      );
    }
    const fileLimit = Math.min(
      ctx.config.maxBundleFileBytes,
      ctx.config.maxBundleRawPartBytes,
      ctx.config.maxFileSizeBytes,
    );
    if (before.size > fileLimit) {
      return skipResult(
        ctx,
        selection,
        'too_large',
        ErrorCode.TOO_LARGE,
        `Original exceeds the per-file/raw-part cap (${String(before.size)} > ${String(fileLimit)} bytes)`,
        { observed: { before: observedBefore }, limit: fileLimit },
      );
    }
    if (totalStagedBytes + before.size > ctx.config.maxBundleJobRawBytes) {
      throw new FsError(ErrorCode.TOO_LARGE, 'Bundle job raw-byte limit exceeded');
    }

    tempPath = ctx.tempPath('bundle-original.partial');
    output = await open(tempPath, 'wx', 0o600);
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(Math.min(CAPTURE_CHUNK_BYTES, Math.max(1, before.size + 1)));
    let written = 0;
    try {
      for (;;) {
        ctx.signal.throwIfAborted();
        let bytesRead: number;
        try {
          ({ bytesRead } = await handle.read(chunk, 0, chunk.length, null));
        } catch (error) {
          const status = classifyRecoverable(error);
          if (!status) throw error;
          await discardCapture();
          const code =
            status === 'missing'
              ? ErrorCode.NOT_FOUND
              : status === 'special'
                ? ErrorCode.NOT_FILE
                : ErrorCode.PERMISSION_DENIED;
          return skipResult(
            ctx,
            selection,
            status,
            code,
            error instanceof Error ? error.message : code,
            { observed: { before: observedBefore } },
          );
        }
        if (bytesRead === 0) break;
        if (written + bytesRead > fileLimit) {
          await discardCapture();
          return skipResult(
            ctx,
            selection,
            'changed',
            ErrorCode.INVALID_INPUT,
            'Original grew beyond its observed size or configured cap while being captured',
            { observed: { before: observedBefore } },
          );
        }
        ctx.reserveDisk(bytesRead);
        reservedBytes += bytesRead;
        await hooks.beforeCaptureWrite?.(selection, tempPath);
        let offset = 0;
        while (offset < bytesRead) {
          const result = await output.write(chunk, offset, bytesRead - offset);
          if (result.bytesWritten === 0) throw new Error('Bundle capture write made no progress');
          offset += result.bytesWritten;
        }
        hash.update(chunk.subarray(0, bytesRead));
        written += bytesRead;
      }
      await hooks.afterCaptureBeforeRestat?.(selection, validPath);
      const handleAfter = await handle.stat();
      let pathAfter: Awaited<ReturnType<GuardedFileSystem['statDetailed']>>;
      try {
        pathAfter = await fs.statDetailed(absolutePath, { signal: ctx.signal });
      } catch (error) {
        const status = classifyRecoverable(error);
        if (!status) throw error;
        await discardCapture();
        return skipResult(
          ctx,
          selection,
          status === 'special' ? 'special' : status === 'inaccessible' ? 'inaccessible' : 'missing',
          status === 'special'
            ? ErrorCode.NOT_FILE
            : status === 'inaccessible'
              ? ErrorCode.PERMISSION_DENIED
              : ErrorCode.NOT_FOUND,
          'Original disappeared or became inaccessible while its bytes were being captured',
          { observed: { before: observedBefore } },
        );
      }
      if (pathAfter.isSymlink) {
        throw new FsError(
          ErrorCode.ACCESS_DENIED,
          'Bundle selector became a symlink or junction during capture',
          selection.relativePath,
        );
      }
      const observedAfter = metadata(pathAfter.stats);
      if (
        written !== before.size ||
        !sameIdentity(before, handleAfter) ||
        !sameIdentity(before, pathAfter.stats)
      ) {
        await discardCapture();
        return skipResult(
          ctx,
          selection,
          'changed',
          ErrorCode.INVALID_INPUT,
          'Original changed while its bytes were being captured',
          { observed: { before: observedBefore, after: observedAfter } },
        );
      }
      await closeOutput();
      const archiveEntry = `files/${selection.relativePath}`;
      return {
        selection,
        tempPath,
        validPath,
        size: written,
        result: {
          relativePath: selection.relativePath,
          ...(selection.expected ? { expected: selection.expected } : {}),
          status: 'included',
          observed: { before: observedBefore, after: observedAfter },
          actual: { size: written, sha256: hash.digest('hex') },
          partArtifactId: '',
          partName: '',
          archiveEntry,
        },
      };
    } catch (error) {
      try {
        await discardCapture();
      } catch (cleanupError) {
        throw new AggregateError(
          [asError(error), asError(cleanupError)],
          'Bundle capture failed and its scratch cleanup also failed',
          { cause: cleanupError },
        );
      }
      throw error;
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function createScratchSource(file: StagedOriginal, ctx: JobRunContext): Readable {
  return Readable.from(
    (async function* readScratch(): AsyncGenerator<Buffer> {
      const handle = await open(file.tempPath, 'r');
      const chunk = Buffer.alloc(CAPTURE_CHUNK_BYTES);
      try {
        for (;;) {
          ctx.signal.throwIfAborted();
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
          if (bytesRead === 0) return;
          // Readable.from/yazl may retain a yielded chunk while requesting the
          // next one. Copy only this bounded slice so the next handle.read
          // cannot mutate bytes still in compression.
          yield Buffer.from(chunk.subarray(0, bytesRead));
        }
      } finally {
        await handle.close();
      }
    })(),
    { objectMode: false },
  );
}

function observePipeChain(
  source: NodeJS.ReadableStream,
  observe: (stream: OwnedPipelineStream) => void,
): void {
  // yazl creates its CRC/counter/DeflateRaw chain inside addReadStream() and does
  // not expose those streams. Instrument this owned source's synchronous pipe
  // chain so abort/split cleanup can close every intermediate, not just its ends.
  const instrumented = new WeakSet<object>();
  const instrument = (stream: NodeJS.ReadableStream): void => {
    if (instrumented.has(stream)) return;
    instrumented.add(stream);
    const originalPipe = stream.pipe.bind(stream);
    stream.pipe = <T extends NodeJS.WritableStream>(
      destination: T,
      options?: { end?: boolean },
    ): T => {
      if (
        'pipe' in destination &&
        typeof destination.pipe === 'function' &&
        'destroy' in destination &&
        typeof destination.destroy === 'function'
      ) {
        const chained = destination as T & NodeJS.ReadableStream & OwnedPipelineStream;
        observe(chained);
        instrument(chained);
      }
      return originalPipe(destination, options);
    };
  };
  instrument(source);
}

async function writeClosedZip(
  staged: readonly StagedOriginal[],
  partNumber: number,
  ctx: JobRunContext,
  hooks: BundlePipelineHooks,
): Promise<StoredArtifact> {
  if (partNumber > ctx.config.maxParts) {
    throw new FsError(ErrorCode.TOO_LARGE, 'Bundle part-count limit exceeded');
  }
  await hooks.beforeCompress?.(
    staged.map((file) => file.selection),
    staged.map((file) => file.tempPath),
  );
  const zipPath = ctx.tempPath(`bundle-${String(partNumber).padStart(5, '0')}.zip`);
  const zipHandle = await open(zipPath, 'wx', 0o600);
  const zip = new ZipFile();
  const output = zip.outputStream as Readable;
  const sources: Readable[] = [];
  const pipelineStreams = new Set<OwnedPipelineStream>();
  const hash = createHash('sha256');
  const limit = Math.min(
    ctx.config.maxZipBytes,
    ctx.config.maxDeliveryBytes,
    ctx.config.maxFileSizeBytes,
  );
  let zipBytes = 0;
  let zipReservedBytes = 0;
  const onZipError = (error: Error): void => {
    output.destroy(error);
  };
  zip.on('error', onZipError);
  for (const file of staged) {
    const source = createScratchSource(file, ctx);
    observePipeChain(source, (stream) => {
      pipelineStreams.add(stream);
      hooks.onZipPipelineStream?.(stream, file.selection);
    });
    const onSourceError = (error: Error): void => {
      zip.emit('error', error);
    };
    source.on('error', onSourceError);
    sources.push(source);
    hooks.onZipSource?.(source, file.selection);
    zip.addReadStream(source, file.result.archiveEntry, {
      mtime: ZIP_EPOCH,
      mode: 0o600,
      compressionLevel: 6,
      size: file.size,
    });
  }
  zip.end();
  let failure: Error | undefined;
  try {
    for await (const rawChunk of output as AsyncIterable<Buffer | Uint8Array>) {
      ctx.signal.throwIfAborted();
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      if (zipBytes + chunk.length > limit) throw new ClosedZipTooLargeError(limit);
      ctx.reserveDisk(chunk.length);
      zipReservedBytes += chunk.length;
      let offset = 0;
      while (offset < chunk.length) {
        const result = hooks.writeZipChunk
          ? await hooks.writeZipChunk(zipHandle, chunk, offset, chunk.length - offset)
          : await zipHandle.write(chunk, offset, chunk.length - offset);
        if (result.bytesWritten === 0) throw new Error('Bundle ZIP write made no progress');
        offset += result.bytesWritten;
      }
      hash.update(chunk);
      zipBytes += chunk.length;
    }
  } catch (error) {
    failure = asError(error);
  }
  const ownedStreams = [
    ...new Set<Readable | OwnedPipelineStream>([output, ...sources, ...pipelineStreams]),
  ];
  const completions = ownedStreams.map((stream) => finished(stream, { cleanup: true }));
  output.destroy(failure instanceof Error ? failure : undefined);
  for (const source of sources) source.destroy();
  for (const stream of pipelineStreams) stream.destroy();
  const settled = await Promise.allSettled(completions);
  zip.off('error', onZipError);
  const rejected = settled.find((result) => result.status === 'rejected');
  failure ??= rejected?.status === 'rejected' ? asError(rejected.reason) : undefined;
  try {
    await zipHandle.close();
  } catch (error) {
    const closeError = asError(error);
    failure = failure
      ? new AggregateError(
          [failure, closeError],
          'Bundle ZIP failed while closing scratch output',
          {
            cause: closeError,
          },
        )
      : closeError;
  }
  if (failure) {
    try {
      await ctx.removeTemp(zipPath, zipReservedBytes);
    } catch (cleanupError) {
      throw new AggregateError(
        [failure, asError(cleanupError)],
        'Bundle ZIP failed and its scratch cleanup also failed',
        { cause: cleanupError },
      );
    }
    throw failure;
  }
  return ctx.commitArtifact(zipPath, {
    kind: 'bundle-part',
    name: `bundle-${String(partNumber).padStart(5, '0')}.zip`,
    mimeType: 'application/zip',
    size: zipBytes,
    sha256: hash.digest('hex'),
    rawBytes: staged.reduce((sum, file) => sum + file.size, 0),
  });
}

function splitGroup(staged: readonly StagedOriginal[]): [StagedOriginal[], StagedOriginal[]] {
  const total = staged.reduce((sum, file) => sum + file.size, 0);
  let prefix = 0;
  let splitAt = 1;
  for (let index = 0; index < staged.length - 1; index += 1) {
    prefix += staged[index]?.size ?? 0;
    splitAt = index + 1;
    if (prefix >= total / 2) break;
  }
  return [staged.slice(0, splitAt), staged.slice(splitAt)];
}

export async function runBundlePipeline(
  fs: GuardedFileSystem,
  root: string,
  selections: readonly BundleSelection[],
  ctx: JobRunContext,
  hooks: BundlePipelineHooks = {},
): Promise<string> {
  const startedAt = ctx.job.startedAt ?? new Date().toISOString();
  const results: BundleFileResult[] = [];
  const stagedGroups: StagedOriginal[][] = [];
  const canonicalPaths: string[] = [];
  let group: StagedOriginal[] = [];
  let groupBytes = 0;
  let totalStagedBytes = 0;

  await ctx.setPhase('capturing');
  for (const selection of selections) {
    ctx.signal.throwIfAborted();
    const captured = await captureOriginal(fs, root, selection, totalStagedBytes, ctx, hooks);
    if ('status' in captured) {
      results.push(captured);
      continue;
    }
    if (canonicalPaths.some((path) => isSamePath(path, captured.validPath))) {
      throw new FsError(
        ErrorCode.INVALID_INPUT,
        'Bundle selection contains multiple aliases of the same canonical file',
        selection.relativePath,
      );
    }
    canonicalPaths.push(captured.validPath);
    if (group.length > 0 && groupBytes + captured.size > ctx.config.maxBundleRawPartBytes) {
      stagedGroups.push(group);
      group = [];
      groupBytes = 0;
    }
    group.push(captured);
    groupBytes += captured.size;
    totalStagedBytes += captured.size;
  }
  if (group.length > 0) stagedGroups.push(group);

  await ctx.setPhase('compressing');
  const parts: StoredArtifact[] = [];
  const pending = [...stagedGroups];
  while (pending.length > 0) {
    const next = pending.shift();
    if (!next || next.length === 0) continue;
    try {
      const artifact = await writeClosedZip(next, parts.length + 1, ctx, hooks);
      parts.push(artifact);
      const counters = bundleCounters(ctx);
      counters.parts += 1;
      counters.zipBytes += artifact.size;
      counters.included += next.length;
      counters.sourceBytes += next.reduce((sum, file) => sum + file.size, 0);
      for (const file of next) {
        file.result.partArtifactId = artifact.artifactId;
        file.result.partName = artifact.name;
        results.push(file.result);
        await ctx.removeTemp(file.tempPath, file.size);
      }
    } catch (error) {
      if (!(error instanceof ClosedZipTooLargeError)) throw error;
      if (next.length > 1) {
        const [left, right] = splitGroup(next);
        pending.unshift(right, left);
        continue;
      }
      const file = next[0];
      if (!file) continue;
      results.push(
        skipResult(
          ctx,
          file.selection,
          'too_large',
          ErrorCode.TOO_LARGE,
          `Original cannot fit in a closed ZIP under the ${String(error.limit)} byte delivery cap`,
          { observed: file.result.observed, limit: error.limit },
        ),
      );
      await ctx.removeTemp(file.tempPath, file.size);
    }
  }

  results.sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
  );
  ctx.job.complete = ctx.job.complete && bundleCounters(ctx).included === selections.length;
  await ctx.setPhase('manifest');
  const endedAt = new Date().toISOString();
  const manifest = {
    schema: 'filesystem-mcp.bundle-manifest',
    version: 1,
    jobId: ctx.job.jobId,
    root: { id: ctx.job.sourceRootId },
    observed: {
      startedAt,
      endedAt,
      atomic: false,
      caveat:
        'Size, identity, and mtime were checked around capture; restored mtimes or writes outside that interval may not be detected without an expected content hash.',
    },
    policy: {
      selectedFilesOnly: true,
      symlinksFollowed: false,
      archivePrefix: 'files/',
      maxFiles: ctx.config.maxBundleFiles,
      maxSelectionBytes: ctx.config.maxBundleSelectionBytes,
      maxFileBytes: ctx.config.maxBundleFileBytes,
      maxRawPartBytes: ctx.config.maxBundleRawPartBytes,
      maxJobRawBytes: ctx.config.maxBundleJobRawBytes,
      maxZipBytes: ctx.config.maxZipBytes,
      maxDeliveryBytes: ctx.config.maxDeliveryBytes,
      maxFileSizeBytes: ctx.config.maxFileSizeBytes,
      effectiveZipDeliveryBytes: Math.min(
        ctx.config.maxZipBytes,
        ctx.config.maxDeliveryBytes,
        ctx.config.maxFileSizeBytes,
      ),
      maxManifestBytes: ctx.config.maxBundleManifestBytes,
      maxJobArtifactBytes: ctx.config.maxJobArtifactBytes,
      maxParts: ctx.config.maxParts,
      resultTtlMs: ctx.config.resultTtlMs,
    },
    complete: ctx.job.complete,
    counters: ctx.job.counters,
    files: results,
    parts: parts.map((artifact) => ({
      artifactId: artifact.artifactId,
      name: artifact.name,
      fileCount: results.filter(
        (result) => result.status === 'included' && result.partArtifactId === artifact.artifactId,
      ).length,
      rawBytes: artifact.rawBytes,
      zipBytes: artifact.size,
      base64Bytes: 4 * Math.ceil(artifact.size / 3),
      sha256: artifact.sha256,
    })),
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const manifestLimit = Math.min(
    ctx.config.maxBundleManifestBytes,
    ctx.config.maxDeliveryBytes,
    ctx.config.maxFileSizeBytes,
  );
  if (bytes.length > manifestLimit) {
    throw new FsError(
      ErrorCode.TOO_LARGE,
      `Bundle manifest exceeds its effective cap (${String(bytes.length)} > ${String(manifestLimit)} bytes)`,
    );
  }
  const manifestPath = ctx.tempPath('bundle-manifest.json');
  ctx.reserveDisk(bytes.length);
  const handle = await open(manifestPath, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  const artifact = await ctx.commitArtifact(manifestPath, {
    kind: 'manifest',
    name: 'bundle-manifest.json',
    mimeType: 'application/json',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  return artifact.artifactId;
}
