import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { ErrorCode, FsError } from '../src/core/errors.js';
import { ArtifactJobManager } from '../src/core/job-manager.js';
import type { StoredJob } from '../src/core/job-types.js';
import { getSnapshotConfig } from '../src/core/snapshot-config.js';
import { jobStatusValue } from '../src/tools/job-shared.js';
import { cleanupTestRoot, createTestRoot, makeGuard } from './helpers.js';

function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function waitForState(
  manager: ArtifactJobManager,
  jobId: string,
  guard: Awaited<ReturnType<typeof makeGuard>>,
  state: string,
): Promise<StoredJob> {
  const deadline = Date.now() + 12_000;
  for (;;) {
    const job = await manager.getJob(jobId, guard);
    if (job.state === state) return job;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${state}; got ${job.state}`);
    await delay(10);
  }
}

async function waitForDurable(path: string, state: string): Promise<StoredJob> {
  const deadline = Date.now() + 12_000;
  for (;;) {
    const job = JSON.parse(await readFile(path, 'utf8')) as StoredJob;
    if (job.state === state) return job;
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for durable ${state}; got ${job.state}`);
    await delay(10);
  }
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`Synthetic ${code}`), { code, syscall: 'rename' });
}

async function holdWindowsReadHandle(
  path: string,
  durationMs: number,
): Promise<() => Promise<void>> {
  const script = `$ErrorActionPreference = 'Stop'; $file = [System.IO.File]::Open($env:FSMCP_METADATA_TEST_FILE, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite); try { [Console]::Out.WriteLine('OPEN'); Start-Sleep -Milliseconds ${durationMs} } finally { $file.Dispose() }`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, FSMCP_METADATA_TEST_FILE: path },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`Handle helper failed: ${code}: ${stderr}`)),
    );
    child.once('error', reject);
  });
  await new Promise<void>((resolve, reject) => {
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.includes('OPEN')) resolve();
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      reject(new Error(`Handle helper exited before opening: ${code}: ${stderr}`)),
    );
  });
  return async () => exited;
}

for (const holdMs of [50, 1500])
  it(
    `survives a ${holdMs} ms Windows read handle without losing the checkpoint`,
    { skip: process.platform !== 'win32' },
    async () => {
      const root = await createTestRoot();
      const scratch = await createTestRoot();
      const guard = await makeGuard([root]);
      const manager = new ArtifactJobManager({
        ...getSnapshotConfig(),
        scratchDirectory: scratch,
        ephemeralScratch: false,
      });
      const ready = gate();
      const proceed = gate();
      try {
        const { job } = await manager.submit({
          kind: 'snapshot',
          idempotencyKey: randomUUID(),
          fingerprint: 'metadata-handle-test',
          sourceRoot: root,
          sourceRootId: 'test',
          input: {},
          run: async (ctx) => {
            await ctx.setPhase('ready');
            ready.open();
            await proceed.promise;
            ctx.job.counters.filesWritten = 1;
            await ctx.checkpoint();
            return randomUUID();
          },
        });
        await ready.promise;
        const metadataPath = join(manager.jobDirectory(job.jobId), 'job.json');
        const waitHolder = await holdWindowsReadHandle(metadataPath, holdMs);
        proceed.open();
        await waitHolder();
        const terminal = await waitForState(manager, job.jobId, guard, 'completed');
        assert.equal(terminal.counters.filesWritten, 1);
        await waitForDurable(metadataPath, 'completed');
        await manager.close();
        const durable = JSON.parse(await readFile(metadataPath, 'utf8')) as StoredJob;
        assert.equal(durable.state, 'completed');
        assert.equal(durable.counters.filesWritten, 1);
      } finally {
        proceed.open();
        await manager.close();
        await cleanupTestRoot(root);
        await cleanupTestRoot(scratch);
      }
    },
  );

