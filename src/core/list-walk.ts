import { join, posix } from 'node:path';

import { ErrorCode, formatUnknownErrorMessage, isFsError, isNodeError } from './errors.js';
import type { GuardedFileSystem } from './fs.js';
import type { GlobEntry } from './glob.js';
import { Logger } from './observability.js';
import { toPosixRelative } from './path.js';
import { DEFAULT_EXCLUDE_PATTERNS, GitignoreManager } from './source-ignore.js';

interface WalkOptions {
  readonly fs: GuardedFileSystem;
  readonly root: string;
  /** One-based: 1 enumerates only the root's children. */
  readonly maxDepth: number;
  readonly includeHidden: boolean;
  readonly includeIgnored: boolean;
  readonly signal: AbortSignal;
}

async function loadIgnoreRules(
  directory: string,
  options: WalkOptions,
  manager: GitignoreManager,
): Promise<void> {
  const { fs, root, signal } = options;
  signal.throwIfAborted();
  const path = join(directory, '.gitignore');
  try {
    // Guard the rules as source files too; never follow a rules-file symlink.
    const { handle } = await fs.openOriginal(path, { root, signal });
    try {
      signal.throwIfAborted();
      const contents = await handle.readFile({ encoding: 'utf8', signal });
      signal.throwIfAborted();
      manager.addRules(toPosixRelative(root, directory), contents);
    } finally {
      await handle.close();
    }
  } catch (error) {
    signal.throwIfAborted();
    if (
      (isNodeError(error) && error.code === 'ENOENT') ||
      (isFsError(error) && error.code === ErrorCode.NOT_FOUND)
    )
      return;
    // Match the existing best-effort ignore policy; failed reads are logged.
    Logger.warn(`Failed to read .gitignore at ${path}: ${formatUnknownErrorMessage(error)}`);
  }
}

/**
 * Stream guarded directory entries, pruning before descent. Each frame owns one
 * handle; consumer return (including a collect cap) unwinds every frame. No
 * recursive ignore discovery, full-directory arrays, sorting, or glob rescans.
 */
export async function* walkListEntries(options: WalkOptions): AsyncGenerator<GlobEntry> {
  const manager = new GitignoreManager();
  const { fs, root, signal } = options;

  async function* visit(path: string, depth: number): AsyncGenerator<GlobEntry> {
    signal.throwIfAborted();
    // Dirents do not follow links. Re-check components before opening a child
    // in case it was replaced with a junction/link after enumeration.
    await fs.pathGuard.assertNoSymlinkComponents(root, path, signal);
    signal.throwIfAborted();
    const { directory } = await fs.opendir(path, { signal });
    try {
      if (!options.includeIgnored) await loadIgnoreRules(path, options, manager);
      for (;;) {
        signal.throwIfAborted();
        // read is not abortable: finish that OS operation, then check before
        // filtering or starting any new I/O. finally owns close even at EOF.
        const dirent = await directory.read();
        signal.throwIfAborted();
        if (dirent === null) return;
        if (!options.includeHidden && dirent.name.startsWith('.')) continue;
        const entryPath = join(path, dirent.name);
        const relativePath = toPosixRelative(root, entryPath);
        if (
          !options.includeIgnored &&
          (DEFAULT_EXCLUDE_PATTERNS.some((pattern) => posix.matchesGlob(relativePath, pattern)) ||
            manager.isIgnored(relativePath, dirent.isDirectory()))
        )
          continue;
        const accessible = await fs.pathGuard.isEntryAccessible(entryPath, signal);
        signal.throwIfAborted();
        if (!accessible) continue;
        yield { path: entryPath, dirent };
        signal.throwIfAborted();
        if (dirent.isDirectory() && !dirent.isSymbolicLink() && depth < options.maxDepth) {
          yield* visit(entryPath, depth + 1);
        }
      }
    } finally {
      await directory.close();
    }
  }

  yield* visit(root, 1);
}
