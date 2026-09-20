import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import { parse } from 'csv-parse';
import yauzl from 'yauzl';

import { GuardedFileSystem } from '../../src/core/fs.js';
import { ArtifactJobManager, fingerprintJobInput } from '../../src/core/job-manager.js';
import { PathGuard, resolveAllowedDirectoriesState } from '../../src/core/path.js';
import { getSnapshotConfig } from '../../src/core/snapshot-config.js';
import type { SnapshotRecord } from '../../src/core/snapshot-pipeline.js';
import { runSnapshotPipeline, writeSnapshotFromRecords } from '../../src/core/snapshot-pipeline.js';

interface Args {
  mode: 'pipeline' | 'walk';
  records: number;
  walkFiles: number;
  entropy: 'normal' | 'high';
  expectFailure: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  const mode = value('--mode') ?? 'pipeline';
  if (mode !== 'pipeline' && mode !== 'walk') throw new Error('--mode must be pipeline or walk');
  const records = Number(value('--records') ?? '3000000');
  const walkFiles = Number(value('--walk-files') ?? '21000');
  const entropy = value('--entropy') ?? 'normal';
  if (entropy !== 'normal' && entropy !== 'high') {
    throw new Error('--entropy must be normal or high');
  }
  if (!Number.isSafeInteger(records) || records < 1) throw new Error('--records must be positive');
  if (!Number.isSafeInteger(walkFiles) || walkFiles < 20001) {
    throw new Error('--walk-files must be an integer greater than 20000');
  }
  return { mode, records, walkFiles, entropy, expectFailure: argv.includes('--expect-failure') };
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
      else if (entry.isFile()) total += (await stat(path).catch(() => ({ size: 0 }))).size;
    }
  }
  return total;
}

async function waitForTerminal(manager: ArtifactJobManager, jobId: string, guard: PathGuard) {
  for (;;) {
    const job = await manager.getJob(jobId, guard);
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(job.state)) return job;
    await delay(25);
  }
}

async function parseZipCsv(
  bytes: Buffer,
  collectPaths: boolean,
): Promise<{ rows: number; paths: Set<string> }> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(openError ?? new Error('ZIP did not open'));
        return;
      }
      let entries = 0;
      zip.once('error', reject);
      zip.on('entry', (entry) => {
        entries += 1;
        if (entries !== 1) {
          reject(new Error('Snapshot ZIP must contain exactly one CSV entry'));
          zip.close();
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError ?? new Error('CSV entry did not open'));
            return;
          }
          const parser = parse({ bom: false, columns: true, relax_column_count: false });
          let rows = 0;
          const paths = new Set<string>();
          parser.on('readable', () => {
            let record: Record<string, string> | null;
            while ((record = parser.read() as Record<string, string> | null) !== null) {
              assert.deepEqual(Object.keys(record), [
                'RootId',
                'RelativePath',
                'Name',
                'Extension',
                'Length',
                'LastWriteTime',
              ]);
              assert(Number.isSafeInteger(Number(record['Length'])));
              assert(!Number.isNaN(Date.parse(record['LastWriteTime'] ?? '')));
              rows += 1;
              if (collectPaths) paths.add(record['RelativePath'] ?? '');
            }
          });
          parser.once('error', reject);
          parser.once('end', () => resolve({ rows, paths }));
          stream.pipe(parser);
        });
      });
      zip.readEntry();
    });
  });
}

function pipelineRecords(count: number, entropy: Args['entropy']): AsyncIterable<SnapshotRecord> {
  return (async function* () {
    for (let index = 0; index < count; index += 1) {
      const number = String(index).padStart(7, '0');
      const noise =
        entropy === 'high'
          ? createHash('sha256').update(number).digest('hex').slice(0, 28)
          : `project-${String(index % 10_000).padStart(4, '0')}-revision-${String(index % 1_000_000).padStart(6, '0')}`;
      const name = `item-${number}-${noise}.dat`;
      yield {
        rootId: 'root-synthetic-load',
        relativePath: `area-${String(index % 1000).padStart(3, '0')}/${name}`,
        name,
        extension: '.dat',
        length: index % 10_000_000,
        lastWriteTime: `2026-09-${String((index % 28) + 1).padStart(2, '0')}T12:34:56.000Z`,
      };
    }
  })();
}

