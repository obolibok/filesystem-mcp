// Each format/profile runs in a fresh process. No production inventories required.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { GuardedFileSystem } from '../../src/core/fs.js';
import { ArtifactJobManager } from '../../src/core/job-manager.js';
import { PathGuard, resolveAllowedDirectoriesState } from '../../src/core/path.js';
import { getSnapshotConfig } from '../../src/core/snapshot-config.js';
import type { SnapshotRecord, SnapshotTreeRecord } from '../../src/core/snapshot-pipeline.js';
import { runSnapshotPipeline, writeSnapshotFromRecords } from '../../src/core/snapshot-pipeline.js';
import { mergeTrees, type VerifiedTree, verifyTreeZip } from './verify-tree.mjs';
import { verifySnapshotZip } from './verify.mjs';

const value = (name: string, fallback: string) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
};
const count = Number(value('--files', '100000'));
const walkCount = Number(value('--walk-files', '1200'));
assert(
  Number.isSafeInteger(count) && count > 0 && Number.isSafeInteger(walkCount) && walkCount > 0,
);
const profile = value('--profile', 'shared');
const mode = value('--mode', 'metadata');
const format = value('--format', 'stable');
const tree = format === 'tree';
const rootId = 'root-synthetic-load';
const stamp = '2026-09-07T12:00:00.000Z';

function* nodes(files: number): Generator<SnapshotTreeRecord> {
  if (profile === 'flat') {
    for (let i = 0; i < 10; i++) yield { type: 'D', depth: 0, name: `empty-${i}` };
    for (let i = 0; i < files; i++)
      yield {
        type: 'F',
        depth: 0,
        name: `${createHash('sha256').update(String(i)).digest('hex').slice(0, 48)}.dat`,
        length: i % 10000,
        lastWriteTime: stamp,
      };
  } else {
    for (let start = 0; start < files; start += 1000) {
      const names = [
        `department-${String(start / 1000).padStart(4, '0')}`,
        'engineering-records',
        'repeatable-project',
        'revision-history',
        'measurements',
      ];
      for (const [depth, name] of names.entries()) yield { type: 'D', depth, name };
      for (let i = start; i < Math.min(start + 1000, files); i++)
        yield {
          type: 'F',
          depth: 5,
          name: `part-${String(i).padStart(7, '0')}.dat`,
          length: i % 10000,
          lastWriteTime: stamp,
        };
      yield { type: 'D', depth: 5, name: 'empty' };
    }
  }
}

async function* metadata(files: number): AsyncGenerator<SnapshotRecord | SnapshotTreeRecord> {
  const stack: string[] = [];
  for (const node of nodes(files)) {
    stack.length = node.depth;
    if (tree) yield node;
    else if (node.type === 'F')
      yield {
        rootId,
        relativePath: [...stack, node.name].join('/'),
        name: node.name,
        extension: extname(node.name),
        length: node.length ?? 0,
        lastWriteTime: node.lastWriteTime ?? stamp,
      };
    if (node.type === 'D') stack.push(node.name);
  }
}

