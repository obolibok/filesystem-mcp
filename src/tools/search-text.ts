import { dirname, posix } from 'node:path';

import * as z from 'zod/v4';

import { SearchStoppedReasonSchema } from '../core/concurrency.js';
import { pageQueryKey, paginate, readPageQuery } from '../core/cursor.js';
import { ErrorCode, FsError, isFsError } from '../core/errors.js';
import { formatCount, pageTrailer, scanWarning, truncateProgressPattern } from '../core/fmt.js';
import { Logger } from '../core/observability.js';
import { invalidCursor } from '../core/page-store.js';
import { toPosixRelative } from '../core/path.js';
import {
  CursorSchema,
  defaultFalseBoolean,
  includeHiddenField,
  includeIgnoredField,
  isBlank,
  MAX_PATH_LENGTH,
  maxDepthField,
  NextCursorSchema,
  NonNegInt,
  OptionalPath,
  PositiveInt,
  SafeGlobPattern,
} from '../core/schema.js';
import type { SearchContentOptions } from '../core/search.js';
import { searchContent } from '../core/search.js';
import type { JsonResourceResult } from '../core/store.js';
import { MAX_RESOURCE_ENTRY_BYTES, putJsonResource } from '../core/store.js';
import {
  DEFAULT_SEARCH_CONTENT_RESULTS,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_SEARCH_RESULTS,
} from '../core/util.js';
import { defineTool, type ToolCtx } from './define.js';

/**
 * `FS_MAX_INLINE_MATCHES` used to cap how many matches a page showed inline
 * and, past it, push the rest into the resource store. `pageSize` is the one
 * page size now, and the full list is externalized whenever a response is
 * incomplete, so the variable does nothing. It is still read so an operator who
 * set it hears why it stopped mattering; the read goes at the next major.
 */
if (process.env['FS_MAX_INLINE_MATCHES'] !== undefined) {
  Logger.warn(
    'FS_MAX_INLINE_MATCHES is deprecated and ignored: pageSize caps lines per search_text page within its 16 KiB budget; limit caps collected matching lines. It will be removed in the next major release.',
  );
}

// Reserve space for the optional, fixed-name resource_link block too.
const INLINE_TEXT_BYTES = 16_384 - 256;
const MAX_SNIPPET_POINTS = 500;
// The longest UTF-8 spelling of a path accepted by the read/get_file schema.
const MAX_INLINE_PATH_BYTES = MAX_PATH_LENGTH * 3;
const MAX_REPEATED_QUERY_BYTES = 1024;
const CONTEXT_REDUCED = '\n// Context reduced to fit the page.';

type SearchQuery = z.infer<typeof GrepQuerySchema>;
type SearchInput = z.infer<typeof GrepInputSchema>;
type SearchOutput = z.infer<typeof GrepOutputSchema>;
type SearchMatchPayload = NonNullable<SearchOutput['matches']>[number];
type SearchResultValue = Awaited<ReturnType<typeof searchContent>>;

interface SearchContentPageMetadata {
  readonly limit: number;
  readonly totalMatches: number;
  readonly filesScanned: number;
  readonly filesMatched?: number;
  readonly truncated: boolean;
  readonly stoppedReason?: SearchOutput['stoppedReason'];
  readonly skippedInaccessible?: number;
  readonly skippedTooLarge?: number;
  readonly skippedBinary?: number;
  readonly skippedUnsupportedEncoding?: number;
}

