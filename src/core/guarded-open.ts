import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, open, readlink, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { withAbort } from './concurrency.js';
import { ErrorCode, FsError } from './errors.js';
import { Logger } from './observability.js';
import { isSamePath } from './path-utils.js';
import type { PathGuard } from './path.js';

// Node does not expose these flags on Windows. The identity/policy checks below
// are still required there; they are not a native HANDLE containment check.
const { O_NOFOLLOW = 0, O_NONBLOCK = 0 } = constants as {
  O_NOFOLLOW?: number;
  O_NONBLOCK?: number;
};
const READ_FLAGS = constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK;
export const APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND | O_NOFOLLOW | O_NONBLOCK;
export const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW;

function changed(path: string): FsError {
  return new FsError(ErrorCode.ACCESS_DENIED, 'File changed during guarded open (TOCTOU).', path);
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** Best-effort cleanup only of our own, still allowed, regular directory entry. */
export async function removeCreatedFile(
  guard: PathGuard,
  path: string,
  stats: Stats,
): Promise<void> {
  try {
    const resolved = await guard.validateExistingPath(path);
    const current = await lstat(path);
    if (isSamePath(path, resolved) && current.isFile() && sameFile(current, stats)) {
      await unlink(path);
    }
  } catch (error) {
    Logger.warn(`Could not safely clean up newly created file ${path}: ${String(error)}`);
  }
}

/**
 * All source-byte opens go through here, after PathGuard resolution. No byte is
 * read/written before type, identity and policy checks. Linux checks the opened
 * descriptor itself and fails closed without procfs. Other platforms require
 * trusted ancestors: pathname probes cannot defeat an adversarial ABA swap.
 */
export async function openGuardedFile(
  guard: PathGuard,
  validPath: string,
  requestedPath: string,
  flags = READ_FLAGS,
  signal?: AbortSignal,
  creating = false,
): Promise<{ handle: FileHandle; stats: Stats }> {
  signal?.throwIfAborted();
  guard.assertPathAllowed(validPath);
  const before = creating ? undefined : await withAbort(lstat(validPath), signal);
  if (before && !before.isFile()) {
    throw new FsError(ErrorCode.NOT_FILE, 'Not a regular file', requestedPath);
  }
  signal?.throwIfAborted();
  const pending = open(validPath, flags);
  let handle: FileHandle;
  try {
    // Creation has a side effect: wait for ownership before handling an abort.
    handle = creating ? await pending : await withAbort(pending, signal);
  } catch (error) {
    void pending
      .then(
        (late) => late.close(),
        () => undefined,
      )
      .catch((closeError: unknown) => {
        Logger.warn(`Failed to close late guarded open: ${String(closeError)}`);
      });
    throw error;
  }
  let stats: Stats | undefined;
  let pendingStat: Promise<Stats> | undefined;
  try {
    pendingStat = handle.stat();
    stats = await withAbort(pendingStat, signal);
    pendingStat = undefined;
    if (!stats.isFile()) {
      throw new FsError(ErrorCode.NOT_FILE, 'Not a regular file', requestedPath);
    }
    if (before && !sameFile(before, stats)) throw changed(requestedPath);
    if (process.platform === 'linux') {
      // Never silently skip an unavailable descriptor check. readlink (rather
      // than realpath) also exposes Linux's unlinked " (deleted)" marker.
      const actual = await withAbort(readlink(`/proc/self/fd/${handle.fd}`), signal);
      if (!isAbsolute(actual)) throw changed(requestedPath);
      guard.assertPathAllowed(actual);
      if (!isSamePath(actual, validPath)) throw changed(requestedPath);
    } else {
      const actual = await withAbort(guard.validateExistingPath(validPath), signal);
      const after = await withAbort(lstat(validPath), signal);
      if (!isSamePath(actual, validPath) || !after.isFile() || !sameFile(stats, after)) {
        throw changed(requestedPath);
      }
    }
    signal?.throwIfAborted();
    return { handle, stats };
  } catch (error) {
    if (pendingStat) {
      // close queues behind fstat. A stalled mount must not hold an aborted
      // request; release the descriptor (and any owned creation) when it settles.
      void pendingStat
        .then(
          async (owned) => {
            if (creating) await removeCreatedFile(guard, validPath, owned);
          },
          () => undefined,
        )
        .finally(() => handle.close())
        .catch((closeError: unknown) => {
          Logger.warn(`Failed to release guarded open after fstat: ${String(closeError)}`);
        });
      throw error;
    }
    if (creating) {
      // An abort may precede fstat; obtain identity for cleanup without a signal.
      const owned = stats ?? (await handle.stat().catch(() => undefined));
      if (owned) await removeCreatedFile(guard, validPath, owned);
    }
    await handle.close();
    throw error;
  }
}
