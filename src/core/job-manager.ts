import { createHash, randomUUID } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { ErrorCode, formatUnknownErrorMessage, FsError, isNodeError } from './errors.js';
import type { GuardedFileSystem } from './fs.js';
import type {
  JobCounters,
  JobErrorSample,
  JobFatalError,
  SnapshotCounters,
  StoredArtifact,
  StoredJob,
} from './job-types.js';
import { emptySnapshotCounters } from './job-types.js';
import { Logger } from './observability.js';
import { isPathInsideDirectory, isSamePath } from './path-utils.js';
import type { PathGuard } from './path.js';
import type { SnapshotConfig } from './snapshot-config.js';
import { getSnapshotConfig } from './snapshot-config.js';
import { getMaxTextFileSize } from './util.js';

const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_ERROR_SAMPLES = 20;
const MAX_ERROR_MESSAGE = 512;
const MAX_ERROR_PATH = 1024;
const METADATA_RENAME_ATTEMPTS = 8;
const MAX_KEY_BINDINGS_PER_JOB = 1024;
const OWNED_ARTIFACT_FILE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:json|zip)$/u;

export interface SubmitJobInput<Counters extends JobCounters = SnapshotCounters> {
  readonly kind: string;
  readonly idempotencyKey?: string;
  readonly fingerprint: string;
  readonly automaticReuse?: {
    readonly fingerprint: string;
    readonly policyFingerprint: string;
    readonly configFingerprint: string;
    readonly requestFingerprint: string;
    readonly maxAgeMs: number;
    readonly forceRefresh: boolean;
  };
  readonly sourceRoot: string;
  readonly sourceRootId: string;
  readonly input: Record<string, unknown>;
  readonly authorizationPaths?: readonly string[];
  /** Re-check current policy before returning metadata for an idempotent reuse. */
  readonly reuseGuard?: PathGuard;
  readonly counters?: Counters;
  readonly run: (ctx: JobRunContext<Counters>) => Promise<string>;
}

export type SubmitReason = 'created' | 'completed_reuse' | 'inflight_reuse' | 'idempotent_replay';

export interface ArtifactPayload {
  readonly artifact: StoredArtifact;
  readonly bytes: Buffer;
  readonly job: StoredJob<JobCounters>;
}

interface RuntimeJob {
  readonly job: StoredJob<JobCounters>;
  readonly run?: (ctx: JobRunContext) => Promise<string>;
  readonly abortController: AbortController;
  worker?: Promise<void>;
  tempBytes: number;
}

interface ArtifactJobManagerDeps {
  readonly now?: () => number;
  readonly statArtifact?: (path: string) => Promise<Stats>;
  readonly readArtifact?: (path: string) => Promise<Buffer>;
  readonly unlinkFile?: (path: string) => Promise<void>;
  /** Test seams for exercising cancellation on both sides of the atomic rename. */
  readonly beforeArtifactRename?: (job: StoredJob<JobCounters>) => Promise<void>;
  readonly afterArtifactRename?: (job: StoredJob<JobCounters>) => Promise<void>;
}

function isTerminal(job: StoredJob<JobCounters>): boolean {
  return ['completed', 'failed', 'cancelled', 'interrupted'].includes(job.state);
}

function isJobRunning(job: StoredJob<JobCounters>): boolean {
  return job.state === 'running';
}

function nativeError(error: unknown): NodeJS.ErrnoException | undefined {
  const visited = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error && !visited.has(current); depth += 1) {
    visited.add(current);
    if (
      !(current instanceof FsError) &&
      isNodeError(current) &&
      /^E[A-Z]{2,20}$/u.test(current.code ?? '')
    ) {
      return current;
    }
    current = current.cause;
  }
  return undefined;
}

function safeDiagnosticPath(
  error: unknown,
  job: StoredJob<JobCounters>,
  scratchDirectory: string,
  explicitPath?: string,
): string | undefined {
  const native = nativeError(error);
  const candidates = [
    explicitPath,
    error instanceof FsError ? error.problem.path : undefined,
    native?.path,
  ];
  for (const candidate of candidates) {
    if (
      typeof candidate !== 'string' ||
      candidate.length > MAX_ERROR_PATH ||
      !isAbsolute(candidate)
    )
      continue;
    const normalized = resolve(candidate);
    if (
      isPathInsideDirectory(job.sourceRoot, normalized) ||
      isPathInsideDirectory(scratchDirectory, normalized)
    )
      return normalized;
  }
  return undefined;
}

function safeDiagnosticMessage(error: unknown, code: string): string {
  // Error.message may contain an arbitrary path, URL, or credential. Expose
  // only fixed text; stopReason retains its existing contract.
  if (error instanceof FsError && error.message === 'Cannot access path')
    return 'Cannot access path';
  if (error instanceof FsError && error.message === 'Path not found') return 'Path not found';
  switch (code) {
    case ErrorCode.TOO_LARGE:
      return 'Configured limit exceeded';
    case ErrorCode.NOT_FILE:
      return 'Path is not a file';
    case ErrorCode.NOT_DIRECTORY:
      return 'Path is not a directory';
    case ErrorCode.PERMISSION_DENIED:
    case 'EACCES':
    case 'EPERM':
      return 'Permission denied';
    default:
      return 'Job failed';
  }
}

function safeDiagnostic(
  error: unknown,
  job: StoredJob<JobCounters>,
  scratchDirectory: string,
  explicitPath?: string,
): JobFatalError {
  const native = nativeError(error);
  const code = error instanceof FsError ? error.code : (native?.code ?? ErrorCode.UNKNOWN);
  const message = safeDiagnosticMessage(error, code);
  const path = safeDiagnosticPath(error, job, scratchDirectory, explicitPath);
  const nativeErrorCode = native?.code;
  const operation = native?.syscall;
  return {
    code: code.slice(0, 64),
    message: message.slice(0, MAX_ERROR_MESSAGE),
    ...(path ? { path } : {}),
    ...(nativeErrorCode ? { nativeErrorCode } : {}),
    ...(typeof operation === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,31}$/u.test(operation)
      ? { operation }
      : {}),
  };
}