it(
  'bounds a terminal-only Windows handle block beyond the recovery window',
  { skip: process.platform !== 'win32' },
  async () => {
    const root = await createTestRoot();
    const scratch = await createTestRoot();
    const guard = await makeGuard([root]);
    const ready = gate();
    const proceed = gate();
    const manager = new ArtifactJobManager({
      ...getSnapshotConfig(),
      scratchDirectory: scratch,
      ephemeralScratch: false,
    });
    let restarted: ArtifactJobManager | undefined;
    try {
      const { job } = await manager.submit({
        kind: 'snapshot',
        idempotencyKey: randomUUID(),
        fingerprint: 'long-handle-terminal',
        sourceRoot: root,
        sourceRootId: 'test',
        input: {},
        run: async () => {
          ready.open();
          await proceed.promise;
          return randomUUID();
        },
      });
      await ready.promise;
      const path = join(manager.jobDirectory(job.jobId), 'job.json');
      const waitHolder = await holdWindowsReadHandle(path, 6_500);
      const start = performance.now();
      proceed.open();
      const live = await waitForState(manager, job.jobId, guard, 'completed');
      const deadline = Date.now() + 6_000;
      while (live.metadataPersistence?.state !== 'failed') {
        if (Date.now() > deadline) throw new Error('No bounded terminal failure');
        await delay(10);
      }
      assert(performance.now() - start < 6_000);
      await waitHolder();
      assert.equal((JSON.parse(await readFile(path, 'utf8')) as StoredJob).state, 'running');
      assert.equal(live.metadataPersistence.error.nativeErrorCode, 'EPERM');
      await manager.close();
      restarted = new ArtifactJobManager({
        ...getSnapshotConfig(),
        scratchDirectory: scratch,
        ephemeralScratch: false,
      });
      assert.equal((await restarted.getJob(job.jobId, guard)).state, 'interrupted');
    } finally {
      proceed.open();
      await manager.close();
      await restarted?.close();
      await cleanupTestRoot(root);
      await cleanupTestRoot(scratch);
    }
  },
);

it('recovers a terminal-only rename failure and persists fatalError across restart', async () => {
  const root = await createTestRoot();
  const scratch = await createTestRoot();
  const guard = await makeGuard([root]);
  let blockTerminal = true;
  let terminalAttempts = 0;
  const manager = new ArtifactJobManager(
    { ...getSnapshotConfig(), scratchDirectory: scratch, ephemeralScratch: false },
    {
      metadataRetryWindowMs: 80,
      terminalRecoveryWindowMs: 500,
      renameMetadata: async (temp, destination) => {
        const state = (JSON.parse(await readFile(temp, 'utf8')) as StoredJob).state;
        if (state === 'failed' && blockTerminal) {
          terminalAttempts += 1;
          throw errno('EPERM');
        }
        await rename(temp, destination);
      },
    },
  );
  let restarted: ArtifactJobManager | undefined;
  try {
    const { job } = await manager.submit({
      kind: 'snapshot',
      idempotencyKey: randomUUID(),
      fingerprint: 'terminal-recovery',
      sourceRoot: root,
      sourceRootId: 'test',
      input: {},
      run: async () => {
        throw new FsError(ErrorCode.ACCESS_DENIED, 'Sensitive file blocked', root);
      },
    });
    const path = join(manager.jobDirectory(job.jobId), 'job.json');
    const recovering = await waitForState(manager, job.jobId, guard, 'failed');
    assert.equal(recovering.fatalError?.code, ErrorCode.ACCESS_DENIED);
    const deadline = Date.now() + 3_000;
    while (
      jobStatusValue(await manager.getJob(job.jobId, guard)).metadataPersistence?.state !==
      'recovering'
    ) {
      if (Date.now() > deadline) throw new Error('No visible terminal recovery diagnostic');
      await delay(5);
    }
    assert.equal((JSON.parse(await readFile(path, 'utf8')) as StoredJob).state, 'running');
    blockTerminal = false;
    const durable = await waitForDurable(path, 'failed');
    assert.equal(durable.fatalError?.code, ErrorCode.ACCESS_DENIED);
    assert.equal(durable.fatalError?.message, 'Permission denied');
    assert.equal(durable.metadataPersistence, undefined);
    assert(terminalAttempts > 1);
    await manager.close();
    restarted = new ArtifactJobManager({
      ...getSnapshotConfig(),
      scratchDirectory: scratch,
      ephemeralScratch: false,
    });
    const afterRestart = await restarted.getJob(job.jobId, guard);
    assert.equal(afterRestart.state, 'failed');
    assert.equal(afterRestart.fatalError?.code, ErrorCode.ACCESS_DENIED);
  } finally {
    blockTerminal = false;
    await manager.close();
    await restarted?.close();
    await cleanupTestRoot(root);
    await cleanupTestRoot(scratch);
  }
});

