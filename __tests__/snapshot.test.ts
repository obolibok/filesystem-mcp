import type { CallToolResult } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import yauzl from 'yauzl';

import { GuardedFileSystem } from '../src/core/fs.js';
import { ArtifactJobManager, fingerprintJobInput } from '../src/core/job-manager.js';
import type { StoredJob } from '../src/core/job-types.js';
import { getSnapshotConfig } from '../src/core/snapshot-config.js';
import type { SnapshotRecord } from '../src/core/snapshot-pipeline.js';
import {
  runSnapshotPipeline,
  serializeSnapshotRecord,
  SNAPSHOT_CSV_HEADER,
  writeSnapshotFromRecords,
} from '../src/core/snapshot-pipeline.js';
import {
  bootHttpTest,
  cleanupTestRoot,
  createStdioClient,
  createTestClientPair,
  createTestRoot,
  firstTextBlock,
  makeGuard,
  writeTestFile,
} from './helpers.js';

interface ToolMeta {
  reused?: boolean;
  job?: StoredJob & { artifacts: { artifactId: string; kind: string }[] };
  state?: string;
  artifacts?: { artifactId: string; kind: string }[];
  manifestArtifactId?: string;
  resultExpired?: boolean;
}

function meta(result: CallToolResult): ToolMeta {
  return (result.structuredContent ?? result._meta) as ToolMeta;
}

function embeddedBytes(result: CallToolResult): Buffer {
  const block = result.content.find((item) => item.type === 'resource');
  assert(block?.type === 'resource' && 'blob' in block.resource);
  return Buffer.from(block.resource.blob, 'base64');
}

async function unzipSingle(bytes: Buffer): Promise<{ name: string; bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(openError ?? new Error('ZIP did not open'));
        return;
      }
      let seen = false;
      zip.once('error', reject);
      zip.on('entry', (entry) => {
        if (seen) {
          reject(new Error('Expected exactly one ZIP entry'));
          zip.close();
          return;
        }
        seen = true;
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError ?? new Error('ZIP entry did not open'));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.once('error', reject);
          stream.once('end', () => {
            zip.readEntry();
            resolve({ name: entry.fileName, bytes: Buffer.concat(chunks) });
          });
        });
      });
      zip.readEntry();
    });
  });
}

async function waitForTerminal(
  getJob: () => Promise<StoredJob>,
  timeoutMs = 10_000,
): Promise<StoredJob> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await getJob();
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(job.state)) return job;
    if (Date.now() >= deadline) throw new Error('Timed out waiting for snapshot job');
    await delay(10);
  }
}

