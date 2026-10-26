import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { ArtifactJobManager } from '../src/core/job-manager.js';
import type { JobCounters, StoredJob } from '../src/core/job-types.js';
import { normalizePath } from '../src/core/path-utils.js';
import { getSnapshotConfig } from '../src/core/snapshot-config.js';
import type { SourceProvenance } from '../src/core/source-provenance.js';
import { sourceProvenance, SourceProvenanceProvider } from '../src/core/source-provenance.js';
import { createServer } from '../src/server.js';
import { cleanupTestRoot, createTestRoot, makeGuard } from './helpers.js';

const MACHINE_ID = '12345678-1234-5678-9ABC-123456789ABC';
const VOLUME = { label: 'Daten Größe Антенна', serialNumber: 'ABCD-0123' };

interface ToolData {
  roots: string[];
  hint?: string;
  host: SourceProvenance['host'];
  rootDetails: SourceProvenance['root'][];
  job: { jobId: string };
  reused: boolean;
  reason?: string;
}

function data(result: CallToolResult): ToolData {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return (result.structuredContent ?? result._meta) as ToolData;
}

function bytes(result: CallToolResult): Buffer {
  const block = result.content.find((item) => item.type === 'resource');
  assert(block?.type === 'resource' && 'blob' in block.resource);
  return Buffer.from(block.resource.blob, 'base64');
}

it('queries exact local, nested, same-volume, mapped and UNC roots without inventing IDs', async () => {
  const paths = [
    'C:\\',
    'C:\\Größe Антенна\\two',
    'C:\\other',
    'Z:\\source',
    "\\\\server\\share\\a ' $name ` b",
  ];
  const queried: string[] = [];
  const provider = new SourceProvenanceProvider({
    platform: 'win32',
    hostname: () => 'synthetic-host',
    queryWindows: async (kind, path) => {
      if (kind === 'machine') return MACHINE_ID.toLowerCase();
      assert(path);
      queried.push(path);
      return path.startsWith('\\\\') ? { label: null, serialNumber: '1234abcd' } : VOLUME;
    },
  });
  const result = await provider.describeRoots(paths);
  assert.deepEqual(result.host, { name: 'synthetic-host', machineId: MACHINE_ID });
  assert.deepEqual(queried, paths);
  assert.deepEqual(
    result.rootDetails.map((root) => root.path),
    paths,
  );
  assert.deepEqual(
    result.rootDetails.slice(0, 4).map((root) => root.volume),
    paths.slice(0, 4).map(() => VOLUME),
  );
  assert.deepEqual(result.rootDetails[4]?.volume, { label: null, serialNumber: '1234-ABCD' });
});

it('rejects empty, zero, sentinel and malformed UUIDs while retaining independent fields', async () => {
  for (const value of [
    undefined,
    null,
    '',
    '  ',
    '00000000-0000-0000-0000-000000000000',
    'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF',
    'not-a-uuid',
    {},
  ]) {
    const provider = new SourceProvenanceProvider({
      platform: 'win32',
      hostname: () => {
        throw new Error('hostname unavailable');
      },
      queryWindows: async (kind) =>
        kind === 'machine' ? value : { label: VOLUME.label, serialNumber: 'not-a-serial' },
    });
    const result = await provider.capture('C:\\source');
    assert.deepEqual(result.host, { name: null, machineId: null });
    assert.deepEqual(result.root.volume, { label: VOLUME.label, serialNumber: null });
  }
  const provider = new SourceProvenanceProvider({
    platform: 'win32',
    hostname: () => 'synthetic-host',
    queryWindows: async (kind) =>
      kind === 'machine' ? MACHINE_ID : { label: '', serialNumber: '00000000' },
  });
  assert.deepEqual((await provider.capture('C:\\')).root.volume, {
    label: null,
    serialNumber: '0000-0000',
  });
  const partial = new SourceProvenanceProvider({
    platform: 'win32',
    hostname: () => {
      throw new Error('hostname unavailable');
    },
    queryWindows: async (kind) =>
      kind === 'machine' ? MACHINE_ID : { label: '  Label  ', serialNumber: 'A-BCD0123' },
  });
  assert.deepEqual(await partial.capture('C:\\'), {
    host: { name: null, machineId: MACHINE_ID },
    root: { path: 'C:\\', volume: { label: '  Label  ', serialNumber: null } },
  });
});