it('reports a permanent terminal metadata error and restarts from the last durable state', async () => {
  const root = await createTestRoot();
  const scratch = await createTestRoot();
  const guard = await makeGuard([root]);
  const manager = new ArtifactJobManager(
    { ...getSnapshotConfig(), scratchDirectory: scratch, ephemeralScratch: false },
    {
      metadataRetryWindowMs: 50,
      terminalRecoveryWindowMs: 50,
      renameMetadata: async (temp, destination) => {
        if ((JSON.parse(await readFile(temp, 'utf8')) as StoredJob).state === 'completed')
          throw errno('EIO');
        await rename(temp, destination);
      },
    },
  );
  let restarted: ArtifactJobManager | undefined;
  try {
    const { job } = await manager.submit({
      kind: 'snapshot',
      idempotencyKey: randomUUID(),
      fingerprint: 'terminal-permanent',
      sourceRoot: root,
      sourceRootId: 'test',
      input: {},
      run: async () => randomUUID(),
    });
    const live = await waitForState(manager, job.jobId, guard, 'completed');
    const path = join(manager.jobDirectory(job.jobId), 'job.json');
    const deadline = Date.now() + 3_000;
    while (live.metadataPersistence?.state !== 'failed') {
      if (Date.now() > deadline) throw new Error('No permanent persistence diagnostic');
      await delay(5);
    }
    assert.equal(live.metadataPersistence.error.nativeErrorCode, 'EIO');
    assert.equal((JSON.parse(await readFile(path, 'utf8')) as StoredJob).state, 'running');
    await manager.close();
    restarted = new ArtifactJobManager({
      ...getSnapshotConfig(),
      scratchDirectory: scratch,
      ephemeralScratch: false,
    });
    const recovered = await restarted.getJob(job.jobId, guard);
    assert.equal(recovered.state, 'interrupted');
    assert.equal(recovered.stopReason, 'server-restarted');
    assert.equal(recovered.metadataPersistence, undefined);
  } finally {
    await manager.close();
    await restarted?.close();
    await cleanupTestRoot(root);
    await cleanupTestRoot(scratch);
  }
});

it('serializes 500 checkpoints with concurrent status callers and no stale terminal overwrite', async () => {
  const root = await createTestRoot();
  const scratch = await createTestRoot();
  const guard = await makeGuard([root]);
  const manager = new ArtifactJobManager({
    ...getSnapshotConfig(),
    scratchDirectory: scratch,
    ephemeralScratch: false,
  });
  let reads = 0;
  let polling = true;
  const pollers: Promise<void>[] = [];
  try {
    const { job } = await manager.submit({
      kind: 'snapshot',
      idempotencyKey: randomUUID(),
      fingerprint: 'metadata-stress',
      sourceRoot: root,
      sourceRootId: 'test',
      input: {},
      run: async (ctx) => {
        for (let index = 1; index <= 500; index += 1) {
          ctx.job.counters.filesWritten = index;
          await ctx.checkpoint();
        }
        return randomUUID();
      },
    });
    for (let index = 0; index < 4; index += 1)
      pollers.push(
        (async () => {
          while (polling) {
            const status = jobStatusValue(await manager.getJob(job.jobId, guard));
            assert('filesWritten' in status.counters);
            assert(status.counters.filesWritten <= 500);
            reads += 1;
            await delay(1);
          }
        })(),
      );
    const path = join(manager.jobDirectory(job.jobId), 'job.json');
    const terminal = await waitForState(manager, job.jobId, guard, 'completed');
    assert.equal(terminal.counters.filesWritten, 500);
    polling = false;
    await Promise.all(pollers);
    await manager.close();
    const durable = JSON.parse(await readFile(path, 'utf8')) as StoredJob;
    assert.equal(durable.state, 'completed');
    assert.equal(durable.counters.filesWritten, 500);
    assert(reads > 100);
    assert.deepEqual((await readdir(manager.jobDirectory(job.jobId))).sort(), ['job.json']);
  } finally {
    polling = false;
    await Promise.allSettled(pollers);
    await manager.close();
    await cleanupTestRoot(root);
    await cleanupTestRoot(scratch);
  }
});

