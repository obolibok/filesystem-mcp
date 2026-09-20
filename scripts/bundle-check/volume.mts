import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import yauzl from 'yauzl';

import type { BundleSelection } from '../../src/core/bundle-pipeline.js';
import { runBundlePipeline } from '../../src/core/bundle-pipeline.js';
import { GuardedFileSystem } from '../../src/core/fs.js';
import { ArtifactJobManager, fingerprintJobInput } from '../../src/core/job-manager.js';
import type { BundleCounters, StoredJob } from '../../src/core/job-types.js';
import { emptyBundleCounters } from '../../src/core/job-types.js';
import { PathGuard, resolveAllowedDirectoriesState } from '../../src/core/path.js';
import { getSnapshotConfig } from '../../src/core/snapshot-config.js';

interface Options {
  output: string;
  files: number;
  fileBytes: number;
  rawPartBytes: number;
  zipBytes: number;
}

function parseArgs(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(
        'Usage: node --import tsx volume.mts --output PATH [--files 7 --file-bytes 1048576 --raw-part-bytes 2097152 --zip-bytes 2097152]',
      );
    }
    values.set(key, value);
  }
  const output = values.get('--output');
  if (!output) throw new Error('--output is required');
  const options = {
    output: resolve(output),
    files: Number(values.get('--files') ?? 7),
    fileBytes: Number(values.get('--file-bytes') ?? 1024 * 1024),
    rawPartBytes: Number(values.get('--raw-part-bytes') ?? 2 * 1024 * 1024),
    zipBytes: Number(values.get('--zip-bytes') ?? 2 * 1024 * 1024),
  };
  for (const [key, value] of Object.entries(options)) {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`${key} must be a positive safe integer`);
    }
  }
  if (options.files < 2 || options.fileBytes > options.rawPartBytes) {
    throw new Error('Need at least two files and fileBytes <= rawPartBytes');
  }
  return options;
}

function deterministicBytes(size: number, seed: number): Buffer {
  const output = Buffer.allocUnsafe(size);
  let offset = 0;
  let block = 0;
  while (offset < size) {
    const digest = createHash('sha256')
      .update(`${String(seed)}:${String(block)}`)
      .digest();
    const length = Math.min(digest.length, size - offset);
    digest.copy(output, offset, 0, length);
    offset += length;
    block += 1;
  }
  return output;
}

async function directoryBytes(root: string): Promise<number> {
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) total += (await stat(path).catch(() => undefined))?.size ?? 0;
    }
  }
  return total;
}

