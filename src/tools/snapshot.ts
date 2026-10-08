import { createHash } from 'node:crypto';

import * as z from 'zod/v4';

import { ErrorCode } from '../core/errors.js';
import { GuardedFileSystem } from '../core/fs.js';
import { fingerprintJobInput, resolveSnapshotRoot } from '../core/job-manager.js';
import { defaultFalseBoolean, RequiredPath } from '../core/schema.js';
import { runSnapshotPipeline } from '../core/snapshot-pipeline.js';
import { defineTool, type ToolCtx } from './define.js';
import { JobStatusOutputSchema, jobStatusValue } from './job-shared.js';

const IdempotencyKey = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/u)
  .describe('Optional stable retry key (8-128 safe characters).');

const SnapshotInputSchema = z.strictObject({
  path: RequiredPath.describe('One guarded directory to scan recursively.'),
  idempotencyKey: IdempotencyKey.optional(),
  includeHidden: defaultFalseBoolean('Include dot-prefixed files and directories.'),
  includeIgnored: defaultFalseBoolean(
    'Include default exclusions and entries excluded by nested .gitignore files.',
  ),
  maxAgeMs: z
    .int()
    .min(0)
    .max(30 * 24 * 60 * 60 * 1000)
    .default(3_600_000)
    .describe('Completed-result age from walk start in ms; 0 still joins running work.'),
  forceRefresh: defaultFalseBoolean('Bypass automatic reuse; use idempotencyKey for safe retries.'),
});

const SnapshotOutputSchema = z.strictObject({
  reused: z.boolean(),
  reason: z.enum(['created', 'completed_reuse', 'inflight_reuse', 'idempotent_replay']),
  job: JobStatusOutputSchema,
});

export const SNAPSHOT = defineTool({
  name: 'snapshot',
  title: 'Start Metadata Snapshot',
  description:
    'Create/reuse a recursive metadata index (CSV/ZIP) for inventories, whole-tree exploration and file totals. ' +
    'A known list_roots root needs no broad find_files first. Reads sources; writes scratch under policy/quota/deadline limits. ' +
    'Reuse matching complete results within maxAgeMs or join queued/running jobs; source changes are not detected. ' +
    'Use forceRefresh/idempotencyKey for new scans/safe retries. job_status gives counters; get_artifact delivers the index.',
  input: SnapshotInputSchema,
  output: SnapshotOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  sourceMutating: false,
  defaultErrorCode: ErrorCode.IO_ERROR,
  accessPaths: (args) => [args.path],
  run: async (args, ctx: ToolCtx) => {
    const sourceRoot = await resolveSnapshotRoot(ctx.fs, args.path);
    await ctx.jobManager.assertScratchSeparated(sourceRoot);
    const normalized = {
      kind: 'snapshot',
      sourceRoot,
      includeHidden: args.includeHidden,
      includeIgnored: args.includeIgnored,
    };
    const policyFingerprint = await ctx.fs.pathGuard.snapshotPolicyFingerprint();
    const configFingerprint = ctx.jobManager.snapshotConfigFingerprint();
    const automaticFingerprint = fingerprintJobInput({
      version: 2,
      ...normalized,
      policyFingerprint,
      configFingerprint,
    });
    const requestFingerprint = fingerprintJobInput({
      ...normalized,
      maxAgeMs: args.maxAgeMs,
      forceRefresh: args.forceRefresh,
    });
    const sourceRootId = `root-${createHash('sha256').update(sourceRoot).digest('hex').slice(0, 16)}`;
    const workerFs = new GuardedFileSystem(ctx.fs.pathGuard);
    const submitted = await ctx.jobManager.submit({
      kind: 'snapshot',
      ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
      fingerprint: fingerprintJobInput(normalized),
      automaticReuse: {
        fingerprint: automaticFingerprint,
        policyFingerprint,
        configFingerprint,
        requestFingerprint,
        maxAgeMs: args.maxAgeMs,
        forceRefresh: args.forceRefresh,
      },
      sourceRoot,
      sourceRootId,
      reuseGuard: ctx.fs.pathGuard,
      input: {
        includeHidden: args.includeHidden,
        includeIgnored: args.includeIgnored,
      },
      run: async (runCtx) =>
        runSnapshotPipeline(
          workerFs,
          sourceRoot,
          { includeHidden: args.includeHidden, includeIgnored: args.includeIgnored },
          runCtx,
        ),
    });
    const value = {
      reused: submitted.reused,
      reason: submitted.reason,
      job: jobStatusValue(submitted.job),
    };
    return {
      structured: value,
      text: `Snapshot job ${submitted.job.jobId} (${submitted.job.state}; ${submitted.reason}). Poll job_status; the submit request may close without cancelling the shared job.`,
    };
  },
});