it('bounds a permanent transient terminal block and exposes the failed persistence', async () => {
  const root = await createTestRoot();
  const scratch = await createTestRoot();
  const guard = await makeGuard([root]);
  let terminalAttempts = 0;
  const manager = new ArtifactJobManager(
    { ...getSnapshotConfig(), scratchDirectory: scratch, ephemeralScratch: false },
    {
      metadataRetryWindowMs: 100,
      terminalRecoveryWindowMs: 150,
      renameMetadata: async (temp, destination) => {
        if ((JSON.parse(await readFile(temp, 'utf8')) as StoredJob).state === 'completed') {
          terminalAttempts += 1;
          throw errno('EPERM');
        }
        await rename(temp, destination);
      },
    },
  );
  try {
    const start = performance.now();
    const { job } = await manager.submit({
      kind: 'snapshot',
      idempotencyKey: randomUUID(),
      fingerprint: 'terminal-permanent-transient',
      sourceRoot: root,
      sourceRootId: 'test',
      input: {},
      run: async () => randomUUID(),
    });
    const live = await waitForState(manager, job.jobId, guard, 'completed');
    const deadline = Date.now() + 3_000;
    while (live.metadataPersistence?.state !== 'failed') {
      if (Date.now() > deadline) throw new Error('No bounded persistence failure');
      await delay(5);
    }
    assert(performance.now() - start < 2_000);
    assert(terminalAttempts >= 2);
    assert.equal(live.metadataPersistence.error.nativeErrorCode, 'EPERM');
    assert.equal(
      (
        JSON.parse(
          await readFile(join(manager.jobDirectory(job.jobId), 'job.json'), 'utf8'),
        ) as StoredJob
      ).state,
      'running',
    );
    assert.deepEqual((await readdir(manager.jobDirectory(job.jobId))).sort(), ['job.json']);
  } finally {
    await manager.close();
    await cleanupTestRoot(root);
    await cleanupTestRoot(scratch);
  }
});

it('cancels an in-flight metadata retry and never overwrites cancelled with running', async () => {
  const root = await createTestRoot();
  const scratch = await createTestRoot();
  const guard = await makeGuard([root]);
  const checkpointStarted = gate();
  const manager = new ArtifactJobManager(
    { ...getSnapshotConfig(), scratchDirectory: scratch, ephemeralScratch: false },
    {
      renameMetadata: async (temp, destination) => {
        const metadata = JSON.parse(await readFile(temp, 'utf8')) as StoredJob;
        if (metadata.state === 'running' && metadata.phase === 'blocked') {
          checkpointStarted.open();
          throw errno('EPERM');
        }
        await rename(temp, destination);
      },
    },
  );
  try {
    const { job } = await manager.submit({
      kind: 'snapshot',
      idempotencyKey: randomUUID(),
      fingerprint: 'cancel-metadata-retry',
      sourceRoot: root,
      sourceRootId: 'test',
      input: {},
      run: async (ctx) => {
        ctx.job.phase = 'blocked';
        await ctx.checkpoint();
        return randomUUID();
      },
    });
    await checkpointStarted.promise;
    const start = performance.now();
    const cancelled = await manager.cancel(job.jobId, guard);
    assert.equal(cancelled.state, 'cancelled');
    assert(performance.now() - start < 1_500);
    await manager.close();
    const durable = JSON.parse(
      await readFile(join(manager.jobDirectory(job.jobId), 'job.json'), 'utf8'),
    ) as StoredJob;
    assert.equal(durable.state, 'cancelled');
    assert.deepEqual((await readdir(manager.jobDirectory(job.jobId))).sort(), ['job.json']);
  } finally {
    await manager.close();
    await cleanupTestRoot(root);
    await cleanupTestRoot(scratch);
  }
});

