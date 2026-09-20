export const JOB_STATES = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
] as const;

type JobState = (typeof JOB_STATES)[number];

export interface SnapshotCounters {
  entriesSeen: number;
  filesWritten: number;
  directoriesVisited: number;
  symlinksSkipped: number;
  hiddenExcluded: number;
  ignoredExcluded: number;
  scratchExcluded: number;
  inaccessibleSkipped: number;
  disappearedSkipped: number;
  specialSkipped: number;
  errors: number;
  rawCsvBytes: number;
  zipBytes: number;
  parts: number;
}

export interface JobErrorSample {
  readonly code: string;
  readonly path?: string;
  readonly message: string;
}

export interface StoredArtifact {
  readonly artifactId: string;
  readonly kind: 'manifest' | 'snapshot-part';
  readonly name: string;
  readonly mimeType: string;
  readonly fileName: string;
  readonly size: number;
  readonly sha256: string;
  readonly rows?: number;
  readonly rawBytes?: number;
}

export interface StoredJob {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly sourceRoot: string;
  readonly sourceRootId: string;
  readonly input: Record<string, unknown>;
  state: JobState;
  phase: string;
  readonly createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  resultExpiresAt?: string;
  resultExpired?: boolean;
  stopReason?: string;
  complete: boolean;
  counters: SnapshotCounters;
  errors: JobErrorSample[];
  artifacts: StoredArtifact[];
  manifestArtifactId?: string;
}

export function emptySnapshotCounters(): SnapshotCounters {
  return {
    entriesSeen: 0,
    filesWritten: 0,
    directoriesVisited: 0,
    symlinksSkipped: 0,
    hiddenExcluded: 0,
    ignoredExcluded: 0,
    scratchExcluded: 0,
    inaccessibleSkipped: 0,
    disappearedSkipped: 0,
    specialSkipped: 0,
    errors: 0,
    rawCsvBytes: 0,
    zipBytes: 0,
    parts: 0,
  };
}
