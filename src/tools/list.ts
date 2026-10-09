import type { ContentBlock } from '@modelcontextprotocol/server';

import { basename } from 'node:path';

import * as z from 'zod/v4';

import { pageQueryKey, paginate } from '../core/cursor.js';
import { ErrorCode } from '../core/errors.js';
import { pageTrailer } from '../core/fmt.js';
import type { GuardedFileSystem } from '../core/fs.js';
import type { EntryType } from '../core/glob.js';
import { walkListEntries } from '../core/list-walk.js';
import { toPosixRelative } from '../core/path.js';
import { resolveEntryType } from '../core/primitives.js';
import {
  CursorSchema,
  FileType as FileTypeEnum,
  includeHiddenField,
  includeIgnoredField,
  NextCursorSchema,
  NonNegInt,
  OptionalPath,
  PositiveInt,
} from '../core/schema.js';
import type { JsonResourceResult } from '../core/store.js';
import { putJsonResource } from '../core/store.js';
import {
  DEFAULT_SEARCH_TIMEOUT_MS,
  DEFAULT_TREE_ENTRIES,
  MAX_LIST_ENTRIES,
  MAX_TREE_DEPTH,
} from '../core/util.js';
import { defineTool, type ToolCtx } from './define.js';

interface CollectedEntry {
  name: string;
  relativePath: string; // POSIX
  type: EntryType;
}

interface CollectOptions {
  maxDepth: number;
  includeHidden: boolean;
  includeIgnored: boolean;
  signal: AbortSignal;
  fs: GuardedFileSystem;
  /** Stop traversal immediately after this many accessible entries. */
  entryCap: number;
  onProgress?: (progress: { current: number; total?: number }) => void;
}

interface CollectResult {
  truncated: boolean;
  entries: CollectedEntry[];
  totalEntries: number;
  totalFiles: number;
  totalDirectories: number;
}

function entryTypeRank(type: EntryType): number {
  if (type === 'directory') return 0;
  return 1;
}

function compareEntries(a: CollectedEntry, b: CollectedEntry): number {
  // Compare by parent directory first (depth-level grouping)
  const slashA = a.relativePath.lastIndexOf('/');
  const slashB = b.relativePath.lastIndexOf('/');
  const parentA = slashA === -1 ? '' : a.relativePath.slice(0, slashA);
  const parentB = slashB === -1 ? '' : b.relativePath.slice(0, slashB);

  if (parentA !== parentB) return parentA.localeCompare(parentB);

  // Within same parent: dirs first, then alphabetical
  const rankDiff = entryTypeRank(a.type) - entryTypeRank(b.type);
  if (rankDiff !== 0) return rankDiff;
  return a.name.localeCompare(b.name);
}

async function collect(rootPath: string, options: CollectOptions): Promise<CollectResult> {
  const entries: CollectedEntry[] = [];
  let scanned = 0;
  let totalEntries = 0;
  let totalFiles = 0;
  let totalDirectories = 0;

  let truncated = false;
  for await (const entry of walkListEntries({
    fs: options.fs,
    root: rootPath,
    maxDepth: options.maxDepth,
    includeHidden: options.includeHidden,
    includeIgnored: options.includeIgnored,
    signal: options.signal,
  })) {
    options.signal.throwIfAborted();
    scanned++;
    options.onProgress?.({ current: scanned });

    const entryType: EntryType = resolveEntryType(entry.dirent);
    const relPath = toPosixRelative(rootPath, entry.path);
    const name = basename(relPath);

    totalEntries++;
    if (entryType === 'directory') {
      totalDirectories++;
    } else {
      totalFiles++;
    }

    const collectedEntry: CollectedEntry = {
      name,
      relativePath: relPath,
      type: entryType,
    };

    entries.push(collectedEntry);
    if (entries.length === options.entryCap) {
      // No look-ahead: exact N is conservatively incomplete until EOF is known.
      truncated = true;
      break;
    }
  }

  options.signal.throwIfAborted();
  entries.sort(compareEntries);

  return {
    truncated,
    entries,
    totalEntries,
    totalFiles,
    totalDirectories,
  };
}

function limitWarning(metadata: Pick<ListPageMetadata, 'limit' | 'truncated'>): string {
  return metadata.truncated
    ? `// list stopped at limit=${String(metadata.limit)}; completeness is unconfirmed. Totals count collected entries only. Cursors do not resume traversal.\n\n`
    : '';
}

const TEE = '├── ';
const ELBOW = '└── ';
const PIPE = '│   ';
const INDENT = '    ';