const GrepQuerySchema = z.strictObject({
  path: OptionalPath.describe(
    'File to search, or directory to search under; omit only when allowed root entries resolve to exactly one filesystem location. With roots at multiple locations, provide an explicit path. Naming a file searches that file alone: pattern is ignored and hidden/ignored filtering does not apply.',
  ),
  pattern: SafeGlobPattern.optional().describe(
    'Glob to restrict search to specific file types (e.g. **/*.ts); default: all text files',
  ),
  searchPattern: z
    .string()
    .min(1)
    .max(10000)
    .refine((val) => !isBlank(val), {
      message: 'searchPattern cannot be empty or whitespace-only',
    })
    .describe(
      'Literal text or RE2 pattern. Regexes do not support lookaround or backreferences. Required for a new search; omit for a cursor-only continuation.',
    )
    .meta({ examples: ['TODO', 'function\\s+(\\w+)', 'import.*from'] }),
  isRegex: defaultFalseBoolean('Treat searchPattern as a regex (default: literal text match)'),
  includeHidden: includeHiddenField(),
  includeIgnored: includeIgnoredField(),
  caseSensitive: defaultFalseBoolean('Enable case-sensitive matching (default: case-insensitive)'),
  limit: PositiveInt.max(MAX_SEARCH_RESULTS)
    .default(MAX_SEARCH_RESULTS)
    .describe(
      'Collect at most this many matching lines across all pages; occurrences/context do not consume extra limit (default/cap 10000).',
    ),
  pageSize: PositiveInt.max(MAX_SEARCH_RESULTS)
    .default(DEFAULT_SEARCH_CONTENT_RESULTS)
    .describe(
      'Maximum matching lines per page (default 500), subject to the 16 KiB output budget. Can change between pages.',
    ),
  context: z
    .uint32()
    .max(10)
    .optional()
    .default(0)
    .describe(
      'Context lines on either side of each match (default 0, max 10); each is clipped and may be dropped to fit the page.',
    ),
  maxDepth: maxDepthField(),
  cursor: CursorSchema,
});

// Publish defaults while leaving absent fields undefined so a cursor-only
// call can reject extra query fields, including explicitly supplied defaults.
function optionalQueryField<T extends z.ZodType>(field: z.ZodDefault<T>) {
  return field
    .unwrap()
    .optional()
    .meta({ ...field.meta(), default: field.parse(undefined) });
}

const GrepInputSchema = GrepQuerySchema.extend({
  searchPattern: GrepQuerySchema.shape.searchPattern.optional(),
  isRegex: optionalQueryField(GrepQuerySchema.shape.isRegex),
  includeHidden: optionalQueryField(GrepQuerySchema.shape.includeHidden),
  includeIgnored: optionalQueryField(GrepQuerySchema.shape.includeIgnored),
  caseSensitive: optionalQueryField(GrepQuerySchema.shape.caseSensitive),
  limit: optionalQueryField(GrepQuerySchema.shape.limit),
  context: optionalQueryField(GrepQuerySchema.shape.context),
  maxDepth: optionalQueryField(GrepQuerySchema.shape.maxDepth),
  pageSize: optionalQueryField(GrepQuerySchema.shape.pageSize),
})
  .superRefine((args, ctx) => {
    if (args.searchPattern !== undefined) return;
    if (args.cursor === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['searchPattern'],
        message: 'searchPattern is required for a new search',
      });
      return;
    }
    const extraFields = Object.keys(args).filter((key) => key !== 'cursor' && key !== 'pageSize');
    if (extraFields.length > 0) {
      ctx.addIssue({ code: 'unrecognized_keys', keys: extraFields });
    }
  })
  .meta({ anyOf: [{ required: ['searchPattern'] }, { required: ['cursor'] }] });

// A configured root may be longer than a user-supplied path. The path here
// has already been saved by the server, and is reauthorized on every replay.
const StoredGrepQuerySchema = GrepQuerySchema.extend({ path: z.string() });

