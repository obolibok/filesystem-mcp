import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { Dir } from 'node:fs';
import {
  cp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

import { parse } from 'csv-parse/sync';

import {
  mergeTrees,
  type VerifiedTree,
  verifyTreeZip,
} from '../scripts/snapshot-benchmark/verify-tree.mjs';
import { verifySnapshotZip } from '../scripts/snapshot-benchmark/verify.mjs';
import { ErrorCode, FsError } from '../src/core/errors.js';
import { GuardedFileSystem } from '../src/core/fs.js';
import { ArtifactJobManager, fingerprintJobInput } from '../src/core/job-manager.js';
import type { StoredJob } from '../src/core/job-types.js';
import { getSnapshotConfig, type SnapshotConfig } from '../src/core/snapshot-config.js';
import {
  runSnapshotPipeline,
  type SnapshotTreeRecord,
  writeSnapshotFromRecords,
} from '../src/core/snapshot-pipeline.js';
import { createServer } from '../src/server.js';
import { JobStatusOutputSchema, jobStatusValue } from '../src/tools/job-shared.js';
import { createTestRoot, firstTextBlock, makeGuard } from './helpers.js';

const treeOptions = {
  includeHidden: false,
  includeIgnored: false,
  layout: 'tree-depth-v1',
} as const;
const timestamp = '2026-09-07T12:00:00.000Z';
const key = (...names: string[]) => JSON.stringify(names);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function required<T>(value: T | undefined): T {
  assert(value !== undefined);
  return value;
}

async function terminal(
  manager: ArtifactJobManager,
  id: string,
  guard: Awaited<ReturnType<typeof makeGuard>>,
) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const job = await manager.getJob(id, guard);
    if (!['queued', 'running'].includes(job.state)) return job;
    assert(Date.now() < deadline, 'job timeout');
    await delay(10);
  }
}

async function fixture(
  overrides: Partial<SnapshotConfig> = {},
  deps: ConstructorParameters<typeof ArtifactJobManager>[1] = {},
) {
  const root = await realpath(await createTestRoot());
  const scratch = await realpath(await createTestRoot());
  const guard = await makeGuard([root]);
  const config = {
    ...getSnapshotConfig(),
    scratchDirectory: scratch,
    ephemeralScratch: false,
    ...overrides,
  };
  const manager = new ArtifactJobManager(config, deps);
  return {
    root,
    scratch,
    guard,
    manager,
    config,
    close: async () => {
      await manager.close();
      await rm(root, { recursive: true, force: true });
      await rm(scratch, { recursive: true, force: true });
    },
  };
}

async function submit(
  f: Awaited<ReturnType<typeof fixture>>,
  run: Parameters<ArtifactJobManager['submit']>[0]['run'],
  tree = true,
) {
  const result = await f.manager.submit({
    kind: 'snapshot',
    idempotencyKey: randomUUID(),
    fingerprint: fingerprintJobInput(randomUUID()),
    sourceRoot: f.root,
    sourceRootId: 'root-test',
    input: tree ? { layout: 'tree-depth-v1' } : {},
    run,
  });
  return terminal(f.manager, result.job.jobId, f.guard);
}

async function readTree(
  f: Awaited<ReturnType<typeof fixture>>,
  job: StoredJob,
): Promise<VerifiedTree[]> {
  assert.equal(job.state, 'completed', job.stopReason);
  const manifestArtifact = required(job.artifacts.find((a) => a.kind === 'manifest'));
  const manifestBytes = (await f.manager.getArtifact(manifestArtifact.artifactId, f.guard)).bytes;
  assert.equal(sha(manifestBytes), manifestArtifact.sha256);
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
    schema: string;
    version: number;
    layout: string;
    complete: boolean;
    counters: StoredJob['counters'];
    parts: {
      artifactId: string;
      sha256: string;
      rows: number;
      rawBytes: number;
      zipBytes: number;
      files: number;
      directories: number;
      contextRecords: number;
      errorRecords: number;
    }[];
  };
  assert.equal(manifest.schema, 'filesystem-mcp.snapshot-tree-manifest');
  assert.equal(manifest.version, 1);
  assert.equal(manifest.layout, 'tree-depth-v1');
  assert.equal(manifest.complete, job.complete);
  assert.deepEqual(manifest.counters, job.counters);
  assert.equal(
    manifest.parts.length,
    job.artifacts.filter((a) => a.kind === 'snapshot-part').length,
  );
  const parts: VerifiedTree[] = [];
  for (const artifact of job.artifacts.filter((a) => a.kind === 'snapshot-part')) {
    const { bytes } = await f.manager.getArtifact(artifact.artifactId, f.guard);
    const declared = required(manifest.parts.find((p) => p.artifactId === artifact.artifactId));
    assert.equal(declared.sha256, artifact.sha256);
    assert.equal(declared.zipBytes, bytes.length);
    const part = await verifyTreeZip(bytes, declared.sha256);
    assert.equal(part.root, f.root);
    assert.equal(part.rows, artifact.rows);
    assert.equal(part.rawBytes, artifact.rawBytes);
    assert.equal(part.rows, declared.rows);
    assert.equal(part.rawBytes, declared.rawBytes);
    for (const name of ['files', 'directories', 'contextRecords', 'errorRecords'] as const) {
      assert.equal(part[name], artifact[name]);
      assert.equal(part[name], declared[name]);
    }
    parts.push(part);
  }
  assert.equal(
    parts.reduce((n, p) => n + p.files, 0),
    job.counters.filesWritten,
  );
  return parts;
}

async function* records(nodes: readonly SnapshotTreeRecord[]) {
  yield* nodes;
}

async function pairFor(
  f: Awaited<ReturnType<typeof fixture>>,
  readOnly: boolean,
  format = f.manager.config.snapshotFormat,
) {
  Object.assign(f.manager.config, { snapshotFormat: format });
  const server = await createServer(
    { cliAllowedDirs: [f.root], readOnly },
    { jobManager: f.manager },
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'tree-test', version: '1' }, { capabilities: {} });
  await Promise.all([client.connect(a), server.mcp.connect(b)]);
  return {
    client,
    close: async () => {
      await client.close();
      server.disposeRuntimeState();
      await server.mcp.close();
      await f.manager.close();
    },
  };
}

async function pairsFor(f: Awaited<ReturnType<typeof fixture>>) {
  const stable = await pairFor(f, true, 'stable');
  const tree = await pairFor(f, true, 'tree');
  return {
    stable,
    tree,
    close: async () => {
      await stable.close();
      await tree.close();
    },
  };
}