async function createWalkFixture(root: string, count: number): Promise<Set<string>> {
  const expected = new Set<string>();
  const directories = Math.ceil(count / 200);
  for (let directory = 0; directory < directories; directory += 1) {
    const relativeDirectory = `d-${String(directory).padStart(4, '0')}`;
    const absoluteDirectory = join(root, relativeDirectory);
    await mkdir(absoluteDirectory);
    const writes: Promise<void>[] = [];
    for (let offset = 0; offset < 200 && expected.size < count; offset += 1) {
      const index = expected.size;
      const name = index % 97 === 0 ? `Größe-Антенна-${index}` : `file-${index}.txt`;
      expected.add(`${relativeDirectory}/${name}`);
      writes.push(writeFile(join(absoluteDirectory, name), `${index}\n`, 'utf8'));
    }
    await Promise.all(writes);
  }
  await mkdir(join(root, 'ignored'));
  await writeFile(join(root, '.gitignore'), 'ignored/\n', 'utf8');
  await writeFile(join(root, 'ignored', 'not-in-snapshot.txt'), 'ignored', 'utf8');
  return expected;
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = await mkdtemp(join(tmpdir(), 'fsmcp-snapshot-source-'));
  const scratch = await mkdtemp(join(tmpdir(), 'fsmcp-snapshot-scratch-'));
  const guard = new PathGuard();
  guard.initialize(await resolveAllowedDirectoriesState([root]));
  const fs = new GuardedFileSystem(guard);
  const config = {
    ...getSnapshotConfig(),
    scratchDirectory: scratch,
    ephemeralScratch: false,
    cleanupIntervalMs: 60_000,
  };
  const manager = new ArtifactJobManager(config);
  let expectedPaths: Set<string> | undefined;
  let expectedRows: number;
  if (args.mode === 'walk') {
    expectedPaths = await createWalkFixture(root, args.walkFiles);
    expectedRows = expectedPaths.size;
  } else {
    expectedRows = args.records;
  }

  const baseline = process.memoryUsage();
  let peakRss = baseline.rss;
  let peakHeap = baseline.heapUsed;
  let peakDisk = 0;
  let sampling = false;
  const sample = async () => {
    if (sampling) return;
    sampling = true;
    try {
      const memory = process.memoryUsage();
      peakRss = Math.max(peakRss, memory.rss);
      peakHeap = Math.max(peakHeap, memory.heapUsed);
      peakDisk = Math.max(peakDisk, await directoryBytes(scratch));
    } finally {
      sampling = false;
    }
  };
  const timer = setInterval(() => void sample(), 25);
  const started = performance.now();
  try {
    const submitted = await manager.submit({
      kind: 'snapshot',
      idempotencyKey: `benchmark-${args.mode}-${String(expectedRows)}`,
      fingerprint: fingerprintJobInput(args),
      sourceRoot: root,
      sourceRootId: 'root-synthetic-load',
      input: {
        mode: args.mode,
        records: args.records,
        walkFiles: args.walkFiles,
        entropy: args.entropy,
      },
      run: async (ctx) =>
        args.mode === 'walk'
          ? runSnapshotPipeline(fs, root, { includeHidden: false, includeIgnored: false }, ctx)
          : writeSnapshotFromRecords(pipelineRecords(args.records, args.entropy), ctx, {
              includeHidden: false,
              includeIgnored: false,
            }),
    });
    const job = await waitForTerminal(manager, submitted.job.jobId, guard);
    if (args.expectFailure) {
      assert.equal(job.state, 'failed');
      assert.match(job.stopReason ?? '', /ZIP part|quota|limit/u);
      await sample();
      process.stdout.write(
        `${JSON.stringify(
          {
            mode: args.mode,
            entropy: args.entropy,
            state: job.state,
            stopReason: job.stopReason,
            elapsedMs: Math.round(performance.now() - started),
            peakRssBytes: peakRss,
            peakHeapBytes: peakHeap,
            peakDiskBytes: peakDisk,
            partialArtifacts: job.artifacts.length,
            verifiedBoundedFailure: true,
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    assert.equal(job.state, 'completed', job.stopReason);
    await sample();
    const manifestId = job.manifestArtifactId;
    assert(manifestId);
    const manifestPayload = await manager.getArtifact(manifestId, guard);
    const manifest = JSON.parse(manifestPayload.bytes.toString('utf8')) as {
      counters: { filesWritten: number; rawCsvBytes: number; zipBytes: number; parts: number };
      parts: {
        artifactId: string;
        rows: number;
        rawBytes: number;
        zipBytes: number;
        sha256: string;
      }[];
    };
    let verifiedRows = 0;
    let base64Bytes = 4 * Math.ceil(manifestPayload.bytes.length / 3);
    const observedPaths = new Set<string>();
    for (const part of manifest.parts) {
      const payload = await manager.getArtifact(part.artifactId, guard);
      assert.equal(payload.bytes.length, part.zipBytes);
      assert.equal(createHash('sha256').update(payload.bytes).digest('hex'), part.sha256);
      const parsed = await parseZipCsv(payload.bytes, expectedPaths !== undefined);
      assert.equal(parsed.rows, part.rows);
      verifiedRows += parsed.rows;
      base64Bytes += 4 * Math.ceil(payload.bytes.length / 3);
      for (const path of parsed.paths) observedPaths.add(path);
    }
    assert.equal(verifiedRows, expectedRows);
    assert.equal(manifest.counters.filesWritten, expectedRows);
    if (expectedPaths) assert.deepEqual(observedPaths, expectedPaths);
    const elapsedMs = Math.round(performance.now() - started);
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: args.mode,
          entropy: args.entropy,
          rows: verifiedRows,
          elapsedMs,
          baselineRssBytes: baseline.rss,
          peakRssBytes: peakRss,
          peakHeapBytes: peakHeap,
          peakDiskBytes: peakDisk,
          rawCsvBytes: manifest.counters.rawCsvBytes,
          zipBytes: manifest.counters.zipBytes,
          base64Bytes,
          parts: manifest.counters.parts,
          filesSeen: job.counters.entriesSeen,
          directoriesVisited: job.counters.directoriesVisited,
          ignoredExcluded: job.counters.ignoredExcluded,
          errors: job.counters.errors,
          verified: true,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    clearInterval(timer);
    await manager.close();
    await rm(root, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
}

await run();
