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
  .describe('Stable caller-generated key (8-128 safe characters); reuse after a lost response.');

const SnapshotInputSchema = z.strictObject({
  path: RequiredPath.describe('Exactly one guarded directory to snapshot recursively.'),
  idempotencyKey: IdempotencyKey,
  includeHidden: defaultFalseBoolean('Include dot-prefixed files and directories.'),
  includeIgnored: defaultFalseBoolean(
    'Include default exclusions and entries excluded by nested .gitignore files.',
  ),
});

const SnapshotOutputSchema = z.strictObject({
  reused: z.boolean(),
  job: JobStatusOutputSchema,
});

export const SNAPSHOT = defineTool({
  name: 'snapshot',
  title: 'Start Metadata Snapshot',
  description:
    'Submit a durable background metadata snapshot for one guarded directory. Returns quickly with a job ID; poll job_status, then fetch the manifest and independent ZIP parts with get_artifact. Source files are never modified or content-hashed.',
  input: SnapshotInputSchema,
  output: SnapshotOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
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
    const sourceRootId = `root-${createHash('sha256').update(sourceRoot).digest('hex').slice(0, 16)}`;
    const workerFs = new GuardedFileSystem(ctx.fs.pathGuard);
    const submitted = await ctx.jobManager.submit({
      kind: 'snapshot',
      idempotencyKey: args.idempotencyKey,
      fingerprint: fingerprintJobInput(normalized),
      sourceRoot,
      sourceRootId,
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
    const value = { reused: submitted.reused, job: jobStatusValue(submitted.job) };
    return {
      structured: value,
      text: `${submitted.reused ? 'Reused' : 'Submitted'} snapshot job ${submitted.job.jobId} (${submitted.job.state}). Poll job_status; the submit request may close without cancelling the job.`,
    };
  },
});