it(
  'bounds hanging lookups, isolates unavailable roots and retries missing metadata',
  { timeout: 5_000 },
  async () => {
    let recovered = false;
    const signals: AbortSignal[] = [];
    const provider = new SourceProvenanceProvider({
      platform: 'win32',
      hostname: () => 'synthetic-host',
      timeoutMs: 30,
      queryWindows: async (kind, path, signal) => {
        if (recovered) return kind === 'machine' ? MACHINE_ID : VOLUME;
        if (path === 'healthy') return { label: VOLUME.label, serialNumber: null };
        if (path === 'denied') throw new Error('synthetic access denied');
        signals.push(signal);
        return new Promise(() => {});
      },
    });
    const result = await provider.describeRoots(['healthy', 'denied', '\\\\offline\\share']);
    assert.equal(result.host.machineId, null);
    assert.deepEqual(
      result.rootDetails.map((root) => root.volume),
      [
        { label: VOLUME.label, serialNumber: null },
        { label: null, serialNumber: null },
        { label: null, serialNumber: null },
      ],
    );
    assert.equal(signals.length, 2);
    assert(signals.every((signal) => signal.aborted));
    recovered = true;
    const next = await provider.describeRoots(['healthy', 'denied', '\\\\offline\\share']);
    assert.equal(next.host.machineId, MACHINE_ID);
    assert(next.rootDetails.every((root) => root.volume.serialNumber === VOLUME.serialNumber));
  },
);

it('keeps hostname and null metadata on other operating systems without probing Windows', async () => {
  for (const platform of ['linux', 'darwin'] as const) {
    const provider = new SourceProvenanceProvider({
      platform,
      hostname: () => 'synthetic-host',
      queryWindows: async () => {
        assert.fail('Windows query on another platform');
      },
    });
    assert.deepEqual(await provider.capture('/source'), {
      host: { name: 'synthetic-host', machineId: null },
      root: { path: '/source', volume: { label: null, serialNumber: null } },
    });
  }
});

it(
  'Windows native helper handles subdirectories, Unicode, spaces and PowerShell metacharacters',
  { skip: process.platform !== 'win32', timeout: 15_000 },
  async (t) => {
    const root = await createTestRoot();
    const nested = join(root, "Größe Антенна ' $name ` space");
    await mkdir(nested);
    try {
      const provider = new SourceProvenanceProvider();
      const result = await provider.describeRoots([root, nested]);
      assert(result.host.name === hostname(), 'Native hostname differs from the MCP host');
      assert.deepEqual(
        result.rootDetails.map((item) => item.path),
        [root, nested],
      );
      const first = result.rootDetails[0]?.volume;
      const second = result.rootDetails[1]?.volume;
      assert(first && second);
      // Either native lookup may independently time out on a busy runner.
      if (first.serialNumber !== null && second.serialNumber !== null)
        assert(first.serialNumber === second.serialNumber, 'Subdirectory volume differs');
      if (first.label !== null && second.label !== null)
        assert(first.label === second.label, 'Subdirectory label differs');
      if (first.serialNumber !== null)
        assert(/^[0-9A-F]{4}-[0-9A-F]{4}$/u.test(first.serialNumber));
      // Do not emit actual machine names, UUIDs, labels or serials in test evidence.
      const powershell = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
        { encoding: 'utf8', windowsHide: true, timeout: 3_000 },
      ).trim();
      t.diagnostic(
        JSON.stringify({
          powershell,
          hostnamePresent: result.host.name !== null,
          uuidPresent: result.host.machineId !== null,
          labelPresent: first.label !== null,
          serialPresent: first.serialNumber !== null,
          nestedSerialPresent: second.serialNumber !== null,
        }),
      );
    } finally {
      await cleanupTestRoot(root);
    }
  },
);