it('bounds timeout and close while a checkpoint rename is blocked', async () => {
  for (const action of ['timeout', 'close'] as const) {
    const root = await createTestRoot();
    const scratch = await createTestRoot();
    const guard = await makeGuard([root]);
    const checkpointStarted = gate();
    const manager = new ArtifactJobManager(
      {
        ...getSnapshotConfig(),
        scratchDirectory: scratch,
        ephemeralScratch: false,
        maxJobMs: 1_000,
      },
      {
        renameMetadata: async (temp, destination) => {
          const metadata = JSON.parse(await readFile(temp, 'utf8')) as StoredJob;
          if (metadata.state === 'running' && metadata.phase === 'blocked') {
            checkpointStarted.open();
            throw errno('EPERM');
          }
          await rename(temp, destination);
        },
      },
    );
    try {
      const { job } = await manager.submit({
        kind: 'snapshot',
        idempotencyKey: randomUUID(),
        fingerprint: action,
        sourceRoot: root,
        sourceRootId: 'test',
        input: {},
        run: async (ctx) => {
          ctx.job.phase = 'blocked';
          await ctx.checkpoint();
          return randomUUID();
        },
      });
      await checkpointStarted.promise;
      const start = performance.now();
      if (action === 'close') await manager.close();
      else await waitForState(manager, job.jobId, guard, 'failed');
      assert(performance.now() - start < 3_000);
      await manager.close();
      const durable = JSON.parse(
        await readFile(join(manager.jobDirectory(job.jobId), 'job.json'), 'utf8'),
      ) as StoredJob;
      assert.equal(durable.state, action === 'close' ? 'interrupted' : 'failed');
      if (action === 'timeout') assert.equal(durable.fatalError?.code, ErrorCode.TIMEOUT);
    } finally {
      await manager.close();
      await cleanupTestRoot(root);
      await cleanupTestRoot(scratch);
    }
  }
});

it('does not retry unknown metadata failures and uses safe non-fatal access samples', async () => {
  const root = await createTestRoot();
  const scratch = await createTestRoot();
  const guard = await makeGuard([root]);
  let attempts = 0;
  const manager = new ArtifactJobManager(
    { ...getSnapshotConfig(), scratchDirectory: scratch, ephemeralScratch: false },
    {
      renameMetadata: async (temp, destination) => {
        const metadata = JSON.parse(await readFile(temp, 'utf8')) as StoredJob;
        if (metadata.state === 'running' && metadata.phase === 'bad-checkpoint') {
          attempts += 1;
          throw errno('EIO');
        }
        await rename(temp, destination);
      },
    },
  );
  try {
    const { job } = await manager.submit({
      kind: 'snapshot',
      idempotencyKey: randomUUID(),
      fingerprint: 'nontransient',
      sourceRoot: root,
      sourceRootId: 'test',
      input: {},
      run: async (ctx) => {
        ctx.addError(new FsError(ErrorCode.ACCESS_DENIED, 'secret path or credential', root), root);
        ctx.job.phase = 'bad-checkpoint';
        await ctx.checkpoint();
        return randomUUID();
      },
    });
    const failed = await waitForState(manager, job.jobId, guard, 'failed');
    await manager.close();
    assert.equal(attempts, 1);
    assert.equal(failed.errors[0]?.code, ErrorCode.ACCESS_DENIED);
    assert.equal(failed.errors[0]?.message, 'Permission denied');
    assert.equal(failed.fatalError?.code, 'EIO');
    assert.equal(failed.fatalError?.message, 'Job failed');
    assert.equal(failed.metadataPersistence, undefined);
    assert.deepEqual((await readdir(manager.jobDirectory(job.jobId))).sort(), ['job.json']);
  } finally {
    await manager.close();
    await cleanupTestRoot(root);
    await cleanupTestRoot(scratch);
  }
});

it('rejects over-quota metadata without temporary files or retained reservation', async () => {
  const root = await createTestRoot();
  const scratch = await createTestRoot();
  const guard = await makeGuard([root]);
  const ready = gate();
  const proceed = gate();
  const manager = new ArtifactJobManager({
    ...getSnapshotConfig(),
    scratchDirectory: scratch,
    scratchQuotaBytes: 16_000,
    ephemeralScratch: false,
  });
  try {
    const { job } = await manager.submit({
      kind: 'snapshot',
      idempotencyKey: randomUUID(),
      fingerprint: 'quota-metadata',
      sourceRoot: root,
      sourceRootId: 'test',
      input: {},
      run: async () => {
        ready.open();
        await proceed.promise;
        return randomUUID();
      },
    });
    await ready.promise;
    job.input['large'] = 'x'.repeat(20_000);
    await assert.rejects(manager.persist(job), (error: unknown) => {
      assert(error instanceof FsError);
      assert.equal(error.code, ErrorCode.TOO_LARGE);
      return true;
    });
    delete job.input['large'];
    await manager.persist(job);
    assert.deepEqual((await readdir(manager.jobDirectory(job.jobId))).sort(), ['job.json']);
    proceed.open();
    await waitForState(manager, job.jobId, guard, 'completed');
    await manager.close();
  } finally {
    proceed.open();
    await manager.close();
    await cleanupTestRoot(root);
    await cleanupTestRoot(scratch);
  }
});
