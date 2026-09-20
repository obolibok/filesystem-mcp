import type { CallToolResult } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { parse } from 'csv-parse/sync';
import yauzl from 'yauzl';
import { ZipFile } from 'yazl';

import { verifySnapshotZip } from '../scripts/snapshot-benchmark/verify.mjs';
import { GuardedFileSystem } from '../src/core/fs.js';
import { ArtifactJobManager, fingerprintJobInput } from '../src/core/job-manager.js';
import type { StoredJob } from '../src/core/job-types.js';
import { emptySnapshotCounters } from '../src/core/job-types.js';
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
  // Keep byte-returning assertions on the same whole-archive/CRC gate as the
  // benchmark verifier; the extraction below is only for inspecting CSV bytes.
  await verifySnapshotZip(bytes, false);
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

async function makeZip(entries: readonly (readonly [string, string])[]): Promise<Buffer> {
  const zip = new ZipFile();
  for (const [name, content] of entries) zip.addBuffer(Buffer.from(content), name);
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream as AsyncIterable<Buffer | Uint8Array>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
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
      else if (entry.isFile()) total += (await stat(path)).size;
    }
  }
  return total;
}

function storedJob(jobId: string, sourceRoot: string, overrides: Partial<StoredJob>): StoredJob {
  return {
    schemaVersion: 1,
    jobId,
    kind: 'snapshot',
    idempotencyKey: `persisted-${jobId}`,
    fingerprint: fingerprintJobInput(jobId),
    sourceRoot,
    sourceRootId: 'root-test',
    input: {},
    state: 'completed',
    phase: 'completed',
    createdAt: new Date(0).toISOString(),
    finishedAt: new Date(0).toISOString(),
    complete: true,
    counters: emptySnapshotCounters(),
    errors: [],
    artifacts: [],
    ...overrides,
  };
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

      const lostResponseArgs = {
        path: root,
        idempotencyKey: `http-lost-response-${randomUUID()}`,
      };
      let dropSnapshotResponse = true;
      const lossyClient = await http.makeClient(
        'snapshot-http-lossy',
        undefined,
        async (response, _url, init) => {
          const body = typeof init?.body === 'string' ? init.body : '';
          if (dropSnapshotResponse && body.includes('"name":"snapshot"')) {
            dropSnapshotResponse = false;
            throw new Error('synthetic response loss after durable acceptance');
          }
          return response;
        },
      );
      await assert.rejects(
        lossyClient.callTool({ name: 'snapshot', arguments: lostResponseArgs }),
        /response loss|fetch failed|terminated/u,
      );
      await lossyClient.close().catch(() => undefined);

      const recoveryClient = await http.makeClient('snapshot-http-recovery');
      const recovered = await recoveryClient.callTool({
        name: 'snapshot',
        arguments: lostResponseArgs,
      });
      assert.equal(meta(recovered).reused, true);
      const recoveredJobId = meta(recovered).job?.jobId;
      assert(recoveredJobId);
      const recoveredDeadline = Date.now() + 10_000;
      for (;;) {
        const status = await recoveryClient.callTool({
          name: 'job_status',
          arguments: { jobId: recoveredJobId },
        });
        if (meta(status).state === 'completed') break;
        assert.notEqual(meta(status).state, 'failed', firstTextBlock(status).text);
        assert(Date.now() < recoveredDeadline, 'response-loss recovery did not finish');
        await delay(10);
      }
      await recoveryClient.close();

      const timeoutArgs = {
        path: root,
        idempotencyKey: `http-client-timeout-${randomUUID()}`,
      };
      let delaySnapshotResponse = true;
      const timeoutClient = await http.makeClient(
        'snapshot-http-timeout',
        undefined,
        async (response, _url, init) => {
          const body = typeof init?.body === 'string' ? init.body : '';
          if (delaySnapshotResponse && body.includes('"name":"snapshot"')) {
            delaySnapshotResponse = false;
            await delay(100);
          }
          return response;
        },
      );
      await assert.rejects(
        timeoutClient.callTool({ name: 'snapshot', arguments: timeoutArgs }, { timeout: 10 }),
        /timeout|timed out/u,
      );
      await timeoutClient.close().catch(() => undefined);

      const timeoutRecoveryClient = await http.makeClient('snapshot-http-timeout-recovery');
      const timeoutRecovered = await timeoutRecoveryClient.callTool({
        name: 'snapshot',
        arguments: timeoutArgs,
      });
      assert.equal(meta(timeoutRecovered).reused, true);
      const timeoutJobId = meta(timeoutRecovered).job?.jobId;
      assert(timeoutJobId);
      const timeoutDeadline = Date.now() + 10_000;
      for (;;) {
        const status = await timeoutRecoveryClient.callTool({
          name: 'job_status',
          arguments: { jobId: timeoutJobId },
        });
        if (meta(status).state === 'completed') break;
        assert.notEqual(meta(status).state, 'failed', firstTextBlock(status).text);
        assert(Date.now() < timeoutDeadline, 'client-timeout recovery did not finish');
        await delay(10);
      }
      await timeoutRecoveryClient.close();
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

  it('preserves nested gitignore negation after repeated cache refreshes', async () => {
    const root = await createTestRoot();
    const scratch = await createTestRoot();
    await writeFile(join(root, '.gitignore'), 'ignored/*\n!ignored/keep/\n', 'utf8');
    await mkdir(join(root, 'ignored', 'keep'), { recursive: true });
    await mkdir(join(root, 'ignored', 'drop'), { recursive: true });
    await writeFile(join(root, 'ignored', 'keep', '.gitignore'), '*.tmp\n!important.tmp\n');
    await writeFile(join(root, 'ignored', 'keep', 'important.tmp'), 'kept');
    await writeFile(join(root, 'ignored', 'keep', 'ordinary.txt'), 'kept');
    await writeFile(join(root, 'ignored', 'drop', 'not-kept.txt'), 'ignored');
    for (let index = 0; index < 600; index += 1) {
      await writeFile(join(root, 'ignored', 'keep', `ignored-${String(index)}.tmp`), 'ignored');
    }
    const guard = await makeGuard([root]);
    const fs = new GuardedFileSystem(guard);
    const manager = new ArtifactJobManager({
      ...getSnapshotConfig(),
      scratchDirectory: scratch,
      ephemeralScratch: false,
    });
    try {
      const submitted = await manager.submit({
        kind: 'snapshot',
        idempotencyKey: 'nested-ignore-key',
        fingerprint: fingerprintJobInput('nested-ignore'),
        sourceRoot: root,
        sourceRootId: 'root-test',
        input: {},
        run: async (ctx) =>
          runSnapshotPipeline(fs, root, { includeHidden: true, includeIgnored: false }, ctx),
      });
      const completed = await waitForTerminal(() => manager.getJob(submitted.job.jobId, guard));
      assert.equal(completed.state, 'completed');
      assert.equal(completed.counters.filesWritten, 4);
      assert(completed.counters.ignoredExcluded >= 601);
    } finally {
      await manager.close();
      await rm(scratch, { recursive: true, force: true });
      await cleanupTestRoot(root);
    }
  });

  it('fails the job when the configured walk-depth cap is exceeded', async () => {
    const root = await createTestRoot();
    const scratch = await createTestRoot();
    let directory = root;
    for (let depth = 0; depth < 10; depth += 1) {
      directory = join(directory, `depth-${String(depth)}`);
      await mkdir(directory);
    }
    await writeFile(join(directory, 'too-deep.txt'), 'deep');
    const guard = await makeGuard([root]);
    const fs = new GuardedFileSystem(guard);
    const manager = new ArtifactJobManager({
      ...getSnapshotConfig(),
      scratchDirectory: scratch,
      ephemeralScratch: false,
      maxWalkDepth: 8,
    });
    try {
      const submitted = await manager.submit({
        kind: 'snapshot',
        idempotencyKey: 'walk-depth-key',
        fingerprint: fingerprintJobInput('walk-depth'),
        sourceRoot: root,
        sourceRootId: 'root-test',
        input: {},
        run: async (ctx) =>
          runSnapshotPipeline(fs, root, { includeHidden: false, includeIgnored: false }, ctx),
      });
      const failed = await waitForTerminal(() => manager.getJob(submitted.job.jobId, guard));
      assert.equal(failed.state, 'failed');
      assert.match(failed.stopReason ?? '', /walk depth/u);
      assert.deepEqual(failed.artifacts, []);
      assert.equal(failed.manifestArtifactId, undefined);
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

  it('round-trips quoted CSV with an independent parser across forced part boundaries', async () => {
    const root = await createTestRoot();
    const scratch = await createTestRoot();
    const guard = await makeGuard([root]);
    const manager = new ArtifactJobManager({
      ...getSnapshotConfig(),
      scratchDirectory: scratch,
      ephemeralScratch: false,
      maxRawPartBytes: 240,
      maxZipBytes: 64 * 1024,
      maxDeliveryBytes: 64 * 1024,
      maxFileSizeBytes: 64 * 1024,
    });
    const records: SnapshotRecord[] = Array.from({ length: 12 }, (_, index) => ({
      rootId: 'root-test',
      relativePath: `folder-${String(index)}/a,"${String(index)}"\nline.txt`,
      name: `a,"${String(index)}"\nline.txt`,
      extension: '.txt',
      length: index,
      lastWriteTime: '2026-09-20T10:11:12.000Z',
    }));
    try {
      const submitted = await manager.submit({
        kind: 'snapshot',
        idempotencyKey: 'csv-boundary-key',
        fingerprint: fingerprintJobInput(records),
        sourceRoot: root,
        sourceRootId: 'root-test',
        input: {},
        run: async (ctx) =>
          writeSnapshotFromRecords(
            (async function* () {
              yield* records;
            })(),
            ctx,
            { includeHidden: false, includeIgnored: false },
          ),
      });
      const completed = await waitForTerminal(() => manager.getJob(submitted.job.jobId, guard));
      assert.equal(completed.state, 'completed');
      const parts = completed.artifacts.filter((artifact) => artifact.kind === 'snapshot-part');
      assert(parts.length > 1);
      const observed: Record<string, string>[] = [];
      for (const part of parts) {
        const extracted = await unzipSingle(
          (await manager.getArtifact(part.artifactId, guard)).bytes,
        );
        const parsedRows: Record<string, string>[] = parse(extracted.bytes, {
          bom: false,
          columns: true,
          relax_column_count: false,
        });
        observed.push(...parsedRows);
      }
      assert.deepEqual(
        observed.map((record) => record['RelativePath']),
        records.map((record) => record.relativePath),
      );
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

  it('removes artifacts when cancellation races on either side of the commit rename', async () => {
    for (const stage of ['before', 'after'] as const) {
      const root = await createTestRoot();
      const scratch = await createTestRoot();
      const guard = await makeGuard([root]);
      let entered!: () => void;
      let release!: () => void;
      const enteredHook = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const releaseHook = new Promise<void>((resolve) => {
        release = resolve;
      });
      const hook = async () => {
        entered();
        await releaseHook;
      };
      const manager = new ArtifactJobManager(
        {
          ...getSnapshotConfig(),
          scratchDirectory: scratch,
          ephemeralScratch: false,
        },
        stage === 'before' ? { beforeArtifactRename: hook } : { afterArtifactRename: hook },
      );
      try {
        const submitted = await manager.submit({
          kind: 'snapshot',
          idempotencyKey: `cancel-commit-${stage}`,
          fingerprint: fingerprintJobInput(stage),
          sourceRoot: root,
          sourceRootId: 'root-test',
          input: {},
          run: async (ctx) => {
            const bytes = Buffer.from('committing artifact');
            const partial = ctx.tempPath('commit-race');
            ctx.reserveDisk(bytes.length);
            await writeFile(partial, bytes);
            const artifact = await ctx.commitArtifact(partial, {
              kind: 'snapshot-part',
              name: 'race.zip',
              mimeType: 'application/zip',
              size: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex'),
            });
            return artifact.artifactId;
          },
        });
        await enteredHook;
        const cancelled = await manager.cancel(submitted.job.jobId, guard);
        assert.equal(cancelled.state, 'cancelled');
        release();
        const deadline = Date.now() + 2000;
        for (;;) {
          const names = await readdir(manager.jobDirectory(submitted.job.jobId));
          if (names.every((name) => name === 'job.json')) break;
          assert(Date.now() < deadline, `${stage}-rename cancellation left an artifact`);
          await delay(5);
        }
        const final = await manager.getJob(submitted.job.jobId, guard);
        assert.equal(final.state, 'cancelled');
        assert.deepEqual(final.artifacts, []);
      } finally {
        release();
        await manager.close();
        await rm(scratch, { recursive: true, force: true });
        await cleanupTestRoot(root);
      }
    }
  });

  it('serializes concurrent expiry cleanup without undercounting scratch usage', async () => {
    const root = await createTestRoot();
    const scratch = await createTestRoot();
    const guard = await makeGuard([root]);
    const quota = 1024 * 1024;
    const artifactBytes = Buffer.alloc(256 * 1024, 0x61);
    const now = Date.now();
    for (const expired of [true, false]) {
      const jobId = randomUUID();
      const artifactId = randomUUID();
      const fileName = `${artifactId}.zip`;
      const directory = join(scratch, jobId);
      await mkdir(directory);
      await writeFile(join(directory, fileName), artifactBytes);
      const job = storedJob(jobId, root, {
        idempotencyKey: `quota-${expired ? 'expired' : 'retained'}`,
        finishedAt: new Date(expired ? 0 : now).toISOString(),
        resultExpiresAt: new Date(expired ? 0 : now + 60_000).toISOString(),
        artifacts: [
          {
            artifactId,
            kind: 'snapshot-part',
            name: 'part.zip',
            mimeType: 'application/zip',
            fileName,
            size: artifactBytes.length,
            sha256: createHash('sha256').update(artifactBytes).digest('hex'),
          },
        ],
      });
      await writeFile(join(directory, 'job.json'), `${JSON.stringify(job)}\n`);
    }
    const manager = new ArtifactJobManager({
      ...getSnapshotConfig(),
      scratchDirectory: scratch,
      ephemeralScratch: false,
      scratchQuotaBytes: quota,
      resultTtlMs: 10,
    });
    try {
      await manager.initialize();
      await Promise.all([
        manager.cleanupExpired(),
        manager.cleanupExpired(),
        manager.cleanupExpired(),
      ]);
      const onDiskBeforeProbe = await directoryBytes(scratch);
      const reservation = quota - onDiskBeforeProbe + 16 * 1024;
      const probe = await manager.submit({
        kind: 'snapshot',
        idempotencyKey: 'quota-accounting-probe',
        fingerprint: fingerprintJobInput('quota-accounting-probe'),
        sourceRoot: root,
        sourceRootId: 'root-test',
        input: {},
        run: async (ctx) => {
          ctx.reserveDisk(reservation);
          ctx.releaseDisk(reservation);
          return randomUUID();
        },
      });
      const failed = await waitForTerminal(() => manager.getJob(probe.job.jobId, guard));
      assert.equal(failed.state, 'failed');
      assert.match(failed.stopReason ?? '', /scratch quota/u);
      assert((await directoryBytes(scratch)) + reservation > quota);
    } finally {
      await manager.close();
      await rm(scratch, { recursive: true, force: true });
      await cleanupTestRoot(root);
    }
  });

  it('reconciles an orphan final artifact safely after a failed deletion and restart', async () => {
    const root = await createTestRoot();
    const scratch = await createTestRoot();
    const guard = await makeGuard([root]);
    const quota = 1024 * 1024;
    const jobId = randomUUID();
    const jobDirectory = join(scratch, jobId);
    const orphanPath = join(jobDirectory, `${randomUUID()}.zip`);
    const foreignPath = join(jobDirectory, 'foreign.txt');
    await mkdir(jobDirectory);
    await writeFile(orphanPath, Buffer.alloc(256 * 1024, 0x62));
    await writeFile(foreignPath, 'must survive');
    await writeFile(
      join(jobDirectory, 'job.json'),
      `${JSON.stringify(storedJob(jobId, root, { state: 'running', phase: 'compressing' }))}\n`,
    );
    let failOrphanDeletion = true;
    const config = {
      ...getSnapshotConfig(),
      scratchDirectory: scratch,
      ephemeralScratch: false,
      scratchQuotaBytes: quota,
    };
    const manager = new ArtifactJobManager(config, {
      unlinkFile: async (path) => {
        if (path === orphanPath && failOrphanDeletion) {
          failOrphanDeletion = false;
          throw Object.assign(new Error('synthetic orphan delete failure'), { code: 'EACCES' });
        }
        await unlink(path);
      },
    });
    const reservation = 800 * 1024;
    try {
      await manager.initialize();
      assert.equal((await manager.getJob(jobId, guard)).state, 'interrupted');
      const blocked = await manager.submit({
        kind: 'snapshot',
        idempotencyKey: 'orphan-quota-blocked',
        fingerprint: fingerprintJobInput('orphan-quota-blocked'),
        sourceRoot: root,
        sourceRootId: 'root-test',
        input: {},
        run: async (ctx) => {
          ctx.reserveDisk(reservation);
          ctx.releaseDisk(reservation);
          return randomUUID();
        },
      });
      const failed = await waitForTerminal(() => manager.getJob(blocked.job.jobId, guard));
      assert.equal(failed.state, 'failed');
      assert.match(failed.stopReason ?? '', /scratch quota/u);
      assert.equal(await readFile(foreignPath, 'utf8'), 'must survive');
    } finally {
      await manager.close();
    }

    const restarted = new ArtifactJobManager(config);
    try {
      await restarted.initialize();
      await assert.rejects(stat(orphanPath), /ENOENT/u);
      assert.equal(await readFile(foreignPath, 'utf8'), 'must survive');
      const admitted = await restarted.submit({
        kind: 'snapshot',
        idempotencyKey: 'orphan-quota-recovered',
        fingerprint: fingerprintJobInput('orphan-quota-recovered'),
        sourceRoot: root,
        sourceRootId: 'root-test',
        input: {},
        run: async (ctx) => {
          ctx.reserveDisk(reservation);
          ctx.releaseDisk(reservation);
          return randomUUID();
        },
      });
      assert.equal(
        (await waitForTerminal(() => restarted.getJob(admitted.job.jobId, guard))).state,
        'completed',
      );
    } finally {
      await restarted.close();
      await rm(scratch, { recursive: true, force: true });
      await cleanupTestRoot(root);
    }
  });

  it('keeps startup available when expired artifact deletion is temporarily blocked', async () => {
    for (const code of ['EACCES', 'EPERM'] as const) {
      const root = await createTestRoot();
      const scratch = await createTestRoot();
      const guard = await makeGuard([root]);
      const quota = 256 * 1024;
      const artifactBytes = Buffer.alloc(64 * 1024, 0x64);
      const jobId = randomUUID();
      const artifactId = randomUUID();
      const fileName = `${artifactId}.zip`;
      const directory = join(scratch, jobId);
      const artifactPath = join(directory, fileName);
      await mkdir(directory);
      await writeFile(artifactPath, artifactBytes);
      await writeFile(
        join(directory, 'job.json'),
        `${JSON.stringify(
          storedJob(jobId, root, {
            idempotencyKey: `startup-expiry-${code}`,
            finishedAt: new Date().toISOString(),
            resultExpiresAt: new Date(0).toISOString(),
            artifacts: [
              {
                artifactId,
                kind: 'snapshot-part',
                name: 'expired.zip',
                mimeType: 'application/zip',
                fileName,
                size: artifactBytes.length,
                sha256: createHash('sha256').update(artifactBytes).digest('hex'),
              },
            ],
          }),
        )}\n`,
      );
      let artifactDeleteAttempts = 0;
      const manager = new ArtifactJobManager(
        {
          ...getSnapshotConfig(),
          scratchDirectory: scratch,
          ephemeralScratch: false,
          scratchQuotaBytes: quota,
          resultTtlMs: 60_000,
          cleanupIntervalMs: 60_000,
        },
        {
          unlinkFile: async (path) => {
            if (path === artifactPath) {
              artifactDeleteAttempts += 1;
              if (artifactDeleteAttempts === 1) {
                throw Object.assign(new Error(`synthetic ${code} startup lock`), { code });
              }
            }
            await unlink(path);
          },
        },
      );
      try {
        await manager.initialize();
        await manager.initialize();
        assert.equal(artifactDeleteAttempts, 1);
        assert.equal((await stat(artifactPath)).size, artifactBytes.length);
        await assert.rejects(manager.getArtifact(artifactId, guard), /expired/u);
        assert.equal(artifactDeleteAttempts, 1);

        const ordinary = await manager.submit({
          kind: 'snapshot',
          idempotencyKey: `startup-available-${code}`,
          fingerprint: fingerprintJobInput(`startup-available-${code}`),
          sourceRoot: root,
          sourceRootId: 'root-test',
          input: {},
          run: async (ctx) => {
            ctx.reserveDisk(4096);
            ctx.releaseDisk(4096);
            return randomUUID();
          },
        });
        assert.equal(
          (await waitForTerminal(() => manager.getJob(ordinary.job.jobId, guard))).state,
          'completed',
        );

        const onDiskBeforeProbe = await directoryBytes(scratch);
        const reservation = quota - onDiskBeforeProbe + 4096;
        const blocked = await manager.submit({
          kind: 'snapshot',
          idempotencyKey: `startup-quota-blocked-${code}`,
          fingerprint: fingerprintJobInput(`startup-quota-blocked-${code}`),
          sourceRoot: root,
          sourceRootId: 'root-test',
          input: {},
          run: async (ctx) => {
            ctx.reserveDisk(reservation);
            ctx.releaseDisk(reservation);
            return randomUUID();
          },
        });
        const failed = await waitForTerminal(() => manager.getJob(blocked.job.jobId, guard));
        assert.equal(failed.state, 'failed');
        assert.match(failed.stopReason ?? '', /scratch quota/u);
        assert.equal(artifactDeleteAttempts, 1);

        await manager.cleanupExpired();
        assert.equal(artifactDeleteAttempts, 2);
        await assert.rejects(stat(artifactPath), /ENOENT/u);
        await assert.rejects(manager.getArtifact(artifactId, guard), /expired|not found/u);

        const admitted = await manager.submit({
          kind: 'snapshot',
          idempotencyKey: `startup-quota-recovered-${code}`,
          fingerprint: fingerprintJobInput(`startup-quota-recovered-${code}`),
          sourceRoot: root,
          sourceRootId: 'root-test',
          input: {},
          run: async (ctx) => {
            ctx.reserveDisk(reservation);
            ctx.releaseDisk(reservation);
            return randomUUID();
          },
        });
        assert.equal(
          (await waitForTerminal(() => manager.getJob(admitted.job.jobId, guard))).state,
          'completed',
        );
        await manager.cleanupExpired();
        assert.equal(artifactDeleteAttempts, 2);
      } finally {
        await manager.close();
        await rm(scratch, { recursive: true, force: true });
        await cleanupTestRoot(root);
      }
    }
  });

  it('keeps scratch initialization failures fatal', async () => {
    const root = await createTestRoot();
    const scratchFile = join(root, 'not-a-directory');
    await writeFile(scratchFile, 'file');
    const manager = new ArtifactJobManager({
      ...getSnapshotConfig(),
      scratchDirectory: scratchFile,
      ephemeralScratch: false,
    });
    try {
      await assert.rejects(manager.initialize(), (error: NodeJS.ErrnoException) => {
        assert.equal(error.code, 'EEXIST');
        return true;
      });
    } finally {
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

  it('contains a ZIP producer read fault and continues running later jobs', async () => {
    const root = await createTestRoot();
    const scratch = await createTestRoot();
    const guard = await makeGuard([root]);
    const manager = new ArtifactJobManager({
      ...getSnapshotConfig(),
      scratchDirectory: scratch,
      ephemeralScratch: false,
    });
    const record: SnapshotRecord = {
      rootId: 'root-test',
      relativePath: 'fault.txt',
      name: 'fault.txt',
      extension: '.txt',
      length: 5,
      lastWriteTime: '2026-09-20T00:00:00.000Z',
    };
    const records = async function* () {
      yield record;
    };
    try {
      const faulted = await manager.submit({
        kind: 'snapshot',
        idempotencyKey: 'zip-read-fault-key',
        fingerprint: fingerprintJobInput('zip-read-fault'),
        sourceRoot: root,
        sourceRootId: 'root-test',
        input: {},
        run: async (ctx) =>
          writeSnapshotFromRecords(
            records(),
            ctx,
            { includeHidden: false, includeIgnored: false },
            { beforeCompress: unlink },
          ),
      });
      const failed = await waitForTerminal(() => manager.getJob(faulted.job.jobId, guard));
      assert.equal(failed.state, 'failed');
      assert.deepEqual(failed.artifacts, []);
      const cleanupDeadline = Date.now() + 2000;
      for (;;) {
        const names = await readdir(manager.jobDirectory(failed.jobId));
        if (names.every((name) => name === 'job.json')) break;
        assert(Date.now() < cleanupDeadline, 'faulted ZIP job left a partial artifact');
        await delay(5);
      }

      const healthy = await manager.submit({
        kind: 'snapshot',
        idempotencyKey: 'after-zip-read-fault-key',
        fingerprint: fingerprintJobInput('after-zip-read-fault'),
        sourceRoot: root,
        sourceRootId: 'root-test',
        input: {},
        run: async (ctx) =>
          writeSnapshotFromRecords(records(), ctx, {
            includeHidden: false,
            includeIgnored: false,
          }),
      });
      assert.equal(
        (await waitForTerminal(() => manager.getJob(healthy.job.jobId, guard))).state,
        'completed',
      );
    } finally {
      await manager.close();
      await rm(scratch, { recursive: true, force: true });
      await cleanupTestRoot(root);
    }
  });

  it('enforces delivery and general-file caps before publishing any artifact', async () => {
    const makeRecords = () =>
      (async function* () {
        for (let index = 0; index < 3000; index += 1) {
          const noise = createHash('sha256').update(String(index)).digest('hex');
          yield {
            rootId: 'root-test',
            relativePath: `${noise}-${String(index)}.txt`,
            name: `${noise}.txt`,
            extension: '.txt',
            length: index,
            lastWriteTime: '2026-09-20T00:00:00.000Z',
          };
        }
      })();
    for (const cap of ['delivery', 'general-file'] as const) {
      const root = await createTestRoot();
      const scratch = await createTestRoot();
      const guard = await makeGuard([root]);
      const manager = new ArtifactJobManager({
        ...getSnapshotConfig(),
        scratchDirectory: scratch,
        ephemeralScratch: false,
        maxRawPartBytes: 1024 * 1024,
        maxZipBytes: 1024 * 1024,
        maxDeliveryBytes: cap === 'delivery' ? 64 * 1024 : 1024 * 1024,
        maxFileSizeBytes: cap === 'general-file' ? 64 * 1024 : 1024 * 1024,
        maxJobRawBytes: 4 * 1024 * 1024,
        maxJobArtifactBytes: 4 * 1024 * 1024,
        scratchQuotaBytes: 8 * 1024 * 1024,
      });
      try {
        const submitted = await manager.submit({
          kind: 'snapshot',
          idempotencyKey: `effective-cap-${cap}`,
          fingerprint: fingerprintJobInput(cap),
          sourceRoot: root,
          sourceRootId: 'root-test',
          input: {},
          run: async (ctx) =>
            writeSnapshotFromRecords(makeRecords(), ctx, {
              includeHidden: false,
              includeIgnored: false,
            }),
        });
        const failed = await waitForTerminal(() => manager.getJob(submitted.job.jobId, guard));
        assert.equal(failed.state, 'failed');
        assert.match(failed.stopReason ?? '', /effective deliverable cap/u);
        assert.deepEqual(failed.artifacts, []);
        assert.equal(failed.manifestArtifactId, undefined);
      } finally {
        await manager.close();
        await rm(scratch, { recursive: true, force: true });
        await cleanupTestRoot(root);
      }
    }
  });

  it('rechecks the current general file limit when fetching a stored artifact', async () => {
    const root = await createTestRoot();
    const scratch = await createTestRoot();
    const guard = await makeGuard([root]);
    const jobId = randomUUID();
    const artifactId = randomUUID();
    const directory = join(scratch, jobId);
    const fileName = `${artifactId}.zip`;
    const bytes = Buffer.alloc(1024 * 1024 + 1, 0x63);
    await mkdir(directory);
    await writeFile(join(directory, fileName), bytes);
    await writeFile(
      join(directory, 'job.json'),
      `${JSON.stringify(
        storedJob(jobId, root, {
          resultExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          artifacts: [
            {
              artifactId,
              kind: 'snapshot-part',
              name: 'part.zip',
              mimeType: 'application/zip',
              fileName,
              size: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex'),
            },
          ],
        }),
      )}\n`,
    );
    const manager = new ArtifactJobManager({
      ...getSnapshotConfig(),
      scratchDirectory: scratch,
      ephemeralScratch: false,
      maxDeliveryBytes: 2 * 1024 * 1024,
      maxFileSizeBytes: 2 * 1024 * 1024,
      scratchQuotaBytes: 4 * 1024 * 1024,
    });
    const savedLimit = process.env['FS_MAX_FILE_SIZE'];
    try {
      await manager.initialize();
      process.env['FS_MAX_FILE_SIZE'] = String(1024 * 1024);
      await assert.rejects(manager.getArtifact(artifactId, guard), /delivery limit/u);
    } finally {
      if (savedLimit === undefined) Reflect.deleteProperty(process.env, 'FS_MAX_FILE_SIZE');
      else process.env['FS_MAX_FILE_SIZE'] = savedLimit;
      await manager.close();
      await rm(scratch, { recursive: true, force: true });
      await cleanupTestRoot(root);
    }
  });

  it('verifies the complete ZIP, single-entry shape, parser stream, and CRC', async () => {
    const validCsv = `${SNAPSHOT_CSV_HEADER}root,a.txt,a.txt,.txt,1,2026-09-20T00:00:00.000Z\r\n`;
    const valid = await makeZip([['snapshot-00001.csv', validCsv]]);
    assert.equal((await verifySnapshotZip(valid, true)).rows, 1);

    const empty = await makeZip([['snapshot-00001.csv', SNAPSHOT_CSV_HEADER]]);
    assert.equal((await verifySnapshotZip(empty, false)).rows, 0);
    const wrongEmptyHeader = await makeZip([
      ['snapshot-00001.csv', 'Wrong,RelativePath,Name,Extension,Length,LastWriteTime\r\n'],
    ]);
    await assert.rejects(verifySnapshotZip(wrongEmptyHeader, false));

    const extraEntry = await makeZip([
      ['snapshot-00001.csv', validCsv],
      ['unexpected.csv', validCsv],
    ]);
    await assert.rejects(verifySnapshotZip(extraEntry, false), /exactly one/u);

    const central = valid.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    assert(central >= 0);
    const badCrc = Buffer.from(valid);
    badCrc.writeUInt32LE((badCrc.readUInt32LE(central + 16) ^ 0xffff_ffff) >>> 0, central + 16);
    await assert.rejects(verifySnapshotZip(badCrc, false), /CRC-32/u);

    await assert.rejects(verifySnapshotZip(valid.subarray(0, valid.length - 12), false));

    const corruptCompressed = Buffer.from(valid);
    const fileNameLength = corruptCompressed.readUInt16LE(26);
    const extraLength = corruptCompressed.readUInt16LE(28);
    const compressedSize = corruptCompressed.readUInt32LE(central + 20);
    const compressedStart = 30 + fileNameLength + extraLength;
    const corruptOffset = compressedStart + Math.floor(compressedSize / 2);
    corruptCompressed.writeUInt8(corruptCompressed.readUInt8(corruptOffset) ^ 0xff, corruptOffset);
    await assert.rejects(verifySnapshotZip(corruptCompressed, false));
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
      await assert.rejects(manager.cancel(submitted.job.jobId, narrowed), /Outside allowed/u);
      await assert.rejects(manager.getArtifact(artifactId, narrowed), /Outside allowed/u);

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

  it('rechecks narrowed source access for cancel and fetch after restart', async () => {
    const root = await createTestRoot();
    const otherRoot = await createTestRoot();
    const scratch = await createTestRoot();
    const guard = await makeGuard([root]);
    const narrowed = await makeGuard([otherRoot]);
    const config = {
      ...getSnapshotConfig(),
      scratchDirectory: scratch,
      ephemeralScratch: false,
      resultTtlMs: 60_000,
    };
    const manager = new ArtifactJobManager(config);
    let jobId: string;
    let artifactId: string;
    try {
      const submitted = await manager.submit({
        kind: 'snapshot',
        idempotencyKey: 'narrowed-restart-key',
        fingerprint: fingerprintJobInput('narrowed-restart'),
        sourceRoot: root,
        sourceRootId: 'root-test',
        input: {},
        run: async (ctx) =>
          writeSnapshotFromRecords(
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
          ),
      });
      jobId = submitted.job.jobId;
      const completed = await waitForTerminal(() => manager.getJob(jobId, guard));
      artifactId = completed.manifestArtifactId ?? '';
      assert(artifactId);
      await manager.close();

      const restarted = new ArtifactJobManager(config);
      try {
        await assert.rejects(restarted.cancel(jobId, narrowed), /Outside allowed/u);
        await assert.rejects(restarted.getArtifact(artifactId, narrowed), /Outside allowed/u);
        assert.equal((await restarted.getJob(jobId, guard)).state, 'completed');
      } finally {
        await restarted.close();
      }
    } finally {
      await manager.close();
      await rm(scratch, { recursive: true, force: true });
      await cleanupTestRoot(root);
      await cleanupTestRoot(otherRoot);
    }
  });
});