it('list_roots preserves roots/hint, publishes metadata and tolerates provider failures', async (t) => {
  const provider = new SourceProvenanceProvider({
    platform: 'win32',
    hostname: () => 'synthetic-host',
    queryWindows: async (kind) => (kind === 'machine' ? MACHINE_ID : VOLUME),
  });
  t.mock.method(sourceProvenance, 'describeRoots', provider.describeRoots.bind(provider));
  const root = await createTestRoot();
  const scratch = await createTestRoot();
  const config = { ...getSnapshotConfig(), scratchDirectory: scratch, ephemeralScratch: false };
  await mkdir(join(root, 'nested'));
  try {
    for (const roots of [[root, join(root, 'nested')], []]) {
      const pair = await openPair(new ArtifactJobManager(config), roots);
      try {
        const result = data(await pair.client.callTool({ name: 'list_roots' }));
        assert.deepEqual(result.roots, [...pair.guard.getAllowedDirectories()]);
        assert.deepEqual(
          result.rootDetails,
          result.roots.map((path: string) => ({ path, volume: VOLUME })),
        );
        assert.deepEqual(result.host, { name: 'synthetic-host', machineId: MACHINE_ID });
        if (roots.length === 0) assert.match(result.hint ?? '', /FS_ALLOWED_DIRS/u);
        else assert.equal(result.hint, undefined);
      } finally {
        await pair.close();
      }
    }
    const unavailable = new SourceProvenanceProvider({
      platform: 'win32',
      hostname: () => 'synthetic-host',
      timeoutMs: 20,
      queryWindows: async () => new Promise(() => {}),
    });
    t.mock.method(sourceProvenance, 'describeRoots', unavailable.describeRoots.bind(unavailable));
    const pair = await openPair(new ArtifactJobManager(config), root);
    try {
      const result = data(await pair.client.callTool({ name: 'list_roots' }));
      assert.equal(result.host.machineId, null);
      assert(
        result.rootDetails.every(
          (item: SourceProvenance['root']) => item.volume.serialNumber === null,
        ),
      );
    } finally {
      await pair.close();
    }
  } finally {
    await cleanupTestRoot(root);
    await cleanupTestRoot(scratch);
  }
});

async function openPair(manager: ArtifactJobManager, roots: string | string[]) {
  const guard = await makeGuard(typeof roots === 'string' ? [roots] : roots);
  const server = await createServer({ readOnly: true }, { pathGuard: guard, jobManager: manager });
  const client = new Client({ name: 'provenance-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.mcp.connect(serverTransport)]);
  return {
    client,
    guard,
    close: async () => {
      await client.close();
      server.disposeRuntimeState();
      await server.mcp.close();
      await manager.close();
    },
  };
}

async function terminal(
  manager: ArtifactJobManager,
  jobId: string,
  guard: Awaited<ReturnType<typeof makeGuard>>,
) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const job = await manager.getJob<JobCounters>(jobId, guard);
    if (job.state === 'completed' || job.state === 'failed') {
      assert.equal(job.state, 'completed', job.stopReason);
      return job;
    }
    assert(Date.now() < deadline, 'Job did not complete');
    await delay(10);
  }
}