const GrepOutputSchema = z.strictObject({
  matches: z
    .array(
      z.strictObject({
        file: z.string().describe('File path relative to the search root'),
        line: PositiveInt.describe('1-indexed line number of the match'),
        column: NonNegInt.describe(
          '0-indexed UTF-16 column of the match start in the original line',
        ),
        content: z.string().describe('Up to 500 Unicode code points surrounding the first match'),
        clippedBefore: z.literal(true).optional().describe('The beginning of the line was omitted'),
        clippedAfter: z.literal(true).optional().describe('The end of the line was omitted'),
        matchClipped: z
          .literal(true)
          .optional()
          .describe('The first match itself exceeds the fragment'),
        matchCount: NonNegInt.optional().describe('Number of pattern occurrences on this line'),
        before: z
          .array(z.string())
          .optional()
          .describe('Lines immediately before the match; present when context > 0'),
        after: z
          .array(z.string())
          .optional()
          .describe('Lines immediately after the match; present when context > 0'),
      }),
    )
    .describe('Flat list of matches sorted by file path then line number'),
  contextReduced: z
    .literal(true)
    .optional()
    .describe('Neighboring lines were dropped to fit the page'),
  totalMatches: NonNegInt.optional().describe(
    "Total matching lines, one per entry in matches (not per occurrence); see that entry's matchCount for occurrences on a line.",
  ),
  limit: PositiveInt.describe('Effective matching-line collect cap'),
  filesMatched: NonNegInt.optional().describe('Number of files containing at least one match'),
  filesScanned: NonNegInt.optional().describe(
    'Accessible files whose metadata or text classification were examined, including files reported by a skip counter',
  ),
  skippedInaccessible: NonNegInt.optional().describe(
    'Files skipped unread due to permission or access errors',
  ),
  skippedTooLarge: NonNegInt.optional().describe(
    'Files skipped unread because they exceed the text-file size limit; raise the limit or narrow pattern if a match was expected in one',
  ),
  skippedBinary: NonNegInt.optional().describe(
    'Files skipped because their bytes are binary, regardless of filename extension',
  ),
  skippedUnsupportedEncoding: NonNegInt.optional().describe(
    'Files skipped because their BOM declares an unsupported text encoding (currently UTF-16 LE or BE)',
  ),
  truncated: z
    .boolean()
    .describe(
      'True when the search engine cut the match list — the hard result cap or the time limit. Paging is not truncation: a set that spans pages has nextCursor instead.',
    ),
  stoppedReason: SearchStoppedReasonSchema.describe(
    'Why collection stopped: limit = collect cap reached (completeness unconfirmed), timeout = time limit hit or cancelled. Absent after completion.',
  ),
  resourceUri: z
    .string()
    .optional()
    .describe(
      'Optional first-page resource with all collected match fragments when the result spans pages or the scan stopped early',
    ),
  nextCursor: NextCursorSchema,
});

function contextSnippet(text: string): string {
  if (text.length <= MAX_SNIPPET_POINTS) return text;
  const points = Array.from(text.slice(0, MAX_SNIPPET_POINTS * 2 + 1));
  return points.length > MAX_SNIPPET_POINTS
    ? points.slice(0, MAX_SNIPPET_POINTS - 1).join('') + '…'
    : text;
}

function matchSnippet(
  text: string,
  column: number,
  matchEnd: number,
): Pick<SearchMatchPayload, 'content' | 'clippedBefore' | 'clippedAfter' | 'matchClipped'> {
  if (text.length <= MAX_SNIPPET_POINTS) return { content: text };

  // At most two UTF-16 units per code point. The extra unit at each far end
  // keeps a partial surrogate pair outside the selected 500 code points.
  const span = MAX_SNIPPET_POINTS * 2 + 1;
  const match = Array.from(text.slice(column, Math.min(matchEnd, column + span)));
  const before = Array.from(text.slice(Math.max(0, column - span), column));
  const after = Array.from(text.slice(matchEnd, matchEnd + span));
  const space = Math.max(0, MAX_SNIPPET_POINTS - match.length);
  const rightCount = Math.min(after.length, space - Math.min(before.length, Math.floor(space / 2)));
  const leftCount = Math.min(before.length, space - rightCount);

  const left = before.slice(before.length - leftCount).join('');
  const hit = match.slice(0, MAX_SNIPPET_POINTS).join('');
  const right = after.slice(0, rightCount).join('');
  return {
    content: left + hit + right,
    ...(left.length < column ? { clippedBefore: true } : {}),
    ...(column + hit.length + right.length < text.length ? { clippedAfter: true } : {}),
    ...(column + hit.length < matchEnd ? { matchClipped: true } : {}),
  };
}

function displayPath(file: string): string {
  return Buffer.byteLength(file, 'utf8') <= MAX_INLINE_PATH_BYTES
    ? file
    : '…/' + contextSnippet(posix.basename(file)) + ' [path clipped, full path in metadata]';
}

