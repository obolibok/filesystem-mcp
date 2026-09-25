import * as z from 'zod/v4';

import type { JobCounters, StoredJob } from '../core/job-types.js';
import { JOB_STATES } from '../core/job-types.js';
import { IsoDateTime, NonNegInt, Sha256Hex } from '../core/schema.js';

const SnapshotCountersSchema = z.strictObject({
  entriesSeen: NonNegInt,
  filesWritten: NonNegInt,
  directoriesVisited: NonNegInt,
  symlinksSkipped: NonNegInt,
  hiddenExcluded: NonNegInt,
  ignoredExcluded: NonNegInt,
  scratchExcluded: NonNegInt,
  inaccessibleSkipped: NonNegInt,
  disappearedSkipped: NonNegInt,
  specialSkipped: NonNegInt,
  errors: NonNegInt,
  rawCsvBytes: NonNegInt,
  zipBytes: NonNegInt,
  parts: NonNegInt,
});

const BundleCountersSchema = z.strictObject({
  requested: NonNegInt,
  included: NonNegInt,
  skipped: NonNegInt,
  missing: NonNegInt,
  inaccessible: NonNegInt,
  changed: NonNegInt,
  special: NonNegInt,
  tooLarge: NonNegInt,
  sourceBytes: NonNegInt,
  zipBytes: NonNegInt,
  parts: NonNegInt,
  errors: NonNegInt,
});

const ErrorSampleSchema = z.strictObject({
  code: z.string(),
  path: z.string().optional(),
  message: z.string(),
});

const FatalErrorSchema = ErrorSampleSchema.extend({
  nativeErrorCode: z.string().optional(),
  operation: z.string().optional(),
});

const ArtifactSummarySchema = z.strictObject({
  artifactId: z.string(),
  kind: z.enum(['manifest', 'snapshot-part', 'bundle-part']),
  name: z.string(),
  size: NonNegInt,
  sha256: Sha256Hex,
  rows: NonNegInt.optional(),
  rawBytes: NonNegInt.optional(),
});

export const JobStatusOutputSchema = z.strictObject({
  jobId: z.string(),
  kind: z.string(),
  state: z.enum(JOB_STATES),
  phase: z.string(),
  createdAt: IsoDateTime,
  startedAt: IsoDateTime.optional(),
  finishedAt: IsoDateTime.optional(),
  elapsedMs: NonNegInt,
  complete: z.boolean(),
  resultExpired: z.boolean(),
  resultExpiresAt: IsoDateTime.optional(),
  stopReason: z.string().optional(),
  fatalError: FatalErrorSchema.optional(),
  counters: z.union([SnapshotCountersSchema, BundleCountersSchema]),
  errors: z.array(ErrorSampleSchema),
  manifestArtifactId: z.string().optional(),
  artifacts: z.array(ArtifactSummarySchema),
});

export type JobStatusValue = z.infer<typeof JobStatusOutputSchema>;

export function jobStatusValue(job: StoredJob<JobCounters>): JobStatusValue {
  const start = Date.parse(job.startedAt ?? job.createdAt);
  const end = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
  return {
    jobId: job.jobId,
    kind: job.kind,
    state: job.state,
    phase: job.phase,
    createdAt: job.createdAt,
    ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    elapsedMs: Math.max(0, end - start),
    complete: job.complete,
    resultExpired: job.resultExpired ?? false,
    ...(job.resultExpiresAt ? { resultExpiresAt: job.resultExpiresAt } : {}),
    ...(job.stopReason ? { stopReason: job.stopReason } : {}),
    ...(job.fatalError ? { fatalError: { ...job.fatalError } } : {}),
    counters: { ...job.counters },
    errors: job.errors.map((error) => ({ ...error })),
    ...(job.manifestArtifactId ? { manifestArtifactId: job.manifestArtifactId } : {}),
    artifacts: job.artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      name: artifact.name,
      size: artifact.size,
      sha256: artifact.sha256,
      ...(artifact.rows !== undefined ? { rows: artifact.rows } : {}),
      ...(artifact.rawBytes !== undefined ? { rawBytes: artifact.rawBytes } : {}),
    })),
  };
}

export const JobIdInputSchema = z.strictObject({
  jobId: z.uuid().describe('Opaque job ID returned by snapshot or bundle; pass unchanged.'),
});
