import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { Dir } from 'node:fs';
import { cp, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

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

async function fixture(overrides: Partial<SnapshotConfig> = {}) {
  const root = await realpath(await createTestRoot());
  const scratch = await realpath(await createTestRoot());
  const guard = await makeGuard([root]);
  const config = {
    ...getSnapshotConfig(),
    scratchDirectory: scratch,
    ephemeralScratch: false,
    ...overrides,
  };
  const manager = new ArtifactJobManager(config);
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

async function pairFor(f: Awaited<ReturnType<typeof fixture>>, readOnly: boolean) {
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

describe('experimental snapshot_tree', () => {
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
      [{ maxRecordBytes: 1 }, /root\/header record/u],
      [{ maxRecordBytes: 60 }, /record exceeds/u],
      [{ maxRawPartBytes: 180 }, /context and record/u],
      [{ maxJobRawBytes: 160 }, /raw CSV byte/u],
      [{ maxZipBytes: 100 }, /ZIP part/u],
      [{ maxDeliveryBytes: 100 }, /ZIP part/u],
      [{ maxFileSizeBytes: 100 }, /ZIP part/u],
      [{ maxParts: 1, maxRawPartBytes: 300 }, /part-count/u],
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

  it('shares cancellation/TTL and preserves tree and legacy stable bytes across restart with the flag off', async () => {
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

  it('gates discovery/calls, keeps default budgets and isolates completed/inflight/retry identities in both directions', async (t) => {
    const f = await fixture();
    const previous = process.env['FS_EXPERIMENTAL_SNAPSHOT_TREE'];
    const scratchPrevious = process.env['FS_SNAPSHOT_DIR'];
    try {
      await writeFile(join(f.root, 'probe.txt'), 'synthetic');
      for (const enabled of [false, true]) {
        process.env['FS_EXPERIMENTAL_SNAPSHOT_TREE'] = enabled ? '1' : '0';
        for (const readOnly of [false, true]) {
          const own = await fixture();
          const pair = await pairFor(own, readOnly);
          try {
            const { tools } = await pair.client.listTools();
            assert.equal(tools.length, (readOnly ? 13 : 19) + Number(enabled));
            assert.equal(
              tools.some((t) => t.name === 'snapshot_tree'),
              enabled,
            );
            const size = JSON.stringify(tools).length;
            t.diagnostic(
              `enabled=${enabled} readOnly=${readOnly} tools=${tools.length} chars=${size}`,
            );
            assert(
              size <= (readOnly ? 17_100 : 27_200) + (enabled ? 3400 : 0),
              `toolset size ${size}`,
            );
            if (enabled) {
              const tool = required(tools.find((t) => t.name === 'snapshot_tree'));
              assert.match(tool.description ?? '', /Experimental/u);
              assert.deepEqual(
                tool.inputSchema,
                required(tools.find((t) => t.name === 'snapshot')).inputSchema,
              );
              const response = await pair.client.callTool({
                name: 'snapshot_tree',
                arguments: { path: own.root },
              });
              assert(!response.isError, firstTextBlock(response).text);
            } else
              await assert.rejects(
                pair.client.callTool({ name: 'snapshot_tree', arguments: { path: own.root } }),
              );
          } finally {
            await pair.close();
            await own.close();
          }
        }
      }
      process.env['FS_EXPERIMENTAL_SNAPSHOT_TREE'] = '1';
      for (const order of [
        ['snapshot', 'snapshot_tree'],
        ['snapshot_tree', 'snapshot'],
      ]) {
        // A dedicated scratch per order; hold source open to deterministically test joining.
        const own = await fixture();
        const pair = await pairFor(own, true);
        // eslint-disable-next-line @typescript-eslint/unbound-method -- restored below; invoked with original.call(this).
        const original = GuardedFileSystem.prototype.opendir;
        let release = () => {};
        const gate = new Promise<void>((r) => {
          release = r;
        });
        GuardedFileSystem.prototype.opendir = async function (path, options) {
          if (path === own.root) await gate;
          return original.call(this, path, options);
        };
        const call = async (name: string, args: Record<string, unknown> = {}) => {
          const response = await pair.client.callTool({
            name,
            arguments: { path: own.root, ...args },
          });
          assert(!response.isError, firstTextBlock(response).text);
          return (response.structuredContent ?? response._meta) as {
            reason: string;
            job: { jobId: string; layout?: string };
          };
        };
        const wait = async (id: string) => {
          for (let n = 0; n < 1000; n++) {
            const r = await pair.client.callTool({ name: 'job_status', arguments: { jobId: id } });
            const job = (r.structuredContent ?? r._meta) as { state: string; complete: boolean };
            if (job.state === 'completed') {
              assert(job.complete);
              return;
            }
            assert(['queued', 'running'].includes(job.state), JSON.stringify(job));
            await delay(10);
          }
          assert.fail('tool job timeout');
        };
        try {
          const ids: string[] = [];
          for (const name of order) {
            const first = await call(name, { idempotencyKey: `key-${name}` });
            ids.push(first.job.jobId);
            const joined = await call(name);
            assert.equal(joined.reason, 'inflight_reuse');
            assert.equal(joined.job.jobId, first.job.jobId);
            const other = required(order.find((n) => n !== name));
            const conflict = await pair.client.callTool({
              name: other,
              arguments: { path: own.root, idempotencyKey: `key-${name}` },
            });
            assert.equal(conflict.isError, true);
            assert.match(firstTextBlock(conflict).text ?? '', /different normalized/u);
          }
          assert.notEqual(ids[0], ids[1]);
          release();
          for (const id of ids) await wait(id);
          for (const [i, name] of order.entries()) {
            const reused = await call(name);
            assert.equal(reused.reason, 'completed_reuse');
            assert.equal(reused.job.jobId, ids[i]);
            const forced = await call(name, {
              forceRefresh: true,
              idempotencyKey: `forced-${name}`,
            });
            assert.notEqual(forced.job.jobId, ids[i]);
            assert.equal(
              (await call(name, { forceRefresh: true, idempotencyKey: `forced-${name}` })).reason,
              'idempotent_replay',
            );
            await wait(forced.job.jobId);
          }
          process.env['FS_EXPERIMENTAL_SNAPSHOT_TREE'] = '0';
          const off = await pairFor(own, true);
          try {
            const treeId = required(ids[order.indexOf('snapshot_tree')]);
            const response = await off.client.callTool({
              name: 'job_status',
              arguments: { jobId: treeId },
            });
            assert(!response.isError);
            const status = (response.structuredContent ?? response._meta) as {
              layout: string;
              artifacts: { artifactId: string }[];
            };
            assert.equal(status.layout, 'tree-depth-v1');
            for (const artifact of status.artifacts) {
              const fetched = await off.client.callTool({
                name: 'get_artifact',
                arguments: { artifactId: artifact.artifactId },
              });
              assert(!fetched.isError, firstTextBlock(fetched).text);
              const block = fetched.content.find((b) => b.type === 'resource');
              assert(block?.type === 'resource' && 'blob' in block.resource);
              assert.deepEqual(
                Buffer.from(block.resource.blob, 'base64'),
                (await own.manager.getArtifact(artifact.artifactId, own.guard)).bytes,
              );
            }
            // Existing work remains cancellable when the creation tool is absent.
            const pending = await own.manager.submit({
              kind: 'snapshot',
              idempotencyKey: randomUUID(),
              fingerprint: 'flag-off-cancel',
              sourceRoot: own.root,
              sourceRootId: 'root-test',
              input: { layout: 'tree-depth-v1' },
              run: async (ctx) => {
                await new Promise<void>((r) => {
                  if (ctx.signal.aborted) r();
                  else ctx.signal.addEventListener('abort', () => r(), { once: true });
                });
                ctx.signal.throwIfAborted();
                return '';
              },
            });
            const cancelled = await off.client.callTool({
              name: 'cancel_job',
              arguments: { jobId: pending.job.jobId },
            });
            assert(!cancelled.isError);
            assert.equal(
              ((cancelled.structuredContent ?? cancelled._meta) as { state: string }).state,
              'cancelled',
            );
          } finally {
            await off.close();
            process.env['FS_EXPERIMENTAL_SNAPSHOT_TREE'] = '1';
          }
        } finally {
          release();
          GuardedFileSystem.prototype.opendir = original;
          await pair.close();
          await own.close();
        }
      }
    } finally {
      if (previous === undefined)
        Reflect.deleteProperty(process.env, 'FS_EXPERIMENTAL_SNAPSHOT_TREE');
      else process.env['FS_EXPERIMENTAL_SNAPSHOT_TREE'] = previous;
      if (scratchPrevious === undefined) Reflect.deleteProperty(process.env, 'FS_SNAPSHOT_DIR');
      else process.env['FS_SNAPSHOT_DIR'] = scratchPrevious;
      await f.close();
    }
  });

  it('validates portable opt-in and removes inherited experiment settings', async () => {
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
        const code = `const m = await import(${JSON.stringify(url)}); const c = await m.configuration(); m.serverEnvironment(c); process.stdout.write(process.env.FS_EXPERIMENTAL_SNAPSHOT_TREE);`;
        const run = () =>
          execFileSync(process.execPath, ['--input-type=module', '-e', code], {
            env: { ...process.env, FS_EXPERIMENTAL_SNAPSHOT_TREE: '1' },
            encoding: 'utf8',
            windowsHide: true,
            stdio: 'pipe',
          });
        if (setting === '1') assert.throws(run, /must be a boolean/u);
        else assert.equal(run(), setting === true ? '1' : '0');
      }
    } finally {
      await rm(kit, { recursive: true, force: true });
    }
  });
});
