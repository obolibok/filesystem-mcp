import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Dir } from 'node:fs';
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { parse } from 'csv-parse/sync';
import yauzl from 'yauzl';

import { verifySnapshotZip } from '../scripts/snapshot-benchmark/verify.mjs';
import { ErrorCode, FsError } from '../src/core/errors.js';
import { GuardedFileSystem } from '../src/core/fs.js';
import { ArtifactJobManager, fingerprintJobInput } from '../src/core/job-manager.js';
import type { StoredJob } from '../src/core/job-types.js';
import { emptyBundleCounters } from '../src/core/job-types.js';
import { getSnapshotConfig } from '../src/core/snapshot-config.js';
import { runSnapshotPipeline } from '../src/core/snapshot-pipeline.js';
import { JobStatusOutputSchema, jobStatusValue } from '../src/tools/job-shared.js';
import { createTestRoot, makeGuard } from './helpers.js';

async function terminal(
  manager: ArtifactJobManager,
  jobId: string,
  guard: Awaited<ReturnType<typeof makeGuard>>,
): Promise<StoredJob> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const job = await manager.getJob(jobId, guard);
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(job.state)) return job;
    assert(Date.now() < deadline, 'snapshot did not finish');
    await delay(10);
  }
}

async function submit(
  manager: ArtifactJobManager,
  fs: GuardedFileSystem,
  root: string,
): Promise<string> {
  const result = await manager.submit({
    kind: 'snapshot',
    idempotencyKey: '007-walk',
    fingerprint: fingerprintJobInput(root),
    sourceRoot: root,
    sourceRootId: 'root-test',
    input: {},
    run: (ctx) =>
      runSnapshotPipeline(fs, root, { includeHidden: false, includeIgnored: false }, ctx),
  });
  return result.job.jobId;
}

function native(code: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`synthetic ${code}`), { code, path, syscall: 'realpath' });
}

async function csvInZip(bytes: Buffer): Promise<string> {
  await verifySnapshotZip(bytes, false);
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (openError, zip) => {
      if (openError || !zip) return reject(openError ?? new Error('ZIP did not open'));
      zip.once('error', reject);
      zip.once('entry', (entry) => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream)
            return reject(streamError ?? new Error('ZIP entry did not open'));
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.once('error', reject);
          stream.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
      });
      zip.readEntry();
    });
  });
}

async function snapshotPaths(
  manager: ArtifactJobManager,
  job: StoredJob,
  guard: Awaited<ReturnType<typeof makeGuard>>,
): Promise<string[]> {
  const paths: string[] = [];
  for (const artifact of job.artifacts.filter((item) => item.kind === 'snapshot-part')) {
    const { bytes } = await manager.getArtifact(artifact.artifactId, guard);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
    const csv = await csvInZip(bytes);
    const rows: { RelativePath: string }[] = parse(csv, { columns: true, skip_empty_lines: true });
    paths.push(...rows.map((row) => row.RelativePath));
  }
  return paths;
}

