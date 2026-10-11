import { glob as fsGlob, readFile as fsReadFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';

import { prepareBracePatterns } from './brace-pattern.js';
import { processInParallel } from './concurrency.js';
import {
  ErrorCode,
  formatUnknownErrorMessage,
  isFsError,
  isNodeError,
  SKIPPABLE_ERRNOS,
  SKIPPABLE_FS_CODES,
} from './errors.js';
import type { GuardedFileSystem } from './fs.js';
import { walkListEntries } from './list-walk.js';
import { Logger } from './observability.js';
import { isWindowsDriveRelativePath } from './path-utils.js';
import { type DirentLike, toPosixPath } from './primitives.js';
import type { EntryType } from './primitives.js';
import { DEFAULT_EXCLUDE_PATTERNS, GitignoreManager } from './source-ignore.js';

export type { EntryType };

export function isSafeGlobSyntax(pattern: string): boolean {
  if (!pattern || pattern.trim().length === 0) {
    return false;
  }
  if (isAbsolute(pattern)) {
    return false;
  }
  if (isWindowsDriveRelativePath(pattern)) {
    return false;
  }
  // Covers every engine-specific traversal form too — `{a,..}` and `[..]` both
  // contain '..', so they are rejected here. Keep this check whole-string: the
  // per-form guards that used to follow it were unreachable because of it.
  if (pattern.includes('..')) {
    return false;
  }
  return true;
}

async function loadGitignoreFiles(
  root: string,
  gitignorePaths: readonly string[],
  manager: GitignoreManager,
  signal?: AbortSignal,
): Promise<void> {
  await processInParallel(
    gitignorePaths,
    async (relPath) => {
      const absPath = join(root, relPath);
      try {
        const contents = await fsReadFile(absPath, { encoding: 'utf-8', signal });
        const dir = toPosixPath(dirname(relPath));
        manager.addRules(dir, contents);
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        Logger.warn(`Failed to read .gitignore at ${absPath}: ${formatUnknownErrorMessage(error)}`);
      }
    },
    GLOB_BATCH_CONCURRENCY,
    signal,
  );
}

async function loadGitignoreManager(root: string, signal?: AbortSignal): Promise<GitignoreManager> {
  const manager = new GitignoreManager();
  try {
    const gitignorePaths: string[] = [];
    const gitignoreEntries = fsGlob('**/.gitignore', {
      cwd: root,
      exclude: (entry: string) => {
        const name = basename(entry);
        if (name === 'node_modules' || name === '.git' || name === '.hg' || name === '.svn') {
          return true;
        }
        return false;
      },
    });
    for await (const match of gitignoreEntries) {
      if (signal?.aborted) break;
      gitignorePaths.push(match);
    }

    await loadGitignoreFiles(root, gitignorePaths, manager, signal);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    Logger.warn(
      `Failed to enumerate .gitignore files under ${root}: ${formatUnknownErrorMessage(error)}`,
    );
  }
  return manager;
}

async function loadRootGitignore(
  root: string,
  signal?: AbortSignal,
): Promise<GitignoreManager | null> {
  const manager = await loadGitignoreManager(root, signal);
  if (manager.size() === 0) {
    return null;
  }
  return manager;
}

interface GlobDirentLike extends DirentLike {
  name: string;
  parentPath?: string;
}

export interface GlobEntry {
  path: string;
  dirent: DirentLike;
}

export interface GlobEntriesOptions {
  /** Guarded bounded walker for read-only searches; legacy replace sweep uses fs.glob. */
  fs?: GuardedFileSystem;
  onInaccessible?: () => void;
  cwd: string;
  pattern: string;
  includeHidden?: boolean;
  baseNameMatch?: boolean;
  maxDepth?: number;
  onlyFiles?: boolean;
  suppressErrors?: boolean;
  /** Skip what a walk should not surface: DEFAULT_EXCLUDE_PATTERNS and .gitignore. */
  skipIgnored?: boolean;
  /** Bounds the `.gitignore` discovery `skipIgnored` runs before the walk. */
  signal?: AbortSignal;
}

interface NormalizedGlob {
  cwd: string;
  patterns: readonly string[];
  exclude: readonly string[];
  suppressErrors: boolean;
  maxDepth?: number;
}

const GLOB_MAGIC_RE = /[*?[\]{}!]/u;
// Comma braces are expanded first; remaining braces are literal names. Prefix
// pruning must still recognize extglobs used in directory segments.
const PREFIX_MAGIC_RE = /[*?[\]!@+()]/u;
const GLOB_BATCH_CONCURRENCY = 64;
const SEP = '/';
const DOT_CHAR_CODE = 46;
function normalizePattern(pattern: string, baseNameMatch: boolean): string {
  const normalized = toPosixPath(pattern);

  if (!baseNameMatch) return normalized;
  if (normalized.includes(SEP)) return normalized;
  return `**/${normalized}`;
}

function splitPatternPrefix(normalizedPattern: string): {
  prefix: string;
  remainder: string;
} {
  if (!GLOB_MAGIC_RE.test(normalizedPattern)) {
    return { prefix: '', remainder: normalizedPattern };
  }

  const segments = normalizedPattern.split(SEP);
  const splitIndex = segments.findIndex((seg) => GLOB_MAGIC_RE.test(seg));

  if (splitIndex <= 0) {
    return { prefix: '', remainder: normalizedPattern };
  }

  return {
    prefix: segments.slice(0, splitIndex).join(SEP) + SEP,
    remainder: segments.slice(splitIndex).join(SEP),
  };
}

function addFirstDotSegment(patterns: Set<string>, prefix: string, remainder: string): void {
  if (remainder.length === 0) return;
  const segments = remainder.split(SEP);
  const idx = segments.findIndex((seg) => seg !== '**' && seg.length > 0);

  if (idx !== -1) {
    const original = segments[idx];
    if (original && original.charCodeAt(0) !== DOT_CHAR_CODE) {
      const newSegments = [...segments];
      newSegments[idx] = `.${original}`;
      patterns.add(`${prefix}${newSegments.join(SEP)}`);
    }
  }
}

function expandHiddenGlobstars(patterns: Set<string>, prefix: string, remainder: string): void {
  // Trailing bare globstar — `src/**`, `**` (remainder is exactly `**`, no
  // following segment). The pattern itself already matches every non-dot
  // entry under the prefix; add the two hidden complements fs.glob skips:
  // dotfiles/dot-dirs anywhere, and the contents of dot-dirs anywhere.
  if (remainder === '**') {
    patterns.add(`${prefix}**/.*`);
    patterns.add(`${prefix}**/.*/**`);
    return;
  }

  if (!remainder.startsWith('**/')) return;

  const afterGlobstar = remainder.slice(3);
  // Node fs.glob skips leading-dot entries unless the matching segment itself
  // starts with '.', and its `dot` option is not honored. So `**/*` alone misses
  // hidden files. Two depth-agnostic patterns cover everything the per-depth
  // unroll did: contents of dot-directories anywhere, and dotfiles/dotdirs
  // anywhere.
  patterns.add(`${prefix}**/.*/**/${afterGlobstar}`);
  const addDotFile = afterGlobstar.length > 0 && afterGlobstar.charCodeAt(0) !== DOT_CHAR_CODE;
  if (addDotFile) patterns.add(`${prefix}**/.${afterGlobstar}`);
}

function buildHiddenPatterns(normalizedPattern: string): readonly string[] {
  const patterns = new Set<string>([normalizedPattern]);
  const { prefix, remainder } = splitPatternPrefix(normalizedPattern);

  addFirstDotSegment(patterns, prefix, remainder);
  expandHiddenGlobstars(patterns, prefix, remainder);

  return Array.from(patterns);
}

function normalizeGlobOptions(options: GlobEntriesOptions): NormalizedGlob {
  const cwd = resolve(options.cwd);
  const normalizedPattern = normalizePattern(options.pattern, options.baseNameMatch ?? false);

  const patterns = options.includeHidden
    ? buildHiddenPatterns(normalizedPattern)
    : [normalizedPattern];

  const normalized: NormalizedGlob = {
    cwd,
    patterns,
    exclude: options.skipIgnored ? DEFAULT_EXCLUDE_PATTERNS.map(toPosixPath) : [],
    suppressErrors: options.suppressErrors ?? false,
  };

  if (options.maxDepth !== undefined) {
    normalized.maxDepth = options.maxDepth;
  }

  return normalized;
}

interface WalkPattern {
  readonly prefix: string;
  readonly remainder: string;
  readonly directoryOnly: boolean;
  readonly maxDepth: number;
}

function normalizeWalkPattern(pattern: string): string {
  // Normalize literal dot/empty segments for both matching and pruning. Keep
  // a trailing separator: it restricts a native glob to directory results.
  const segments = pattern.split(SEP);
  const normalized = segments.filter((segment) => segment !== '.' && segment !== '').join(SEP);
  return pattern.endsWith(SEP) ? `${normalized}/` : normalized;
}

function isSkippableGlobError(error: unknown): boolean {
  return (
    (isFsError(error) &&
      (SKIPPABLE_FS_CODES.has(error.code) || error.code === ErrorCode.NOT_DIRECTORY)) ||
    (isNodeError(error) &&
      error.code !== undefined &&
      (SKIPPABLE_ERRNOS.has(error.code) || error.code === 'ENOTDIR' || error.code === 'EPERM'))
  );
}

async function resolveWalkPattern(
  pattern: string,
  root: string,
  fs: GuardedFileSystem,
  signal: AbortSignal,
  maxDepth: number,
): Promise<WalkPattern | null> {
  const directoryOnly = pattern.endsWith(SEP);
  const segments = (directoryOnly ? pattern.slice(0, -1) : pattern).split(SEP);
  const magic = segments.findIndex((segment) => PREFIX_MAGIC_RE.test(segment));
  const literalCount = magic < 0 ? segments.length : magic;
  if (literalCount === 0)
    return { prefix: '', remainder: segments.join(SEP), directoryOnly, maxDepth };
  if (literalCount > maxDepth + 1) return null;

  const literalPath = join(root, ...segments.slice(0, literalCount));
  try {
    // Native glob looks up the initial literal path, including a literal
    // filename, through the filesystem. realpath preserves that filesystem's
    // case/8.3 semantics without making subsequent glob literals nocase.
    // Resolve only this fixed path; no directory enumeration or link following.
    await fs.pathGuard.assertNoSymlinkComponents(root, literalPath, signal);
    const { resolvedPath } = await fs.pathGuard.validateExistingPathDetailed(literalPath, signal);
    signal.throwIfAborted();
    return {
      prefix: toPosixPath(relative(root, resolvedPath)),
      remainder: segments.slice(literalCount).join(SEP),
      directoryOnly,
      maxDepth,
    };
  } catch (error) {
    signal.throwIfAborted();
    if (isSkippableGlobError(error)) {
      // Let the walker apply its accessibility filter and count an existing
      // inaccessible literal file. Dropping the pattern here would erase that
      // counter. Unresolved spellings still cannot bypass guarded descent.
      return {
        prefix: segments.slice(0, literalCount).join(SEP),
        remainder: segments.slice(literalCount).join(SEP),
        directoryOnly,
        maxDepth,
      };
    }
    throw error;
  }
}

function matchesWalkPattern(path: string, pattern: WalkPattern): boolean {
  const { prefix, remainder } = pattern;
  if (!prefix) return posix.matchesGlob(path, remainder);
  if (!remainder) return path === prefix;
  if (path === prefix) return posix.matchesGlob('', remainder);
  return (
    path.startsWith(`${prefix}/`) && posix.matchesGlob(path.slice(prefix.length + 1), remainder)
  );
}

async function matchesFiniteLiteralPath(
  entry: GlobEntry,
  pattern: WalkPattern,
  root: string,
  fs: GuardedFileSystem,
  signal: AbortSignal,
): Promise<boolean> {
  if (pattern.directoryOnly && !entry.dirent.isDirectory()) return false;
  const rel = toPosixPath(relative(root, entry.path));
  if (pattern.prefix && !rel.startsWith(`${pattern.prefix}/`)) return false;
  const suffix = pattern.prefix ? rel.slice(pattern.prefix.length + 1) : rel;
  const names = suffix.split(SEP);
  const segments = pattern.remainder.split(SEP);
  // Finite patterns perform literal lookups after wildcard directories too.
  // Keep globstar and compound slash-containing patterns on the Node matcher;
  // their literal matching has different traversal semantics.
  if (segments.includes('**') || segments.length !== names.length) return false;
  const requested: string[] = [];
  let needsLookup = false;
  for (const [index, segment] of segments.entries()) {
    const name = names[index];
    if (name === undefined) return false;
    if (PREFIX_MAGIC_RE.test(segment)) {
      if (!posix.matchesGlob(name, segment)) return false;
      requested.push(name);
    } else {
      requested.push(segment);
      if (segment !== name) needsLookup = true;
    }
  }
  if (!needsLookup) return false;
  const path = join(root, pattern.prefix, ...requested);
  try {
    signal.throwIfAborted();
    await fs.pathGuard.assertNoSymlinkComponents(root, path, signal);
    const { resolvedPath } = await fs.pathGuard.validateExistingPathDetailed(path, signal);
    signal.throwIfAborted();
    return resolvedPath === entry.path;
  } catch (error) {
    signal.throwIfAborted();
    if (isSkippableGlobError(error)) return false;
    throw error;
  }
}

function resolveDirentBase(cwd: string, parentPath: string | undefined): string {
  if (!parentPath) return cwd;
  return isAbsolute(parentPath) ? parentPath : resolve(cwd, parentPath);
}

function* processDirentMatch(
  match: GlobDirentLike,
  cwd: string,
  maxDepth: number | undefined,
  seen: Set<string>,
  onlyFiles: boolean,
): Generator<GlobEntry> {
  const base = resolveDirentBase(cwd, match.parentPath);
  const absolutePath = resolve(base, match.name);

  if (maxDepth !== undefined) {
    const rel = relative(cwd, absolutePath);
    if (rel.split(/[/\\]/u).length - 1 > maxDepth) return;
  }

  if (seen.has(absolutePath)) return;
  seen.add(absolutePath);

  if (onlyFiles && !match.isFile()) return;
  yield { path: absolutePath, dirent: match };
}

function createExcludeFilter(
  cwd: string,
  excludePatterns: readonly string[],
  gitignoreMatcher?: GitignoreManager | null,
): ((match: GlobDirentLike) => boolean) | readonly string[] {
  if (!gitignoreMatcher) {
    return excludePatterns;
  }

  return (match: GlobDirentLike) => {
    const relPath = match.parentPath
      ? relative(cwd, join(match.parentPath, match.name))
      : match.name;

    const posixRel = toPosixPath(relPath);

    // Gitignore check
    const isDir = match.isDirectory();
    if (gitignoreMatcher.isIgnored(posixRel, isDir)) {
      return true;
    }

    // Also check explicit exclude patterns
    if (excludePatterns.length > 0) {
      for (const ex of excludePatterns) {
        if (posix.matchesGlob(posixRel, ex)) return true;
      }
    }

    return false;
  };
}

async function* processGlobPattern(
  pattern: string,
  plan: NormalizedGlob,
  seen: Set<string>,
  onlyFiles: boolean,
  excludeFunc: ((match: GlobDirentLike) => boolean) | readonly string[],
): AsyncGenerator<GlobEntry> {
  const { cwd, maxDepth, suppressErrors } = plan;
  let iterable: AsyncIterable<GlobDirentLike>;
  try {
    iterable = fsGlob(pattern, {
      cwd,
      exclude: excludeFunc,
      withFileTypes: true,
    }) as AsyncIterable<GlobDirentLike>;
  } catch (error) {
    if (suppressErrors) return;
    throw error;
  }

  try {
    for await (const match of iterable) {
      // A function `exclude` only prunes descent in fs.glob — it still yields
      // the rejected dirent itself, and any rejected entry below the top level.
      // An array `exclude` drops both. Re-apply the predicate so the two agree.
      if (typeof excludeFunc === 'function' && excludeFunc(match)) continue;
      yield* processDirentMatch(match, cwd, maxDepth, seen, onlyFiles);
    }
  } catch (error) {
    if (!suppressErrors) throw error;
    Logger.warn(
      `globEntries: suppressed mid-walk error for pattern "${pattern}": ${formatUnknownErrorMessage(error)}`,
    );
  }
}

export async function* globEntries(options: GlobEntriesOptions): AsyncGenerator<GlobEntry> {
  if (options.fs) {
    const plan = normalizeGlobOptions(options);
    const signal = options.signal ?? new AbortController().signal;
    // Without globstar no path can match beyond its slash count. Braces that
    // contain slashes can overestimate this bound, never underestimate it.
    const patterns = plan.patterns.map(normalizeWalkPattern);
    const patternDepth = patterns.some((pattern) => pattern.includes('**'))
      ? 100
      : Math.max(...patterns.map((pattern) => pattern.split(SEP).length - 1));
    const maxDepth = Math.min(options.maxDepth ?? 100, patternDepth);
    const braces = plan.patterns.some((pattern) => pattern.includes('{') && pattern.includes(','));
    // Preserve the existing hidden-pattern policy before expanding alternatives.
    const variants: Awaited<ReturnType<typeof prepareBracePatterns>>[] | undefined = braces
      ? []
      : undefined;
    if (variants)
      for (const pattern of plan.patterns)
        variants.push(await prepareBracePatterns(pattern, signal));
    const fs = options.fs;
    const literalPrefixes = variants
      ? plan.patterns.map((pattern) => {
          const segments = pattern.split(SEP);
          const firstChoice = segments.findIndex((segment) => /[*?[\]{}!@+()]/u.test(segment));
          return firstChoice > 0
            ? normalizeWalkPattern(segments.slice(0, firstChoice).join(SEP)).split(SEP)
            : [];
        })
      : [];
    const commonSegments: string[] = [];
    for (const [index, segment] of (literalPrefixes[0] ?? []).entries()) {
      if (!literalPrefixes.every((prefix) => prefix[index] === segment)) break;
      commonSegments.push(segment);
    }
    const commonLiteral = commonSegments.join(SEP);
    const common = commonLiteral
      ? await resolveWalkPattern(`${commonLiteral}/*`, plan.cwd, fs, signal, maxDepth)
      : undefined;
    const walkPatterns: WalkPattern[] = [];
    if (!variants)
      for (const pattern of patterns) {
        signal.throwIfAborted();
        const resolved = await resolveWalkPattern(pattern, plan.cwd, fs, signal, maxDepth);
        if (resolved) walkPatterns.push(resolved);
      }
    signal.throwIfAborted();
    // Cache only a small bounded set; variants beyond it remain lazy and are
    // governed by cancellation, not a silently truncated alternative list.
    const cache = new Map<string, WalkPattern | null>();
    let cacheChars = 0;
    async function* queryPatterns(name?: string): AsyncGenerator<WalkPattern> {
      if (!variants) {
        yield* walkPatterns;
        return;
      }
      for (const source of variants)
        for await (const expanded of source(name)) {
          signal.throwIfAborted();
          // Alternatives must not reinterpret an absolute/traversal path as a
          // relative one when normalizing dots or separators.
          if (!isSafeGlobSyntax(expanded)) continue;
          const pattern = normalizeWalkPattern(expanded);
          signal.throwIfAborted();
          let resolved = cache.get(pattern);
          if (!cache.has(pattern)) {
            const depth = pattern.includes('**') ? 100 : pattern.split(SEP).length - 1;
            resolved = await resolveWalkPattern(
              pattern,
              plan.cwd,
              fs,
              signal,
              Math.min(maxDepth, depth),
            );
            const chars =
              pattern.length + (resolved ? resolved.prefix.length + resolved.remainder.length : 0);
            if (cache.size < 128 && cacheChars + chars <= 32768) {
              cache.set(pattern, resolved);
              cacheChars += chars;
            }
          }
          if (resolved) yield resolved;
        }
      signal.throwIfAborted();
    }
    const matchesPattern = (entry: GlobEntry, pattern: WalkPattern): boolean =>
      (!pattern.directoryOnly || entry.dirent.isDirectory()) &&
      matchesWalkPattern(toPosixPath(relative(plan.cwd, entry.path)), pattern);
    const matches = async (entry: GlobEntry): Promise<boolean> => {
      if ((options.onlyFiles ?? true) && !entry.dirent.isFile()) return false;
      if (!variants && walkPatterns.some((pattern) => matchesPattern(entry, pattern))) return true;
      for await (const pattern of queryPatterns(basename(entry.path))) {
        if (
          matchesPattern(entry, pattern) ||
          (await matchesFiniteLiteralPath(entry, pattern, plan.cwd, fs, signal))
        )
          return true;
      }
      return false;
    };
    const entries = walkListEntries({
      fs: options.fs,
      root: plan.cwd,
      maxDepth: maxDepth + 1,
      includeHidden: options.includeHidden ?? false,
      includeIgnored: !options.skipIgnored,
      signal,
      ...(options.onInaccessible
        ? {
            onInaccessible: async (entry: GlobEntry) => {
              if (await matches(entry)) options.onInaccessible?.();
            },
          }
        : {}),
      shouldDescend: async (path) => {
        const rel = toPosixPath(relative(plan.cwd, path));
        const depth = rel.split(SEP).length;
        if (
          common?.prefix &&
          common.prefix !== rel &&
          !common.prefix.startsWith(`${rel}/`) &&
          !rel.startsWith(`${common.prefix}/`)
        )
          return false;
        for await (const { prefix, maxDepth: branchDepth } of queryPatterns())
          if (
            depth <= branchDepth &&
            (!prefix ||
              prefix === rel ||
              prefix.startsWith(`${rel}/`) ||
              rel.startsWith(`${prefix}/`))
          )
            return true;
        return false;
      },
    });
    for await (const entry of entries) {
      signal.throwIfAborted();
      if (await matches(entry)) yield entry;
    }
    signal.throwIfAborted();
    return;
  }
  let gitignoreMatcher: GitignoreManager | null = null;
  if (options.skipIgnored) {
    gitignoreMatcher = await loadRootGitignore(options.cwd, options.signal);
  }

  const plan = normalizeGlobOptions(options);
  const seen = new Set<string>();
  const onlyFiles = options.onlyFiles ?? true;
  const excludeFunc = createExcludeFilter(plan.cwd, plan.exclude, gitignoreMatcher);

  for (const pattern of plan.patterns) {
    yield* processGlobPattern(pattern, plan, seen, onlyFiles, excludeFunc);
  }
}