describe('snapshot tree-depth-v1', () => {
  it('publishes closed-ZIP failure only after partial cleanup and preserves cancellation during cleanup', async () => {
    for (const cancel of [false, true]) {
      let release = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let entered = () => {};
      const deleting = new Promise<void>((r) => {
        entered = r;
      });
      const f = await fixture(
        { maxZipBytes: 100 },
        {
          unlinkFile: async (path) => {
            if (path.endsWith('.partial')) {
              entered();
              await gate;
            }
            await unlink(path);
          },
        },
      );
      try {
        const pending = await f.manager.submit({
          kind: 'snapshot',
          idempotencyKey: randomUUID(),
          fingerprint: randomUUID(),
          sourceRoot: f.root,
          sourceRootId: 'root-test',
          input: { layout: 'tree-depth-v1' },
          run: (ctx) => writeSnapshotFromRecords(records([]), ctx, treeOptions),
        });
        await deleting;
        const duringCleanup = await f.manager.getJob(pending.job.jobId, f.guard);
        assert.equal(duringCleanup.state, 'running');
        assert(
          (await readdir(f.manager.jobDirectory(pending.job.jobId))).some((name) =>
            name.endsWith('.partial'),
          ),
        );
        if (cancel) await f.manager.cancel(pending.job.jobId, f.guard);
        release();
        const done = await terminal(f.manager, pending.job.jobId, f.guard);
        assert.equal(done.state, cancel ? 'cancelled' : 'failed');
        assert.equal(done.fatalError?.code, cancel ? undefined : 'TOO_LARGE');
        // Cancellation has its existing immediate status; close awaits its worker.
        if (cancel) await f.manager.close();
        assert(
          (await readdir(f.manager.jobDirectory(done.jobId))).every(
            (name) => !name.endsWith('.partial'),
          ),
        );
      } finally {
        release();
        await f.close();
      }
    }
  });

  it('uses independent raw caps and accounts for every tree service byte without changing stable ZIP bytes', async () => {
    const f = await fixture({ maxRawPartBytes: 1200, maxTreeRawPartBytes: 330, maxRunningJobs: 2 });
    const nodes: SnapshotTreeRecord[] = [
      { type: 'D', depth: 0, name: 'ancestor' },
      { type: 'U', depth: 1, name: 'unreadable' },
      ...Array.from({ length: 30 }, (_, i): SnapshotTreeRecord => ({
        type: 'F',
        depth: 1,
        name: `file-${i}.dat`,
        length: i,
        lastWriteTime: timestamp,
      })),
    ];
    const stableOptions = { includeHidden: false, includeIgnored: false };
    const stableRun: Parameters<typeof submit>[1] = (ctx) =>
      writeSnapshotFromRecords(
        (async function* () {
          for (const node of nodes.filter((n) => n.type === 'F'))
            yield {
              rootId: 'root-test',
              relativePath: `ancestor/${node.name}`,
              name: node.name,
              extension: '.dat',
              length: node.length ?? 0,
              lastWriteTime: timestamp,
            };
        })(),
        ctx,
        stableOptions,
      );
    try {
      const [stable, tree] = await Promise.all([
        submit(f, stableRun, false),
        submit(f, (ctx) => writeSnapshotFromRecords(records(nodes), ctx, treeOptions)),
      ]);
      assert.equal(stable.state, 'completed', stable.stopReason);
      const parts = await readTree(f, tree);
      assert(parts.length > 1);
      assert(parts.every((p) => p.rawBytes <= 330));
      assert((tree.counters.contextRecords ?? 0) > 0);
      assert.equal(tree.counters.errorRecords, 1);
      assert.equal(
        parts.reduce((n, p) => n + p.rawBytes, 0),
        tree.counters.rawCsvBytes,
      );
      assert(stable.artifacts.some((a) => a.kind === 'snapshot-part' && (a.rawBytes ?? 0) > 330));
      for (const [job, cap] of [
        [stable, 1200],
        [tree, 330],
      ] as const) {
        const manifest = JSON.parse(
          (await f.manager.getArtifact(required(job.manifestArtifactId), f.guard)).bytes.toString(),
        ) as { policy: Record<string, number> };
        assert.equal(manifest.policy['maxRawPartBytes'], cap);
        for (const name of [
          'maxZipBytes',
          'maxDeliveryBytes',
          'maxFileSizeBytes',
          'maxJobRawBytes',
          'maxJobArtifactBytes',
          'maxParts',
        ] as const)
          assert.equal(manifest.policy[name], f.config[name]);
        assert(
          job.artifacts
            .filter((a) => a.kind === 'snapshot-part')
            .every((a) => (a.rawBytes ?? 0) <= cap),
        );
      }
      const hashes = stable.artifacts
        .filter((a) => a.kind === 'snapshot-part')
        .map((a) => a.sha256);
      const original = f.manager.snapshotConfigFingerprint();
      // Probe identity changes on the captured config without two owners of one scratch.
      Object.assign(f.config, { maxTreeRawPartBytes: 500 });
      assert.equal(f.manager.snapshotConfigFingerprint(), original);
      const stableAgain = await submit(f, stableRun, false);
      assert.deepEqual(
        stableAgain.artifacts.filter((a) => a.kind === 'snapshot-part').map((a) => a.sha256),
        hashes,
      );
      assert.deepEqual(stableAgain.counters, stable.counters);
    } finally {
      await f.close();
    }
  });

  it('keeps the shared closed-ZIP ceiling on noisy records while a smaller tree cap succeeds', async () => {
    const f = await fixture({
      maxRawPartBytes: 512 * 1024,
      maxTreeRawPartBytes: 512 * 1024,
      maxZipBytes: 128 * 1024,
      maxDeliveryBytes: 64 * 1024,
    });
    const nodes = Array.from({ length: 1800 }, (_, i): SnapshotTreeRecord => ({
      type: 'F',
      depth: 0,
      name: createHash('sha512').update(String(i)).digest('hex'),
      length: i,
      lastWriteTime: timestamp,
    }));
    try {
      const large = await submit(f, (ctx) =>
        writeSnapshotFromRecords(records(nodes), ctx, treeOptions),
      );
      assert.equal(large.state, 'failed');
      assert.equal(large.fatalError?.code, 'TOO_LARGE');
      assert.match(large.stopReason ?? '', /Closed ZIP.*65536/u);
      assert.deepEqual(large.artifacts, []);
      assert(
        (await readdir(f.manager.jobDirectory(large.jobId))).every(
          (name) => !name.endsWith('.partial'),
        ),
      );
      Object.assign(f.config, { maxTreeRawPartBytes: 64 * 1024 });
      const small = await submit(f, (ctx) =>
        writeSnapshotFromRecords(records(nodes), ctx, treeOptions),
      );
      const parts = await readTree(f, small);
      assert(parts.length > 1);
      assert.equal(small.counters.filesWritten, nodes.length);
      assert.equal(mergeTrees(parts).size, nodes.length);
      for (const artifact of small.artifacts.filter((a) => a.kind === 'snapshot-part')) {
        assert((artifact.rawBytes ?? 0) <= 64 * 1024);
        assert(artifact.size <= 64 * 1024);
      }
      assert.equal(f.config.maxRawPartBytes, 512 * 1024);
      assert.equal(f.config.maxZipBytes, 128 * 1024);
      assert.equal(f.config.maxDeliveryBytes, 64 * 1024);
    } finally {
      await f.close();
    }
  });

  it('separates tree cap reuse while preserving stable completed/inflight/retry and restart/format-switch access', async () => {
    const f = await fixture({ maxRawPartBytes: 1200, maxRunningJobs: 2 });
    let pair = await pairsFor(f);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- restored below; original is called with this.
    const original = GuardedFileSystem.prototype.opendir;
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    GuardedFileSystem.prototype.opendir = async function (path, options) {
      if (path === f.root) await gate;
      return original.call(this, path, options);
    };
    const call = async (name: 'tree' | 'stable', args: Record<string, unknown> = {}) => {
      const response = await pair[name].client.callTool({
        name: 'snapshot',
        arguments: { path: f.root, ...args },
      });
      assert(!response.isError, firstTextBlock(response).text);
      return (response.structuredContent ?? response._meta) as {
        reason: string;
        job: { jobId: string };
      };
    };
    try {
      await writeFile(join(f.root, 'probe.txt'), 'synthetic');
      const legacyFingerprint = fingerprintJobInput({
        version: 1,
        scratchDirectory: f.scratch,
        maxRecordBytes: f.config.maxRecordBytes,
        maxRawPartBytes: f.config.maxRawPartBytes,
        maxZipBytes: f.config.maxZipBytes,
        maxDeliveryBytes: f.config.maxDeliveryBytes,
        maxFileSizeBytes: f.config.maxFileSizeBytes,
        maxJobRawBytes: f.config.maxJobRawBytes,
        maxJobArtifactBytes: f.config.maxJobArtifactBytes,
        maxParts: f.config.maxParts,
        maxWalkDepth: f.config.maxWalkDepth,
      });
      assert.equal(f.manager.snapshotConfigFingerprint(), legacyFingerprint);
      assert.equal(f.manager.snapshotConfigFingerprint(true), legacyFingerprint);
      const stable = await call('stable', { idempotencyKey: 'stable-settings-key' });
      const tree = await call('tree', { idempotencyKey: 'tree-settings-key' });
      // No producer has passed the gate: compare in-flight identity at different effective caps.
      Object.assign(f.config, { maxTreeRawPartBytes: 1200 });
      assert.equal((await call('tree')).job.jobId, tree.job.jobId);
      Object.assign(f.config, { maxTreeRawPartBytes: 330 });
      assert.equal((await call('stable')).reason, 'inflight_reuse');
      assert.equal((await call('stable')).job.jobId, stable.job.jobId);
      assert.equal(
        (await call('stable', { idempotencyKey: 'stable-settings-key' })).reason,
        'idempotent_replay',
      );
      const changed = await call('tree');
      assert.equal(changed.reason, 'created');
      assert.notEqual(changed.job.jobId, tree.job.jobId);
      assert.equal((await call('tree')).job.jobId, changed.job.jobId);
      const denied = await pair.tree.client.callTool({
        name: 'snapshot',
        arguments: { path: f.root, idempotencyKey: 'tree-settings-key' },
      });
      assert(denied.isError);
      assert.match(firstTextBlock(denied).text ?? '', /reuse policy has changed/u);
      await f.manager.cancel(changed.job.jobId, f.guard);
      // Restore the legacy effective cap before allowing those producers to execute.
      Reflect.deleteProperty(f.config, 'maxTreeRawPartBytes');
      assert.equal((await call('tree')).job.jobId, tree.job.jobId);
      release();
      const stableDone = await terminal(f.manager, stable.job.jobId, f.guard);
      const treeDone = await terminal(f.manager, tree.job.jobId, f.guard);
      assert.equal(stableDone.state, 'completed');
      assert.equal(treeDone.state, 'completed');
      const stableBytes = await Promise.all(
        stableDone.artifacts.map(async (a) => ({
          a,
          bytes: (await f.manager.getArtifact(a.artifactId, f.guard)).bytes,
        })),
      );
      await pair.close();
      const restarted = new ArtifactJobManager({ ...f.config, maxTreeRawPartBytes: 330 });
      pair = await pairsFor({ ...f, manager: restarted });
      assert.equal((await call('stable')).reason, 'completed_reuse');
      assert.equal((await call('stable')).job.jobId, stable.job.jobId);
      assert.equal(
        (await call('stable', { idempotencyKey: 'stable-settings-key' })).reason,
        'idempotent_replay',
      );
      for (const { a, bytes } of stableBytes)
        assert.deepEqual((await restarted.getArtifact(a.artifactId, f.guard)).bytes, bytes);
      await assert.rejects(restarted.getJob(tree.job.jobId, f.guard), /reuse policy has changed/u);
      await assert.rejects(
        restarted.getArtifact(required(treeDone.manifestArtifactId), f.guard),
        /reuse policy has changed/u,
      );
      const fresh = await call('tree');
      assert.notEqual(fresh.job.jobId, tree.job.jobId);
      const freshDone = await terminal(restarted, fresh.job.jobId, f.guard);
      assert.equal((await call('tree')).job.jobId, fresh.job.jobId);
      await pair.close();
      const off = new ArtifactJobManager({ ...f.config, maxTreeRawPartBytes: 330 });
      pair = await pairsFor({ ...f, manager: off });
      assert.equal((await pair.stable.client.listTools()).tools.length, 13);
      for (const job of [stableDone, freshDone]) {
        const status = await pair.stable.client.callTool({
          name: 'job_status',
          arguments: { jobId: job.jobId },
        });
        assert(!status.isError, firstTextBlock(status).text);
        for (const artifact of job.artifacts) {
          const response = await pair.stable.client.callTool({
            name: 'get_artifact',
            arguments: { artifactId: artifact.artifactId },
          });
          assert(!response.isError, firstTextBlock(response).text);
        }
      }
    } finally {
      release();
      GuardedFileSystem.prototype.opendir = original;
      await pair.close();
      await f.close();
    }
  });

  it('walks the selected subdir losslessly and keeps stable files/policy unchanged', async () => {
    const f = await fixture({ maxRawPartBytes: 330 });
    const base = join(f.root, 'chosen,大小');
    await mkdir(base);
    const files = [
      'root.txt',
      'noextension',
      'a.dir/same.txt',
      'a.dir/deep/Größe,Антенна.txt',
      'z/same.txt',
    ];
    const dirs = ['a.dir', 'a.dir/deep', 'a.dir/empty', 'Empty', 'z'];
    for (const name of dirs) await mkdir(join(base, name), { recursive: true });
    for (const name of files) await writeFile(join(base, name), 'synthetic');
    await writeFile(join(base, '.gitignore'), 'ignored/\n');
    await mkdir(join(base, 'ignored'));
    await writeFile(join(base, 'ignored', 'excluded'), 'excluded');
    await mkdir(join(base, '.hidden'));
    await writeFile(join(base, '.hidden', 'excluded'), 'excluded');
    await mkdir(join(base, 'dist'));
    // Junctions do not need Windows file-symlink privilege.
    await symlink(
      join(base, 'z'),
      join(base, 'link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const nestedScratch = join(base, 'scratch');
    const nestedConfig = { ...f.config, scratchDirectory: nestedScratch };
    const manager = new ArtifactJobManager(nestedConfig);
    const local = { ...f, root: base, manager };
    try {
      const fs = new GuardedFileSystem(f.guard);
      const tree = await submit(local, (ctx) => runSnapshotPipeline(fs, base, treeOptions, ctx));
      const parts = await readTree(local, tree);
      assert(parts.length > 1);
      const nodes = mergeTrees(parts);
      assert.deepEqual(
        [...nodes]
          .filter(([, n]) => n.type === 'D')
          .map(([p]) => p)
          .sort(),
        dirs.map((p) => key(...p.split('/'))).sort(),
      );
      assert.deepEqual(
        [...nodes]
          .filter(([, n]) => n.type === 'F')
          .map(([p]) => p)
          .sort(),
        files.map((p) => key(...p.split('/'))).sort(),
      );
      assert.equal(tree.counters.directoriesWritten, dirs.length);
      assert.equal(tree.counters.symlinksSkipped, 1);
      assert.equal(tree.counters.scratchExcluded, 1);
      assert.equal(tree.complete, true);
      const stable = await submit(
        local,
        (ctx) =>
          runSnapshotPipeline(fs, base, { includeHidden: false, includeIgnored: false }, ctx),
        false,
      );
      const observed = new Set<string>();
      for (const part of stable.artifacts.filter((a) => a.kind === 'snapshot-part')) {
        const { bytes } = await manager.getArtifact(part.artifactId, f.guard);
        const verified = await verifySnapshotZip(bytes, true);
        for (const path of verified.paths) observed.add(path);
      }
      assert.deepEqual([...observed].sort(), files.sort());
      assert.equal(stable.counters.directoriesWritten, undefined);
      for (const counter of [
        'filesWritten',
        'directoriesVisited',
        'entriesSeen',
        'hiddenExcluded',
        'ignoredExcluded',
        'symlinksSkipped',
        'scratchExcluded',
      ] as const)
        assert.equal(tree.counters[counter], stable.counters[counter], counter);
      const manifest = JSON.parse(
        (await manager.getArtifact(required(tree.manifestArtifactId), f.guard)).bytes.toString(),
      ) as { schema: string; layout: string; root: { path: string }; parts: { rows: number }[] };
      assert.equal(manifest.schema, 'filesystem-mcp.snapshot-tree-manifest');
      assert.equal(manifest.layout, 'tree-depth-v1');
      assert.equal(manifest.root.path, base);
    } finally {
      await manager.close();
      await f.close();
    }
  });

  it('reconstructs each multipart independently with exact CSV basenames, upward transitions and empty dirs', async () => {
    const f = await fixture({ maxRawPartBytes: 310 });
    const nodes: SnapshotTreeRecord[] = [
      { type: 'D', depth: 0, name: 'shared,"\r\n大小' },
      { type: 'D', depth: 1, name: 'deep.目录' },
      // Force >4 parts even with the shortest sourceRoot record on Linux.
      ...Array.from({ length: 28 }, (_, i): SnapshotTreeRecord => ({
        type: 'F',
        depth: 2,
        name: `file,"${i}\n.dat`,
        length: i,
        lastWriteTime: timestamp,
      })),
      { type: 'D', depth: 2, name: 'empty' },
      { type: 'D', depth: 0, name: 'other' },
      { type: 'F', depth: 1, name: 'file,"0\n.dat', length: 0, lastWriteTime: timestamp },
      { type: 'D', depth: 0, name: 'last-empty' },
    ];
    try {
      const job = await submit(f, (ctx) =>
        writeSnapshotFromRecords(records(nodes), ctx, treeOptions),
      );
      const parts = await readTree(f, job);
      const merged = mergeTrees(parts);
      assert(parts.length > 4);
      assert.equal(merged.size, nodes.length);
      const stack: string[] = [];
      for (const node of nodes) {
        stack.length = node.depth;
        assert.deepEqual(merged.get(key(...stack, node.name)), {
          type: node.type,
          length: node.length === undefined ? '' : String(node.length),
          lastWriteTime: node.lastWriteTime ?? '',
        });
        if (node.type === 'D') stack.push(node.name);
      }
      assert.equal(job.counters.filesWritten, 29);
      assert.equal(job.counters.directoriesWritten, 5);
      assert.equal(
        parts.reduce((n, p) => n + p.rawBytes, 0),
        job.counters.rawCsvBytes,
      );
      assert.equal(
        parts.reduce((n, p) => n + p.contextRecords, 0),
        job.counters.contextRecords,
      );
      // The verifier must reject a plausible SHA but corrupt CRC (central directory).
      const artifact = required(job.artifacts.find((a) => a.kind === 'snapshot-part'));
      const { bytes } = await f.manager.getArtifact(artifact.artifactId, f.guard);
      const corrupt = Buffer.from(bytes);
      const central = corrupt.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      assert(central >= 0);
      corrupt.writeUInt32LE((corrupt.readUInt32LE(central + 16) ^ 1) >>> 0, central + 16);
      await assert.rejects(verifyTreeZip(corrupt, sha(corrupt)), /CRC-32/u);
      await assert.rejects(verifyTreeZip(bytes, '0'.repeat(64)), /SHA-256/u);
    } finally {
      await f.close();
    }
  });

  it('writes the actual root as one RFC4180 record, including UNC and newline spellings', async () => {
    const f = await fixture();
    try {
      for (const sourceRoot of [
        '\\\\synthetic-host\\share\\chosen,"sub',
        '/synthetic/base,"\r\n大小',
      ]) {
        let restored = () => {};
        const finished = new Promise<void>((r) => {
          restored = r;
        });
        const submitted = await f.manager.submit({
          kind: 'snapshot',
          idempotencyKey: randomUUID(),
          fingerprint: randomUUID(),
          sourceRoot: f.root,
          sourceRootId: 'root-test',
          input: { layout: 'tree-depth-v1' },
          run: async (ctx) => {
            // Encoder-only fixture: never access these synthetic paths.
            Object.defineProperty(ctx.job, 'sourceRoot', { value: sourceRoot });
            try {
              return await writeSnapshotFromRecords(records([]), ctx, treeOptions);
            } finally {
              Object.defineProperty(ctx.job, 'sourceRoot', { value: f.root });
              restored();
            }
          },
        });
        await finished;
        const job = await terminal(f.manager, submitted.job.jobId, f.guard);
        const artifact = required(job.artifacts.find((a) => a.kind === 'snapshot-part'));
        const raw = await readFile(join(f.scratch, job.jobId, artifact.fileName));
        const part = await verifyTreeZip(raw, artifact.sha256);
        assert.equal(part.root, sourceRoot);
        assert.equal(part.rows, 2);
      }
    } finally {
      await f.close();
    }
  });

  it('marks unreadable/partially read children with U and continues siblings; root and policy faults stay fatal', async () => {
    for (const fault of ['open', 'iteration', 'ignore', 'root', 'policy'] as const) {
      const f = await fixture();
      const child = join(f.root, 'a-child');
      await mkdir(child);
      await writeFile(join(child, 'first.txt'), 'synthetic');
      await writeFile(join(child, 'second.txt'), 'synthetic');
      await writeFile(join(f.root, 'later.txt'), 'synthetic');
      const native = (code: string) => Object.assign(new Error('Synthetic fault'), { code });
      class FaultFs extends GuardedFileSystem {
        override async opendir(
          path: string,
          options?: { signal?: AbortSignal },
        ): ReturnType<GuardedFileSystem['opendir']> {
          if ((path === child && fault === 'open') || (path === f.root && fault === 'root'))
            throw native('EACCES');
          if (path === child && fault === 'policy')
            throw new FsError(ErrorCode.ACCESS_DENIED, 'Synthetic containment failure');
          const opened = await super.opendir(path, options);
          if (path !== child || fault !== 'iteration') return opened;
          let calls = 0;
          return {
            ...opened,
            directory: {
              read: async () => {
                if (++calls === 2) throw native('EBUSY');
                return opened.directory.read();
              },
              close: () => opened.directory.close(),
            } as unknown as Dir,
          };
        }
        override async readEditableText(
          path: string,
          options?: { signal?: AbortSignal; tool?: string },
        ): ReturnType<GuardedFileSystem['readEditableText']> {
          if (path === join(child, '.gitignore') && fault === 'ignore') throw native('EACCES');
          return super.readEditableText(path, options);
        }
      }
      try {
        const job = await submit(f, (ctx) =>
          runSnapshotPipeline(new FaultFs(f.guard), f.root, treeOptions, ctx),
        );
        if (fault === 'root' || fault === 'policy') {
          assert.equal(job.state, 'failed');
          assert.deepEqual(job.artifacts, []);
        } else {
          const parts = await readTree(f, job);
          const merged = mergeTrees(parts);
          assert.equal(job.complete, false);
          assert.equal(job.counters.errors, 1);
          assert.equal(job.counters.errorRecords, 1);
          assert.equal(merged.get(key('a-child'))?.type, 'D');
          assert.equal(merged.get(key('later.txt'))?.type, 'F');
          assert(parts.some((p) => p.servicePaths.has(key('a-child'))));
        }
      } finally {
        await f.close();
      }
    }
  });

  it('fails boundedly for impossible root/context/record/raw/ZIP/part/quota budgets and cleans partials', async () => {
    const nodes: SnapshotTreeRecord[] = [
      { type: 'D', depth: 0, name: 'ancestor'.repeat(5) },
      { type: 'D', depth: 1, name: 'second'.repeat(6) },
      ...Array.from({ length: 30 }, (_, i): SnapshotTreeRecord => ({
        type: 'F',
        depth: 2,
        name: `${i}-${'x'.repeat(18)}`,
        length: i,
        lastWriteTime: timestamp,
      })),
    ];
    for (const [overrides, pattern] of [
      [{ maxRawPartBytes: 1 }, /root\/header/u],
      [{ maxRawPartBytes: 99999, maxTreeRawPartBytes: 1 }, /root\/header/u],
      [{ maxRecordBytes: 1 }, /root\/header record/u],
      [{ maxRecordBytes: 60 }, /record exceeds/u],
      [{ maxRawPartBytes: 180 }, /context and record/u],
      [{ maxRawPartBytes: 99999, maxTreeRawPartBytes: 180 }, /context and record/u],
      [{ maxJobRawBytes: 160 }, /raw CSV byte/u],
      [{ maxZipBytes: 100 }, /ZIP part/u],
      [{ maxDeliveryBytes: 100 }, /ZIP part/u],
      [{ maxFileSizeBytes: 100 }, /ZIP part/u],
      [{ maxParts: 1, maxRawPartBytes: 300 }, /part-count/u],
      [{ maxParts: 1, maxRawPartBytes: 99999, maxTreeRawPartBytes: 300 }, /part-count/u],
      [{ scratchQuotaBytes: 2000 }, /quota/u],
      [{ maxJobArtifactBytes: 100 }, /artifact-byte/u],
    ] as const) {
      const f = await fixture(overrides);
      try {
        const job = await submit(f, (ctx) =>
          writeSnapshotFromRecords(
            records(
              'maxRecordBytes' in overrides && overrides.maxRecordBytes === 60
                ? [
                    ...nodes,
                    {
                      type: 'F',
                      depth: 0,
                      name: 'oversized'.repeat(30),
                      length: 1,
                      lastWriteTime: timestamp,
                    },
                  ]
                : nodes,
            ),
            ctx,
            treeOptions,
          ),
        );
        assert.equal(job.state, 'failed', JSON.stringify(overrides));
        assert.match(job.stopReason ?? '', pattern);
        assert.deepEqual(job.artifacts, []);
        await f.manager.close();
        assert.deepEqual(await readdir(join(f.scratch, job.jobId)), ['job.json']);
      } finally {
        await f.close();
      }
    }
  });

  it('shares cancellation/TTL and preserves tree and legacy stable bytes across restart in either creation format', async () => {
    const f = await fixture({ resultTtlMs: 100_000 });
    try {
      await writeFile(join(f.root, 'probe.txt'), 'synthetic');
      const fs = new GuardedFileSystem(f.guard);
      const tree = await submit(f, (ctx) => runSnapshotPipeline(fs, f.root, treeOptions, ctx));
      const stable = await submit(
        f,
        (ctx) =>
          runSnapshotPipeline(fs, f.root, { includeHidden: false, includeIgnored: false }, ctx),
        false,
      );
      const all = await Promise.all(
        [...tree.artifacts, ...stable.artifacts].map(async (a) => ({
          a,
          bytes: (await f.manager.getArtifact(a.artifactId, f.guard)).bytes,
        })),
      );
      await f.manager.close();
      const restarted = new ArtifactJobManager(f.config);
      try {
        const restored = await restarted.getJob(tree.jobId, f.guard);
        assert.equal(JobStatusOutputSchema.parse(jobStatusValue(restored)).layout, 'tree-depth-v1');
        assert.equal((await restarted.getJob(stable.jobId, f.guard)).input['layout'], undefined);
        for (const { a, bytes } of all)
          assert.deepEqual((await restarted.getArtifact(a.artifactId, f.guard)).bytes, bytes);
        const future = Date.now() + 200_000;
        const expiredManager = new ArtifactJobManager(f.config, { now: () => future });
        await restarted.close();
        try {
          assert.equal((await expiredManager.getJob(tree.jobId, f.guard)).resultExpired, true);
          await assert.rejects(
            expiredManager.getArtifact(required(tree.artifacts[0]).artifactId, f.guard),
          );
        } finally {
          await expiredManager.close();
        }
      } finally {
        await restarted.close();
      }
    } finally {
      await f.close();
    }

    const c = await fixture();
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let entered = () => {};
    const ready = new Promise<void>((r) => {
      entered = r;
    });
    try {
      const submission = await c.manager.submit({
        kind: 'snapshot',
        idempotencyKey: randomUUID(),
        fingerprint: 'cancel-tree',
        sourceRoot: c.root,
        sourceRootId: 'root-test',
        input: { layout: 'tree-depth-v1' },
        run: (ctx) =>
          writeSnapshotFromRecords(
            records([{ type: 'F', depth: 0, name: 'a', length: 1, lastWriteTime: timestamp }]),
            ctx,
            treeOptions,
            {
              beforeCompress: async () => {
                entered();
                await gate;
              },
            },
          ),
      });
      await ready;
      await c.manager.cancel(submission.job.jobId, c.guard);
      release();
      const cancelled = await terminal(c.manager, submission.job.jobId, c.guard);
      assert.equal(cancelled.state, 'cancelled');
      assert.deepEqual(cancelled.artifacts, []);
    } finally {
      release();
      await c.close();
    }
  });

  it('publishes one snapshot in both modes within discovery budgets, ignoring the retired flag', async (t) => {
    const previous = process.env['FS_EXPERIMENTAL_SNAPSHOT_TREE'];
    try {
      for (const format of ['tree', 'stable'] as const) {
        for (const flag of ['0', '1']) {
          process.env['FS_EXPERIMENTAL_SNAPSHOT_TREE'] = flag;
          for (const readOnly of [false, true]) {
            const f = await fixture({ snapshotFormat: format });
            const pair = await pairFor(f, readOnly);
            try {
              const { tools } = await pair.client.listTools();
              assert.equal(tools.length, readOnly ? 13 : 19);
              assert.equal(tools.filter((tool) => tool.name === 'snapshot').length, 1);
              assert(!tools.some((tool) => tool.name === 'snapshot_tree'));
              const size = JSON.stringify(tools).length;
              t.diagnostic(format + ' readOnly=' + String(readOnly) + ' chars=' + String(size));
              assert(size <= (readOnly ? 17_100 : 27_200));
              const tool = required(tools.find((tool) => tool.name === 'snapshot'));
              assert.match(
                tool.description ?? '',
                format === 'tree' ? /tree-depth-v1 manifest/u : /stable manifest/u,
              );
              await assert.rejects(
                pair.client.callTool({ name: 'snapshot_tree', arguments: { path: f.root } }),
              );
              const response = await pair.client.callTool({
                name: 'snapshot',
                arguments: { path: f.root },
              });
              assert(!response.isError, firstTextBlock(response).text);
              const { job } = (response.structuredContent ?? response._meta) as {
                job: { jobId: string };
              };
              const done = await terminal(f.manager, job.jobId, f.guard);
              const manifest = JSON.parse(
                (
                  await f.manager.getArtifact(required(done.manifestArtifactId), f.guard)
                ).bytes.toString(),
              ) as { schema: string };
              assert.equal(
                manifest.schema,
                format === 'tree'
                  ? 'filesystem-mcp.snapshot-tree-manifest'
                  : 'filesystem-mcp.snapshot-manifest',
              );
            } finally {
              await pair.close();
              await f.close();
            }
          }
        }
      }
    } finally {
      if (previous === undefined)
        Reflect.deleteProperty(process.env, 'FS_EXPERIMENTAL_SNAPSHOT_TREE');
      else process.env['FS_EXPERIMENTAL_SNAPSHOT_TREE'] = previous;
    }
  });

  it('isolates completed/inflight/retry/forced identities in both directions and restores both formats after restart', async () => {
    for (const order of [
      ['stable', 'tree'],
      ['tree', 'stable'],
    ] as const) {
      const f = await fixture({ maxRunningJobs: 2 });
      let pairs = await pairsFor(f);
      // eslint-disable-next-line @typescript-eslint/unbound-method -- restored below.
      const original = GuardedFileSystem.prototype.opendir;
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      GuardedFileSystem.prototype.opendir = async function (path, options) {
        if (path === f.root) await gate;
        return original.call(this, path, options);
      };
      const call = async (format: 'tree' | 'stable', args: Record<string, unknown> = {}) => {
        const r = await pairs[format].client.callTool({
          name: 'snapshot',
          arguments: { path: f.root, ...args },
        });
        assert(!r.isError, firstTextBlock(r).text);
        return (r.structuredContent ?? r._meta) as { reason: string; job: { jobId: string } };
      };
      try {
        await writeFile(join(f.root, 'probe.txt'), 'synthetic');
        const saved: StoredJob[] = [];
        const ids: string[] = [];
        for (const format of order) {
          const first = await call(format, { idempotencyKey: 'key-' + format });
          ids.push(first.job.jobId);
          const joined = await call(format);
          assert.equal(joined.reason, 'inflight_reuse');
          assert.equal(joined.job.jobId, first.job.jobId);
          const conflict = await pairs[format === 'tree' ? 'stable' : 'tree'].client.callTool({
            name: 'snapshot',
            arguments: { path: f.root, idempotencyKey: 'key-' + format },
          });
          assert(conflict.isError);
          assert.match(firstTextBlock(conflict).text ?? '', /different normalized/u);
        }
        assert.notEqual(ids[0], ids[1]);
        release();
        for (const id of ids) saved.push(await terminal(f.manager, id, f.guard));
        for (const [i, format] of order.entries()) {
          const reused = await call(format);
          assert.equal(reused.reason, 'completed_reuse');
          assert.equal(reused.job.jobId, ids[i]);
          const forced = await call(format, {
            forceRefresh: true,
            idempotencyKey: 'forced-' + format,
          });
          assert.notEqual(forced.job.jobId, ids[i]);
          assert.equal(
            (await call(format, { forceRefresh: true, idempotencyKey: 'forced-' + format })).reason,
            'idempotent_replay',
          );
          saved.push(await terminal(f.manager, forced.job.jobId, f.guard));
        }
        const savedBytes = new Map<string, Buffer>();
        for (const job of saved)
          for (const a of job.artifacts)
            savedBytes.set(
              a.artifactId,
              (await f.manager.getArtifact(a.artifactId, f.guard)).bytes,
            );
        await pairs.close();
        const manager = new ArtifactJobManager(f.config);
        pairs = await pairsFor({ ...f, manager });
        for (const mode of order) {
          // A creation mode cannot restrict access to previously saved work.
          for (const job of saved) {
            const client = pairs[mode].client;
            const status = await client.callTool({
              name: 'job_status',
              arguments: { jobId: job.jobId },
            });
            assert(!status.isError, firstTextBlock(status).text);
            const cancelled = await client.callTool({
              name: 'cancel_job',
              arguments: { jobId: job.jobId },
            });
            assert(!cancelled.isError);
            for (const artifact of job.artifacts) {
              const fetched = await client.callTool({
                name: 'get_artifact',
                arguments: { artifactId: artifact.artifactId },
              });
              assert(!fetched.isError, firstTextBlock(fetched).text);
              const block = fetched.content.find((b) => b.type === 'resource');
              assert(block?.type === 'resource' && 'blob' in block.resource);
              assert.deepEqual(
                Buffer.from(block.resource.blob, 'base64'),
                savedBytes.get(artifact.artifactId),
              );
            }
          }
          assert.equal(
            (await call(mode, { idempotencyKey: 'key-' + mode })).job.jobId,
            ids[order.indexOf(mode)],
          );
          assert.equal((await call(mode)).reason, 'completed_reuse');
          const pending = await call(mode, { forceRefresh: true });
          const cancelled = await pairs[mode === 'tree' ? 'stable' : 'tree'].client.callTool({
            name: 'cancel_job',
            arguments: { jobId: pending.job.jobId },
          });
          assert(!cancelled.isError);
        }
      } finally {
        release();
        GuardedFileSystem.prototype.opendir = original;
        await pairs.close();
        await f.close();
      }
    }
  });

  it('keeps authorization and expiry for both saved layouts after restart in either creation mode', async () => {
    const f = await fixture({ resultTtlMs: 100_000 });
    try {
      await writeFile(join(f.root, 'probe.txt'), 'synthetic');
      const child = join(f.root, 'narrow');
      await mkdir(child);
      const jobs: StoredJob[] = [];
      for (const tree of [false, true])
        jobs.push(
          await submit(
            f,
            (ctx) =>
              runSnapshotPipeline(
                new GuardedFileSystem(f.guard),
                f.root,
                {
                  includeHidden: false,
                  includeIgnored: false,
                  ...(tree ? { layout: 'tree-depth-v1' as const } : {}),
                },
                ctx,
              ),
            tree,
          ),
        );
      await f.manager.close();
      for (const snapshotFormat of ['tree', 'stable'] as const) {
        const manager = new ArtifactJobManager({ ...f.config, snapshotFormat });
        const denied = await pairFor({ ...f, root: child, manager }, true);
        try {
          for (const job of jobs)
            for (const [name, args] of [
              ['job_status', { jobId: job.jobId }],
              ['cancel_job', { jobId: job.jobId }],
              ['get_artifact', { artifactId: required(job.manifestArtifactId) }],
            ] as const) {
              const response = await denied.client.callTool({ name, arguments: args });
              assert(response.isError, name + ' must reauthorize the original source');
            }
        } finally {
          await denied.close();
        }
      }
      const future = Date.now() + 200_000;
      for (const snapshotFormat of ['tree', 'stable'] as const) {
        const manager = new ArtifactJobManager(
          { ...f.config, snapshotFormat },
          { now: () => future },
        );
        const expired = await pairFor({ ...f, manager }, true);
        try {
          for (const job of jobs) {
            const status = await expired.client.callTool({
              name: 'job_status',
              arguments: { jobId: job.jobId },
            });
            assert(!status.isError);
            assert.equal(
              ((status.structuredContent ?? status._meta) as { resultExpired: boolean })
                .resultExpired,
              true,
            );
            const fetched = await expired.client.callTool({
              name: 'get_artifact',
              arguments: { artifactId: required(job.manifestArtifactId) },
            });
            assert(fetched.isError, 'Format switch must not revive expired bytes');
            const cancelled = await expired.client.callTool({
              name: 'cancel_job',
              arguments: { jobId: job.jobId },
            });
            assert(!cancelled.isError);
            assert.equal(
              ((cancelled.structuredContent ?? cancelled._meta) as { resultExpired: boolean })
                .resultExpired,
              true,
            );
          }
        } finally {
          await expired.close();
        }
      }
    } finally {
      await f.close();
    }
  });

  it('reuses a persisted 014/015 snapshot_tree identity through canonical snapshot after upgrade', async () => {
    const f = await fixture();
    let pair: Awaited<ReturnType<typeof pairFor>> | undefined;
    let manager = f.manager;
    try {
      await writeFile(join(f.root, 'legacy.txt'), 'synthetic');
      await manager.initialize();
      // Frozen pre-016 input shape: snapshot_tree used kind snapshot plus layout,
      // without the public tool name or any creation-format setting in identity.
      const sourceRoot = await f.guard.validateExistingDirectory(f.root);
      const normalized = {
        kind: 'snapshot',
        sourceRoot,
        includeHidden: false,
        includeIgnored: false,
        layout: 'tree-depth-v1',
      };
      const policyFingerprint = await f.guard.snapshotPolicyFingerprint();
      const configFingerprint = manager.snapshotConfigFingerprint(true);
      const old = await manager.submit({
        kind: 'snapshot',
        idempotencyKey: 'pre-016-tree-key',
        fingerprint: fingerprintJobInput(normalized),
        sourceRoot: f.root,
        sourceRootId: 'root-legacy',
        input: { includeHidden: false, includeIgnored: false, layout: 'tree-depth-v1' },
        reuseGuard: f.guard,
        automaticReuse: {
          fingerprint: fingerprintJobInput({
            version: 2,
            ...normalized,
            policyFingerprint,
            configFingerprint,
          }),
          policyFingerprint,
          configFingerprint,
          requestFingerprint: fingerprintJobInput({
            ...normalized,
            maxAgeMs: 3600000,
            forceRefresh: false,
          }),
          maxAgeMs: 3600000,
          forceRefresh: false,
        },
        run: (ctx) =>
          runSnapshotPipeline(new GuardedFileSystem(f.guard), sourceRoot, treeOptions, ctx),
      });
      const done = await terminal(manager, old.job.jobId, f.guard);
      const bytes = (await manager.getArtifact(required(done.manifestArtifactId), f.guard)).bytes;
      await manager.close();
      manager = new ArtifactJobManager(f.config);
      pair = await pairFor({ ...f, manager }, true, 'tree');
      for (const args of [{}, { idempotencyKey: 'pre-016-tree-key' }]) {
        const response = await pair.client.callTool({
          name: 'snapshot',
          arguments: { path: f.root, ...args },
        });
        assert(!response.isError, firstTextBlock(response).text);
        const result = (response.structuredContent ?? response._meta) as {
          reason: string;
          job: { jobId: string };
        };
        assert.equal(
          result.reason,
          'idempotencyKey' in args ? 'idempotent_replay' : 'completed_reuse',
        );
        assert.equal(result.job.jobId, old.job.jobId);
      }
      assert.deepEqual(
        (await manager.getArtifact(required(done.manifestArtifactId), f.guard)).bytes,
        bytes,
      );
    } finally {
      await pair?.close();
      await manager.close();
      await f.close();
    }
  });

  it('independently compares exact stable/tree file metadata with quoted CR/LF names and multipart C/U/empty directories', async () => {
    const f = await fixture({ maxRawPartBytes: 330 });
    const parent = 'parent,"\r\n大小';
    const files = Array.from({ length: 20 }, (_, i) => ({
      name: 'file,"' + String(i) + '\r\n.txt',
      length: i,
      lastWriteTime: timestamp,
    }));
    const expected = new Map(
      files.map((file) => [parent + '/' + file.name, [String(file.length), file.lastWriteTime]]),
    );
    try {
      const tree = await submit(f, (ctx) =>
        writeSnapshotFromRecords(
          records([
            { type: 'D', depth: 0, name: parent },
            ...files.map((file) => ({ ...file, type: 'F' as const, depth: 1 })),
            { type: 'D', depth: 1, name: 'empty' },
            { type: 'U', depth: 0, name: parent },
          ]),
          ctx,
          treeOptions,
        ),
      );
      const treeParts = await readTree(f, tree);
      assert(treeParts.length > 1);
      assert(treeParts.some((part) => part.contextRecords > 0));
      assert(treeParts.some((part) => part.errorRecords > 0));
      const treeFiles = new Map(
        [...mergeTrees(treeParts)]
          .filter(([, node]) => node.type === 'F')
          .map(([path, node]) => [
            (JSON.parse(path) as string[]).join('/'),
            [node.length, node.lastWriteTime],
          ]),
      );
      assert.deepEqual(treeFiles, expected);
      const stable = await submit(
        f,
        (ctx) =>
          writeSnapshotFromRecords(
            (async function* () {
              for (const file of files)
                yield {
                  rootId: 'root-test',
                  relativePath: parent + '/' + file.name,
                  name: file.name,
                  extension: '.txt',
                  length: file.length,
                  lastWriteTime: file.lastWriteTime,
                };
            })(),
            ctx,
            { includeHidden: false, includeIgnored: false },
          ),
        false,
      );
      const observed = new Map<string, string[]>();
      for (const artifact of stable.artifacts.filter((a) => a.kind === 'snapshot-part')) {
        const { bytes } = await f.manager.getArtifact(artifact.artifactId, f.guard);
        await verifySnapshotZip(bytes, true); // Independent CRC and strict CSV validation.
        const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
        const central = bytes.readUInt32LE(end + 16);
        const local = bytes.readUInt32LE(central + 42);
        const offset = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
        const compressed = bytes.subarray(offset, offset + bytes.readUInt32LE(central + 20));
        const csv =
          bytes.readUInt16LE(central + 10) === 8
            ? inflateRawSync(compressed, { maxOutputLength: 1048576 })
            : compressed;
        for (const row of parse<{
          RelativePath: string;
          Length: string;
          LastWriteTime: string;
        }>(csv, { columns: true })) {
          assert(!observed.has(row.RelativePath));
          observed.set(row.RelativePath, [row.Length, row.LastWriteTime]);
        }
      }
      assert.deepEqual(observed, expected);
      assert.deepEqual(observed, treeFiles);
    } finally {
      await f.close();
    }
  });

  it('defaults runtime creation to tree and rejects invalid format before server startup', async () => {
    const previous = process.env['FS_SNAPSHOT_FORMAT'];
    try {
      Reflect.deleteProperty(process.env, 'FS_SNAPSHOT_FORMAT');
      assert.equal(getSnapshotConfig().snapshotFormat, 'tree');
      for (const setting of ['tree', 'stable', '', 'TREE', 'csv', 'false']) {
        process.env['FS_SNAPSHOT_FORMAT'] = setting;
        if (setting === 'tree' || setting === 'stable')
          assert.equal(getSnapshotConfig().snapshotFormat, setting);
        else {
          assert.throws(() => getSnapshotConfig(), /FS_SNAPSHOT_FORMAT must be tree or stable/u);
          await assert.rejects(createServer(), /FS_SNAPSHOT_FORMAT must be tree or stable/u);
        }
      }
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, 'FS_SNAPSHOT_FORMAT');
      else process.env['FS_SNAPSHOT_FORMAT'] = previous;
    }
  });

  it('validates portable tree caps before launch and removes inherited experiment settings', async () => {
    const kit = await createTestRoot();
    try {
      await cp(resolve('scripts/windows-portable/template'), kit, { recursive: true });
      const configPath = join(kit, 'config.json');
      const initial = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
      const url = pathToFileURL(join(kit, 'scripts/config.mjs')).href;
      for (const setting of [undefined, false, true, '1']) {
        await writeFile(
          configPath,
          JSON.stringify({ ...initial, experimentalSnapshotTree: setting }),
        );
        const code = `const m = await import(${JSON.stringify(url)}); const c = await m.configuration(); m.serverEnvironment(c); process.stdout.write(process.env.FS_SNAPSHOT_FORMAT);`;
        const run = () =>
          execFileSync(process.execPath, ['--input-type=module', '-e', code], {
            env: { ...process.env, FS_EXPERIMENTAL_SNAPSHOT_TREE: '1' },
            encoding: 'utf8',
            windowsHide: true,
            stdio: 'pipe',
          });
        if (setting === '1') assert.throws(run, /must be a boolean/u);
        else assert.equal(run(), 'tree');
      }
      for (const setting of [
        undefined,
        'tree',
        'stable',
        '',
        'TREE',
        'csv',
        null,
        false,
        1,
        {},
        [],
      ]) {
        await writeFile(
          configPath,
          JSON.stringify({ ...initial, snapshotFormat: setting, experimentalSnapshotTree: false }),
        );
        const code = `const m = await import(${JSON.stringify(url)}); const c = await m.configuration(); m.serverEnvironment(c); process.stdout.write(process.env.FS_SNAPSHOT_FORMAT);`;
        const run = () =>
          execFileSync(process.execPath, ['--input-type=module', '-e', code], {
            env: {
              ...process.env,
              FS_SNAPSHOT_FORMAT: 'stable',
              FS_EXPERIMENTAL_SNAPSHOT_TREE: '1',
            },
            encoding: 'utf8',
            windowsHide: true,
            stdio: 'pipe',
          });
        if (setting === undefined || setting === 'tree' || setting === 'stable')
          assert.equal(run(), setting ?? 'tree');
        else assert.throws(run, /snapshotFormat must be tree or stable/u);
      }
      const limits = initial['limits'] as Record<string, number>;
      for (const cap of [
        undefined,
        65536,
        16777216,
        536870912,
        65535,
        536870913,
        1.5,
        '16777216',
        null,
        true,
        {},
        [],
      ]) {
        await writeFile(
          configPath,
          JSON.stringify({
            ...initial,
            experimentalSnapshotTree: false,
            limits: { ...limits, FS_SNAPSHOT_TREE_MAX_RAW_PART_BYTES: cap },
          }),
        );
        const code = `
          const m = await import(${JSON.stringify(url)});
          const before = { ...process.env };
          try {
            const c = await m.configuration();
            m.serverEnvironment(c);
            process.stdout.write(JSON.stringify({
              tree: process.env.FS_SNAPSHOT_TREE_MAX_RAW_PART_BYTES,
              stable: process.env.FS_SNAPSHOT_MAX_RAW_PART_BYTES,
              format: process.env.FS_SNAPSHOT_FORMAT,
              retired: process.env.FS_EXPERIMENTAL_SNAPSHOT_TREE,
              inherited: process.env.FS_SNAPSHOT_TREE_MAX_ZIP_BYTES,
            }));
          } catch (error) {
            if (JSON.stringify(before) !== JSON.stringify(process.env)) throw new Error('Invalid config changed environment');
            throw error;
          }
        `;
        const run = () =>
          execFileSync(process.execPath, ['--input-type=module', '-e', code], {
            env: {
              ...process.env,
              FS_EXPERIMENTAL_SNAPSHOT_TREE: '1',
              FS_SNAPSHOT_MAX_RAW_PART_BYTES: '99999',
              FS_SNAPSHOT_TREE_MAX_RAW_PART_BYTES: '88888',
              FS_SNAPSHOT_TREE_MAX_ZIP_BYTES: '77777',
            },
            encoding: 'utf8',
            windowsHide: true,
            stdio: 'pipe',
          });
        if (
          cap === undefined ||
          (typeof cap === 'number' && Number.isInteger(cap) && cap >= 65536 && cap <= 536870912)
        ) {
          assert.deepEqual(JSON.parse(run()), {
            ...(cap === undefined ? {} : { tree: String(cap) }),
            stable: String(limits['FS_SNAPSHOT_MAX_RAW_PART_BYTES']),
            format: 'tree',
          });
        } else assert.throws(run, /out-of-range limit: FS_SNAPSHOT_TREE_MAX_RAW_PART_BYTES/u);
      }
    } finally {
      await rm(kit, { recursive: true, force: true });
    }
  });

  it('captures optional runtime tree caps with the common range and fallback without enabling discovery', () => {
    const before = { ...process.env };
    try {
      process.env['FS_SNAPSHOT_MAX_RAW_PART_BYTES'] = '131072';
      process.env['FS_EXPERIMENTAL_SNAPSHOT_TREE'] = '0';
      for (const cap of [
        undefined,
        '65536',
        '16777216',
        '536870912',
        '65535',
        '536870913',
        '1.5',
        'bad',
      ]) {
        if (cap === undefined)
          Reflect.deleteProperty(process.env, 'FS_SNAPSHOT_TREE_MAX_RAW_PART_BYTES');
        else process.env['FS_SNAPSHOT_TREE_MAX_RAW_PART_BYTES'] = cap;
        const config = getSnapshotConfig();
        assert.equal(config.maxRawPartBytes, 131072);
        assert.equal(
          config.maxTreeRawPartBytes ?? config.maxRawPartBytes,
          cap !== undefined && ['65536', '16777216', '536870912'].includes(cap)
            ? Number(cap)
            : 131072,
        );
        assert.equal(process.env['FS_EXPERIMENTAL_SNAPSHOT_TREE'], '0');
      }
    } finally {
      process.env = before;
    }
  });
});
