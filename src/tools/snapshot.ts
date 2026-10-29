import { createHash } from 'node:crypto';

import * as z from 'zod/v4';

import { ErrorCode } from '../core/errors.js';
import { GuardedFileSystem } from '../core/fs.js';
import { fingerprintJobInput, resolveSnapshotRoot } from '../core/job-manager.js';
import { defaultFalseBoolean, RequiredPath } from '../core/schema.js';
import { runSnapshotPipeline } from '../core/snapshot-pipeline.js';
import { sourceProvenance } from '../core/source-provenance.js';
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

function snapshotTool(tree: boolean) {
  return defineTool({
    name: 'snapshot',
    title: 'Start Metadata Snapshot',
    description:
      'Create/reuse a recursive CSV/ZIP metadata index for inventories and file totals. ' +
      (tree
        ? 'Returns a tree-depth-v1 manifest. Each part has a root record, then RFC 4180 records with numeric depth and exact names; D/F are directory/file objects, C is ancestor context, U marks incomplete directories. ' +
          'Parse records, not lines; check completeness. '
        : 'Returns the stable manifest and file-only CSV: RootId,RelativePath,Name,Extension,Length,LastWriteTime. ') +
      'Reads sources; writes separate bounded scratch. Reuses complete results within maxAgeMs or joins running jobs of the same format; source changes are not detected. ' +
      'Use forceRefresh/idempotencyKey for new scans/safe retries. Poll job_status; get_artifact delivers manifest/ZIP parts.',
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
        ...(tree ? { layout: 'tree-depth-v1' as const } : {}),
      };
      const policyFingerprint = await ctx.fs.pathGuard.snapshotPolicyFingerprint();
      const configFingerprint = ctx.jobManager.snapshotConfigFingerprint(tree);
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
          ...(tree ? { layout: 'tree-depth-v1' } : {}),
        },
        run: async (runCtx) => {
          runCtx.job.provenance = await sourceProvenance.capture(sourceRoot);
          await runCtx.checkpoint();
          return runSnapshotPipeline(
            workerFs,
            sourceRoot,
            {
              includeHidden: args.includeHidden,
              includeIgnored: args.includeIgnored,
              ...(tree ? { layout: 'tree-depth-v1' as const } : {}),
            },
            runCtx,
          );
        },
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
}

export const SNAPSHOT = snapshotTool(true);
export const STABLE_SNAPSHOT = snapshotTool(false);
