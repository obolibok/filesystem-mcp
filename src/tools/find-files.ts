import * as z from 'zod/v4';

import { SearchStoppedReasonSchema } from '../core/concurrency.js';
import { pageQueryKey, paginate } from '../core/cursor.js';
import { ErrorCode } from '../core/errors.js';
import { formatCount, pageTrailer, scanWarning, truncateProgressPattern } from '../core/fmt.js';
import { toPosixRelative } from '../core/path.js';
import {
  CursorSchema,
  includeHiddenField,
  includeIgnoredField,
  maxDepthField,
  NextCursorSchema,
  NonNegInt,
  OptionalPath,
  PositiveInt,
  SafeGlobPattern,
} from '../core/schema.js';
import { searchFiles } from '../core/search.js';
import type { JsonResourceResult } from '../core/store.js';
import { putJsonResource } from '../core/store.js';
import {
  DEFAULT_SEARCH_RESULTS,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_SEARCH_RESULTS,
} from '../core/util.js';
import { defineTool, type ToolCtx } from './define.js';

// ---------------------------------------------------------------------------

const SearchFilesInputSchema = z.strictObject({
  path: OptionalPath.describe(
    'Base directory to search under; omit only when allowed root entries resolve to exactly one filesystem location. With roots at multiple locations, provide an explicit path.',
  ),
  pattern: SafeGlobPattern.describe('Glob pattern to match file paths (e.g. **/*.ts, src/**/*.js)'),
  limit: PositiveInt.max(MAX_SEARCH_RESULTS)
    .default(MAX_SEARCH_RESULTS)
    .describe(
      'Collect at most this many matching files across all pages; stops traversal (default/cap 10000).',
    ),
  pageSize: PositiveInt.max(MAX_SEARCH_RESULTS)
    .default(DEFAULT_SEARCH_RESULTS)
    .describe(
      'Matching files per page; can change between pages (default 100). Does not limit traversal.',
    ),
  includeIgnored: includeIgnoredField(),
  includeHidden: includeHiddenField(),
  sortBy: z
    .enum(['name', 'path'])
    .optional()
    .default('path')
    .describe('Sort order: path = full path (default), name = basename only'),
  maxDepth: maxDepthField(),
  cursor: CursorSchema,
});

const SearchFilesOutputSchema = z.strictObject({
  root: z.string().describe('Resolved base directory used as the search root'),
  results: z
    .array(
      z.strictObject({
        path: z.string().describe('File path relative to the search root'),
      }),
    )
    .describe('Matched files ordered by sortBy'),
  totalMatches: NonNegInt.optional().describe(
    'Collected matching files; a lower bound when truncated',
  ),
  limit: PositiveInt.describe('Effective collect cap'),
  truncated: z.boolean().describe('Scan stopped before establishing completion'),
  filesScanned: NonNegInt.optional().describe('Total number of files examined during the search'),
  skippedInaccessible: NonNegInt.optional().describe(
    'Files skipped due to permission or access errors',
  ),
  stoppedReason: SearchStoppedReasonSchema.describe(
    'Why collection stopped: limit = collect cap reached (completeness unconfirmed), timeout = time limit hit or cancelled. Absent after completion.',
  ),
  resourceUri: z
    .string()
    .optional()
    .describe(
      'URI to the full results JSON in the resource store; first page only, whenever the response is incomplete — more pages follow, or the result cap cut the search',
    ),
  nextCursor: NextCursorSchema,
});

function buildRelativeResults(
  basePath: string,
  displayResults: readonly { path: string }[],
): NonNullable<z.infer<typeof SearchFilesOutputSchema>['results']> {
  const relativeResults: NonNullable<z.infer<typeof SearchFilesOutputSchema>['results']> = [];
  for (const entry of displayResults) {
    relativeResults.push({
      path: toPosixRelative(basePath, entry.path),
    });
  }
  return relativeResults;
}

type SearchFileResult = NonNullable<z.infer<typeof SearchFilesOutputSchema>['results']>[number];

interface SearchFilesPageMetadata {
  readonly limit: number;
  readonly truncated: boolean;
  readonly root: string;
  readonly totalMatches: number;
  readonly filesScanned: number;
  readonly skippedInaccessible?: number;
  readonly stoppedReason?: z.infer<typeof SearchFilesOutputSchema>['stoppedReason'];
}

