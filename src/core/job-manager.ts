import { createHash, randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import {
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
import { basename, join, resolve } from 'node:path';

import { ErrorCode, formatUnknownErrorMessage, FsError, isNodeError } from './errors.js';
import type { GuardedFileSystem } from './fs.js';
import type { JobErrorSample, StoredArtifact, StoredJob } from './job-types.js';
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

export interface SubmitJobInput {
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly sourceRoot: string;
  readonly sourceRootId: string;
  readonly input: Record<string, unknown>;
  readonly run: (ctx: JobRunContext) => Promise<string>;
}

export interface ArtifactPayload {
  readonly artifact: StoredArtifact;
  readonly bytes: Buffer;
  readonly job: StoredJob;
}

interface RuntimeJob {
  readonly job: StoredJob;
  readonly run?: (ctx: JobRunContext) => Promise<string>;
  readonly abortController: AbortController;
  worker?: Promise<void>;
  tempBytes: number;
}

function isTerminal(job: StoredJob): boolean {
  return ['completed', 'failed', 'cancelled', 'interrupted'].includes(job.state);
}

function isJobRunning(job: StoredJob): boolean {
  return job.state === 'running';
}

function safeErrorSample(error: unknown, path?: string): JobErrorSample {
  const code =
    error instanceof FsError
      ? error.code
      : isNodeError(error) && error.code
        ? error.code
        : ErrorCode.UNKNOWN;
  const message = formatUnknownErrorMessage(error).slice(0, MAX_ERROR_MESSAGE);
  return { code, message, ...(path ? { path } : {}) };
}

export function fingerprintJobInput(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class JobRunContext {
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

  get job(): StoredJob {
    return this.runtime.job;
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
      this.job.errors.push(safeErrorSample(error, path));
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
  readonly #jobs = new Map<string, RuntimeJob>();
  readonly #idempotency = new Map<string, string>();
  readonly #artifactJobs = new Map<string, string>();
  readonly #persistChains = new Map<string, Promise<void>>();
  readonly #activeReads = new Map<string, number>();
  #initialized?: Promise<void>;
  #cleanupTimer?: NodeJS.Timeout;
  #usedBytes = 0;
  #running = 0;
  #closed = false;
  #readSlots = 0;
  readonly #readWaiters: (() => void)[] = [];
  #submitChain: Promise<void> = Promise.resolve();

  constructor(config: SnapshotConfig = getSnapshotConfig()) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    this.#initialized ??= this.#initialize();
    return this.#initialized;
  }

  async #initialize(): Promise<void> {
    await mkdir(this.config.scratchDirectory, { recursive: true, mode: 0o700 });
    const realScratch = await realpath(this.config.scratchDirectory);
    if (!isSamePath(realScratch, this.config.scratchDirectory)) {
      throw new FsError(
        ErrorCode.ACCESS_DENIED,
        'FS_SNAPSHOT_DIR must not be a symlink or junction alias',
        this.config.scratchDirectory,
      );
    }
    let entries: Dirent[];
    try {
      entries = await readdir(this.config.scratchDirectory, { withFileTypes: true });
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
    for (const runtime of this.#jobs.values()) await this.#expireIfNeeded(runtime);
  }

  async #loadJob(jobId: string): Promise<void> {
    const directory = this.jobDirectory(jobId);
    let job: StoredJob;
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
    this.#idempotency.set(job.idempotencyKey, jobId);
    for (const artifact of job.artifacts) {
      if (
        !JOB_ID_RE.test(artifact.artifactId) ||
        basename(artifact.fileName) !== artifact.fileName
      ) {
        continue;
      }
      this.#artifactJobs.set(artifact.artifactId, jobId);
      this.#usedBytes += artifact.size;
    }
    if (job.state === 'queued' || job.state === 'running') {
      job.state = 'interrupted';
      job.phase = 'interrupted';
      job.complete = false;
      job.stopReason = 'server-restarted';
      job.finishedAt = new Date().toISOString();
      await this.persist(job);
    }
    const leftovers = await readdir(directory, { withFileTypes: true });
    for (const leftover of leftovers) {
      if (
        !leftover.isFile() ||
        (!leftover.name.endsWith('.partial') && !leftover.name.endsWith('.metadata-tmp'))
      ) {
        continue;
      }
      const path = join(directory, leftover.name);
      const size = (await stat(path).catch(() => undefined))?.size ?? 0;
      await unlink(path).catch(() => undefined);
      this.#usedBytes = Math.max(0, this.#usedBytes - size);
    }
  }

  jobDirectory(jobId: string): string {
    if (!JOB_ID_RE.test(jobId)) throw new FsError(ErrorCode.INVALID_INPUT, 'Invalid job ID');
    return join(this.config.scratchDirectory, jobId);
  }

  async submit(input: SubmitJobInput): Promise<{ job: StoredJob; reused: boolean }> {
    await this.initialize();
    const result = this.#submitChain.then(() => this.#submit(input));
    this.#submitChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #submit(input: SubmitJobInput): Promise<{ job: StoredJob; reused: boolean }> {
    if (this.#closed) throw new FsError(ErrorCode.IO_ERROR, 'Job manager is shutting down');
    const priorId = this.#idempotency.get(input.idempotencyKey);
    if (priorId) {
      const prior = this.#jobs.get(priorId)?.job;
      if (prior) {
        if (prior.fingerprint !== input.fingerprint) {
          throw new FsError(
            ErrorCode.INVALID_INPUT,
            'Idempotency key is already bound to different normalized snapshot parameters',
          );
        }
        return { job: prior, reused: true };
      }
    }
    const queued = [...this.#jobs.values()].filter(
      (runtime) => runtime.job.state === 'queued',
    ).length;
    if (queued >= this.config.maxQueuedJobs) {
      throw new FsError(ErrorCode.TOO_LARGE, 'Snapshot job queue is full');
    }
    const now = new Date().toISOString();
    const jobId = randomUUID();
    const job: StoredJob = {
      schemaVersion: 1,
      jobId,
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
      fingerprint: input.fingerprint,
      sourceRoot: input.sourceRoot,
      sourceRootId: input.sourceRootId,
      input: input.input,
      state: 'queued',
      phase: 'queued',
      createdAt: now,
      complete: true,
      counters: emptySnapshotCounters(),
      errors: [],
      artifacts: [],
    };
    const runtime: RuntimeJob = {
      job,
      run: input.run,
      abortController: new AbortController(),
      tempBytes: 0,
    };
    await mkdir(this.jobDirectory(jobId), { recursive: false, mode: 0o700 });
    this.#jobs.set(jobId, runtime);
    this.#idempotency.set(input.idempotencyKey, jobId);
    try {
      await this.persist(job);
    } catch (error) {
      this.#jobs.delete(jobId);
      this.#idempotency.delete(input.idempotencyKey);
      await rm(this.jobDirectory(jobId), { recursive: true, force: true });
      throw error;
    }
    queueMicrotask(() => {
      this.#pump();
    });
    return { job, reused: false };
  }

  #pump(): void {
    if (this.#closed) return;
    while (this.#running < this.config.maxRunningJobs) {
      const runtime = [...this.#jobs.values()].find(
        (candidate) => candidate.job.state === 'queued',
      );
      if (!runtime?.run) return;
      this.#running += 1;
      runtime.worker = this.#run(runtime).finally(() => {
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
    job.startedAt = new Date().toISOString();
    await this.persist(job);
    const timeout = AbortSignal.timeout(this.config.maxJobMs);
    const signal = AbortSignal.any([runtime.abortController.signal, timeout]);
    const ctx = new JobRunContext(this, runtime, signal);
    try {
      signal.throwIfAborted();
      const manifestArtifactId = await runtime.run(ctx);
      if (!isJobRunning(job)) return;
      signal.throwIfAborted();
      job.state = 'completed';
      job.phase = 'completed';
      job.manifestArtifactId = manifestArtifactId;
      job.finishedAt = new Date().toISOString();
      job.resultExpiresAt = new Date(Date.now() + this.config.resultTtlMs).toISOString();
    } catch (error) {
      if (runtime.abortController.signal.aborted || this.#closed) return;
      job.state = 'failed';
      job.phase = 'failed';
      job.complete = false;
      job.stopReason = timeout.aborted ? 'time-limit-exceeded' : formatUnknownErrorMessage(error);
      job.finishedAt = new Date().toISOString();
      ctx.addError(error);
      await this.#removeArtifacts(runtime);
    } finally {
      await this.#removePartials(runtime);
      await this.persist(job);
    }
  }

  async getJob(jobId: string, guard: PathGuard): Promise<StoredJob> {
    await this.initialize();
    const runtime = this.#jobs.get(jobId);
    if (!runtime) throw new FsError(ErrorCode.NOT_FOUND, 'Snapshot job not found');
    await guard.validateExistingDirectory(runtime.job.sourceRoot);
    await this.#expireIfNeeded(runtime);
    return runtime.job;
  }

  async cancel(jobId: string, guard: PathGuard): Promise<StoredJob> {
    const job = await this.getJob(jobId, guard);
    const runtime = this.#jobs.get(jobId);
    if (!runtime || isTerminal(job)) return job;
    job.state = 'cancelled';
    job.phase = 'cancelled';
    job.complete = false;
    job.stopReason = 'cancelled-by-client';
    job.finishedAt = new Date().toISOString();
    runtime.abortController.abort(new Error('Snapshot job cancelled'));
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
    await guard.validateExistingDirectory(runtime.job.sourceRoot);
    await this.#expireIfNeeded(runtime);
    if (runtime.job.resultExpired) throw new FsError(ErrorCode.NOT_FOUND, 'Artifact has expired');
    const artifact = runtime.job.artifacts.find((candidate) => candidate.artifactId === artifactId);
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
    await this.#acquireReadSlot();
    this.#activeReads.set(jobId, (this.#activeReads.get(jobId) ?? 0) + 1);
    try {
      const path = this.#artifactPath(jobId, artifact);
      const bytes = await readFile(path);
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
    }
  }

  reserveTemp(runtime: RuntimeJob, bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid disk reservation');
    if (this.#usedBytes + bytes > this.config.scratchQuotaBytes) {
      throw new FsError(ErrorCode.TOO_LARGE, 'Snapshot scratch quota exceeded');
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
    await unlink(path).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    });
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
      throw new FsError(ErrorCode.TOO_LARGE, 'Snapshot job artifact-byte limit exceeded');
    }
    const artifactId = randomUUID();
    const extension = artifactInput.kind === 'manifest' ? 'json' : 'zip';
    const fileName = `${artifactId}.${extension}`;
    const finalPath = join(this.jobDirectory(runtime.job.jobId), fileName);
    await rename(partialPath, finalPath);
    if (!isJobRunning(runtime.job)) {
      await unlink(finalPath).catch(() => undefined);
      this.releaseTemp(runtime, artifactInput.size);
      throw new Error('Job stopped while committing artifact');
    }
    runtime.tempBytes = Math.max(0, runtime.tempBytes - artifactInput.size);
    const artifact: StoredArtifact = { artifactId, fileName, ...artifactInput };
    runtime.job.artifacts.push(artifact);
    this.#artifactJobs.set(artifactId, runtime.job.jobId);
    await this.persist(runtime.job);
    return artifact;
  }

  async persist(job: StoredJob): Promise<void> {
    const previous = this.#persistChains.get(job.jobId) ?? Promise.resolve();
    const next = previous.then(() => this.#persistNow(job));
    this.#persistChains.set(
      job.jobId,
      next.catch(() => undefined),
    );
    await next;
  }

  async #persistNow(job: StoredJob): Promise<void> {
    const path = join(this.jobDirectory(job.jobId), 'job.json');
    const temp = join(this.jobDirectory(job.jobId), `job.${randomUUID()}.metadata-tmp`);
    const bytes = Buffer.from(`${JSON.stringify(job, null, 2)}\n`, 'utf8');
    if (this.#usedBytes + bytes.length > this.config.scratchQuotaBytes) {
      throw new FsError(
        ErrorCode.TOO_LARGE,
        'Snapshot scratch quota exceeded while saving metadata',
      );
    }
    await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temp, path);
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

  async #removePartials(runtime: RuntimeJob): Promise<void> {
    const entries = await readdir(this.jobDirectory(runtime.job.jobId), {
      withFileTypes: true,
    }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.partial')) continue;
      await unlink(join(this.jobDirectory(runtime.job.jobId), entry.name)).catch(() => undefined);
    }
    this.releaseTemp(runtime, runtime.tempBytes);
  }

  async #removeArtifacts(runtime: RuntimeJob): Promise<void> {
    for (const artifact of runtime.job.artifacts) {
      await unlink(this.#artifactPath(runtime.job.jobId, artifact)).catch(() => undefined);
      this.#usedBytes = Math.max(0, this.#usedBytes - artifact.size);
      this.#artifactJobs.delete(artifact.artifactId);
    }
    runtime.job.artifacts = [];
    delete runtime.job.manifestArtifactId;
  }

  async #expireIfNeeded(runtime: RuntimeJob): Promise<void> {
    const expiry = runtime.job.resultExpiresAt
      ? Date.parse(runtime.job.resultExpiresAt)
      : Number.POSITIVE_INFINITY;
    if (Date.now() < expiry || runtime.job.resultExpired) return;
    if ((this.#activeReads.get(runtime.job.jobId) ?? 0) > 0) return;
    await this.#removeArtifacts(runtime);
    runtime.job.resultExpired = true;
    runtime.job.phase = 'expired';
    await this.persist(runtime.job);
  }

  async cleanupExpired(): Promise<void> {
    await this.initialize();
    for (const runtime of this.#jobs.values()) {
      await this.#expireIfNeeded(runtime);
      const finished = runtime.job.finishedAt ? Date.parse(runtime.job.finishedAt) : undefined;
      if (
        runtime.job.resultExpired &&
        finished !== undefined &&
        Date.now() - finished > this.config.resultTtlMs * 2 &&
        (this.#activeReads.get(runtime.job.jobId) ?? 0) === 0
      ) {
        this.#jobs.delete(runtime.job.jobId);
        this.#idempotency.delete(runtime.job.idempotencyKey);
        await rm(this.jobDirectory(runtime.job.jobId), { recursive: true, force: true });
      }
    }
  }

  async assertScratchSeparated(sourceRoot: string): Promise<void> {
    await this.initialize();
    if (
      isSamePath(sourceRoot, this.config.scratchDirectory) ||
      isPathInsideDirectory(this.config.scratchDirectory, sourceRoot)
    ) {
      throw new FsError(
        ErrorCode.INVALID_INPUT,
        'Snapshot source cannot be the scratch directory or one of its descendants',
        sourceRoot,
      );
    }
  }

  isScratchPath(path: string): boolean {
    return (
      isSamePath(path, this.config.scratchDirectory) ||
      isPathInsideDirectory(this.config.scratchDirectory, path)
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
        runtime.job.finishedAt = new Date().toISOString();
        runtime.abortController.abort(new Error('Server shutting down'));
        await this.persist(runtime.job);
      }
      if (runtime.worker) workers.push(runtime.worker);
    }
    await Promise.allSettled(workers);
    if (this.config.ephemeralScratch) {
      await rm(this.config.scratchDirectory, { recursive: true, force: true });
    }
  }
}

export async function resolveSnapshotRoot(fs: GuardedFileSystem, path: string): Promise<string> {
  return fs.pathGuard.validateExistingDirectory(path);
}
