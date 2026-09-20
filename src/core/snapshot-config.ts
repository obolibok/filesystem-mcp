import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { getMaxTextFileSize, MIB, parseEnvInt } from './util.js';

export interface SnapshotConfig {
  readonly scratchDirectory: string;
  readonly maxRecordBytes: number;
  readonly maxRawPartBytes: number;
  readonly maxZipBytes: number;
  readonly maxDeliveryBytes: number;
  /** General file cap captured when this endpoint/process manager is created. */
  readonly maxFileSizeBytes: number;
  readonly maxJobRawBytes: number;
  readonly maxJobArtifactBytes: number;
  readonly maxParts: number;
  readonly maxRunningJobs: number;
  readonly maxQueuedJobs: number;
  readonly maxJobMs: number;
  readonly resultTtlMs: number;
  readonly scratchQuotaBytes: number;
  readonly maxConcurrentReads: number;
  readonly maxWalkDepth: number;
  readonly cleanupIntervalMs: number;
  readonly ephemeralScratch: boolean;
}

export function getSnapshotConfig(): SnapshotConfig {
  const isTest =
    process.env['NODE_ENV'] === 'test' ||
    process.env['NODE_TEST_CONTEXT'] !== undefined ||
    process.execArgv.includes('--test');
  const defaultScratch = resolve(
    tmpdir(),
    isTest ? `filesystem-mcp-snapshot-test-${randomUUID()}` : 'filesystem-mcp-snapshot-v1',
  );
  return {
    scratchDirectory: resolve(process.env['FS_SNAPSHOT_DIR'] ?? defaultScratch),
    maxRecordBytes: parseEnvInt('FS_SNAPSHOT_MAX_RECORD_BYTES', MIB, 1024, 16 * MIB),
    maxRawPartBytes: parseEnvInt('FS_SNAPSHOT_MAX_RAW_PART_BYTES', 45 * MIB, 64 * 1024, 512 * MIB),
    maxZipBytes: parseEnvInt('FS_SNAPSHOT_MAX_ZIP_BYTES', 8 * MIB, 64 * 1024, 100 * MIB),
    maxDeliveryBytes: parseEnvInt('FS_SNAPSHOT_MAX_DELIVERY_BYTES', 8 * MIB, 64 * 1024, 100 * MIB),
    maxFileSizeBytes: getMaxTextFileSize(),
    maxJobRawBytes: parseEnvInt('FS_SNAPSHOT_MAX_JOB_RAW_BYTES', 512 * MIB, MIB, 16 * 1024 * MIB),
    maxJobArtifactBytes: parseEnvInt(
      'FS_SNAPSHOT_MAX_JOB_ARTIFACT_BYTES',
      512 * MIB,
      MIB,
      16 * 1024 * MIB,
    ),
    maxParts: parseEnvInt('FS_SNAPSHOT_MAX_PARTS', 128, 1, 4096),
    maxRunningJobs: parseEnvInt('FS_SNAPSHOT_MAX_RUNNING_JOBS', 1, 1, 16),
    maxQueuedJobs: parseEnvInt('FS_SNAPSHOT_MAX_QUEUED_JOBS', 4, 0, 100),
    maxJobMs: parseEnvInt('FS_SNAPSHOT_MAX_JOB_MS', 60 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
    resultTtlMs: parseEnvInt(
      'FS_SNAPSHOT_RESULT_TTL_MS',
      24 * 60 * 60 * 1000,
      1000,
      30 * 24 * 60 * 60 * 1000,
    ),
    scratchQuotaBytes: parseEnvInt(
      'FS_SNAPSHOT_SCRATCH_QUOTA_BYTES',
      1024 * MIB,
      MIB,
      64 * 1024 * MIB,
    ),
    maxConcurrentReads: parseEnvInt('FS_SNAPSHOT_MAX_CONCURRENT_READS', 2, 1, 32),
    maxWalkDepth: parseEnvInt('FS_SNAPSHOT_MAX_WALK_DEPTH', 256, 8, 4096),
    cleanupIntervalMs: parseEnvInt(
      'FS_SNAPSHOT_CLEANUP_INTERVAL_MS',
      60 * 1000,
      1000,
      60 * 60 * 1000,
    ),
    ephemeralScratch: isTest && process.env['FS_SNAPSHOT_DIR'] === undefined,
  };
}