function safeErrorSample(
  error: unknown,
  job: StoredJob<JobCounters>,
  scratchDirectory: string,
  path?: string,
): JobErrorSample {
  const { code, message, path: safePath } = safeDiagnostic(error, job, scratchDirectory, path);
  return { code, message, ...(safePath ? { path: safePath } : {}) };
}

async function replaceMetadataFile(temp: string, destination: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(temp, destination);
      return;
    } catch (error) {
      const transient =
        isNodeError(error) &&
        (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EBUSY');
      if (!transient || attempt >= METADATA_RENAME_ATTEMPTS) throw error;
      await delay(attempt * 10);
    }
  }
}

async function assertScratchHasNoLinks(path: string): Promise<void> {
  let current = resolve(path);
  for (;;) {
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new FsError(
          ErrorCode.ACCESS_DENIED,
          'FS_SNAPSHOT_DIR must not be a symlink or junction alias',
          path,
        );
      }
    } catch (error) {
      // A new scratch may not exist yet, but its existing ancestors must be safe.
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export function fingerprintJobInput(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class JobRunContext<Counters extends JobCounters = JobCounters> {
  private readonly manager: ArtifactJobManager;
  readonly runtime: RuntimeJob;
  readonly signal: AbortSignal;

  constructor(manager: ArtifactJobManager, runtime: RuntimeJob, signal: AbortSignal) {
    this.manager = manager;
    this.runtime = runtime;
    this.signal = signal;
  }

  get config(): SnapshotConfig {
    return this.manager.config;
  }

  get job(): StoredJob<Counters> {
    return this.runtime.job as StoredJob<Counters>;
  }

  async setPhase(phase: string): Promise<void> {
    this.signal.throwIfAborted();
    if (this.job.state !== 'running') throw this.signal.reason;
    this.job.phase = phase;
    await this.manager.persist(this.job);
  }

  async checkpoint(): Promise<void> {
    await this.manager.persist(this.job);
  }

  addError(error: unknown, path?: string): void {
    this.job.counters.errors += 1;
    this.job.complete = false;
    if (this.job.errors.length < MAX_ERROR_SAMPLES) {
      this.job.errors.push(safeErrorSample(error, this.job, this.manager.scratchDirectory, path));
    }
  }

  tempPath(label: string): string {
    const safeLabel = label.replace(/[^A-Za-z0-9._-]/gu, '_');
    return join(this.manager.jobDirectory(this.job.jobId), `${randomUUID()}.${safeLabel}.partial`);
  }

  isScratchPath(path: string): boolean {
    return this.manager.isScratchPath(path);
  }

  reserveDisk(bytes: number): void {
    this.manager.reserveTemp(this.runtime, bytes);
  }

  releaseDisk(bytes: number): void {
    this.manager.releaseTemp(this.runtime, bytes);
  }

  async commitArtifact(
    partialPath: string,
    artifact: Omit<StoredArtifact, 'artifactId' | 'fileName'>,
  ): Promise<StoredArtifact> {
    this.signal.throwIfAborted();
    if (!isJobRunning(this.job)) throw new Error('Job is no longer running');
    return this.manager.commitArtifact(this.runtime, partialPath, artifact);
  }

  async removeTemp(path: string, accountedBytes: number): Promise<void> {
    await this.manager.removeTemp(this.runtime, path, accountedBytes);
  }
}

export class ArtifactJobManager {
  readonly config: SnapshotConfig;
  readonly #readArtifact: (path: string) => Promise<Buffer>;
  readonly #unlinkFile: (path: string) => Promise<void>;
  readonly #beforeArtifactRename: ((job: StoredJob<JobCounters>) => Promise<void>) | undefined;
  readonly #afterArtifactRename: ((job: StoredJob<JobCounters>) => Promise<void>) | undefined;
  readonly #now: () => number;
  readonly #statArtifact: (path: string) => Promise<Stats>;
  readonly #jobs = new Map<string, RuntimeJob>();
  readonly #idempotency = new Map<string, { jobId: string; requestFingerprint?: string }>();
  readonly #artifactJobs = new Map<string, string>();
  readonly #artifactBytes = new Map<string, number>();
  readonly #orphanBytes = new Map<string, number>();
  readonly #persistChains = new Map<string, Promise<void>>();
  readonly #artifactRemovalChains = new Map<string, Promise<void>>();
  readonly #lifecycleChains = new Map<string, Promise<void>>();
  readonly #activeReads = new Map<string, number>();
  readonly #metadataBytes = new Map<string, number>();
  #scratchDirectory: string;
  #initialized?: Promise<void>;
  #cleanupTimer?: NodeJS.Timeout;
  #usedBytes = 0;
  #running = 0;
  #closed = false;
  #readSlots = 0;
  readonly #readWaiters: (() => void)[] = [];
  #submitChain: Promise<void> = Promise.resolve();

  constructor(config: SnapshotConfig = getSnapshotConfig(), deps: ArtifactJobManagerDeps = {}) {
    this.config = config;
    this.#scratchDirectory = resolve(config.scratchDirectory);
    this.#readArtifact = deps.readArtifact ?? (async (path) => readFile(path));
    this.#unlinkFile = deps.unlinkFile ?? unlink;
    this.#beforeArtifactRename = deps.beforeArtifactRename;
    this.#afterArtifactRename = deps.afterArtifactRename;
    this.#now = deps.now ?? Date.now;
    this.#statArtifact = deps.statArtifact ?? lstat;
  }

  get scratchDirectory(): string {
    return this.#scratchDirectory;
  }

  async initialize(): Promise<void> {
    this.#initialized ??= this.#initialize();
    return this.#initialized;
  }

  /** Captured settings that can change snapshot traversal or published artifact shape. */
  snapshotConfigFingerprint(): string {
    const config = this.config;
    return fingerprintJobInput({
      version: 1,
      scratchDirectory: this.#scratchDirectory,
      maxRecordBytes: config.maxRecordBytes,
      maxRawPartBytes: config.maxRawPartBytes,
      maxZipBytes: config.maxZipBytes,
      maxDeliveryBytes: config.maxDeliveryBytes,
      maxFileSizeBytes: config.maxFileSizeBytes,
      maxJobRawBytes: config.maxJobRawBytes,
      maxJobArtifactBytes: config.maxJobArtifactBytes,
      maxParts: config.maxParts,
      maxWalkDepth: config.maxWalkDepth,
    });
  }

  async #initialize(): Promise<void> {
    const requestedScratch = this.config.scratchDirectory;
    await assertScratchHasNoLinks(requestedScratch);
    await mkdir(requestedScratch, { recursive: true, mode: 0o700 });
    await assertScratchHasNoLinks(requestedScratch);
    // Windows 8.3 names are valid spellings, not links. Use their canonical path
    // for every later storage operation and comparison with guarded source paths.
    this.#scratchDirectory = await realpath(requestedScratch);
    let entries: Dirent[];
    try {
      entries = await readdir(this.#scratchDirectory, { withFileTypes: true });
    } catch (error) {
      throw new FsError(
        ErrorCode.IO_ERROR,
        'Cannot enumerate snapshot scratch directory',
        undefined,
        error,
      );
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !JOB_ID_RE.test(entry.name)) continue;
      await this.#loadJob(entry.name);
    }
    this.#cleanupTimer = setInterval(() => {
      void this.cleanupExpired().catch((error: unknown) => {
        Logger.warn(`Snapshot cleanup failed: ${formatUnknownErrorMessage(error)}`);
      });
    }, this.config.cleanupIntervalMs);
    this.#cleanupTimer.unref();
    for (const runtime of this.#jobs.values()) {
      await this.#expireIfNeeded(runtime).catch((error: unknown) => {
        Logger.warn(
          `Could not expire snapshot job ${runtime.job.jobId} during startup: ${formatUnknownErrorMessage(error)}`,
        );
      });
    }
  }

  async #loadJob(jobId: string): Promise<void> {
    const directory = this.jobDirectory(jobId);
    let job: StoredJob<JobCounters>;
    try {
      job = JSON.parse(await readFile(join(directory, 'job.json'), 'utf8')) as StoredJob;
    } catch (error) {
      Logger.warn(`Ignoring unreadable snapshot job ${jobId}: ${formatUnknownErrorMessage(error)}`);
      return;
    }
    if (job.jobId !== jobId || !JOB_ID_RE.test(job.jobId)) return;
    const runtime: RuntimeJob = {
      job,
      abortController: new AbortController(),
      tempBytes: 0,
    };
    this.#jobs.set(jobId, runtime);
    if (job.idempotencyKey) {
      this.#idempotency.set(job.idempotencyKey, {
        jobId,
        ...(job.requestFingerprint ? { requestFingerprint: job.requestFingerprint } : {}),
      });
    }
    for (const binding of job.keyBindings ?? []) {
      this.#idempotency.set(binding.key, { jobId, requestFingerprint: binding.requestFingerprint });
    }
    const metadataSize =
      (await stat(join(directory, 'job.json')).catch(() => undefined))?.size ?? 0;
    this.#metadataBytes.set(jobId, metadataSize);
    this.#usedBytes += metadataSize;
    for (const artifact of job.artifacts) {
      if (
        !JOB_ID_RE.test(artifact.artifactId) ||
        basename(artifact.fileName) !== artifact.fileName
      ) {
        continue;
      }
      this.#artifactJobs.set(artifact.artifactId, jobId);
      const actualSize =
        (await stat(this.#artifactPath(jobId, artifact)).catch(() => undefined))?.size ?? 0;
      const chargedBytes = Math.max(artifact.size, actualSize);
      this.#artifactBytes.set(artifact.artifactId, chargedBytes);
      this.#usedBytes += chargedBytes;
    }
    if (job.state === 'queued' || job.state === 'running') {
      job.state = 'interrupted';
      job.phase = 'interrupted';
      job.complete = false;
      job.stopReason = 'server-restarted';
      job.finishedAt = new Date(this.#now()).toISOString();
      await this.persist(job);
    }
    if (job.state !== 'completed' && job.artifacts.length > 0) {
      await this.#removeArtifacts(runtime).catch((error: unknown) => {
        Logger.warn(
          `Could not remove stale artifacts for snapshot job ${jobId}: ${formatUnknownErrorMessage(error)}`,
        );
      });
      await this.persist(job);
    }
    const leftovers = await readdir(directory, { withFileTypes: true });
    const referencedFiles = new Set(job.artifacts.map((artifact) => artifact.fileName));
    for (const leftover of leftovers) {
      if (!leftover.isFile() || referencedFiles.has(leftover.name)) continue;
      const ownedLeftover =
        leftover.name.endsWith('.partial') ||
        leftover.name.endsWith('.metadata-tmp') ||
        OWNED_ARTIFACT_FILE_RE.test(leftover.name);
      if (!ownedLeftover) continue;
      const path = join(directory, leftover.name);
      const size = (await stat(path).catch(() => undefined))?.size ?? 0;
      try {
        await this.#deleteOwnedFile(path);
      } catch (error) {
        // Keep failed deletion charged until a later restart can reconcile it.
        this.#usedBytes += size;
        this.#orphanBytes.set(jobId, (this.#orphanBytes.get(jobId) ?? 0) + size);
        Logger.warn(
          `Could not remove orphan snapshot file ${leftover.name}: ${formatUnknownErrorMessage(error)}`,
        );
      }
    }
  }

  jobDirectory(jobId: string): string {
    if (!JOB_ID_RE.test(jobId)) throw new FsError(ErrorCode.INVALID_INPUT, 'Invalid job ID');
    return join(this.#scratchDirectory, jobId);
  }

  async submit<Counters extends JobCounters = SnapshotCounters>(
    input: SubmitJobInput<Counters>,
  ): Promise<{ job: StoredJob<Counters>; reused: boolean; reason: SubmitReason }> {
    await this.initialize();
    const result = this.#submitChain.then(() => this.#submit(input));
    this.#submitChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #submit<Counters extends JobCounters>(
    input: SubmitJobInput<Counters>,
  ): Promise<{ job: StoredJob<Counters>; reused: boolean; reason: SubmitReason }> {
    if (this.#closed) throw new FsError(ErrorCode.IO_ERROR, 'Job manager is shutting down');
    if (!input.idempotencyKey && !input.automaticReuse) {
      throw new FsError(ErrorCode.INVALID_INPUT, 'Idempotency key is required for this job');
    }
    if (input.automaticReuse && (input.kind !== 'snapshot' || !input.reuseGuard)) {
      throw new FsError(
        ErrorCode.INVALID_INPUT,
        'Automatic snapshot reuse requires a current access guard',
      );
    }
    if (
      input.automaticReuse &&
      input.automaticReuse.policyFingerprint !==
        (await input.reuseGuard?.snapshotPolicyFingerprint())
    ) {
      throw new FsError(ErrorCode.ACCESS_DENIED, 'Snapshot access policy changed during submit');
    }
    const priorBinding = input.idempotencyKey
      ? this.#idempotency.get(input.idempotencyKey)
      : undefined;
    if (priorBinding) {
      const prior = this.#jobs.get(priorBinding.jobId)?.job;
      if (prior) {
        const matches = priorBinding.requestFingerprint
          ? priorBinding.requestFingerprint === input.automaticReuse?.requestFingerprint
          : prior.fingerprint === input.fingerprint &&
            (!input.automaticReuse ||
              (input.automaticReuse.maxAgeMs === 3_600_000 && !input.automaticReuse.forceRefresh));
        if (!matches) {
          throw new FsError(
            ErrorCode.INVALID_INPUT,
            'Idempotency key is already bound to different normalized job parameters',
          );
        }
        if (
          prior.reuseFingerprint &&
          prior.reuseFingerprint !== input.automaticReuse?.fingerprint
        ) {
          throw new FsError(ErrorCode.ACCESS_DENIED, 'Snapshot reuse policy has changed');
        }
        if (input.reuseGuard) await this.#authorize(prior, input.reuseGuard);
        return { job: prior as StoredJob<Counters>, reused: true, reason: 'idempotent_replay' };
      }
    }
    if (input.automaticReuse && !input.automaticReuse.forceRefresh) {
      const candidate = await this.#findReusable(input.automaticReuse, input.reuseGuard);
      if (candidate) {
        if (input.idempotencyKey) {
          const bindings = candidate.job.keyBindings ?? [];
          if (bindings.length >= MAX_KEY_BINDINGS_PER_JOB) {
            throw new FsError(ErrorCode.TOO_LARGE, 'Snapshot job key-binding limit reached');
          }
          const binding = {
            key: input.idempotencyKey,
            requestFingerprint: input.automaticReuse.requestFingerprint,
          };
          candidate.job.keyBindings = [...bindings, binding];
          try {
            await this.persist(candidate.job);
          } catch (error) {
            candidate.job.keyBindings = bindings;
            throw error;
          }
          this.#idempotency.set(binding.key, {
            jobId: candidate.job.jobId,
            requestFingerprint: binding.requestFingerprint,
          });
        }
        return {
          job: candidate.job as StoredJob<Counters>,
          reused: true,
          reason: candidate.reason,
        };
      }
    }
    const queued = [...this.#jobs.values()].filter(
      (runtime) => runtime.job.state === 'queued',
    ).length;
    if (queued >= this.config.maxQueuedJobs) {
      throw new FsError(ErrorCode.TOO_LARGE, 'Artifact job queue is full');
    }
    const now = new Date(this.#now()).toISOString();
    const jobId = randomUUID();
    const job: StoredJob<Counters> = {
      schemaVersion: 1,
      jobId,
      kind: input.kind,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      fingerprint: input.fingerprint,
      ...(input.automaticReuse
        ? {
            reuseFingerprint: input.automaticReuse.fingerprint,
            policyFingerprint: input.automaticReuse.policyFingerprint,
            configFingerprint: input.automaticReuse.configFingerprint,
            requestFingerprint: input.automaticReuse.requestFingerprint,
          }
        : {}),
      sourceRoot: input.sourceRoot,
      sourceRootId: input.sourceRootId,
      input: input.input,
      ...(input.authorizationPaths ? { authorizationPaths: [...input.authorizationPaths] } : {}),
      state: 'queued',
      phase: 'queued',
      createdAt: now,
      complete: true,
      counters: (input.counters ?? emptySnapshotCounters()) as Counters,
      errors: [],
      artifacts: [],
    };
    const runtime: RuntimeJob = {
      job,
      run: (ctx) => input.run(ctx as JobRunContext<Counters>),
      abortController: new AbortController(),
      tempBytes: 0,
    };
    await mkdir(this.jobDirectory(jobId), { recursive: false, mode: 0o700 });
    this.#jobs.set(jobId, runtime);
    if (input.idempotencyKey) {
      this.#idempotency.set(input.idempotencyKey, {
        jobId,
        ...(input.automaticReuse
          ? { requestFingerprint: input.automaticReuse.requestFingerprint }
          : {}),
      });
    }
    try {
      await this.persist(job);
    } catch (error) {
      this.#jobs.delete(jobId);
      if (input.idempotencyKey) this.#idempotency.delete(input.idempotencyKey);
      await rm(this.jobDirectory(jobId), { recursive: true, force: true });
      throw error;
    }
    queueMicrotask(() => {
      this.#pump();
    });
    return { job, reused: false, reason: 'created' };
  }

  async #findReusable(
    request: NonNullable<SubmitJobInput['automaticReuse']>,
    guard?: PathGuard,
  ): Promise<
    { job: StoredJob<JobCounters>; reason: 'completed_reuse' | 'inflight_reuse' } | undefined
  > {
    const candidates = [...this.#jobs.values()]
      .map((runtime) => runtime.job)
      .filter((job) => job.kind === 'snapshot' && job.reuseFingerprint === request.fingerprint);
    if (guard) {
      // The hash selects candidates; the guard remains the access authority.
      for (const candidate of candidates) await this.#authorize(candidate, guard);
    }
    const checked = new Set<string>();
    const readyValid: StoredJob<JobCounters>[] = [];
    for (;;) {
      // A running candidate can complete while an older result's artifacts are
      // being checked. Re-scan after every await before deciding to create work.
      const now = this.#now();
      const ready = candidates
        .filter((job) => {
          if (checked.has(job.jobId)) return false;
          const started = job.startedAt ? Date.parse(job.startedAt) : NaN;
          const expires = job.resultExpiresAt ? Date.parse(job.resultExpiresAt) : NaN;
          return (
            job.state === 'completed' &&
            job.complete &&
            request.maxAgeMs > 0 &&
            !job.resultExpired &&
            Number.isFinite(started) &&
            started <= now &&
            now - started <= request.maxAgeMs &&
            Number.isFinite(expires) &&
            now < expires
          );
        })
        .sort(
          (a, b) =>
            Date.parse(b.startedAt ?? '') - Date.parse(a.startedAt ?? '') ||
            b.jobId.localeCompare(a.jobId),
        );
      const job = ready[0];
      if (!job) break;
      checked.add(job.jobId);
      if (
        (await this.#readyArtifactsPresent(job)) &&
        this.#now() < Date.parse(job.resultExpiresAt ?? '') &&
        this.#now() - Date.parse(job.startedAt ?? '') <= request.maxAgeMs
      ) {
        readyValid.push(job);
      }
    }
    const now = this.#now();
    const best = readyValid
      .filter(
        (job) =>
          job.state === 'completed' &&
          job.complete &&
          !job.resultExpired &&
          now < Date.parse(job.resultExpiresAt ?? '') &&
          now - Date.parse(job.startedAt ?? '') <= request.maxAgeMs,
      )
      .sort(
        (a, b) =>
          Date.parse(b.startedAt ?? '') - Date.parse(a.startedAt ?? '') ||
          b.jobId.localeCompare(a.jobId),
      )[0];
    if (best) return { job: best, reason: 'completed_reuse' };
    const inflight = candidates
      .filter((job) => job.state === 'queued' || job.state === 'running')
      .sort(
        (a, b) =>
          Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.jobId.localeCompare(b.jobId),
      )[0];
    return inflight ? { job: inflight, reason: 'inflight_reuse' } : undefined;
  }

  async #readyArtifactsPresent(job: StoredJob<JobCounters>): Promise<boolean> {
    const manifests = job.artifacts.filter((artifact) => artifact.kind === 'manifest');
    const parts = job.artifacts.filter((artifact) => artifact.kind === 'snapshot-part');
    if (
      !job.manifestArtifactId ||
      manifests.length !== 1 ||
      manifests[0]?.artifactId !== job.manifestArtifactId ||
      parts.length === 0 ||
      parts.length !== job.counters.parts ||
      manifests.length + parts.length !== job.artifacts.length
    )
      return false;
    for (const artifact of job.artifacts) {
      if (this.#artifactJobs.get(artifact.artifactId) !== job.jobId) return false;
      if (!JOB_ID_RE.test(artifact.artifactId) || !OWNED_ARTIFACT_FILE_RE.test(artifact.fileName))
        return false;
      const stored = await this.#statArtifact(this.#artifactPath(job.jobId, artifact)).catch(
        () => undefined,
      );
      if (!stored?.isFile() || stored.size !== artifact.size) return false;
    }
    return job.state === 'completed' && job.complete && !job.resultExpired;
  }

  #pump(): void {
    if (this.#closed) return;
    while (this.#running < this.config.maxRunningJobs) {
      const runtime = [...this.#jobs.values()].find(
        (candidate) => candidate.job.state === 'queued',
      );
      if (!runtime?.run) return;
      this.#running += 1;
      runtime.worker = this.#run(runtime)
        .catch((error: unknown) => {
          Logger.error(
            `Artifact job ${runtime.job.jobId} could not persist its terminal state: ${formatUnknownErrorMessage(error)}`,
          );
        })
        .finally(() => {
          this.#running -= 1;
          this.#pump();
        });
    }
  }

  async #run(runtime: RuntimeJob): Promise<void> {
    const { job } = runtime;
    if (job.state !== 'queued' || !runtime.run) return;
    job.state = 'running';
    job.phase = 'starting';
    job.startedAt = new Date(this.#now()).toISOString();
    const timeout = AbortSignal.timeout(this.config.maxJobMs);
    const signal = AbortSignal.any([runtime.abortController.signal, timeout]);
    const ctx = new JobRunContext(this, runtime, signal);
    try {
      await this.persist(job);
      signal.throwIfAborted();
      const manifestArtifactId = await runtime.run(ctx);
      if (!isJobRunning(job)) return;
      signal.throwIfAborted();
      job.state = 'completed';
      job.phase = 'completed';
      job.manifestArtifactId = manifestArtifactId;
      job.finishedAt = new Date(this.#now()).toISOString();
      job.resultExpiresAt = new Date(this.#now() + this.config.resultTtlMs).toISOString();
    } catch (error) {
      if (runtime.abortController.signal.aborted || this.#closed) {
        await this.#removeArtifacts(runtime);
        return;
      }
      job.state = 'failed';
      job.phase = 'failed';
      job.complete = false;
      job.stopReason = timeout.aborted ? 'time-limit-exceeded' : formatUnknownErrorMessage(error);
      job.fatalError = timeout.aborted
        ? { code: ErrorCode.TIMEOUT, message: 'Job timed out' }
        : safeDiagnostic(error, job, this.#scratchDirectory);
      job.finishedAt = new Date(this.#now()).toISOString();
      ctx.addError(error);
      await this.#removeArtifacts(runtime);
    } finally {
      await this.#removePartials(runtime);
      await this.persist(job);
    }
  }

  async getJob<Counters extends JobCounters = SnapshotCounters>(
    jobId: string,
    guard: PathGuard,
  ): Promise<StoredJob<Counters>> {
    await this.initialize();
    const runtime = this.#jobs.get(jobId);
    if (!runtime) throw new FsError(ErrorCode.NOT_FOUND, 'Job not found');
    await this.#authorize(runtime.job, guard);
    await this.#expireIfNeeded(runtime);
    return runtime.job as StoredJob<Counters>;
  }

  async cancel<Counters extends JobCounters = SnapshotCounters>(
    jobId: string,
    guard: PathGuard,
  ): Promise<StoredJob<Counters>> {
    const job = await this.getJob<Counters>(jobId, guard);
    const runtime = this.#jobs.get(jobId);
    if (!runtime || isTerminal(job)) return job;
    job.state = 'cancelled';
    job.phase = 'cancelled';
    job.complete = false;
    job.stopReason = 'cancelled-by-client';
    job.finishedAt = new Date(this.#now()).toISOString();
    runtime.abortController.abort(new Error('Job cancelled'));
    await this.#removeArtifacts(runtime);
    await this.persist(job);
    return job;
  }

  async getArtifact(artifactId: string, guard: PathGuard): Promise<ArtifactPayload> {
    await this.initialize();
    const jobId = this.#artifactJobs.get(artifactId);
    if (!jobId) throw new FsError(ErrorCode.NOT_FOUND, 'Artifact not found or expired');
    const runtime = this.#jobs.get(jobId);
    if (!runtime) throw new FsError(ErrorCode.NOT_FOUND, 'Artifact not found or expired');
    await this.#authorize(runtime.job, guard);
    const initialExpiry = runtime.job.resultExpiresAt
      ? Date.parse(runtime.job.resultExpiresAt)
      : Number.POSITIVE_INFINITY;
    if (runtime.job.resultExpired || this.#now() >= initialExpiry) {
      throw new FsError(ErrorCode.NOT_FOUND, 'Artifact has expired');
    }
    await this.#acquireReadSlot();
    this.#activeReads.set(jobId, (this.#activeReads.get(jobId) ?? 0) + 1);
    try {
      const expiry = runtime.job.resultExpiresAt
        ? Date.parse(runtime.job.resultExpiresAt)
        : Number.POSITIVE_INFINITY;
      if (this.#now() >= expiry) {
        throw new FsError(ErrorCode.NOT_FOUND, 'Artifact has expired');
      }
      const artifact = runtime.job.artifacts.find(
        (candidate) => candidate.artifactId === artifactId,
      );
      if (!artifact || runtime.job.state !== 'completed') {
        throw new FsError(ErrorCode.NOT_FOUND, 'Artifact is not available');
      }
      const deliveryLimit = Math.min(this.config.maxDeliveryBytes, getMaxTextFileSize());
      if (artifact.size > deliveryLimit) {
        throw new FsError(
          ErrorCode.TOO_LARGE,
          `Artifact exceeds delivery limit (${String(artifact.size)} > ${String(deliveryLimit)} bytes)`,
        );
      }
      const path = this.#artifactPath(jobId, artifact);
      const bytes = await this.#readArtifact(path);
      if (bytes.length !== artifact.size)
        throw new FsError(ErrorCode.IO_ERROR, 'Artifact size changed');
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (hash !== artifact.sha256) throw new FsError(ErrorCode.IO_ERROR, 'Artifact hash changed');
      return { artifact, bytes, job: runtime.job };
    } finally {
      const remaining = (this.#activeReads.get(jobId) ?? 1) - 1;
      if (remaining > 0) this.#activeReads.set(jobId, remaining);
      else this.#activeReads.delete(jobId);
      this.#releaseReadSlot();
      if (remaining === 0) await this.#expireIfNeeded(runtime);
    }
  }

  reserveTemp(runtime: RuntimeJob, bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid disk reservation');
    if (this.#usedBytes + bytes > this.config.scratchQuotaBytes) {
      throw new FsError(ErrorCode.TOO_LARGE, 'Artifact scratch quota exceeded');
    }
    this.#usedBytes += bytes;
    runtime.tempBytes += bytes;
  }

  releaseTemp(runtime: RuntimeJob, bytes: number): void {
    const released = Math.min(runtime.tempBytes, Math.max(0, bytes));
    runtime.tempBytes -= released;
    this.#usedBytes = Math.max(0, this.#usedBytes - released);
  }

  async removeTemp(runtime: RuntimeJob, path: string, accountedBytes: number): Promise<void> {
    this.#assertOwnedPath(runtime.job.jobId, path);
    await this.#deleteOwnedFile(path);
    this.releaseTemp(runtime, accountedBytes);
  }

  async commitArtifact(
    runtime: RuntimeJob,
    partialPath: string,
    artifactInput: Omit<StoredArtifact, 'artifactId' | 'fileName'>,
  ): Promise<StoredArtifact> {
    this.#assertOwnedPath(runtime.job.jobId, partialPath);
    const currentArtifactBytes = runtime.job.artifacts.reduce(
      (sum, artifact) => sum + artifact.size,
      0,
    );
    if (currentArtifactBytes + artifactInput.size > this.config.maxJobArtifactBytes) {
      throw new FsError(ErrorCode.TOO_LARGE, 'Job artifact-byte limit exceeded');
    }
    const artifactId = randomUUID();
    const extension = artifactInput.kind === 'manifest' ? 'json' : 'zip';
    const fileName = `${artifactId}.${extension}`;
    const finalPath = join(this.jobDirectory(runtime.job.jobId), fileName);
    await this.#beforeArtifactRename?.(runtime.job);
    await rename(partialPath, finalPath);
    runtime.tempBytes = Math.max(0, runtime.tempBytes - artifactInput.size);
    const artifact: StoredArtifact = { artifactId, fileName, ...artifactInput };
    runtime.job.artifacts.push(artifact);
    this.#artifactJobs.set(artifactId, runtime.job.jobId);
    this.#artifactBytes.set(artifactId, artifactInput.size);
    try {
      await this.#afterArtifactRename?.(runtime.job);
      if (!isJobRunning(runtime.job)) throw new Error('Job stopped while committing artifact');
    } catch (error) {
      await this.#removeArtifacts(runtime).catch((cleanupError: unknown) => {
        Logger.warn(
          `Could not roll back artifact ${artifactId}: ${formatUnknownErrorMessage(cleanupError)}`,
        );
      });
      throw error;
    }
    await this.persist(runtime.job);
    return artifact;
  }

  async persist(job: StoredJob<JobCounters>): Promise<void> {
    const previous = this.#persistChains.get(job.jobId) ?? Promise.resolve();
    const next = previous.then(() => this.#persistNow(job));
    this.#persistChains.set(
      job.jobId,
      next.catch(() => undefined),
    );
    await next;
  }

  async #persistNow(job: StoredJob<JobCounters>): Promise<void> {
    const path = join(this.jobDirectory(job.jobId), 'job.json');
    const temp = join(this.jobDirectory(job.jobId), `job.${randomUUID()}.metadata-tmp`);
    const bytes = Buffer.from(`${JSON.stringify(job, null, 2)}\n`, 'utf8');
    const previousBytes = this.#metadataBytes.get(job.jobId) ?? 0;
    if (this.#usedBytes + bytes.length > this.config.scratchQuotaBytes) {
      throw new FsError(
        ErrorCode.TOO_LARGE,
        'Artifact scratch quota exceeded while saving metadata',
      );
    }
    await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
    try {
      await replaceMetadataFile(temp, path);
    } finally {
      await this.#deleteOwnedFile(temp).catch(async (error: unknown) => {
        const size = (await stat(temp).catch(() => undefined))?.size ?? 0;
        this.#usedBytes += size;
        this.#orphanBytes.set(job.jobId, (this.#orphanBytes.get(job.jobId) ?? 0) + size);
        Logger.warn(`Could not remove snapshot metadata temp: ${formatUnknownErrorMessage(error)}`);
      });
    }
    this.#usedBytes += bytes.length - previousBytes;
    this.#metadataBytes.set(job.jobId, bytes.length);
  }

  #artifactPath(jobId: string, artifact: StoredArtifact): string {
    if (basename(artifact.fileName) !== artifact.fileName) {
      throw new FsError(ErrorCode.ACCESS_DENIED, 'Invalid stored artifact path');
    }
    const path = join(this.jobDirectory(jobId), artifact.fileName);
    this.#assertOwnedPath(jobId, path);
    return path;
  }

  #assertOwnedPath(jobId: string, path: string): void {
    const directory = this.jobDirectory(jobId);
    const target = resolve(path);
    if (!isPathInsideDirectory(directory, target)) {
      throw new FsError(ErrorCode.ACCESS_DENIED, 'Snapshot storage path escaped its job directory');
    }
  }

  async #deleteOwnedFile(path: string): Promise<void> {
    try {
      await this.#unlinkFile(path);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    }
  }

  async #removePartials(runtime: RuntimeJob): Promise<void> {
    const entries = await readdir(this.jobDirectory(runtime.job.jobId), {
      withFileTypes: true,
    }).catch(() => []);
    let removedBytes = 0;
    let deletionFailed = false;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.partial')) continue;
      const path = join(this.jobDirectory(runtime.job.jobId), entry.name);
      const size = (await stat(path).catch(() => undefined))?.size ?? 0;
      try {
        await this.#deleteOwnedFile(path);
        removedBytes += size;
      } catch (error) {
        deletionFailed = true;
        Logger.warn(
          `Could not remove partial snapshot file ${entry.name}: ${formatUnknownErrorMessage(error)}`,
        );
      }
    }
    this.releaseTemp(runtime, deletionFailed ? removedBytes : runtime.tempBytes);
  }

  async #removeArtifacts(runtime: RuntimeJob): Promise<void> {
    const jobId = runtime.job.jobId;
    const previous = this.#artifactRemovalChains.get(jobId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const retained: StoredArtifact[] = [];
      let firstError: unknown;
      for (const artifact of runtime.job.artifacts) {
        try {
          await this.#deleteOwnedFile(this.#artifactPath(jobId, artifact));
          const chargedBytes = this.#artifactBytes.get(artifact.artifactId) ?? artifact.size;
          this.#usedBytes = Math.max(0, this.#usedBytes - chargedBytes);
          this.#artifactBytes.delete(artifact.artifactId);
          this.#artifactJobs.delete(artifact.artifactId);
        } catch (error) {
          retained.push(artifact);
          firstError ??= error;
        }
      }
      runtime.job.artifacts = retained;
      if (
        runtime.job.manifestArtifactId &&
        !retained.some((artifact) => artifact.artifactId === runtime.job.manifestArtifactId)
      ) {
        delete runtime.job.manifestArtifactId;
      }
      if (firstError) {
        throw firstError instanceof Error
          ? firstError
          : new Error(formatUnknownErrorMessage(firstError));
      }
    });
    this.#artifactRemovalChains.set(
      jobId,
      next.catch(() => undefined),
    );
    await next;
  }

  async #expireIfNeeded(runtime: RuntimeJob): Promise<void> {
    const jobId = runtime.job.jobId;
    const previous = this.#lifecycleChains.get(jobId) ?? Promise.resolve();
    const next = previous.then(() => this.#expireIfNeededNow(runtime));
    this.#lifecycleChains.set(
      jobId,
      next.catch(() => undefined),
    );
    await next;
  }

  async #expireIfNeededNow(runtime: RuntimeJob): Promise<void> {
    const expiry = runtime.job.resultExpiresAt
      ? Date.parse(runtime.job.resultExpiresAt)
      : Number.POSITIVE_INFINITY;
    if (this.#now() < expiry || runtime.job.resultExpired) return;
    if ((this.#activeReads.get(runtime.job.jobId) ?? 0) > 0) return;
    await this.#removeArtifacts(runtime);
    runtime.job.resultExpired = true;
    runtime.job.phase = 'expired';
    await this.persist(runtime.job);
  }

  async cleanupExpired(): Promise<void> {
    await this.initialize();
    const result = this.#submitChain.then(() => this.#cleanupExpired());
    this.#submitChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #cleanupExpired(): Promise<void> {
    for (const runtime of this.#jobs.values()) {
      const jobId = runtime.job.jobId;
      const previous = this.#lifecycleChains.get(jobId) ?? Promise.resolve();
      const next = previous.then(async () => {
        if (!this.#jobs.has(jobId)) return;
        await this.#expireIfNeededNow(runtime);
        const finished = runtime.job.finishedAt ? Date.parse(runtime.job.finishedAt) : undefined;
        if (
          (runtime.job.resultExpired ||
            (runtime.job.state !== 'completed' && isTerminal(runtime.job))) &&
          finished !== undefined &&
          this.#now() - finished > this.config.resultTtlMs * 2 &&
          (this.#activeReads.get(jobId) ?? 0) === 0
        ) {
          await rm(this.jobDirectory(jobId), { recursive: true, force: true });
          const artifactBytes = runtime.job.artifacts.reduce(
            (sum, artifact) =>
              sum + (this.#artifactBytes.get(artifact.artifactId) ?? artifact.size),
            0,
          );
          for (const artifact of runtime.job.artifacts) {
            this.#artifactBytes.delete(artifact.artifactId);
            this.#artifactJobs.delete(artifact.artifactId);
          }
          this.#jobs.delete(jobId);
          if (runtime.job.idempotencyKey) this.#idempotency.delete(runtime.job.idempotencyKey);
          for (const binding of runtime.job.keyBindings ?? [])
            this.#idempotency.delete(binding.key);
          this.#usedBytes = Math.max(
            0,
            this.#usedBytes -
              (this.#metadataBytes.get(jobId) ?? 0) -
              artifactBytes -
              (this.#orphanBytes.get(jobId) ?? 0) -
              runtime.tempBytes,
          );
          this.#metadataBytes.delete(jobId);
          this.#orphanBytes.delete(jobId);
          this.#persistChains.delete(jobId);
          this.#artifactRemovalChains.delete(jobId);
        }
      });
      this.#lifecycleChains.set(
        jobId,
        next.catch(() => undefined),
      );
      await next;
    }
  }

  async assertScratchSeparated(sourceRoot: string): Promise<void> {
    await this.initialize();
    if (
      isSamePath(sourceRoot, this.#scratchDirectory) ||
      isPathInsideDirectory(this.#scratchDirectory, sourceRoot)
    ) {
      throw new FsError(
        ErrorCode.INVALID_INPUT,
        'Snapshot source cannot be the scratch directory or one of its descendants',
        sourceRoot,
      );
    }
  }

  async #authorize(job: StoredJob<JobCounters>, guard: PathGuard): Promise<void> {
    await guard.validateExistingDirectory(job.sourceRoot);
    if (
      job.policyFingerprint &&
      job.policyFingerprint !== (await guard.snapshotPolicyFingerprint())
    ) {
      throw new FsError(ErrorCode.ACCESS_DENIED, 'Snapshot access policy has changed');
    }
    if (job.configFingerprint && job.configFingerprint !== this.snapshotConfigFingerprint()) {
      throw new FsError(ErrorCode.ACCESS_DENIED, 'Snapshot reuse policy has changed');
    }
    for (const path of job.authorizationPaths ?? []) {
      guard.assertPathAllowed(path);
    }
  }

  isScratchPath(path: string): boolean {
    return (
      isSamePath(path, this.#scratchDirectory) ||
      isPathInsideDirectory(this.#scratchDirectory, path)
    );
  }

  async #acquireReadSlot(): Promise<void> {
    if (this.#readSlots < this.config.maxConcurrentReads) {
      this.#readSlots += 1;
      return;
    }
    await new Promise<void>((resolveWaiter) => {
      this.#readWaiters.push(resolveWaiter);
    });
    this.#readSlots += 1;
  }

  #releaseReadSlot(): void {
    this.#readSlots = Math.max(0, this.#readSlots - 1);
    this.#readWaiters.shift()?.();
  }

  async close(): Promise<void> {
    await this.initialize();
    if (this.#closed) return;
    this.#closed = true;
    if (this.#cleanupTimer) clearInterval(this.#cleanupTimer);
    const workers: Promise<void>[] = [];
    for (const runtime of this.#jobs.values()) {
      if (runtime.job.state === 'queued' || runtime.job.state === 'running') {
        runtime.job.state = 'interrupted';
        runtime.job.phase = 'interrupted';
        runtime.job.complete = false;
        runtime.job.stopReason = 'server-shutdown';
        runtime.job.finishedAt = new Date(this.#now()).toISOString();
        runtime.abortController.abort(new Error('Server shutting down'));
        await this.persist(runtime.job).catch((error: unknown) => {
          Logger.warn(
            `Could not persist interrupted snapshot job ${runtime.job.jobId}: ${formatUnknownErrorMessage(error)}`,
          );
        });
      }
      if (runtime.worker) workers.push(runtime.worker);
    }
    await Promise.allSettled(workers);
    if (this.config.ephemeralScratch) {
      await rm(this.#scratchDirectory, { recursive: true, force: true });
    }
  }
}

export async function resolveSnapshotRoot(fs: GuardedFileSystem, path: string): Promise<string> {
  return fs.pathGuard.validateExistingDirectory(path);
}