describe('snapshot jobs and artifacts', () => {
  it('survives independent HTTP requests and remains available in read-only stdio', async () => {
    const root = await createTestRoot();
    await writeTestFile(root, 'probe.txt', 'probe');
    const http = await bootHttpTest([root], { FS_RATE_LIMIT_RPM: '10000' });
    try {
      const client = await http.makeClient('snapshot-http');
      const submitted = await client.callTool({
        name: 'snapshot',
        arguments: { path: root, idempotencyKey: `http-${randomUUID()}` },
      });
      const jobId = meta(submitted).job?.jobId;
      assert(jobId);
      await client.close();
      const resumedClient = await http.makeClient('snapshot-http-resumed');
      const deadline = Date.now() + 10_000;
      for (;;) {
        const status = await resumedClient.callTool({ name: 'job_status', arguments: { jobId } });
        if (meta(status).state === 'completed') break;
        assert.notEqual(meta(status).state, 'failed');
        assert(Date.now() < deadline, 'HTTP snapshot did not finish');
        await delay(10);
      }
      await resumedClient.close();
    } finally {
      await http.close();
    }

    const stdio = await createStdioClient(root, {}, ['--read-only']);
    try {
      const tools = await stdio.client.listTools();
      for (const name of ['snapshot', 'job_status', 'cancel_job', 'get_artifact']) {
        assert(
          tools.tools.some((tool) => tool.name === name),
          `${name} missing in read-only stdio`,
        );
      }
      const submitted = await stdio.client.callTool({
        name: 'snapshot',
        arguments: { path: root, idempotencyKey: `stdio-${randomUUID()}` },
      });
      assert(meta(submitted).job?.jobId);
    } finally {
      await stdio.close();
      await cleanupTestRoot(root);
    }
  });

  it('walks guarded files, reuses a key, and returns immutable manifest/ZIP bytes', async () => {
    const root = await createTestRoot();
    const { client, close } = await createTestClientPair([root], { readOnly: true });
    try {
      await writeTestFile(root, 'plain', 'one');
      await writeTestFile(root, 'nested/Größe-Антенна.txt', 'two');
      await writeTestFile(root, 'ignored/skip.txt', 'skip');
      await writeFile(join(root, '.gitignore'), 'ignored/\n', 'utf8');

      const args = { path: root, idempotencyKey: `snapshot-${randomUUID()}` };
      const submitted = await client.callTool({ name: 'snapshot', arguments: args });
      assert.equal(submitted.isError, undefined, firstTextBlock(submitted).text);
      const jobId = meta(submitted).job?.jobId;
      assert(jobId);

      const repeated = await client.callTool({ name: 'snapshot', arguments: args });
      assert.equal(meta(repeated).reused, true);
      assert.equal(meta(repeated).job?.jobId, jobId);

      const conflict = await client.callTool({
        name: 'snapshot',
        arguments: { ...args, includeHidden: true },
      });
      assert.equal(conflict.isError, true);
      assert.match(firstTextBlock(conflict).text ?? '', /Idempotency key/u);

      const deadline = Date.now() + 10_000;
      let status = await client.callTool({ name: 'job_status', arguments: { jobId } });
      while (meta(status).state !== 'completed' && Date.now() < deadline) {
        status = await client.callTool({ name: 'job_status', arguments: { jobId } });
        assert.notEqual(meta(status).state, 'failed', firstTextBlock(status).text);
        await delay(10);
      }

      assert.equal(meta(status).state, 'completed', 'snapshot did not finish');
      const artifacts = meta(status).artifacts ?? [];
      const manifestId = meta(status).manifestArtifactId;
      const zipId = artifacts.find((artifact) => artifact.kind === 'snapshot-part')?.artifactId;
      assert(manifestId && zipId);

      const manifestResult = await client.callTool({
        name: 'get_artifact',
        arguments: { artifactId: manifestId },
      });
      const manifestBytes = embeddedBytes(manifestResult);
      const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
        complete: boolean;
        counters: { filesWritten: number; ignoredExcluded: number };
        parts: { artifactId: string; sha256: string; rows: number }[];
      };
      assert.equal(manifest.complete, true);
      assert.equal(manifest.counters.filesWritten, 2);
      assert(manifest.counters.ignoredExcluded >= 1);
      assert.equal(manifest.parts[0]?.artifactId, zipId);

      const zipResult = await client.callTool({
        name: 'get_artifact',
        arguments: { artifactId: zipId },
      });
      const zipBytes = embeddedBytes(zipResult);
      assert.equal(createHash('sha256').update(zipBytes).digest('hex'), manifest.parts[0]?.sha256);
      const extracted = await unzipSingle(zipBytes);
      assert.match(extracted.name, /^snapshot-\d{5}\.csv$/u);
      assert(extracted.bytes.toString('utf8').startsWith(SNAPSHOT_CSV_HEADER));
      assert.equal(extracted.bytes.toString('utf8').split('\r\n').length - 2, 2);

      const repeatZip = embeddedBytes(
        await client.callTool({ name: 'get_artifact', arguments: { artifactId: zipId } }),
      );
      assert.deepEqual(repeatZip, zipBytes);
    } finally {
      await close();
      await cleanupTestRoot(root);
    }
  });

  it('records inaccessible and disappearing files without failing the bounded walk', async () => {
    const root = await createTestRoot();
    const scratch = await createTestRoot();
    await writeTestFile(root, 'ok.txt', 'ok');
    await writeTestFile(root, 'denied.txt', 'denied');
    await writeTestFile(root, 'gone.txt', 'gone');
    const guard = await makeGuard([root]);
    class FaultingFileSystem extends GuardedFileSystem {
      override async statDetailed(
        filePath: string,
        options?: { signal?: AbortSignal },
      ): ReturnType<GuardedFileSystem['statDetailed']> {
        if (basename(filePath) === 'denied.txt') {
          throw Object.assign(new Error('synthetic permission denial'), { code: 'EACCES' });
        }
        if (basename(filePath) === 'gone.txt') await unlink(filePath);
        return super.statDetailed(filePath, options);
      }
    }
    const fs = new FaultingFileSystem(guard);
    const manager = new ArtifactJobManager({
      ...getSnapshotConfig(),
      scratchDirectory: scratch,
      ephemeralScratch: false,
    });
    try {
      const submitted = await manager.submit({
        kind: 'snapshot',
        idempotencyKey: 'walk-errors-key',
        fingerprint: fingerprintJobInput('walk-errors'),
        sourceRoot: root,
        sourceRootId: 'root-test',
        input: {},
        run: async (ctx) =>
          runSnapshotPipeline(fs, root, { includeHidden: false, includeIgnored: false }, ctx),
      });
      const completed = await waitForTerminal(() => manager.getJob(submitted.job.jobId, guard));
      assert.equal(completed.state, 'completed');
      assert.equal(completed.complete, false);
      assert.equal(completed.counters.filesWritten, 1);
      assert.equal(completed.counters.inaccessibleSkipped, 1);
      assert.equal(completed.counters.disappearedSkipped, 1);
      assert.equal(completed.counters.errors, 2);
      assert.deepEqual(
        new Set(completed.errors.map((error) => error.code)),
        new Set(['EACCES', 'NOT_FOUND']),
      );
    } finally {
      await manager.close();
      await rm(scratch, { recursive: true, force: true });
      await cleanupTestRoot(root);
    }
  });

  it('does not follow an escape junction and excludes an in-source scratch directory', async (t) => {
    const container = await createTestRoot();
    const external = await createTestRoot();
    const root = join(container, 'target');
    const alias = join(container, 'alias');
    const scratch = join(root, '.snapshot-scratch');
    await mkdir(root);
    await writeTestFile(root, 'kept.txt', 'kept');
    await writeTestFile(external, 'escaped.txt', 'escaped');
    try {
      await symlink(root, alias, 'junction');
      await symlink(external, join(root, 'escape-junction'), 'junction');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'UNKNOWN') {
        t.skip(`junction creation unavailable: ${code}`);
        return;
      }
      throw error;
    }
    const guard = await makeGuard([alias]);
    const canonicalRoot = await guard.validateExistingDirectory(alias);
    const fs = new GuardedFileSystem(guard);
    const manager = new ArtifactJobManager({
      ...getSnapshotConfig(),
      scratchDirectory: scratch,
      ephemeralScratch: false,
    });
    try {
      await manager.assertScratchSeparated(canonicalRoot);
      const submitted = await manager.submit({
        kind: 'snapshot',
        idempotencyKey: 'junction-key',
        fingerprint: fingerprintJobInput('junction'),
        sourceRoot: canonicalRoot,
        sourceRootId: 'root-test',
        input: {},
        run: async (ctx) =>
          runSnapshotPipeline(
            fs,
            canonicalRoot,
            { includeHidden: true, includeIgnored: false },
            ctx,
          ),
      });
      const completed = await waitForTerminal(() => manager.getJob(submitted.job.jobId, guard));
      assert.equal(completed.state, 'completed');
      assert.equal(completed.counters.filesWritten, 1);
      assert.equal(completed.counters.symlinksSkipped, 1);
      assert.equal(completed.counters.scratchExcluded, 1);
    } finally {
      await manager.close();
      await cleanupTestRoot(container);
      await cleanupTestRoot(external);
    }
  });

  it('keeps CSV quoting on record boundaries and preserves completed artifacts across restart', async () => {
    const root = await createTestRoot();
    const scratch = await createTestRoot();
    const guard = await makeGuard([root]);
    const config = {
      ...getSnapshotConfig(),
      scratchDirectory: scratch,
      ephemeralScratch: false,
      maxRawPartBytes: 256,
      maxZipBytes: 64 * 1024,
      maxDeliveryBytes: 64 * 1024,
      maxJobRawBytes: 64 * 1024,
      maxJobArtifactBytes: 64 * 1024,
      scratchQuotaBytes: 256 * 1024,
      resultTtlMs: 60_000,
    };
    const record: SnapshotRecord = {
      rootId: 'root-test',
      relativePath: 'folder/a,"b"\nline.txt',
      name: 'a,"b"\nline.txt',
      extension: '.txt',
      length: 42,
      lastWriteTime: '2026-09-20T10:11:12.000Z',
    };
    const manager = new ArtifactJobManager(config);
    try {
      const submitted = await manager.submit({
        kind: 'snapshot',
        idempotencyKey: 'restart-key',
        fingerprint: fingerprintJobInput(record),
        sourceRoot: root,
        sourceRootId: 'root-test',
        input: {},
        run: async (ctx) =>
          writeSnapshotFromRecords(
            (async function* () {
              yield record;
            })(),
            ctx,
            { includeHidden: false, includeIgnored: false },
          ),
      });
      const completed = await waitForTerminal(() => manager.getJob(submitted.job.jobId, guard));
      assert.equal(completed.state, 'completed');
      const part = completed.artifacts.find((artifact) => artifact.kind === 'snapshot-part');
      assert(part);
      const before = await manager.getArtifact(part.artifactId, guard);
      const extracted = await unzipSingle(before.bytes);
      assert.deepEqual(
        extracted.bytes,
        Buffer.concat([Buffer.from(SNAPSHOT_CSV_HEADER), serializeSnapshotRecord(record)]),
      );
      await manager.close();

      const restarted = new ArtifactJobManager(config);
      try {
        const recovered = await restarted.getJob(submitted.job.jobId, guard);
        assert.equal(recovered.state, 'completed');
        const after = await restarted.getArtifact(part.artifactId, guard);
        assert.deepEqual(after.bytes, before.bytes);
      } finally {
        await restarted.close();
      }
    } finally {
      await manager.close();
      await rm(scratch, { recursive: true, force: true });
      await cleanupTestRoot(root);
    }
  });

  it('coalesces parallel submits with one idempotency key into one producer run', async () => {
    const root = await createTestRoot();
    const scratch = await createTestRoot();
    const guard = await makeGuard([root]);
    const config = {
      ...getSnapshotConfig(),
      scratchDirectory: scratch,
      ephemeralScratch: false,
    };
    const manager = new ArtifactJobManager(config);
    let producerRuns = 0;
    const input = {
      kind: 'snapshot',
      idempotencyKey: 'parallel-key',
      fingerprint: fingerprintJobInput('parallel'),
      sourceRoot: root,
      sourceRootId: 'root-test',
      input: {},
      run: async (ctx: Parameters<Parameters<ArtifactJobManager['submit']>[0]['run']>[0]) => {
        producerRuns += 1;
        await delay(25);
        return writeSnapshotFromRecords(
          (async function* () {
            yield {
              rootId: 'root-test',
              relativePath: 'one.txt',
              name: 'one.txt',
              extension: '.txt',
              length: 1,
              lastWriteTime: '2026-09-20T00:00:00.000Z',
            };
          })(),
          ctx,
          { includeHidden: false, includeIgnored: false },
        );
      },
    };
    try {
      const results = await Promise.all(Array.from({ length: 8 }, () => manager.submit(input)));
      assert.equal(new Set(results.map((result) => result.job.jobId)).size, 1);
      assert.equal(results.filter((result) => !result.reused).length, 1);
      await waitForTerminal(() => manager.getJob(results[0]?.job.jobId ?? '', guard));
      assert.equal(producerRuns, 1);
    } finally {
      await manager.close();
      await rm(scratch, { recursive: true, force: true });
      await cleanupTestRoot(root);
    }
  });

  it('cancels independently of the submit request and marks active work interrupted on restart', async () => {
    const root = await createTestRoot();
    const scratch = await createTestRoot();
    const guard = await makeGuard([root]);
    const config = {
      ...getSnapshotConfig(),
      scratchDirectory: scratch,
      ephemeralScratch: false,
      resultTtlMs: 60_000,
    };
    const manager = new ArtifactJobManager(config);
    try {
      const submitted = await manager.submit({
        kind: 'snapshot',
        idempotencyKey: 'cancel-key',
        fingerprint: fingerprintJobInput('cancel'),
        sourceRoot: root,
        sourceRootId: 'root-test',
        input: {},
        run: async (ctx) =>
          new Promise<string>((_resolve, reject) => {
            ctx.signal.addEventListener(
              'abort',
              () =>
                reject(
                  ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error('aborted'),
                ),
              { once: true },
            );
          }),
      });
      const firstDeadline = Date.now() + 2000;
      while ((await manager.getJob(submitted.job.jobId, guard)).state === 'queued') {
        assert(Date.now() < firstDeadline, 'first job remained queued');
        await delay(1);
      }
      const cancelled = await manager.cancel(submitted.job.jobId, guard);
      assert.equal(cancelled.state, 'cancelled');
      assert.deepEqual(cancelled.artifacts, []);
      assert.equal((await manager.cancel(submitted.job.jobId, guard)).state, 'cancelled');

      const second = await manager.submit({
        kind: 'snapshot',
        idempotencyKey: 'interrupt-key',
        fingerprint: fingerprintJobInput('interrupt'),
        sourceRoot: root,
        sourceRootId: 'root-test',
        input: {},
        run: async (ctx) =>
          new Promise<string>((_resolve, reject) => {
            ctx.signal.addEventListener(
              'abort',
              () =>
                reject(
                  ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error('aborted'),
                ),
              { once: true },
            );
          }),
      });
      const secondDeadline = Date.now() + 2000;
      while ((await manager.getJob(second.job.jobId, guard)).state === 'queued') {
        assert(Date.now() < secondDeadline, 'second job remained queued');
        await delay(1);
      }
      await manager.close();

      const restarted = new ArtifactJobManager(config);
      try {
        assert.equal((await restarted.getJob(second.job.jobId, guard)).state, 'interrupted');
      } finally {
        await restarted.close();
      }
    } finally {
      await manager.close();
      await rm(scratch, { recursive: true, force: true });
      await cleanupTestRoot(root);
    }
  });

  it('fails boundedly on ZIP cap, scratch quota, and synthetic ENOSPC', async () => {
    const root = await createTestRoot();
    const scratch = await createTestRoot();
    const guard = await makeGuard([root]);
    const fs = new GuardedFileSystem(guard);
    await mkdir(join(root, 'data'));
    await writeFile(
      join(root, 'data', 'random.txt'),
      createHash('sha512').update('seed').digest('hex'),
    );
    const config = {
      ...getSnapshotConfig(),
      scratchDirectory: scratch,
      ephemeralScratch: false,
      maxZipBytes: 100,
      maxRawPartBytes: 64 * 1024,
      maxJobRawBytes: 64 * 1024,
      maxJobArtifactBytes: 64 * 1024,
      scratchQuotaBytes: 128 * 1024,
    };
    const manager = new ArtifactJobManager(config);
    try {
      const submitted = await manager.submit({
        kind: 'snapshot',
        idempotencyKey: 'zip-cap-key',
        fingerprint: fingerprintJobInput('zip-cap'),
        sourceRoot: root,
        sourceRootId: 'root-test',
        input: {},
        run: async (ctx) =>
          runSnapshotPipeline(fs, root, { includeHidden: false, includeIgnored: false }, ctx),
      });
      const failed = await waitForTerminal(() => manager.getJob(submitted.job.jobId, guard));
      assert.equal(failed.state, 'failed');
      assert.match(failed.stopReason ?? '', /ZIP part/u);
      assert.deepEqual(failed.artifacts, []);

      const diskFull = await manager.submit({
        kind: 'snapshot',
        idempotencyKey: 'enospc-key',
        fingerprint: fingerprintJobInput('enospc'),
        sourceRoot: root,
        sourceRootId: 'root-test',
        input: {},
        run: async (ctx) => {
          const partial = ctx.tempPath('disk-full');
          const bytes = Buffer.from('partial bytes');
          ctx.reserveDisk(bytes.length);
          await writeFile(partial, bytes);
          throw Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' });
        },
      });
      const noSpace = await waitForTerminal(() => manager.getJob(diskFull.job.jobId, guard));
      assert.equal(noSpace.state, 'failed');
      assert.equal(noSpace.errors.at(-1)?.code, 'ENOSPC');
      assert.deepEqual(noSpace.artifacts, []);
      assert(
        (await readdir(manager.jobDirectory(noSpace.jobId))).every(
          (name) => !name.endsWith('.partial'),
        ),
      );
    } finally {
      await manager.close();
      await rm(scratch, { recursive: true, force: true });
      await cleanupTestRoot(root);
    }

    const quotaRoot = await createTestRoot();
    const quotaScratch = await createTestRoot();
    const quotaGuard = await makeGuard([quotaRoot]);
    const quotaManager = new ArtifactJobManager({
      ...getSnapshotConfig(),
      scratchDirectory: quotaScratch,
      ephemeralScratch: false,
      maxRecordBytes: 16 * 1024,
      maxRawPartBytes: 24 * 1024,
      maxJobRawBytes: 24 * 1024,
      maxJobArtifactBytes: 24 * 1024,
      scratchQuotaBytes: 4096,
    });
    try {
      const submitted = await quotaManager.submit({
        kind: 'snapshot',
        idempotencyKey: 'scratch-cap-key',
        fingerprint: fingerprintJobInput('scratch-cap'),
        sourceRoot: quotaRoot,
        sourceRootId: 'root-test',
        input: {},
        run: async (ctx) =>
          writeSnapshotFromRecords(
            (async function* () {
              yield {
                rootId: 'root-test',
                relativePath: `${'x'.repeat(5000)}.txt`,
                name: `${'x'.repeat(5000)}.txt`,
                extension: '.txt',
                length: 1,
                lastWriteTime: '2026-09-20T00:00:00.000Z',
              };
            })(),
            ctx,
            { includeHidden: false, includeIgnored: false },
          ),
      });
      const failed = await waitForTerminal(() =>
        quotaManager.getJob(submitted.job.jobId, quotaGuard),
      );
      assert.equal(failed.state, 'failed');
      assert.match(failed.stopReason ?? '', /scratch quota/u);
      assert.deepEqual(failed.artifacts, []);
    } finally {
      await quotaManager.close();
      await rm(quotaScratch, { recursive: true, force: true });
      await cleanupTestRoot(quotaRoot);
    }
  });

  it('expires artifacts explicitly and denies status after source access narrows', async () => {
    const root = await createTestRoot();
    const otherRoot = await createTestRoot();
    const scratch = await createTestRoot();
    await writeTestFile(root, 'probe.txt', 'probe');
    const guard = await makeGuard([root]);
    const fs = new GuardedFileSystem(guard);
    const config = {
      ...getSnapshotConfig(),
      scratchDirectory: scratch,
      ephemeralScratch: false,
      resultTtlMs: 200,
      cleanupIntervalMs: 10,
    };
    let enteredRead!: () => void;
    let releaseRead!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      enteredRead = resolve;
    });
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const manager = new ArtifactJobManager(config, {
      readArtifact: async (path) => {
        enteredRead();
        await readGate;
        return readFile(path);
      },
    });
    try {
      const submitted = await manager.submit({
        kind: 'snapshot',
        idempotencyKey: 'expiry-key',
        fingerprint: fingerprintJobInput('expiry'),
        sourceRoot: root,
        sourceRootId: 'root-test',
        input: {},
        run: async (ctx) =>
          runSnapshotPipeline(fs, root, { includeHidden: false, includeIgnored: false }, ctx),
      });
      const completed = await waitForTerminal(() => manager.getJob(submitted.job.jobId, guard));
      assert.equal(completed.state, 'completed');
      const artifactId = completed.manifestArtifactId;
      assert(artifactId);

      const narrowed = await makeGuard([otherRoot]);
      await assert.rejects(manager.getJob(submitted.job.jobId, narrowed), /Outside allowed/u);

      const activeRead = manager.getArtifact(artifactId, guard);
      await readStarted;
      await delay(225);
      await manager.cleanupExpired();
      assert.equal((await manager.getJob(submitted.job.jobId, guard)).resultExpired, undefined);
      releaseRead();
      assert((await activeRead).bytes.length > 0);
      const expired = await manager.getJob(submitted.job.jobId, guard);
      assert.equal(expired.resultExpired, true);
      await assert.rejects(manager.getArtifact(artifactId, guard), /expired|not found/u);
    } finally {
      releaseRead();
      await manager.close();
      await rm(scratch, { recursive: true, force: true });
      await cleanupTestRoot(root);
      await cleanupTestRoot(otherRoot);
    }
  });
});