function matchRow(m: SearchMatchPayload): string {
  const markers = ['column ' + String(m.column)];
  if (m.clippedBefore) markers.push('left clipped');
  if (m.clippedAfter) markers.push('right clipped');
  if (m.matchClipped) markers.push('match clipped');
  return `${displayPath(m.file)}:${String(m.line)}: ${m.content} [${markers.join(', ')}]`;
}

/**
 * grep -C layout: `file-line- text` for a context line, `--` between groups
 * that are not adjacent. Every match's window lands in a per-file line map
 * where a match wins over context, so a line two windows share prints once,
 * and as a match when it is one. The maps iterate in line order without a
 * sort: matches arrive sorted, each window is contiguous, and setting an
 * existing key keeps its slot.
 */
function renderRows(matches: readonly SearchMatchPayload[], withContext: boolean): string[] {
  if (!withContext) return matches.map(matchRow);
  const byFile = new Map<string, Map<number, string>>();
  for (const m of matches) {
    const lines = byFile.get(m.file) ?? new Map<number, string>();
    byFile.set(m.file, lines);
    const setContext = (n: number, text: string): void => {
      if (!lines.has(n)) lines.set(n, `${displayPath(m.file)}-${String(n)}- ${text}`);
    };
    const before = m.before ?? [];
    before.forEach((text, k) => {
      setContext(m.line - before.length + k, text);
    });
    lines.set(m.line, matchRow(m));
    (m.after ?? []).forEach((text, k) => {
      setContext(m.line + 1 + k, text);
    });
  }
  const rows: string[] = [];
  for (const lines of byFile.values()) {
    let prev: number | undefined;
    for (const [n, row] of lines) {
      if (prev === undefined ? rows.length > 0 : n > prev + 1) rows.push('--');
      rows.push(row);
      prev = n;
    }
  }
  return rows;
}

function buildSearchMatchDetail(totalMatches: number, filesMatched: number): string {
  const matchDetail = formatCount(totalMatches, 'match', 'matches');
  if (filesMatched <= 0) return matchDetail;
  return `${matchDetail} · ${formatCount(filesMatched, 'file', 'files')}`;
}

function skipSummary(output: SearchContentPageMetadata): string {
  const skipped: string[] = [];
  if (output.skippedBinary) {
    skipped.push(formatCount(output.skippedBinary, 'binary file', 'binary files'));
  }
  if (output.skippedUnsupportedEncoding) {
    skipped.push(
      formatCount(
        output.skippedUnsupportedEncoding,
        'file with unsupported text encoding',
        'files with unsupported text encoding',
      ),
    );
  }
  if (output.skippedTooLarge) {
    skipped.push(
      formatCount(output.skippedTooLarge, 'file over the size limit', 'files over the size limit'),
    );
  }
  if (output.skippedInaccessible) {
    skipped.push(
      formatCount(output.skippedInaccessible, 'inaccessible file', 'inaccessible files'),
    );
  }
  return skipped.length > 0 ? `\n// Skipped ${skipped.join('; ')}.` : '';
}

