import type { CallToolResult } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
      const deadline = Date.now() + 10_000;
      for (;;) {
        const status = await client.callTool({ name: 'job_status', arguments: { jobId } });
        if (meta(status).state === 'completed') break;
        assert.notEqual(meta(status).state, 'failed');
        assert(Date.now() < deadline, 'HTTP snapshot did not finish');
        await delay(10);
      }
      await client.close();
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

  it('fails boundedly when final ZIP or scratch quota cannot contain a part', async () => {
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
    } finally {
      await manager.close();
      await rm(scratch, { recursive: true, force: true });
      await cleanupTestRoot(root);
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
      resultTtlMs: 100,
      cleanupIntervalMs: 10,
    };
    const manager = new ArtifactJobManager(config);
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

      await delay(125);
      const expired = await manager.getJob(submitted.job.jobId, guard);
      assert.equal(expired.resultExpired, true);
      await assert.rejects(manager.getArtifact(artifactId, guard), /expired|not found/u);
    } finally {
      await manager.close();
      await rm(scratch, { recursive: true, force: true });
      await cleanupTestRoot(root);
      await cleanupTestRoot(otherRoot);
    }
  });
});