describe('snapshot walk recovery', () => {
  it('treats wrapped child permission faults like native faults and keeps later files', async () => {
    for (const [errno, wrapped, mapped] of [
      ['EACCES', false, ErrorCode.PERMISSION_DENIED],
      ['EACCES', true, ErrorCode.PERMISSION_DENIED],
      ['EPERM', false, ErrorCode.PERMISSION_DENIED],
      ['EPERM', true, ErrorCode.PERMISSION_DENIED],
      ['ENOENT', true, ErrorCode.NOT_FOUND],
      ['ENOTDIR', true, ErrorCode.NOT_DIRECTORY],
      ['EISDIR', false, ErrorCode.NOT_FILE],
      ['EISDIR', true, ErrorCode.NOT_FILE],
      ['EBUSY', false, ErrorCode.IO_ERROR],
      ['EBUSY', true, ErrorCode.IO_ERROR],
    ] as const) {
      const root = await realpath(await createTestRoot());
      const scratch = await createTestRoot();
      for (let index = 0; index < 60; index += 1) {
        await writeFile(join(root, `${String(index).padStart(3, '0')}.txt`), 'row');
      }
      const guard = await makeGuard([root]);
      class FaultingFs extends GuardedFileSystem {
        override async statDetailed(
          path: string,
          options?: { signal?: AbortSignal },
        ): ReturnType<GuardedFileSystem['statDetailed']> {
          if (basename(path) === '029.txt') {
            const cause = native(errno, path);
            throw wrapped ? new FsError(mapped, 'Cannot access path', path, cause) : cause;
          }
          return super.statDetailed(path, options);
        }
      }
      const manager = new ArtifactJobManager({
        ...getSnapshotConfig(),
        scratchDirectory: scratch,
        ephemeralScratch: false,
        maxRawPartBytes: 1024,
      });
      try {
        const jobId = await submit(manager, new FaultingFs(guard), root);
        const job = await terminal(manager, jobId, guard);
        assert.equal(
          job.state,
          'completed',
          `${errno} wrapped=${String(wrapped)} ${job.stopReason ?? ''}`,
        );
        assert.equal(job.complete, false);
        assert.equal(job.counters.filesWritten, 59);
        assert.equal(
          job.counters.inaccessibleSkipped,
          ['ENOENT', 'ENOTDIR', 'EISDIR'].includes(errno) ? 0 : 1,
        );
        assert.equal(
          job.counters.disappearedSkipped,
          ['ENOENT', 'ENOTDIR', 'EISDIR'].includes(errno) ? 1 : 0,
        );
        assert.equal(job.counters.errors, 1);
        assert.equal(job.errors[0]?.path, join(root, '029.txt'));
        assert.equal(job.fatalError, undefined);
        const paths = await snapshotPaths(manager, job, guard);
        assert.equal(paths.length, 59);
        assert(paths.includes('030.txt'));
        assert(paths.includes('059.txt'));
        assert(!paths.includes('029.txt'));
        const manifestId = job.manifestArtifactId;
        assert(manifestId);
        const manifest = JSON.parse(
          (await manager.getArtifact(manifestId, guard)).bytes.toString('utf8'),
        ) as { complete: boolean; counters: { filesWritten: number } };
        assert.equal(manifest.complete, false);
        assert.equal(manifest.counters.filesWritten, 59);
      } finally {
        await manager.close();
        await rm(root, { recursive: true, force: true });
        await rm(scratch, { recursive: true, force: true });
      }
    }
  });

  it('retains a fatal diagnostic after the sample budget is exhausted', async () => {
    const root = await realpath(await createTestRoot());
    const scratch = await createTestRoot();
    for (let index = 0; index < 60; index += 1) {
      await writeFile(join(root, `${String(index).padStart(3, '0')}.txt`), 'row');
    }
    const guard = await makeGuard([root]);
    const fatalPath = join(root, '049.txt');
    class FaultingFs extends GuardedFileSystem {
      override async statDetailed(
        path: string,
        options?: { signal?: AbortSignal },
      ): ReturnType<GuardedFileSystem['statDetailed']> {
        if (path === fatalPath)
          throw new FsError(ErrorCode.IO_ERROR, 'Cannot access path', path, native('ENOSPC', path));
        if (basename(path) >= '025.txt' && basename(path) <= '045.txt') {
          throw new FsError(
            ErrorCode.PERMISSION_DENIED,
            'Cannot access path',
            path,
            native('EACCES', path),
          );
        }
        return super.statDetailed(path, options);
      }
    }
    const config = {
      ...getSnapshotConfig(),
      scratchDirectory: scratch,
      ephemeralScratch: false,
      maxRawPartBytes: 1024,
    };
    const manager = new ArtifactJobManager(config);
    try {
      const jobId = await submit(manager, new FaultingFs(guard), root);
      const job = await terminal(manager, jobId, guard);
      assert.equal(job.state, 'failed');
      assert.equal(job.errors.length, 20, job.stopReason);
      assert.equal(job.counters.errors, 22);
      assert(job.counters.parts > 0, 'closed parts preceded the fatal fault');
      assert.deepEqual(job.artifacts, []);
      assert.deepEqual(job.fatalError, {
        code: ErrorCode.IO_ERROR,
        message: 'Cannot access path',
        path: fatalPath,
        nativeErrorCode: 'ENOSPC',
        operation: 'realpath',
      });
      assert.deepEqual(JobStatusOutputSchema.parse(jobStatusValue(job)).fatalError, job.fatalError);
      await manager.close();
      const saved = JSON.parse(
        await readFile(join(scratch, jobId, 'job.json'), 'utf8'),
      ) as StoredJob;
      assert.deepEqual(saved.fatalError, job.fatalError);
      const restarted = new ArtifactJobManager(config);
      try {
        assert.deepEqual((await restarted.getJob(jobId, guard)).fatalError, job.fatalError);
      } finally {
        await restarted.close();
      }
    } finally {
      await manager.close();
      await rm(root, { recursive: true, force: true });
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('continues parent siblings after child open, iteration, and ignore-read failures', async () => {
    for (const fault of ['open', 'iteration', 'ignore', 'ignore-type'] as const) {
      const root = await realpath(await createTestRoot());
      const scratch = await createTestRoot();
      const child = join(root, 'a-child');
      const sibling = join(root, 'z-sibling');
      await mkdir(child);
      await mkdir(sibling);
      await writeFile(join(child, '.gitignore'), 'ignored.txt\n');
      await writeFile(join(child, 'first.txt'), 'first');
      await writeFile(join(child, 'second.txt'), 'second');
      await writeFile(join(sibling, 'later.txt'), 'later');
      const guard = await makeGuard([root]);
      class FaultingFs extends GuardedFileSystem {
        override async opendir(
          path: string,
          options?: { signal?: AbortSignal },
        ): ReturnType<GuardedFileSystem['opendir']> {
          if (path === child && fault === 'open') {
            throw new FsError(
              ErrorCode.PERMISSION_DENIED,
              'Cannot access path',
              path,
              native('EPERM', path),
            );
          }
          const opened = await super.opendir(path, options);
          if (path !== child || fault !== 'iteration') return opened;
          let calls = 0;
          const directory = {
            read: async () => {
              calls += 1;
              if (calls === 2) throw native('EBUSY', path);
              return opened.directory.read();
            },
            close: () => opened.directory.close(),
          } as unknown as Dir;
          return { ...opened, directory };
        }

        override async readEditableText(
          path: string,
          options?: { signal?: AbortSignal; tool?: string },
        ): ReturnType<GuardedFileSystem['readEditableText']> {
          if (
            path === join(child, '.gitignore') &&
            (fault === 'ignore' || fault === 'ignore-type')
          ) {
            if (fault === 'ignore-type')
              throw new FsError(ErrorCode.NOT_FILE, 'Path type changed', path);
            throw new FsError(
              ErrorCode.PERMISSION_DENIED,
              'Cannot access path',
              path,
              native('EACCES', path),
            );
          }
          return super.readEditableText(path, options);
        }
      }
      const manager = new ArtifactJobManager({
        ...getSnapshotConfig(),
        scratchDirectory: scratch,
        ephemeralScratch: false,
      });
      try {
        const jobId = await submit(manager, new FaultingFs(guard), root);
        const job = await terminal(manager, jobId, guard);
        assert.equal(job.state, 'completed', `${fault}: ${job.stopReason ?? ''}`);
        assert.equal(job.complete, false);
        assert.equal(job.counters.errors, 1, fault);
        assert.equal(job.counters.inaccessibleSkipped, fault === 'ignore-type' ? 0 : 1, fault);
        assert.equal(job.counters.disappearedSkipped, fault === 'ignore-type' ? 1 : 0, fault);
        const paths = await snapshotPaths(manager, job, guard);
        assert(paths.includes('z-sibling/later.txt'), fault);
        assert.equal(new Set(paths).size, paths.length);
      } finally {
        await manager.close();
        await rm(root, { recursive: true, force: true });
        await rm(scratch, { recursive: true, force: true });
      }
    }
  });

  it('marks a file that changed type after enumeration as incomplete without following it', async () => {
    for (const changedTo of ['directory', 'symlink'] as const) {
      const root = await realpath(await createTestRoot());
      const scratch = await createTestRoot();
      const hiddenDirectory = join(root, '.replacement');
      await mkdir(hiddenDirectory);
      await writeFile(join(root, 'changed.txt'), 'row');
      await writeFile(join(root, 'later.txt'), 'row');
      const guard = await makeGuard([root]);
      class FaultingFs extends GuardedFileSystem {
        override async statDetailed(
          path: string,
          options?: { signal?: AbortSignal },
        ): ReturnType<GuardedFileSystem['statDetailed']> {
          const detail = await super.statDetailed(path, options);
          if (basename(path) !== 'changed.txt') return detail;
          return changedTo === 'symlink'
            ? { ...detail, isSymlink: true }
            : { ...detail, stats: await stat(hiddenDirectory) };
        }
      }
      const manager = new ArtifactJobManager({
        ...getSnapshotConfig(),
        scratchDirectory: scratch,
        ephemeralScratch: false,
      });
      try {
        const jobId = await submit(manager, new FaultingFs(guard), root);
        const job = await terminal(manager, jobId, guard);
        assert.equal(job.state, 'completed');
        assert.equal(job.complete, false, changedTo);
        assert.equal(job.counters.disappearedSkipped, 0);
        assert.equal(job.counters.symlinksSkipped, changedTo === 'symlink' ? 1 : 0);
        assert.equal(job.counters.specialSkipped, changedTo === 'directory' ? 1 : 0);
        assert.equal(job.counters.errors, 1);
        assert.deepEqual(await snapshotPaths(manager, job, guard), ['later.txt']);
      } finally {
        await manager.close();
        await rm(root, { recursive: true, force: true });
        await rm(scratch, { recursive: true, force: true });
      }
    }
  });

  it('fails on root and unknown child failures without treating them as missing entries', async () => {
    for (const failure of [
      'root',
      'root-iteration',
      'unknown',
      'io',
      'space',
      'handles',
      'mismapped',
      'policy',
    ] as const) {
      const root = await realpath(await createTestRoot());
      const scratch = await createTestRoot();
      await writeFile(join(root, 'one.txt'), 'row');
      const guard = await makeGuard([root]);
      class FaultingFs extends GuardedFileSystem {
        override async opendir(
          path: string,
          options?: { signal?: AbortSignal },
        ): ReturnType<GuardedFileSystem['opendir']> {
          if (failure === 'root' && path === root) {
            throw new FsError(
              ErrorCode.PERMISSION_DENIED,
              'Cannot access path',
              path,
              native('EACCES', path),
            );
          }
          const opened = await super.opendir(path, options);
          if (failure !== 'root-iteration' || path !== root) return opened;
          const directory = {
            read: async () => {
              throw native('EACCES', path);
            },
            close: () => opened.directory.close(),
          } as unknown as Dir;
          return { ...opened, directory };
        }

        override async statDetailed(
          path: string,
          options?: { signal?: AbortSignal },
        ): ReturnType<GuardedFileSystem['statDetailed']> {
          if (failure === 'unknown')
            throw new FsError(ErrorCode.UNKNOWN, 'Cannot access path', path);
          if (failure === 'io') throw new FsError(ErrorCode.IO_ERROR, 'Cannot access path', path);
          if (failure === 'space')
            throw new FsError(
              ErrorCode.IO_ERROR,
              'Cannot access path',
              undefined,
              native('ENOSPC', path),
            );
          if (failure === 'handles')
            throw new FsError(
              ErrorCode.IO_ERROR,
              'Cannot access path',
              path,
              native('EMFILE', path),
            );
          if (failure === 'mismapped')
            throw new FsError(
              ErrorCode.PERMISSION_DENIED,
              'Cannot access path',
              path,
              native('ENOSPC', path),
            );
          if (failure === 'policy')
            throw new FsError(ErrorCode.ACCESS_DENIED, 'Cannot access path', path);
          return super.statDetailed(path, options);
        }
      }
      const manager = new ArtifactJobManager({
        ...getSnapshotConfig(),
        scratchDirectory: scratch,
        ephemeralScratch: false,
      });
      try {
        const jobId = await submit(manager, new FaultingFs(guard), root);
        const job = await terminal(manager, jobId, guard);
        assert.equal(job.state, 'failed', failure);
        assert.deepEqual(job.artifacts, []);
        assert.equal(job.counters.inaccessibleSkipped, 0);
        assert.equal(job.counters.disappearedSkipped, 0);
        assert.equal(
          job.fatalError?.path,
          failure.startsWith('root') ? root : join(root, 'one.txt'),
        );
        assert.equal(job.errors[0]?.path, job.fatalError?.path);
      } finally {
        await manager.close();
        await rm(root, { recursive: true, force: true });
        await rm(scratch, { recursive: true, force: true });
      }
    }
  });

  it('does not automatically reuse a completed incomplete snapshot', async () => {
    const root = await realpath(await createTestRoot());
    const scratch = await createTestRoot();
    await writeFile(join(root, 'denied.txt'), 'row');
    const guard = await makeGuard([root]);
    class FaultingFs extends GuardedFileSystem {
      override async statDetailed(path: string): ReturnType<GuardedFileSystem['statDetailed']> {
        throw new FsError(
          ErrorCode.PERMISSION_DENIED,
          'Cannot access path',
          path,
          native('EACCES', path),
        );
      }
    }
    const fs = new FaultingFs(guard);
    const manager = new ArtifactJobManager({
      ...getSnapshotConfig(),
      scratchDirectory: scratch,
      ephemeralScratch: false,
    });
    try {
      // The config identity must be captured after canonicalizing scratch,
      // including an optional Windows 8.3 spelling.
      await manager.assertScratchSeparated(root);
      const input = {
        kind: 'snapshot',
        fingerprint: fingerprintJobInput({ root, kind: 'snapshot' }),
        automaticReuse: {
          fingerprint: '007-incomplete-reuse',
          policyFingerprint: await guard.snapshotPolicyFingerprint(),
          configFingerprint: manager.snapshotConfigFingerprint(),
          requestFingerprint: fingerprintJobInput({ root, maxAgeMs: 3_600_000 }),
          maxAgeMs: 3_600_000,
          forceRefresh: false,
        },
        sourceRoot: root,
        sourceRootId: 'root-test',
        reuseGuard: guard,
        input: {},
        run: (ctx: Parameters<typeof runSnapshotPipeline>[3]) =>
          runSnapshotPipeline(fs, root, { includeHidden: false, includeIgnored: false }, ctx),
      };
      const first = await manager.submit(input);
      const completed = await terminal(manager, first.job.jobId, guard);
      assert.equal(completed.state, 'completed');
      assert.equal(completed.complete, false);
      const second = await manager.submit(input);
      assert.equal(second.reason, 'created');
      assert.notEqual(second.job.jobId, first.job.jobId);
      await terminal(manager, second.job.jobId, guard);
    } finally {
      await manager.close();
      await rm(root, { recursive: true, force: true });
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('keeps fatal diagnostics safe for shared bundle jobs and old metadata', async () => {
    const root = await realpath(await createTestRoot());
    const scratch = await createTestRoot();
    const outside = await createTestRoot();
    const guard = await makeGuard([root]);
    const manager = new ArtifactJobManager({
      ...getSnapshotConfig(),
      scratchDirectory: scratch,
      ephemeralScratch: false,
    });
    try {
      const submitted = await manager.submit({
        kind: 'bundle',
        idempotencyKey: '007-bundle-fatal',
        fingerprint: fingerprintJobInput('007-bundle-fatal'),
        sourceRoot: root,
        sourceRootId: 'root-test',
        input: {},
        counters: emptyBundleCounters(1),
        run: async () => {
          throw new FsError(
            ErrorCode.IO_ERROR,
            `secret outside ${outside}`,
            undefined,
            native('ENOSPC', outside),
          );
        },
      });
      const failed = await terminal(manager, submitted.job.jobId, guard);
      assert.equal(failed.state, 'failed');
      assert.deepEqual(failed.fatalError, {
        code: ErrorCode.IO_ERROR,
        message: 'Job failed',
        nativeErrorCode: 'ENOSPC',
        operation: 'realpath',
      });
      assert.equal(JobStatusOutputSchema.parse(jobStatusValue(failed)).fatalError?.path, undefined);
      const metadataPath = join(scratch, submitted.job.jobId, 'job.json');
      const legacy = JSON.parse(await readFile(metadataPath, 'utf8')) as StoredJob;
      delete legacy.fatalError;
      await manager.close();
      await writeFile(metadataPath, JSON.stringify(legacy));
      const restarted = new ArtifactJobManager({
        ...getSnapshotConfig(),
        scratchDirectory: scratch,
        ephemeralScratch: false,
      });
      try {
        const loaded = await restarted.getJob(submitted.job.jobId, guard);
        assert.equal(loaded.fatalError, undefined);
        assert.equal(JobStatusOutputSchema.parse(jobStatusValue(loaded)).fatalError, undefined);
      } finally {
        await restarted.close();
      }
    } finally {
      await manager.close();
      await rm(root, { recursive: true, force: true });
      await rm(scratch, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