function searchContentOutput(
  matches: readonly SearchMatchPayload[],
  metadata: SearchContentPageMetadata,
  nextCursor: string | undefined,
  resourceUri: string | undefined,
): SearchOutput {
  return {
    matches: [...matches],
    limit: metadata.limit,
    totalMatches: metadata.totalMatches,
    filesScanned: metadata.filesScanned,
    ...(metadata.filesMatched ? { filesMatched: metadata.filesMatched } : {}),
    truncated: metadata.truncated,
    ...(metadata.stoppedReason !== undefined ? { stoppedReason: metadata.stoppedReason } : {}),
    ...(metadata.skippedInaccessible ? { skippedInaccessible: metadata.skippedInaccessible } : {}),
    ...(metadata.skippedTooLarge ? { skippedTooLarge: metadata.skippedTooLarge } : {}),
    ...(metadata.skippedBinary ? { skippedBinary: metadata.skippedBinary } : {}),
    ...(metadata.skippedUnsupportedEncoding
      ? { skippedUnsupportedEncoding: metadata.skippedUnsupportedEncoding }
      : {}),
    ...(resourceUri !== undefined ? { resourceUri } : {}),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

function buildSortedPayloads(result: SearchResultValue): SearchMatchPayload[] {
  const relativeByFile = new Map<string, string>();

  const getRelativeFile = (file: string): string => {
    const cached = relativeByFile.get(file);
    if (cached !== undefined) return cached;

    const rel = toPosixRelative(result.basePath, file);
    relativeByFile.set(file, rel);
    return rel;
  };

  const payloads = result.matches.map((match): SearchMatchPayload => ({
    file: getRelativeFile(match.file),
    line: match.line,
    column: match.column,
    ...matchSnippet(match.content, match.column, match.matchEnd),
    matchCount: match.matchCount,
    ...(match.before !== undefined ? { before: match.before.map(contextSnippet) } : {}),
    ...(match.after !== undefined ? { after: match.after.map(contextSnippet) } : {}),
  }));

  payloads.sort((l, r) => l.file.localeCompare(r.file) || l.line - r.line);
  return payloads;
}

function buildSearchContentOptions(args: SearchQuery, signal?: AbortSignal): SearchContentOptions {
  return {
    includeHidden: args.includeHidden,
    filePattern: args.pattern ?? '**/*',
    caseSensitive: args.caseSensitive,
    isRegex: args.isRegex,
    maxResults: args.limit,
    skipIgnored: !args.includeIgnored,
    context: args.context,
    maxDepth: args.maxDepth,
    ...(signal ? { signal } : {}),
  };
}

/**
 * `path` is documented as "file to search, or directory to search under", but
 * a file path bypasses directory discovery. Use its parent only for relative
 * result paths; keep the file itself literal, without glob/hidden/ignore filters.
 */
async function resolveSearchScope(
  args: SearchQuery,
  ctx: ToolCtx,
): Promise<{ basePath: string; singleFile?: string }> {
  const requested = await ctx.fs.pathGuard.resolvePathOrRoot(args.path, ctx.signal);
  // One resolution, one stat: validateExistingDirectory would redo both.
  const { validPath: resolved, stats } = await ctx.fs.stat(requested, { signal: ctx.signal });
  if (!stats.isFile()) {
    if (!stats.isDirectory()) {
      throw new FsError(ErrorCode.NOT_DIRECTORY, 'Not a directory', requested);
    }
    return { basePath: resolved };
  }
  return {
    basePath: dirname(resolved),
    singleFile: resolved,
  };
}

function resolveSearchQuery(input: SearchInput, ctx: ToolCtx): SearchQuery {
  if (input.searchPattern !== undefined) {
    const result = GrepQuerySchema.safeParse(input);
    if (!result.success) throw new FsError(ErrorCode.INVALID_INPUT, z.prettifyError(result.error));
    return result.data;
  }
  if (input.cursor === undefined) throw invalidCursor();
  const query = readPageQuery(ctx.pageStore, input.cursor, 'search_text');
  const result = StoredGrepQuerySchema.safeParse({ ...query, ...input });
  if (!result.success) throw invalidCursor();
  return result.data;
}

function continuationArgs(args: SearchQuery, requestedPath: string): Record<string, unknown> {
  const full = { ...args, path: requestedPath, cursor: undefined };
  // Large supplied patterns (including JSON escapes) must leave space for
  // a complete match row. The compact call recovers this same stored query.
  if (
    Buffer.byteLength(JSON.stringify(full), 'utf8') <= MAX_REPEATED_QUERY_BYTES &&
    OptionalPath.safeParse(requestedPath).success
  ) {
    return full;
  }
  return { pageSize: args.pageSize };
}

function searchTrailer(
  offset: number,
  shown: number,
  total: number,
  nextCursor: string | undefined,
  nextArgs: Record<string, unknown>,
): string {
  return pageTrailer({
    offset,
    shown,
    total,
    noun: 'matches',
    tool: 'search_text',
    nextCursor,
    nextArgs,
  });
}

function fitPageSize(
  items: readonly SearchMatchPayload[],
  metadata: SearchContentPageMetadata,
  offset: number,
  cursorAfter: (shown: number) => string | undefined,
  nextArgs: Record<string, unknown>,
  context: number,
): number {
  const fixedBytes = Buffer.byteLength(
    scanWarning(metadata.stoppedReason, metadata.limit) +
      skipSummary(metadata) +
      (context > 0 ? CONTEXT_REDUCED : ''),
    'utf8',
  );
  let rowBytes = 0;
  let fits = 0;
  for (const [index, item] of items.entries()) {
    rowBytes += Buffer.byteLength(matchRow(item), 'utf8') + (index > 0 ? 1 : 0);
    if (rowBytes + fixedBytes > INLINE_TEXT_BYTES) break;
    const shown = index + 1;
    const trailer = searchTrailer(
      offset,
      shown,
      metadata.totalMatches,
      cursorAfter(shown),
      nextArgs,
    );
    if (rowBytes + fixedBytes + Buffer.byteLength(trailer, 'utf8') <= INLINE_TEXT_BYTES)
      fits = shown;
  }
  // With the row, path and repeated-query caps, one row always fits.
  return fits;
}

function renderPage(
  page: readonly SearchMatchPayload[],
  metadata: SearchContentPageMetadata,
  trailer: string,
  args: SearchQuery,
): { text: string; matches: readonly SearchMatchPayload[]; contextReduced: boolean } {
  const scan = scanWarning(metadata.stoppedReason, metadata.limit);
  const skips = skipSummary(metadata);
  const { context } = args;
  for (let radius = context; radius >= 0; radius--) {
    const matches =
      radius === context
        ? page
        : page.map((match) => ({
            ...match,
            before: radius === 0 ? [] : (match.before?.slice(-radius) ?? []),
            after: match.after?.slice(0, radius) ?? [],
          }));
    const rows = renderRows(matches, radius > 0);
    const contextReduced = radius < context;
    const text =
      scan +
      (rows.length === 0
        ? `No matches for '${contextSnippet(args.searchPattern.toWellFormed())}'`
        : rows.join('\n')) +
      skips +
      (contextReduced ? CONTEXT_REDUCED : '') +
      trailer;
    if (Buffer.byteLength(text, 'utf8') <= INLINE_TEXT_BYTES) {
      return { text, matches, contextReduced };
    }
  }
  throw new FsError(ErrorCode.UNKNOWN, 'Search page exceeds its text budget.');
}

function externalizeSearch(
  store: NonNullable<ToolCtx['resourceStore']>,
  matches: readonly SearchMatchPayload[],
  metadata: SearchContentPageMetadata,
): JsonResourceResult | undefined {
  // Avoid allocating an oversized pretty-printed JSON document. The actual
  // store enforces the exact limit, including indentation and metadata.
  let bytes = 0;
  for (const match of matches) {
    bytes += Buffer.byteLength(JSON.stringify(match), 'utf8');
    if (bytes > MAX_RESOURCE_ENTRY_BYTES) return undefined;
  }
  try {
    return putJsonResource(
      store,
      'Search matches',
      searchContentOutput(matches, metadata, undefined, undefined),
    );
  } catch (error) {
    if (isFsError(error) && error.code === ErrorCode.TOO_LARGE) return undefined;
    throw error;
  }
}

async function handleSearchContent(
  input: SearchInput,
  ctx: ToolCtx,
): Promise<{
  structured: SearchOutput;
  text: string;
  link?: ReturnType<typeof putJsonResource>['link'];
}> {
  const args = resolveSearchQuery(input, ctx);
  const requestedPath = await ctx.fs.pathGuard.resolvePathOrRoot(args.path, ctx.signal);
  if (args.cursor !== undefined) ctx.fs.pathGuard.assertPathAllowed(requestedPath);
  const nextArgs = continuationArgs(args, requestedPath);
  const queryKey = pageQueryKey({
    method: 'search_text',
    path: requestedPath,
    pattern: args.pattern ?? '**/*',
    searchPattern: args.searchPattern,
    isRegex: args.isRegex,
    includeHidden: args.includeHidden,
    includeIgnored: args.includeIgnored,
    caseSensitive: args.caseSensitive,
    maxDepth: args.maxDepth,
    context: args.context,
    limit: args.limit,
  });
  const { resourceStore } = ctx;

  const paged = await paginate<
    SearchMatchPayload,
    SearchContentPageMetadata,
    JsonResourceResult | undefined
  >({
    store: ctx.pageStore,
    queryKey,
    cursor: args.cursor,
    pageSize: args.pageSize,
    selectPageSize: ({ items, metadata, offset, cursorAfter }) =>
      fitPageSize(items, metadata, offset, cursorAfter, nextArgs, args.context),
    produce: async () => {
      const { basePath, singleFile } = await resolveSearchScope(args, ctx);

      const result = await searchContent(
        basePath,
        args.searchPattern,
        { ...buildSearchContentOptions(args, ctx.signal), ...(singleFile ? { singleFile } : {}) },
        ctx.fs.pathGuard,
      );

      const items = buildSortedPayloads(result);
      return {
        items,
        metadata: {
          limit: args.limit,
          totalMatches: result.summary.matchingLines,
          filesScanned: result.summary.filesScanned,
          ...(result.summary.filesMatched ? { filesMatched: result.summary.filesMatched } : {}),
          truncated: result.summary.truncated,
          ...(result.summary.stoppedReason !== undefined
            ? { stoppedReason: result.summary.stoppedReason }
            : {}),
          ...(result.summary.skippedInaccessible
            ? { skippedInaccessible: result.summary.skippedInaccessible }
            : {}),
          ...(result.summary.skippedTooLarge
            ? { skippedTooLarge: result.summary.skippedTooLarge }
            : {}),
          ...(result.summary.skippedBinary ? { skippedBinary: result.summary.skippedBinary } : {}),
          ...(result.summary.skippedUnsupportedEncoding
            ? { skippedUnsupportedEncoding: result.summary.skippedUnsupportedEncoding }
            : {}),
        },
        truncated: result.summary.truncated,
      };
    },

    externalize: resourceStore
      ? (matches, metadata) => externalizeSearch(resourceStore, matches, metadata)
      : undefined,
  });

  const trailer = searchTrailer(
    paged.offset,
    paged.page.length,
    paged.metadata.totalMatches,
    paged.nextCursor,
    nextArgs,
  );
  const { text, matches, contextReduced } = renderPage(paged.page, paged.metadata, trailer, args);
  return {
    structured: {
      ...searchContentOutput(matches, paged.metadata, paged.nextCursor, paged.resource?.entry.uri),
      ...(contextReduced ? { contextReduced: true } : {}),
    },
    text,
    ...(paged.resource ? { link: paged.resource.link } : {}),
  };
}

export const SEARCH_TEXT = defineTool({
  name: 'search_text',
  title: 'Search Content',
  description:
    'Search text or RE2 regex in files. Shows up to 500 code points around the first match per line, ' +
    'with original path, line (1-based) and UTF-16 column (0-based). Pages cap output at 16 KiB and drop context first. ' +
    'Use read or get_file for originals. limit caps collected lines (default/cap 10000); pageSize caps lines per page (default 500). ' +
    'Run the Next page JSON to continue. maxDepth bounds traversal (0 = base only, default/cap 100). ' +
    'Sorts the collected subset. Skips and counts binary files and unsupported encodings. Use find_files for filenames.',
  input: GrepInputSchema,
  output: GrepOutputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  defaultErrorCode: ErrorCode.UNKNOWN,
  maxErrorTextBytes: INLINE_TEXT_BYTES,
  progress: (args) => ({
    label: 'Search',
    ...(args.searchPattern !== undefined
      ? { subject: truncateProgressPattern(args.searchPattern) }
      : {}),
  }),
  progressDone: (_args, result) => ({
    detail: buildSearchMatchDetail(result.totalMatches ?? 0, result.filesMatched ?? 0),
  }),
  accessPaths: (args) => (args.path ? [args.path] : []),
  run: async (args, ctx) => {
    const { structured, text, link } = await handleSearchContent(args, ctx);
    return { structured, text, ...(link ? { resources: [link] } : {}) };
  },
});
