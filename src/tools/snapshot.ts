import { createHash } from 'node:crypto';

import * as z from 'zod/v4';

import { ErrorCode, FsError } from '../core/errors.js';
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

function snapshotRootId(path: string): string {
  return `root-${createHash('sha256').update(path).digest('hex').slice(0, 16)}`;
}

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
      const catalog = ctx.jobManager.catalog;
      const plan = await catalog?.planSnapshot(
        ctx.fs,
        sourceRoot,
        normalized,
        args.maxAgeMs,
        args.forceRefresh,
      );
      const automaticFingerprint = (generation?: string): string =>
        fingerprintJobInput({
          version: 2,
          ...normalized,
          policyFingerprint,
          configFingerprint,
          ...(generation ? { catalog: generation } : {}),
        });
      const requestFingerprint = fingerprintJobInput({
        ...normalized,
        maxAgeMs: args.maxAgeMs,
        forceRefresh: args.forceRefresh,
      });
      const workerFs = new GuardedFileSystem(ctx.fs.pathGuard);
      const submitted = await ctx.jobManager.submit({
        kind: 'snapshot',
        ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
        fingerprint: fingerprintJobInput(normalized),
        automaticReuse: {
          fingerprint: automaticFingerprint(plan?.fingerprint),
          policyFingerprint,
          configFingerprint,
          requestFingerprint,
          maxAgeMs: args.maxAgeMs,
          forceRefresh: args.forceRefresh,
        },
        sourceRoot,
        sourceRootId: snapshotRootId(sourceRoot),
        reuseGuard: ctx.fs.pathGuard,
        input: {
          includeHidden: args.includeHidden,
          includeIgnored: args.includeIgnored,
          ...(tree ? { layout: 'tree-depth-v1' } : {}),
        },
        run: async (runCtx) => {
          if (plan && catalog) {
            const artifact = await catalog.exportSnapshot(
              plan,
              workerFs,
              runCtx,
              normalized,
              (id) => {
                runCtx.job.reuseFingerprint = automaticFingerprint(id);
              },
            );
            if (artifact) return artifact;
          }
          runCtx.job.provenance = await sourceProvenance.capture(sourceRoot);
          await runCtx.checkpoint();
          return runSnapshotPipeline(workerFs, sourceRoot, normalized, runCtx);
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

function exportIndexTool(tree: boolean) {
  return defineTool({
    name: 'export_index',
    title: 'Export Published File Catalog',
    description:
      'Export the published SQLite index for one allowed root or indexed subfolder, regardless of index age. ' +
      'This never scans source files or builds an index. The manifest records the generation, observation times and the number of entries excluded by policy. ' +
      (tree ? 'Produces tree-depth-v1 CSV/ZIP. ' : 'Produces stable file-only CSV/ZIP. ') +
      'Poll job_status and use get_artifact for the manifest and ZIP parts. Complete means every published record for the path was exported.',
    input: z.strictObject({ path: RequiredPath.describe('An indexed root or indexed subfolder.') }),
    output: SnapshotOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    sourceMutating: false,
    defaultErrorCode: ErrorCode.IO_ERROR,
    accessPaths: (args) => [args.path],
    run: async ({ path }, ctx) => {
      const catalog = ctx.jobManager.catalog;
      if (!catalog) throw new FsError(ErrorCode.INVALID_INPUT, 'File catalog is disabled');
      const sourceRoot = await ctx.fs.pathGuard.validateExistingDirectory(path, ctx.signal);
      await ctx.jobManager.assertScratchSeparated(sourceRoot);
      const policyFingerprint = await ctx.fs.pathGuard.snapshotPolicyFingerprint();
      const configFingerprint = ctx.jobManager.snapshotConfigFingerprint(tree);
      const options = {
        includeHidden: false,
        includeIgnored: false,
        ...(tree ? { layout: 'tree-depth-v1' as const } : {}),
      };
      const identity = {
        version: 1,
        kind: 'published-catalog-export',
        sourceRoot,
        policyFingerprint,
        configFingerprint,
        ...options,
      };
      const forGeneration = (generation: string) =>
        fingerprintJobInput({ ...identity, generation });
      const fingerprint = forGeneration(await catalog.publishedGeneration(ctx.fs, sourceRoot));
      const fs = new GuardedFileSystem(ctx.fs.pathGuard);
      const submitted = await ctx.jobManager.submit({
        kind: 'snapshot',
        fingerprint,
        automaticReuse: {
          fingerprint,
          policyFingerprint,
          configFingerprint,
          requestFingerprint: fingerprint,
          maxAgeMs: Number.POSITIVE_INFINITY,
          forceRefresh: false,
        },
        sourceRoot,
        sourceRootId: snapshotRootId(sourceRoot),
        reuseGuard: ctx.fs.pathGuard,
        input: { ...options, catalogExport: true },
        run: (runCtx) =>
          catalog.exportPublishedSnapshot(fs, runCtx, options, (generation) => {
            runCtx.job.reuseFingerprint = forGeneration(generation);
          }),
      });
      return {
        structured: {
          reused: submitted.reused,
          reason: submitted.reason,
          job: jobStatusValue(submitted.job),
        },
        text: `Index export job ${submitted.job.jobId} (${submitted.job.state}, ${submitted.reason}). Poll job_status for artifacts.`,
      };
    },
  });
}

export const EXPORT_INDEX = exportIndexTool(true);
export const STABLE_EXPORT_INDEX = exportIndexTool(false);
