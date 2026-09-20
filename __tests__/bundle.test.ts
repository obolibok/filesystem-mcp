import type { CallToolResult } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import yauzl from 'yauzl';
import { ZipFile } from 'yazl';

import type { BundlePipelineHooks, BundleSelection } from '../src/core/bundle-pipeline.js';
import { runBundlePipeline } from '../src/core/bundle-pipeline.js';
import { GuardedFileSystem } from '../src/core/fs.js';
import { ArtifactJobManager, fingerprintJobInput } from '../src/core/job-manager.js';
import type { BundleCounters, StoredJob } from '../src/core/job-types.js';
import { emptyBundleCounters } from '../src/core/job-types.js';
import { getSnapshotConfig } from '../src/core/snapshot-config.js';
import {
  bootHttpTest,
  cleanupTestRoot,
  createTestClientPair,
  createTestRoot,
  firstTextBlock,
  makeGuard,
  trySymlink,
} from './helpers.js';

interface ToolMeta {
  reused?: boolean;
  job?: { jobId?: string };
  state?: string;
  complete?: boolean;
  stopReason?: string;
  counters?: BundleCounters;
  artifacts?: { artifactId: string; kind: string; name: string }[];
  manifestArtifactId?: string;
}

interface BundleManifest {
  schema: string;
  complete: boolean;
  root: { id: string; path?: string };
  counters: BundleCounters;
  files: {
    relativePath: string;
    status: string;
    actual?: { size: number; sha256: string };
    partArtifactId?: string;
    archiveEntry?: string;
  }[];
  parts: { artifactId: string; fileCount: number; rawBytes: number; zipBytes: number }[];
}

function meta(result: CallToolResult): ToolMeta {
  return (result.structuredContent ?? result._meta) as ToolMeta;
}

function windowsShortPath(path: string): string {
  return execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$ErrorActionPreference = "Stop"; (New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:FSMCP_SHORT_PATH_TEST).ShortPath',
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
      env: { ...process.env, FSMCP_SHORT_PATH_TEST: path },
    },
  ).trim();
}

function embeddedBytes(result: CallToolResult): Buffer {
  const block = result.content.find((item) => item.type === 'resource');
  assert(block?.type === 'resource' && 'blob' in block.resource);
  return Buffer.from(block.resource.blob, 'base64');
}

async function unzipAll(bytes: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error('ZIP did not open'));
        return;
      }
      const entries = new Map<string, Buffer>();
      zip.once('error', reject);
      zip.once('end', () => resolve(entries));
      zip.on('entry', (entry) => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError ?? new Error('ZIP entry did not open'));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.once('error', reject);
          stream.once('end', () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

async function makeZip(entries: Readonly<Record<string, Buffer>>): Promise<Buffer> {
  const zip = new ZipFile();
  for (const [name, bytes] of Object.entries(entries)) zip.addBuffer(bytes, name);
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream as AsyncIterable<Buffer | Uint8Array>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function writeBytes(root: string, relativePath: string, bytes: Buffer): Promise<string> {
  const path = join(root, ...relativePath.split('/'));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return path;
}

async function waitForToolJob(
  client: Awaited<ReturnType<typeof createTestClientPair>>['client'],
  jobId: string,
): Promise<CallToolResult> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const status = await client.callTool({ name: 'job_status', arguments: { jobId } });
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(meta(status).state ?? '')) {
      return status;
    }
    assert(Date.now() < deadline, 'Timed out waiting for bundle job');
    await delay(10);
  }
}

async function waitForStoredBundle(
  manager: ArtifactJobManager,
  guard: Awaited<ReturnType<typeof makeGuard>>,
  jobId: string,
): Promise<StoredJob<BundleCounters>> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const job = await manager.getJob<BundleCounters>(jobId, guard);
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(job.state)) return job;
    assert(Date.now() < deadline, 'Timed out waiting for stored bundle job');
    await delay(10);
  }
}

async function submitDirectBundle(
  manager: ArtifactJobManager,
  fs: GuardedFileSystem,
  root: string,
  selections: readonly BundleSelection[],
  hooks: BundlePipelineHooks = {},
): Promise<StoredJob<BundleCounters>> {
  const canonicalRoot = await realpath(root);
  const authorizationPaths = selections.map((selection) =>
    join(canonicalRoot, ...selection.relativePath.split('/')),
  );
  const submitted = await manager.submit({
    kind: 'bundle',
    idempotencyKey: `bundle-${randomUUID()}`,
    fingerprint: fingerprintJobInput(selections),
    sourceRoot: canonicalRoot,
    sourceRootId: 'root-test',
    input: { files: selections },
    authorizationPaths,
    counters: emptyBundleCounters(selections.length),
    run: async (ctx) => runBundlePipeline(fs, canonicalRoot, selections, ctx, hooks),
  });
  return submitted.job;
}