async function verifyZip(
  bytes: Buffer,
  expected: ReadonlyMap<string, { size: number; sha256: string }>,
  seen: Set<string>,
): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error('ZIP did not open'));
        return;
      }
      let entries = 0;
      zip.once('error', reject);
      zip.once('end', () => resolvePromise(entries));
      zip.on('entry', (entry) => {
        assert(entry.fileName.startsWith('files/'));
        const relativePath = entry.fileName.slice('files/'.length);
        const expectedFile = expected.get(relativePath);
        assert(expectedFile, `unexpected ZIP entry ${entry.fileName}`);
        assert(!seen.has(relativePath), `duplicate ZIP entry ${relativePath}`);
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError ?? new Error('ZIP entry did not open'));
            return;
          }
          const hash = createHash('sha256');
          let size = 0;
          stream.on('data', (chunk: Buffer) => {
            hash.update(chunk);
            size += chunk.length;
          });
          stream.once('error', reject);
          stream.once('end', () => {
            assert.equal(size, expectedFile.size);
            assert.equal(hash.digest('hex'), expectedFile.sha256);
            seen.add(relativePath);
            entries += 1;
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

async function waitForTerminal(
  manager: ArtifactJobManager,
  guard: PathGuard,
  jobId: string,
): Promise<StoredJob<BundleCounters>> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const job = await manager.getJob<BundleCounters>(jobId, guard);
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(job.state)) return job;
    assert(Date.now() < deadline, 'volume bundle timed out');
    await new Promise((resolveWaiter) => setTimeout(resolveWaiter, 10));
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(dirname(options.output), { recursive: true });
  const workspace = await mkdtemp(join(dirname(options.output), 'bundle-volume-'));
  const source = join(workspace, 'source');
  const scratch = join(workspace, 'scratch');
  await mkdir(source);
  await mkdir(scratch);
  const expected = new Map<string, { size: number; sha256: string }>();
  const selections: BundleSelection[] = [];
  for (let index = 0; index < options.files; index += 1) {
    const relativePath = `group-${String(index % 3)}/original-${String(index).padStart(3, '0')}.bin`;
    const bytes = deterministicBytes(options.fileBytes, index);
    const path = join(source, ...relativePath.split('/'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    expected.set(relativePath, {
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    selections.push({ relativePath });
  }
  assert(options.files * options.fileBytes >= options.rawPartBytes * 3);

  const guard = new PathGuard();
  guard.initialize(await resolveAllowedDirectoriesState([source]));
  const manager = new ArtifactJobManager({
    ...getSnapshotConfig(),
    scratchDirectory: scratch,
    ephemeralScratch: false,
    maxZipBytes: options.zipBytes,
    maxDeliveryBytes: options.zipBytes,
    maxFileSizeBytes: options.zipBytes,
    maxBundleFileBytes: options.fileBytes,
    maxBundleRawPartBytes: options.rawPartBytes,
    maxBundleJobRawBytes: options.files * options.fileBytes,
    maxBundleManifestBytes: Math.min(options.zipBytes, 1024 * 1024),
    maxJobArtifactBytes: options.files * options.zipBytes + 1024 * 1024,
    scratchQuotaBytes: options.files * (options.fileBytes + options.zipBytes) + 4 * 1024 * 1024,
  });
  let peakRss = process.memoryUsage().rss;
  let peakScratch = 0;
  let sampling = false;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    if (sampling) return;
    sampling = true;
    void directoryBytes(scratch)
      .then((bytes) => {
        peakScratch = Math.max(peakScratch, bytes);
      })
      .finally(() => {
        sampling = false;
      });
  }, 5);
  let report: Record<string, unknown> | undefined;
  try {
    const submitStarted = performance.now();
    const submitted = await manager.submit({
      kind: 'bundle',
      idempotencyKey: `volume-${randomUUID()}`,
      fingerprint: fingerprintJobInput(selections),
      sourceRoot: source,
      sourceRootId: 'root-volume',
      input: { files: selections },
      authorizationPaths: selections.map((selection) =>
        join(source, ...selection.relativePath.split('/')),
      ),
      counters: emptyBundleCounters(selections.length),
      run: async (ctx) => runBundlePipeline(new GuardedFileSystem(guard), source, selections, ctx),
    });
    const submitMs = performance.now() - submitStarted;
    const buildStarted = performance.now();
    const completed = await waitForTerminal(manager, guard, submitted.job.jobId);
    const buildMs = performance.now() - buildStarted;
    assert.equal(completed.state, 'completed', completed.stopReason);
    assert.equal(completed.complete, true);
    assert.equal(completed.counters.included, selections.length);
    const seen = new Set<string>();
    const parts = [];
    let largest: { artifactId: string; bytes: Buffer } | undefined;
    let fetchMs = 0;
    for (const artifact of completed.artifacts.filter(
      (candidate) => candidate.kind === 'bundle-part',
    )) {
      const started = performance.now();
      const payload = await manager.getArtifact(artifact.artifactId, guard);
      fetchMs += performance.now() - started;
      const entryCount = await verifyZip(payload.bytes, expected, seen);
      parts.push({
        name: artifact.name,
        files: entryCount,
        rawBytes: artifact.rawBytes,
        zipBytes: artifact.size,
        sha256: artifact.sha256,
      });
      if (!largest || payload.bytes.length > largest.bytes.length) {
        largest = { artifactId: artifact.artifactId, bytes: payload.bytes };
      }
    }
    assert.deepEqual(seen, new Set(expected.keys()));
    assert(largest);
    const repeated = await manager.getArtifact(largest.artifactId, guard);
    assert.deepEqual(repeated.bytes, largest.bytes);
    peakScratch = Math.max(peakScratch, await directoryBytes(scratch));
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    report = {
      schemaVersion: 1,
      resultClass: 'LOCAL_ONLY_NOT_CHATGPT',
      files: options.files,
      fileBytes: options.fileBytes,
      rawPartCapBytes: options.rawPartBytes,
      zipCapBytes: options.zipBytes,
      sourceBytes: completed.counters.sourceBytes,
      zipBytes: completed.counters.zipBytes,
      partCount: completed.counters.parts,
      submitMs: Number(submitMs.toFixed(1)),
      buildMs: Number(buildMs.toFixed(1)),
      fetchAllMs: Number(fetchMs.toFixed(1)),
      peakRssBytes: peakRss,
      peakScratchBytes: peakScratch,
      repeatedLargestBytes: largest.bytes.length,
      independentByteVerification: 'PASS',
      parts,
      status: 'PASS',
    };
  } finally {
    clearInterval(sampler);
    await manager.close();
    await rm(workspace, { recursive: true, force: true });
  }
  assert(report);
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${options.output}\n`);
}

await main();