function renderMarkdown(rootName: string, entries: readonly CollectedEntry[]): string {
  if (entries.length === 0) return rootName;

  // Group entries by parent path
  const childrenOf = new Map<string, CollectedEntry[]>();
  for (const entry of entries) {
    const slash = entry.relativePath.lastIndexOf('/');
    const parentKey = slash === -1 ? '' : entry.relativePath.slice(0, slash);
    if (!childrenOf.has(parentKey)) childrenOf.set(parentKey, []);
    const children = childrenOf.get(parentKey);
    if (children) children.push(entry);
  }

  const lines: string[] = [rootName];

  function renderChildren(parentKey: string, prefix: string): void {
    const children = childrenOf.get(parentKey);
    if (!children) return;

    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (!child) continue;
      const isLast = i === children.length - 1;
      const connector = isLast ? ELBOW : TEE;
      lines.push(prefix + connector + child.name);

      const childKey = child.relativePath;
      const nextPrefix = prefix + (isLast ? INDENT : PIPE);
      renderChildren(childKey, nextPrefix);
    }
  }

  renderChildren('', '');
  // A page may start below a parent that appeared on an earlier page. Render
  // each disconnected subtree with its relative parent so no page rows vanish.
  const entryPaths = new Set(entries.map((entry) => entry.relativePath));
  for (const parent of childrenOf.keys()) {
    if (parent !== '' && !entryPaths.has(parent)) {
      lines.push(INDENT + parent + '/');
      renderChildren(parent, INDENT);
    }
  }
  return lines.join('\n');
}

const DEFAULT_LIST_DEPTH = 1;
const DEFAULT_LIST_ENTRIES = DEFAULT_TREE_ENTRIES;

const ListInputSchema = z.strictObject({
  path: OptionalPath.describe(
    'Directory to list; omit only when allowed root entries resolve to exactly one filesystem location. With roots at multiple locations, provide an explicit path.',
  ),
  maxDepth: PositiveInt.max(MAX_TREE_DEPTH)
    .default(DEFAULT_LIST_DEPTH)
    .describe("Traversal depth; 1 lists only this directory's children."),
  limit: PositiveInt.max(MAX_LIST_ENTRIES)
    .default(MAX_LIST_ENTRIES)
    .describe(
      'Collect cap across all pages, including files and directories; stops traversal. Totals count collected entries.',
    ),
  pageSize: PositiveInt.max(MAX_LIST_ENTRIES)
    .default(DEFAULT_LIST_ENTRIES)
    .describe('Entries per response; can change between pages. Does not limit traversal.'),
  includeHidden: includeHiddenField(),
  includeIgnored: includeIgnoredField(),
  cursor: CursorSchema,
});

const ListOutputSchema = z.strictObject({
  path: z.string().optional().describe('Resolved absolute path of the listed directory'),
  entries: z
    .array(
      z.strictObject({
        name: z.string().describe('Entry basename'),
        relativePath: z.string().describe('POSIX path relative to the listed directory'),
        type: FileTypeEnum.describe('Entry type: file, directory, symlink, or other'),
      }),
    )
    .describe('Collected entries sorted by parent, then directories-first and name'),
  // The tree rides text; only the cached collected-set resource has a copy.
  entryCount: NonNegInt.describe('Number of entries included in this response'),
  totalEntries: NonNegInt.describe(
    'Entries collected across all pages; not a whole-tree total when truncated',
  ),
  totalFiles: NonNegInt.describe(
    'Collected non-directory entries, including symlinks and other types',
  ),
  totalDirectories: NonNegInt.describe('Collected directories'),
  limit: PositiveInt.describe('Effective collect cap'),
  truncated: z.boolean().describe('Traversal stopped at limit without establishing EOF'),
  stoppedReason: z.literal('limit').optional(),
  resourceUri: z
    .string()
    .optional()
    .describe('First-page URI for the collected set when paged or truncated'),
  nextCursor: NextCursorSchema,
});

interface ListPageMetadata {
  readonly path: string;
  readonly limit: number;
  readonly truncated: boolean;
  readonly stoppedReason?: 'limit';
  readonly totalEntries: number;
  readonly totalFiles: number;
  readonly totalDirectories: number;
}