async function worker() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fsmcp-tree-ab-source-')));
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'fsmcp-tree-ab-scratch-')));
  const expectedFiles = mode === 'walk' ? walkCount : count;
  const expected = new Map<string, { type: 'F' | 'D'; length: string; lastWriteTime: string }>();
  const expectedStable = new Set<string>();
  const stack: string[] = [];
  // Build expectations outside the measurement interval; retain them only for
  // the small actual walk, never for the large streaming metadata fixture.
  if (mode === 'walk')
    for (const node of nodes(expectedFiles)) {
      stack.length = node.depth;
      const names = [...stack, node.name];
      const path = join(root, ...names);
      if (node.type === 'D') {
        await mkdir(path);
        stack.push(node.name);
      } else {
        await writeFile(path, Buffer.alloc(node.length ?? 0));
        await utimes(path, new Date(stamp), new Date(stamp));
        expectedStable.add(names.join('/'));
      }
      expected.set(JSON.stringify(names), {
        type: node.type === 'F' ? 'F' : 'D',
        length: node.length === undefined ? '' : String(node.length),
        lastWriteTime: node.lastWriteTime ?? '',
      });
    }
  const guard = new PathGuard();
  guard.initialize(await resolveAllowedDirectoriesState([root]));
  const fs = new GuardedFileSystem(guard);
  const manager = new ArtifactJobManager({
    ...getSnapshotConfig(),
    scratchDirectory: scratch,
    ephemeralScratch: false,
    maxRawPartBytes: 1024 * 1024,
  });
  let peakRss = 0;
  let peakHeap = 0;
  const sample = () => {
    const m = process.memoryUsage();
    peakRss = Math.max(peakRss, m.rss);
    peakHeap = Math.max(peakHeap, m.heapUsed);
  };
  sample();
  const timer = setInterval(sample, 5);
  const start = performance.now();
  let compressionMs = 0;
  let compressStart = 0;
  const options = {
    includeHidden: false,
    includeIgnored: false,
    ...(tree ? { layout: 'tree-depth-v1' as const } : {}),
  };
  try {
    const submitted = await manager.submit({
      kind: 'snapshot',
      idempotencyKey: 'tree-ab-benchmark',
      fingerprint: 'synthetic',
      sourceRoot: root,
      sourceRootId: rootId,
      input: { profile, mode, format },
      run: (ctx) =>
        mode === 'walk'
          ? runSnapshotPipeline(fs, root, options, ctx)
          : writeSnapshotFromRecords(metadata(expectedFiles), ctx, options, {
              beforeCompress: async () => {
                compressStart = performance.now();
                sample();
                await Promise.resolve();
              },
              afterCompress: () => {
                compressionMs += performance.now() - compressStart;
                sample();
              },
            }),
    });
    let job = submitted.job;
    const deadline = Date.now() + 10 * 60_000;
    while (['running', 'queued'].includes(job.state)) {
      assert(Date.now() < deadline);
      await delay(10);
      job = await manager.getJob(job.jobId, guard);
    }
    assert.equal(job.state, 'completed', job.stopReason);
    assert.equal(job.complete, true);
    sample();
    const elapsedMs = performance.now() - start;
    clearInterval(timer);
    const verifiedParts: VerifiedTree[] = [];
    const observedStable = new Set<string>();
    let verifiedFiles = 0;
    for (const artifact of job.artifacts.filter((a) => a.kind === 'snapshot-part')) {
      const { bytes } = await manager.getArtifact(artifact.artifactId, guard);
      if (tree) {
        const part = await verifyTreeZip(bytes, artifact.sha256, mode === 'walk');
        assert.equal(part.rows, artifact.rows);
        assert.equal(part.rawBytes, artifact.rawBytes);
        verifiedFiles += part.files;
        verifiedParts.push(part);
      } else {
        assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
        const part = await verifySnapshotZip(bytes, mode === 'walk');
        verifiedFiles += part.rows;
        for (const path of part.paths) observedStable.add(path);
      }
    }
    assert.equal(verifiedFiles, expectedFiles);
    if (mode === 'walk') {
      if (tree) assert.deepEqual(mergeTrees(verifiedParts), expected);
      else assert.deepEqual(observedStable, expectedStable);
    }
    process.stdout.write(
      JSON.stringify({
        mode,
        profile,
        format,
        files: job.counters.filesWritten,
        directories: job.counters.directoriesWritten ?? 0,
        context: job.counters.contextRecords ?? 0,
        rawBytes: job.counters.rawCsvBytes,
        zipBytes: job.counters.zipBytes,
        parts: job.counters.parts,
        elapsedMs: Math.round(elapsedMs),
        serializationSpoolMs: mode === 'metadata' ? Math.round(elapsedMs - compressionMs) : null,
        compressionMs: mode === 'metadata' ? Math.round(compressionMs) : null,
        peakRssBytes: peakRss,
        peakHeapBytes: peakHeap,
        verified: true,
      }) + '\n',
    );
  } finally {
    clearInterval(timer);
    await manager.close();
    await rm(root, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv.includes('--worker')) await worker();
else {
  for (const mode of ['metadata', 'walk'])
    for (const profile of ['shared', 'flat'])
      for (const format of ['stable', 'tree']) {
        process.stdout.write(
          execFileSync(
            process.execPath,
            [
              '--import',
              'tsx',
              fileURLToPath(import.meta.url),
              '--worker',
              '--mode',
              mode,
              '--profile',
              profile,
              '--format',
              format,
              '--files',
              String(count),
              '--walk-files',
              String(walkCount),
            ],
            { encoding: 'utf8', windowsHide: true, timeout: 15 * 60_000, maxBuffer: 1024 * 1024 },
          ),
        );
      }
}