function searchFilesOutput(
  results: readonly SearchFileResult[],
  metadata: SearchFilesPageMetadata,
  nextCursor: string | undefined,
  resourceUri: string | undefined,
): z.infer<typeof SearchFilesOutputSchema> {
  return {
    root: metadata.root,
    limit: metadata.limit,
    truncated: metadata.truncated,
    results: [...results],
    totalMatches: metadata.totalMatches,
    filesScanned: metadata.filesScanned,
    ...(metadata.skippedInaccessible ? { skippedInaccessible: metadata.skippedInaccessible } : {}),
    ...(metadata.stoppedReason !== undefined ? { stoppedReason: metadata.stoppedReason } : {}),
    ...(resourceUri !== undefined ? { resourceUri } : {}),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

async function handleSearchFiles(
  args: z.infer<typeof SearchFilesInputSchema>,
  ctx: ToolCtx,
): Promise<{
  structured: z.infer<typeof SearchFilesOutputSchema>;
  offset: number;
  total: number;
  nextArgs: z.infer<typeof SearchFilesInputSchema>;
  link?: ReturnType<typeof putJsonResource>['link'];
}> {
  const requestedBasePath = await ctx.fs.pathGuard.resolvePathOrRoot(args.path, ctx.signal);
  const queryKey = pageQueryKey({
    method: 'find_files',
    path: requestedBasePath,
    pattern: args.pattern,
    includeIgnored: args.includeIgnored,
    includeHidden: args.includeHidden,
    sortBy: args.sortBy,
    maxDepth: args.maxDepth,
    limit: args.limit,
  });
  const { resourceStore } = ctx;

  const paged = await paginate<SearchFileResult, SearchFilesPageMetadata, JsonResourceResult>({
    store: ctx.pageStore,
    queryKey,
    cursor: args.cursor,
    pageSize: args.pageSize,
    produce: async () => {
      const basePath = await ctx.fs.pathGuard.validateExistingDirectory(requestedBasePath);
      const searchOptions: Parameters<typeof searchFiles>[2] = {
        maxResults: args.limit,
        includeHidden: args.includeHidden,
        sortBy: args.sortBy,
        skipIgnored: !args.includeIgnored,
        maxDepth: args.maxDepth,
        signal: ctx.signal,
      };
      const result = await searchFiles(basePath, args.pattern, searchOptions, ctx.fs.pathGuard);
      return {
        items: buildRelativeResults(result.basePath, result.results),
        metadata: {
          root: result.basePath,
          limit: args.limit,
          truncated: result.summary.truncated,
          totalMatches: result.summary.matched,
          filesScanned: result.summary.filesScanned,
          ...(result.summary.skippedInaccessible
            ? { skippedInaccessible: result.summary.skippedInaccessible }
            : {}),
          ...(result.summary.stoppedReason !== undefined
            ? { stoppedReason: result.summary.stoppedReason }
            : {}),
        },
        truncated: result.summary.truncated,
      };
    },
    externalize: resourceStore
      ? (results, metadata) =>
          putJsonResource(
            resourceStore,
            `${args.pattern} files`,
            searchFilesOutput(results, metadata, undefined, undefined),
          )
      : undefined,
  });

  return {
    structured: searchFilesOutput(
      paged.page,
      paged.metadata,
      paged.nextCursor,
      paged.resource?.entry.uri,
    ),
    offset: paged.offset,
    total: paged.metadata.totalMatches,
    nextArgs: { ...args, path: requestedBasePath },
    ...(paged.resource ? { link: paged.resource.link } : {}),
  };
}

export const FIND_FILES = defineTool({
  name: 'find_files',
  title: 'Find Files',
  description:
    'Find specific file names or glob matches. ' +
    `limit caps collected files across all pages (default/cap ${MAX_SEARCH_RESULTS}); pageSize sets response size (default 100). ` +
    'maxDepth prunes traversal: 0 = base only, default/cap 100. Sorts the collected subset, not globally first N. maxResults is removed; use limit/pageSize. ' +
    'Cursors page only collected results, expire after 60 seconds, and never resume beyond cap/timeout. ' +
    'For a recursive inventory/index or file total use snapshot; for content use search_text.',
  input: SearchFilesInputSchema,
  output: SearchFilesOutputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  defaultErrorCode: ErrorCode.UNKNOWN,
  progress: (args) => ({
    label: 'Find',
    subject: truncateProgressPattern(args.pattern),
  }),
  progressDone: (_args, result) => ({
    detail: formatCount(result.totalMatches ?? 0, 'match', 'matches'),
  }),
  accessPaths: (args) => (args.path ? [args.path] : []),
  run: async (args, ctx) => {
    const { structured, offset, total, nextArgs, link } = await handleSearchFiles(args, ctx);
    const body =
      structured.results.length > 0
        ? structured.results.map((r) => r.path).join('\n')
        : `No files matching '${args.pattern}'`;
    const text =
      scanWarning(structured.stoppedReason, structured.limit) +
      body +
      pageTrailer({
        offset,
        shown: structured.results.length,
        total,
        noun: 'files',
        tool: 'find_files',
        nextCursor: structured.nextCursor,
        nextArgs,
      });
    if (link) {
      return { structured, text, resources: [link] };
    }
    return { structured, text };
  },
});
