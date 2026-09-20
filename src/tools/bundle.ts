import { createHash } from 'node:crypto';
import { join } from 'node:path';

import * as z from 'zod/v4';

import type { BundleSelection } from '../core/bundle-pipeline.js';
import { runBundlePipeline } from '../core/bundle-pipeline.js';
import { ErrorCode, FsError } from '../core/errors.js';
import { GuardedFileSystem } from '../core/fs.js';
import { fingerprintJobInput, resolveSnapshotRoot } from '../core/job-manager.js';
import { emptyBundleCounters } from '../core/job-types.js';
import { isSamePath } from '../core/path-utils.js';
import { IsoDateTime, NonNegInt, RequiredPath } from '../core/schema.js';
import { BUNDLE_SCHEMA_MAX_FILES } from '../core/snapshot-config.js';
import { defineTool, type ToolCtx } from './define.js';
import { JobStatusOutputSchema, jobStatusValue } from './job-shared.js';

const WINDOWS_DEVICE_RE = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

const IdempotencyKey = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/u)
  .describe('Stable caller-generated key (8-128 safe characters); reuse after a lost response.');

const RelativePath = z
  .string()
  .min(1)
  .max(4096)
  .superRefine((value, ctx) => {
    const segments = value.split('/');
    const invalid =
      value.startsWith('/') ||
      value.endsWith('/') ||
      value.includes('\\') ||
      value.includes(':') ||
      hasControlCharacter(value) ||
      segments.some(
        (segment) =>
          segment === '' ||
          segment === '.' ||
          segment === '..' ||
          segment.endsWith('.') ||
          segment.endsWith(' ') ||
          WINDOWS_DEVICE_RE.test(segment),
      );
    if (invalid) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Use a portable relative file path with / separators; absolute, drive, UNC, device, ADS, traversal, control-character, and trailing-dot/space names are forbidden',
        fatal: true,
      });
    }
  })
  .describe(
    'One exact file path relative to path, using / separators; directories are not recursive.',
  );

const ExpectedMetadata = z.strictObject({
  size: NonNegInt,
  lastWriteTime: IsoDateTime,
});

const BundleFile = z.strictObject({
  relativePath: RelativePath,
  expected: ExpectedMetadata.optional().describe(
    'Optional snapshot precondition; size and lastWriteTime must both match before capture.',
  ),
});

const BundleInputSchema = z
  .strictObject({
    path: RequiredPath.describe('Exactly one guarded source directory for all selected files.'),
    idempotencyKey: IdempotencyKey,
    files: z
      .array(BundleFile)
      .min(1)
      .max(BUNDLE_SCHEMA_MAX_FILES)
      .describe('Explicit bounded set of originals; no globbing or recursive directory expansion.'),
  })
  .superRefine((value, ctx) => {
    const portableEntries = new Set<string>();
    for (const [index, file] of value.files.entries()) {
      const key = file.relativePath.normalize('NFC').toLowerCase();
      if (portableEntries.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['files', index, 'relativePath'],
          message: 'Duplicate or portable extraction-colliding relative path',
        });
      }
      portableEntries.add(key);
    }
  });

const BundleOutputSchema = z.strictObject({
  reused: z.boolean(),
  job: JobStatusOutputSchema,
});

function compareSelections(left: BundleSelection, right: BundleSelection): number {
  return left.relativePath < right.relativePath
    ? -1
    : left.relativePath > right.relativePath
      ? 1
      : JSON.stringify(left.expected) < JSON.stringify(right.expected)
        ? -1
        : JSON.stringify(left.expected) > JSON.stringify(right.expected)
          ? 1
          : 0;
}

export const BUNDLE = defineTool({
  name: 'bundle',
  title: 'Bundle Selected Originals',
  description:
    'Submit a durable background job that captures exactly the selected regular files from one guarded directory into independent byte-exact ZIP parts. Poll job_status, then fetch the external manifest and every ZIP part with get_artifact.',
  input: BundleInputSchema,
  output: BundleOutputSchema,
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
    if (args.files.length > ctx.jobManager.config.maxBundleFiles) {
      throw new FsError(
        ErrorCode.TOO_LARGE,
        `Bundle selection exceeds configured file-count cap ${String(ctx.jobManager.config.maxBundleFiles)}`,
      );
    }
    const selections: BundleSelection[] = args.files
      .map((file) => ({
        relativePath: file.relativePath,
        ...(file.expected ? { expected: { ...file.expected } } : {}),
      }))
      .sort(compareSelections);
    const selectionBytes = Buffer.byteLength(JSON.stringify(selections), 'utf8');
    if (selectionBytes > ctx.jobManager.config.maxBundleSelectionBytes) {
      throw new FsError(
        ErrorCode.TOO_LARGE,
        `Bundle selection metadata exceeds configured cap (${String(selectionBytes)} > ${String(ctx.jobManager.config.maxBundleSelectionBytes)} bytes)`,
      );
    }
    const authorizationPaths = selections.map((file) =>
      join(sourceRoot, ...file.relativePath.split('/')),
    );
    for (let index = 0; index < authorizationPaths.length; index += 1) {
      if (
        authorizationPaths
          .slice(0, index)
          .some((existing) => isSamePath(existing, authorizationPaths[index] ?? ''))
      ) {
        throw new FsError(
          ErrorCode.INVALID_INPUT,
          'Bundle selection contains duplicate platform path aliases',
          selections[index]?.relativePath,
        );
      }
    }
    const normalized = { kind: 'bundle', sourceRoot, files: selections };
    const sourceRootId = `root-${createHash('sha256').update(sourceRoot).digest('hex').slice(0, 16)}`;
    const workerFs = new GuardedFileSystem(ctx.fs.pathGuard);
    const submitted = await ctx.jobManager.submit({
      kind: 'bundle',
      idempotencyKey: args.idempotencyKey,
      fingerprint: fingerprintJobInput(normalized),
      sourceRoot,
      sourceRootId,
      input: { files: selections },
      authorizationPaths,
      counters: emptyBundleCounters(selections.length),
      run: async (runCtx) => runBundlePipeline(workerFs, sourceRoot, selections, runCtx),
    });
    const value = { reused: submitted.reused, job: jobStatusValue(submitted.job) };
    return {
      structured: value,
      text: `${submitted.reused ? 'Reused' : 'Submitted'} bundle job ${submitted.job.jobId} (${submitted.job.state}). Poll job_status; the submit request may close without cancelling the job.`,
    };
  },
});