describe('selected originals bundle', () => {
  it('survives HTTP disconnect/client timeout and reuses the durably accepted job', async () => {
    const root = await createTestRoot();
    await writeBytes(root, 'original.bin', Buffer.from('http bundle bytes'));
    const http = await bootHttpTest([root], { FS_RATE_LIMIT_RPM: '10000' });
    try {
      const args = {
        path: root,
        idempotencyKey: `bundle-http-${randomUUID()}`,
        files: [{ relativePath: 'original.bin' }],
      };
      const firstClient = await http.makeClient('bundle-http-first');
      const submitted = await firstClient.callTool({ name: 'bundle', arguments: args });
      const firstJobId = meta(submitted).job?.jobId;
      assert(firstJobId);
      await firstClient.close();
      const resumedClient = await http.makeClient('bundle-http-resumed');
      const completed = await waitForToolJob(resumedClient, firstJobId);
      assert.equal(meta(completed).state, 'completed');
      await resumedClient.close();

      const timeoutArgs = { ...args, idempotencyKey: `bundle-timeout-${randomUUID()}` };
      let delayResponse = true;
      const timeoutClient = await http.makeClient(
        'bundle-http-timeout',
        undefined,
        async (response, _url, init) => {
          const body = typeof init?.body === 'string' ? init.body : '';
          if (delayResponse && body.includes('"name":"bundle"')) {
            delayResponse = false;
            await delay(100);
          }
          return response;
        },
      );
      await assert.rejects(
        timeoutClient.callTool({ name: 'bundle', arguments: timeoutArgs }, { timeout: 10 }),
        /timeout|timed out/u,
      );
      await timeoutClient.close().catch(() => undefined);
      const recoveryClient = await http.makeClient('bundle-http-recovery');
      const recovered = await recoveryClient.callTool({ name: 'bundle', arguments: timeoutArgs });
      assert.equal(meta(recovered).reused, true);
      const recoveredJobId = meta(recovered).job?.jobId;
      assert(recoveredJobId);
      assert.equal(meta(await waitForToolJob(recoveryClient, recoveredJobId)).state, 'completed');
      await recoveryClient.close();
    } finally {
      await http.close();
      await cleanupTestRoot(root);
    }
  });

  it('packages exactly the reordered selection and returns independently verified originals', async () => {
    const root = await createTestRoot();
    const harness = await createTestClientPair([root], { readOnly: true });
    try {
      const nestedZip = await makeZip({
        'inside.txt': Buffer.from('nested original\n'),
        'binary.bin': Buffer.from([0, 1, 2, 255]),
      });
      const expected = new Map<string, Buffer>([
        ['Daum/shared.bin', Buffer.from([0, 255, 1, 2, 3])],
        ['Inoplacer/shared.bin', Buffer.from('other basename\r\n')],
        ['Unicode/Größe, Антенна Ω.txt', Buffer.from('Größe Антенна Ω\n')],
        ['empty.bin', Buffer.alloc(0)],
        ['archives/nested.zip', nestedZip],
        ['office/legacy.xls', Buffer.from('d0cf11e0a1b11ae1', 'hex')],
      ]);
      for (const [relativePath, bytes] of expected) await writeBytes(root, relativePath, bytes);
      await writeBytes(root, 'unselected/secret.bin', Buffer.from('must not be included'));

      const expectedStat = await stat(join(root, 'Daum', 'shared.bin'));
      const files = [...expected.keys()].map((relativePath) =>
        relativePath === 'Daum/shared.bin'
          ? {
              relativePath,
              expected: {
                size: expectedStat.size,
                lastWriteTime: expectedStat.mtime.toISOString(),
              },
            }
          : { relativePath },
      );
      const args = {
        path: root,
        idempotencyKey: `selected-${randomUUID()}`,
        files: [...files].reverse(),
      };
      const submitted = await harness.client.callTool({ name: 'bundle', arguments: args });
      assert.equal(submitted.isError, undefined, firstTextBlock(submitted).text);
      const jobId = meta(submitted).job?.jobId;
      assert(jobId);

      const retry = await harness.client.callTool({
        name: 'bundle',
        arguments: { ...args, files },
      });
      assert.equal(meta(retry).reused, true);
      assert.equal(meta(retry).job?.jobId, jobId);
      const conflict = await harness.client.callTool({
        name: 'bundle',
        arguments: { ...args, files: files.slice(1) },
      });
      assert.equal(conflict.isError, true);
      assert.match(firstTextBlock(conflict).text ?? '', /Idempotency key/u);

      const status = await waitForToolJob(harness.client, jobId);
      assert.equal(meta(status).state, 'completed', firstTextBlock(status).text);
      assert.equal(meta(status).complete, true);
      assert.equal(meta(status).counters?.included, expected.size);
      const manifestId = meta(status).manifestArtifactId;
      assert(manifestId);
      const manifest = JSON.parse(
        embeddedBytes(
          await harness.client.callTool({
            name: 'get_artifact',
            arguments: { artifactId: manifestId },
          }),
        ).toString('utf8'),
      ) as BundleManifest;
      assert.equal(manifest.schema, 'filesystem-mcp.bundle-manifest');
      assert.equal(manifest.complete, true);
      assert.equal(manifest.root.path, undefined, 'manifest leaked an absolute source path');
      assert.deepEqual(
        new Set(manifest.files.map((file) => file.relativePath)),
        new Set(expected.keys()),
      );

      const extracted = new Map<string, Buffer>();
      let repeatArtifactId: string | undefined;
      let repeatBytes: Buffer | undefined;
      for (const part of manifest.parts) {
        const result = await harness.client.callTool({
          name: 'get_artifact',
          arguments: { artifactId: part.artifactId },
        });
        const zipBytes = embeddedBytes(result);
        repeatArtifactId ??= part.artifactId;
        repeatBytes ??= zipBytes;
        for (const [name, bytes] of await unzipAll(zipBytes)) {
          assert(!extracted.has(name), `duplicate archive entry ${name}`);
          extracted.set(name, bytes);
        }
      }
      assert.deepEqual(
        new Set(extracted.keys()),
        new Set([...expected.keys()].map((p) => `files/${p}`)),
      );
      for (const [relativePath, bytes] of expected) {
        assert.deepEqual(extracted.get(`files/${relativePath}`), bytes, relativePath);
        const record = manifest.files.find((file) => file.relativePath === relativePath);
        assert.equal(record?.status, 'included');
        assert.equal(record?.actual?.size, bytes.length);
      }
      assert(!extracted.has('files/unselected/secret.bin'));
      assert.deepEqual(
        await unzipAll(extracted.get('files/archives/nested.zip') ?? Buffer.alloc(0)),
        await unzipAll(nestedZip),
      );
      assert(
        (extracted.get('files/office/legacy.xls') ?? Buffer.alloc(0))
          .subarray(0, 8)
          .equals(Buffer.from('d0cf11e0a1b11ae1', 'hex')),
      );
      for (const [relativePath, bytes] of expected) {
        assert.deepEqual(
          await readFile(join(root, ...relativePath.split('/'))),
          bytes,
          `source changed: ${relativePath}`,
        );
      }

      assert(repeatArtifactId && repeatBytes);
      await unlink(join(root, 'Daum', 'shared.bin'));
      const repeatedAfterDelete = embeddedBytes(
        await harness.client.callTool({
          name: 'get_artifact',
          arguments: { artifactId: repeatArtifactId },
        }),
      );
      assert.deepEqual(repeatedAfterDelete, repeatBytes);

      const tools = await harness.client.listTools();
      assert(tools.tools.some((tool) => tool.name === 'bundle'));
    } finally {
      await harness.close();
      await cleanupTestRoot(root);
    }
  });

  it('reports every missing, inaccessible, changed, and special selector without an empty ZIP', async () => {
    const root = await createTestRoot();
    const scratch = await createTestRoot();
    await writeBytes(root, 'denied.bin', Buffer.from('denied'));
    await writeBytes(root, 'stale.bin', Buffer.from('stale'));
    await writeBytes(root, 'changing.bin', Buffer.from('before'));
    await mkdir(join(root, 'directory'));
    const guard = await makeGuard([root]);
    class FaultingFileSystem extends GuardedFileSystem {
      override async openOriginal(
        filePath: string,
        options?: { signal?: AbortSignal },
      ): ReturnType<GuardedFileSystem['openOriginal']> {
        if (basename(filePath) === 'denied.bin') {
          throw Object.assign(new Error('synthetic permission denial'), { code: 'EACCES' });
        }
        return super.openOriginal(filePath, options);
      }
    }
    const fs = new FaultingFileSystem(guard);
    const manager = new ArtifactJobManager({
      ...getSnapshotConfig(),
      scratchDirectory: scratch,
      ephemeralScratch: false,
    });
    try {
      const selections: BundleSelection[] = [
        { relativePath: 'missing.bin' },
        { relativePath: 'denied.bin' },
        {
          relativePath: 'stale.bin',
          expected: { size: 999, lastWriteTime: new Date(0).toISOString() },
        },
        { relativePath: 'changing.bin' },
        { relativePath: 'directory' },
      ];
      const submitted = await submitDirectBundle(manager, fs, root, selections, {
        afterCaptureBeforeRestat: async (selection, path) => {
          if (selection.relativePath === 'changing.bin') await appendFile(path, Buffer.from('!'));
        },
      });
      const completed = await waitForStoredBundle(manager, guard, submitted.jobId);
      assert.equal(completed.state, 'completed');
      assert.equal(completed.complete, false);
      assert.equal(completed.counters.included, 0);
      assert.equal(completed.counters.skipped, 5);
      assert.equal(completed.counters.missing, 1);
      assert.equal(completed.counters.inaccessible, 1);
      assert.equal(completed.counters.changed, 2);
      assert.equal(completed.counters.special, 1);
      assert.equal(
        completed.artifacts.filter((artifact) => artifact.kind === 'bundle-part').length,
        0,
      );
      const manifestId = completed.manifestArtifactId;
      assert(manifestId);
      const manifest = JSON.parse(
        (await manager.getArtifact(manifestId, guard)).bytes.toString('utf8'),
      ) as BundleManifest;
      assert.equal(manifest.complete, false);
      assert.deepEqual(
        new Map(manifest.files.map((file) => [file.relativePath, file.status])),
        new Map([
          ['missing.bin', 'missing'],
          ['denied.bin', 'inaccessible'],
          ['stale.bin', 'changed'],
          ['changing.bin', 'changed'],
          ['directory', 'special'],
        ]),
      );
    } finally {
      await manager.close();
      await cleanupTestRoot(root);
      await cleanupTestRoot(scratch);
    }
  });

  it('splits poorly compressible files and records a single closed-ZIP oversized original', async () => {
    const root = await createTestRoot();
    const scratch = await createTestRoot();
    for (const [name, size] of [
      ['one.bin', 480],
      ['two.bin', 480],
      ['oversized.bin', 900],
    ] as const) {
      await writeBytes(root, name, randomBytes(size));
    }
    const guard = await makeGuard([root]);
    const fs = new GuardedFileSystem(guard);
    const manager = new ArtifactJobManager({
      ...getSnapshotConfig(),
      scratchDirectory: scratch,
      ephemeralScratch: false,
      maxZipBytes: 700,
      maxDeliveryBytes: 16 * 1024,
      maxFileSizeBytes: 16 * 1024,
      maxBundleFileBytes: 4096,
      maxBundleRawPartBytes: 4096,
      maxBundleJobRawBytes: 4096,
      maxBundleManifestBytes: 16 * 1024,
    });
    try {
      const submitted = await submitDirectBundle(
        manager,
        fs,
        root,
        ['one.bin', 'two.bin', 'oversized.bin'].map((relativePath) => ({ relativePath })),
      );
      const completed = await waitForStoredBundle(manager, guard, submitted.jobId);
      assert.equal(completed.state, 'completed');
      assert.equal(completed.complete, false);
      assert.equal(completed.counters.included, 2);
      assert.equal(completed.counters.tooLarge, 1);
      assert.equal(completed.counters.parts, 2);
      for (const artifact of completed.artifacts.filter(
        (candidate) => candidate.kind === 'bundle-part',
      )) {
        assert(artifact.size <= 700);
        const entries = await unzipAll(
          (await manager.getArtifact(artifact.artifactId, guard)).bytes,
        );
        assert.equal(entries.size, 1);
      }
    } finally {
      await manager.close();
      await cleanupTestRoot(root);
      await cleanupTestRoot(scratch);
    }
  });

  it('rejects unsafe/colliding selectors and fails closed on a junction path', async (t) => {
    const root = await createTestRoot();
    const harness = await createTestClientPair([root], { readOnly: true });
    try {
      for (const relativePath of ['../escape.bin', 'C:/drive.bin', 'name:ads', 'back\\slash']) {
        const result = await harness.client.callTool({
          name: 'bundle',
          arguments: {
            path: root,
            idempotencyKey: `unsafe-${randomUUID()}`,
            files: [{ relativePath }],
          },
        });
        assert.equal(result.isError, true, relativePath);
      }
      const duplicate = await harness.client.callTool({
        name: 'bundle',
        arguments: {
          path: root,
          idempotencyKey: `duplicate-${randomUUID()}`,
          files: [{ relativePath: 'A/file.bin' }, { relativePath: 'a/file.bin' }],
        },
      });
      assert.equal(duplicate.isError, true);

      const target = join(root, 'target');
      await mkdir(target);
      await writeFile(join(target, 'inside.bin'), Buffer.from('inside'));
      if (!(await trySymlink(target, join(root, 'alias'), () => t.skip(), 'junction'))) return;
      const submitted = await harness.client.callTool({
        name: 'bundle',
        arguments: {
          path: root,
          idempotencyKey: `junction-${randomUUID()}`,
          files: [{ relativePath: 'alias/inside.bin' }],
        },
      });
      const jobId = meta(submitted).job?.jobId;
      assert(jobId);
      const failed = await waitForToolJob(harness.client, jobId);
      assert.equal(meta(failed).state, 'failed');
      assert.equal(meta(failed).artifacts?.length, 0);
      assert.match(meta(failed).stopReason ?? '', /symlink|junction/u);
    } finally {
      await harness.close();
      await cleanupTestRoot(root);
    }
  });

  it('enforces configured selection count and metadata-byte caps before registering work', async () => {
    const previousFiles = process.env['FS_BUNDLE_MAX_FILES'];
    const previousBytes = process.env['FS_BUNDLE_MAX_SELECTION_BYTES'];
    process.env['FS_BUNDLE_MAX_FILES'] = '1';
    process.env['FS_BUNDLE_MAX_SELECTION_BYTES'] = '1024';
    const root = await createTestRoot();
    const harness = await createTestClientPair([root], { readOnly: true });
    try {
      const countRejected = await harness.client.callTool({
        name: 'bundle',
        arguments: {
          path: root,
          idempotencyKey: `count-cap-${randomUUID()}`,
          files: [{ relativePath: 'one.bin' }, { relativePath: 'two.bin' }],
        },
      });
      assert.equal(countRejected.isError, true);
      assert.match(firstTextBlock(countRejected).text ?? '', /file-count cap/u);
      const bytesRejected = await harness.client.callTool({
        name: 'bundle',
        arguments: {
          path: root,
          idempotencyKey: `bytes-cap-${randomUUID()}`,
          files: [{ relativePath: `${'long-name-'.repeat(120)}.bin` }],
        },
      });
      assert.equal(bytesRejected.isError, true);
      assert.match(firstTextBlock(bytesRejected).text ?? '', /selection metadata/u);
    } finally {
      await harness.close();
      await cleanupTestRoot(root);
      if (previousFiles === undefined) Reflect.deleteProperty(process.env, 'FS_BUNDLE_MAX_FILES');
      else process.env['FS_BUNDLE_MAX_FILES'] = previousFiles;
      if (previousBytes === undefined) {
        Reflect.deleteProperty(process.env, 'FS_BUNDLE_MAX_SELECTION_BYTES');
      } else {
        process.env['FS_BUNDLE_MAX_SELECTION_BYTES'] = previousBytes;
      }
    }
  });

  it('uses the shared cancellation lifecycle and publishes no partial bundle', async () => {
    const root = await createTestRoot();
    const scratch = await createTestRoot();
    await writeBytes(root, 'cancel.bin', randomBytes(1024));
    const guard = await makeGuard([root]);
    const fs = new GuardedFileSystem(guard);
    let releaseCompression!: () => void;
    const compressionReleased = new Promise<void>((resolve) => {
      releaseCompression = resolve;
    });
    let enteredCompression!: () => void;
    const compressionEntered = new Promise<void>((resolve) => {
      enteredCompression = resolve;
    });
    const manager = new ArtifactJobManager({
      ...getSnapshotConfig(),
      scratchDirectory: scratch,
      ephemeralScratch: false,
    });
    try {
      const submitted = await submitDirectBundle(
        manager,
        fs,
        root,
        [{ relativePath: 'cancel.bin' }],
        {
          beforeCompress: async () => {
            enteredCompression();
            await compressionReleased;
          },
        },
      );
      await compressionEntered;
      const cancelled = await manager.cancel<BundleCounters>(submitted.jobId, guard);
      assert.equal(cancelled.state, 'cancelled');
      releaseCompression();
      await delay(20);
      const terminal = await manager.getJob<BundleCounters>(submitted.jobId, guard);
      assert.equal(terminal.state, 'cancelled');
      assert.equal(terminal.artifacts.length, 0);
      assert.equal(terminal.manifestArtifactId, undefined);
    } finally {
      releaseCompression();
      await manager.close();
      await cleanupTestRoot(root);
      await cleanupTestRoot(scratch);
    }
  });

  it('fails on the shared job deadline and removes captured/partial bytes', async () => {
    const root = await createTestRoot();
    const scratch = await createTestRoot();
    await writeBytes(root, 'deadline.bin', randomBytes(1024));
    const guard = await makeGuard([root]);
    const manager = new ArtifactJobManager({
      ...getSnapshotConfig(),
      scratchDirectory: scratch,
      ephemeralScratch: false,
      maxJobMs: 10,
    });
    try {
      const submitted = await submitDirectBundle(
        manager,
        new GuardedFileSystem(guard),
        root,
        [{ relativePath: 'deadline.bin' }],
        { beforeCompress: async () => delay(40) },
      );
      const failed = await waitForStoredBundle(manager, guard, submitted.jobId);
      assert.equal(failed.state, 'failed');
      assert.equal(failed.stopReason, 'time-limit-exceeded');
      assert.equal(failed.complete, false);
      assert.equal(failed.artifacts.length, 0);
      assert.equal(failed.manifestArtifactId, undefined);
    } finally {
      await manager.close();
      await cleanupTestRoot(root);
      await cleanupTestRoot(scratch);
    }
  });

  it('keeps immutable bytes after source deletion but honors narrowed selected-path policy after restart', async () => {
    const root = await createTestRoot();
    const scratch = await createTestRoot();
    const selected = await writeBytes(root, 'selected.bin', Buffer.from('immutable bytes'));
    const initialGuard = await makeGuard([root]);
    const manager = new ArtifactJobManager({
      ...getSnapshotConfig(),
      scratchDirectory: scratch,
      ephemeralScratch: false,
    });
    let artifactId: string;
    try {
      const submitted = await submitDirectBundle(
        manager,
        new GuardedFileSystem(initialGuard),
        root,
        [{ relativePath: 'selected.bin' }],
      );
      const completed = await waitForStoredBundle(manager, initialGuard, submitted.jobId);
      artifactId =
        completed.artifacts.find((artifact) => artifact.kind === 'bundle-part')?.artifactId ?? '';
      assert(artifactId);
    } finally {
      await manager.close();
    }
    await unlink(selected);
    const restarted = new ArtifactJobManager({
      ...getSnapshotConfig(),
      scratchDirectory: scratch,
      ephemeralScratch: false,
    });
    const previousDenylist = process.env['FS_DENYLIST'];
    try {
      assert((await restarted.getArtifact(artifactId, await makeGuard([root]))).bytes.length > 0);
      process.env['FS_DENYLIST'] = 'selected.bin';
      const narrowedGuard = await makeGuard([root]);
      await assert.rejects(
        restarted.getArtifact(artifactId, narrowedGuard),
        /Sensitive file blocked/u,
      );
    } finally {
      if (previousDenylist === undefined) Reflect.deleteProperty(process.env, 'FS_DENYLIST');
      else process.env['FS_DENYLIST'] = previousDenylist;
      await restarted.close();
      await cleanupTestRoot(root);
      await cleanupTestRoot(scratch);
    }
  });

  it(
    'accepts the Windows 8.3 spelling of the selected source root',
    { skip: process.platform !== 'win32' },
    async () => {
      const container = await createTestRoot();
      const source = join(container, 'bundle source root with long name');
      await mkdir(source);
      await writeBytes(source, 'nested/original.bin', Buffer.from('short root bytes'));
      const shortRoot = windowsShortPath(source);
      const harness = await createTestClientPair([shortRoot], { readOnly: true });
      try {
        const submitted = await harness.client.callTool({
          name: 'bundle',
          arguments: {
            path: shortRoot,
            idempotencyKey: `short-root-${randomUUID()}`,
            files: [{ relativePath: 'nested/original.bin' }],
          },
        });
        const jobId = meta(submitted).job?.jobId;
        assert(jobId);
        const completed = await waitForToolJob(harness.client, jobId);
        assert.equal(meta(completed).state, 'completed', firstTextBlock(completed).text);
        assert.equal(meta(completed).complete, true);
      } finally {
        await harness.close();
        await cleanupTestRoot(container);
      }
    },
  );
});