for (const kind of ['snapshot', 'bundle'] as const) {
  it(`${kind} freezes provenance before traversal, preserves it on reuse/restart and reads legacy manifests`, async (t) => {
    const root = await createTestRoot();
    const scratch = await createTestRoot();
    const nested = join(root, 'Größe Антенна');
    await mkdir(nested);
    await writeFile(join(nested, 'original.txt'), 'synthetic original\n');
    const sourceRoot = normalizePath(await realpath(nested));
    let current = { name: 'original-host', machineId: MACHINE_ID, volume: VOLUME };
    let lookups = 0;
    const provider = new SourceProvenanceProvider({
      platform: 'win32',
      hostname: () => current.name,
      queryWindows: async (query) => {
        lookups += 1;
        return query === 'machine' ? current.machineId : current.volume;
      },
    });
    const capture = sourceProvenance.capture.bind(sourceProvenance);
    let release = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let captured: SourceProvenance | undefined;
    t.mock.method(sourceProvenance, 'describeRoots', provider.describeRoots.bind(provider));
    t.mock.method(sourceProvenance, 'capture', async (path: string) => {
      const value = await capture(path);
      captured = value;
      await barrier;
      return value;
    });
    const config = { ...getSnapshotConfig(), scratchDirectory: scratch, ephemeralScratch: false };
    let manager = new ArtifactJobManager(config);
    let pair = await openPair(manager, root);
    const args = {
      path: nested,
      idempotencyKey: `provenance-${kind}`,
      ...(kind === 'bundle' ? { files: [{ relativePath: 'original.txt' }] } : {}),
    };
    try {
      const submitted = data(await pair.client.callTool({ name: kind, arguments: args }));
      const jobId = submitted.job.jobId;
      const deadline = Date.now() + 5_000;
      while (!captured) {
        assert(Date.now() < deadline);
        await delay(5);
      }
      const expected = {
        host: { name: 'original-host', machineId: MACHINE_ID },
        root: { path: sourceRoot, volume: VOLUME },
      };
      assert.deepEqual(captured, expected);
      current = {
        name: 'current-host',
        machineId: 'ABCDEF12-1234-5678-9ABC-123456789ABC',
        volume: { label: 'Other', serialNumber: 'FFFF-4321' },
      };
      const joined = data(await pair.client.callTool({ name: kind, arguments: args }));
      assert.equal(joined.job.jobId, jobId);
      assert.equal(joined.reused, true);
      release();
      const job = await terminal(manager, jobId, pair.guard);
      assert.deepEqual(job.provenance, expected);
      assert.equal(
        job.sourceRootId,
        `root-${createHash('sha256').update(sourceRoot).digest('hex').slice(0, 16)}`,
      );
      const originals = new Map<string, Buffer>();
      for (const artifact of job.artifacts) {
        const content = bytes(
          await pair.client.callTool({
            name: 'get_artifact',
            arguments: { artifactId: artifact.artifactId },
          }),
        );
        originals.set(artifact.artifactId, content);
        assert.equal(createHash('sha256').update(content).digest('hex'), artifact.sha256);
        if (artifact.kind === 'manifest')
          assert.deepEqual(JSON.parse(content.toString()).provenance, expected);
      }
      await pair.close();
      const metadataPath = join(scratch, jobId, 'job.json');
      const stored = JSON.parse(await readFile(metadataPath, 'utf8')) as StoredJob<JobCounters>;
      assert.deepEqual(stored.provenance, expected);
      manager = new ArtifactJobManager(config);
      pair = await openPair(manager, root);
      assert.deepEqual((await manager.getJob(jobId, pair.guard)).provenance, expected);
      const replay = data(await pair.client.callTool({ name: kind, arguments: args }));
      assert.equal(replay.job.jobId, jobId);
      assert.equal(replay.reused, true);
      if (kind === 'snapshot') {
        const automatic = data(
          await pair.client.callTool({ name: kind, arguments: { path: nested } }),
        );
        assert.equal(automatic.job.jobId, jobId);
        assert.equal(automatic.reason, 'completed_reuse');
      }
      for (const [artifactId, original] of originals) {
        assert.deepEqual(
          bytes(await pair.client.callTool({ name: 'get_artifact', arguments: { artifactId } })),
          original,
        );
      }
      assert.equal(lookups, 2, 'reuse/restart/fetch queried current metadata');
      assert.equal(
        data(await pair.client.callTool({ name: 'list_roots' })).host.name,
        'current-host',
      );
      const fresh = data(
        await pair.client.callTool({
          name: kind,
          arguments: {
            ...args,
            idempotencyKey: `fresh-${kind}`,
            ...(kind === 'snapshot' ? { forceRefresh: true } : {}),
          },
        }),
      );
      const freshJob = await terminal(manager, fresh.job.jobId, pair.guard);
      assert.equal(freshJob.provenance?.host.name, 'current-host');
      assert.equal(freshJob.provenance?.root.volume.serialNumber, 'FFFF-4321');
      await pair.close();

      // Model a pre-013 persisted job/manifest without rewriting any production data.
      delete stored.provenance;
      const manifest = stored.artifacts.find((item) => item.kind === 'manifest');
      assert(manifest);
      const originalManifest = originals.get(manifest.artifactId);
      assert(originalManifest);
      const legacy = JSON.parse(originalManifest.toString()) as Record<string, unknown>;
      delete legacy['provenance'];
      const legacyBytes = Buffer.from(`${JSON.stringify(legacy)}\n`);
      await writeFile(join(scratch, jobId, manifest.fileName), legacyBytes);
      stored.artifacts = stored.artifacts.map((item) =>
        item === manifest
          ? {
              ...item,
              size: legacyBytes.length,
              sha256: createHash('sha256').update(legacyBytes).digest('hex'),
            }
          : item,
      );
      await writeFile(metadataPath, JSON.stringify(stored));
      manager = new ArtifactJobManager(config);
      pair = await openPair(manager, root);
      const beforeLegacyRead = lookups;
      const old = data(await pair.client.callTool({ name: kind, arguments: args }));
      assert.equal(old.reused, true);
      assert.equal((await manager.getJob(jobId, pair.guard)).provenance, undefined);
      assert.deepEqual(
        bytes(
          await pair.client.callTool({
            name: 'get_artifact',
            arguments: { artifactId: manifest.artifactId },
          }),
        ),
        legacyBytes,
      );
      assert.equal(lookups, beforeLegacyRead);
    } finally {
      release();
      await pair.close();
      await cleanupTestRoot(root);
      await cleanupTestRoot(scratch);
    }
  });

  it(`${kind} completes with null metadata after provider error/timeout`, async (t) => {
    const root = await createTestRoot();
    const scratch = await createTestRoot();
    await writeFile(join(root, 'original.txt'), 'synthetic original');
    const provider = new SourceProvenanceProvider({
      platform: 'win32',
      hostname: () => 'synthetic-host',
      timeoutMs: 20,
      queryWindows: async (query) => {
        if (query === 'machine') throw new Error('synthetic OS error');
        return new Promise(() => {});
      },
    });
    t.mock.method(sourceProvenance, 'describeRoots', provider.describeRoots.bind(provider));
    const manager = new ArtifactJobManager({
      ...getSnapshotConfig(),
      scratchDirectory: scratch,
      ephemeralScratch: false,
    });
    const pair = await openPair(manager, root);
    try {
      const submitted = data(
        await pair.client.callTool({
          name: kind,
          arguments: {
            path: root,
            idempotencyKey: `unavailable-${kind}`,
            ...(kind === 'bundle' ? { files: [{ relativePath: 'original.txt' }] } : {}),
          },
        }),
      );
      const job = await terminal(manager, submitted.job.jobId, pair.guard);
      assert.equal(job.complete, true);
      const manifest = JSON.parse(
        bytes(
          await pair.client.callTool({
            name: 'get_artifact',
            arguments: { artifactId: job.manifestArtifactId },
          }),
        ).toString(),
      );
      assert.deepEqual(manifest.provenance, {
        host: { name: 'synthetic-host', machineId: null },
        root: {
          path: normalizePath(await realpath(root)),
          volume: { label: null, serialNumber: null },
        },
      });
    } finally {
      await pair.close();
      await cleanupTestRoot(root);
      await cleanupTestRoot(scratch);
    }
  });
}