function listOutput(
  entries: readonly CollectedEntry[],
  metadata: ListPageMetadata,
  nextCursor: string | undefined,
  resourceUri: string | undefined,
): z.infer<typeof ListOutputSchema> {
  return {
    path: metadata.path,
    limit: metadata.limit,
    truncated: metadata.truncated,
    ...(metadata.stoppedReason ? { stoppedReason: metadata.stoppedReason } : {}),
    entries: [...entries],
    entryCount: entries.length,
    totalEntries: metadata.totalEntries,
    totalFiles: metadata.totalFiles,
    totalDirectories: metadata.totalDirectories,
    ...(resourceUri !== undefined ? { resourceUri } : {}),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

async function handleList(
  args: z.infer<typeof ListInputSchema>,
  ctx: ToolCtx,
): Promise<{
  structured: z.infer<typeof ListOutputSchema>;
  markdown: string;
  offset: number;
  nextArgs: z.infer<typeof ListInputSchema>;
  link?: ContentBlock;
}> {
  const path = args.path;
  const resolvedPath = await ctx.fs.pathGuard.resolvePathOrRoot(path, ctx.signal);
  const queryKey = pageQueryKey({
    method: 'list',
    path: resolvedPath,
    limit: args.limit,
    maxDepth: args.maxDepth,
    includeHidden: args.includeHidden,
    includeIgnored: args.includeIgnored,
  });
  const { resourceStore } = ctx;

  const paged = await paginate<CollectedEntry, ListPageMetadata, JsonResourceResult>({
    store: ctx.pageStore,
    queryKey,
    cursor: args.cursor,
    pageSize: args.pageSize,
    produce: async () => {
      const validDir = await ctx.fs.pathGuard.validateExistingDirectory(resolvedPath, ctx.signal);
      const result = await collect(validDir, {
        maxDepth: args.maxDepth,
        includeHidden: args.includeHidden,
        includeIgnored: args.includeIgnored,
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(DEFAULT_SEARCH_TIMEOUT_MS)]),
        fs: ctx.fs,
        entryCap: args.limit,
        ...(ctx.onProgress ? { onProgress: ctx.onProgress } : {}),
      });
      return {
        items: result.entries,
        metadata: {
          path: validDir,
          limit: args.limit,
          truncated: result.truncated,
          ...(result.truncated ? { stoppedReason: 'limit' as const } : {}),
          totalEntries: result.totalEntries,
          totalFiles: result.totalFiles,
          totalDirectories: result.totalDirectories,
        },
        truncated: result.truncated,
      };
    },
    externalize: resourceStore
      ? (entries, metadata) => {
          const name = basename(metadata.path);
          // Store only the bounded collected set, with the same stop state.
          const fullOutput = {
            entries,
            markdown: limitWarning(metadata) + renderMarkdown(name, entries),
            limit: metadata.limit,
            truncated: metadata.truncated,
            ...(metadata.stoppedReason ? { stoppedReason: metadata.stoppedReason } : {}),
            totalEntries: metadata.totalEntries,
            totalFiles: metadata.totalFiles,
            totalDirectories: metadata.totalDirectories,
          };
          return putJsonResource(resourceStore, `${name} collected entries`, fullOutput);
        }
      : undefined,
  });

  return {
    structured: listOutput(paged.page, paged.metadata, paged.nextCursor, paged.resource?.entry.uri),
    markdown: renderMarkdown(basename(paged.metadata.path), [...paged.page]),
    offset: paged.offset,
    // Use the exact path that formed queryKey, including an omitted root.
    nextArgs: { ...args, path: resolvedPath },
    ...(paged.resource ? { link: paged.resource.link } : {}),
  };
}

export const LIST = defineTool({
  name: 'list',
  title: 'List',
  description:
    'List sorted directory entries and an ASCII tree. maxDepth=1 is top-level. ' +
    'limit caps collection (files and folders); pageSize caps one response. Cursors page only collected entries; a limit warning means tree totals are unknown.',
  input: ListInputSchema,
  output: ListOutputSchema,
  // Metadata stays in _meta so clients display the authored tree and warning.
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  defaultErrorCode: ErrorCode.NOT_DIRECTORY,
  progress: (args) => ({
    label: 'List',
    subject: args.path ? basename(args.path) : '.',
  }),
  accessPaths: (args) => (args.path ? [args.path] : []),
  run: async (args, ctx) => {
    const { structured, markdown, offset, nextArgs, link } = await handleList(args, ctx);
    // The tree is what the model reads, so position and the collected-set URI ride
    // the text too — paging needs no second lookup. `pageTrailer` is the one
    // owner of that line, and it owes it on the last page as much as the first.
    const text =
      limitWarning(structured) +
      markdown +
      pageTrailer({
        offset,
        shown: structured.entryCount,
        total: structured.totalEntries,
        noun: 'entries',
        tool: 'list',
        nextCursor: structured.nextCursor,
        nextArgs,
      }) +
      (structured.resourceUri !== undefined
        ? `\ncollected entries at ${structured.resourceUri}`
        : '');
    return {
      structured,
      text,
      ...(link ? { resources: [link] } : {}),
    };
  },
});
