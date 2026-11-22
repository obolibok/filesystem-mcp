import * as z from 'zod/v4';

import { ErrorCode, FsError } from '../core/errors.js';
import { RequiredPath } from '../core/schema.js';
import { defineTool, type ToolCtx } from './define.js';

export const CatalogStatusSchema = z.strictObject({
  indexed: z.boolean(),
  indexedAt: z.iso.datetime().optional(),
  version: z.uuid().optional(),
  state: z.enum(['idle', 'queued', 'running', 'failed']),
  requestId: z.uuid().optional(),
  errorCode: z.enum(ErrorCode).optional(),
  errorStage: z.enum(['source', 'storage', 'policy']).optional(),
  policyExcluded: z.int().nonnegative().optional(),
});

function catalog(ctx: ToolCtx) {
  const service = ctx.jobManager.catalog;
  if (!service) throw new FsError(ErrorCode.INVALID_INPUT, 'File catalog is disabled');
  return service;
}

export const INDEX_ROOT = defineTool({
  name: 'index_root',
  title: 'Build File Catalog',
  description:
    'Queue an index of one allowed root from list_roots. Only one root is scanned at a time. Monitor indexing through list_roots. A failed scan preserves the previous index.',
  input: z.strictObject({ path: RequiredPath }),
  output: z.strictObject({
    requestId: z.uuid(),
    state: z.enum(['queued', 'running']),
    message: z.enum(['Requested', 'Already requested']),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  sourceMutating: false,
  defaultErrorCode: ErrorCode.IO_ERROR,
  accessPaths: (args) => [args.path],
  run: async ({ path }, ctx) => {
    const root = await ctx.fs.pathGuard.validateExistingDirectory(path, ctx.signal);
    return { structured: await catalog(ctx).request(ctx.fs, root) };
  },
});

const FilterText = z.string().min(1).max(255);
const Input = z.strictObject({
  path: RequiredPath.describe('An indexed root or its indexed subdirectory.'),
  name: FilterText.optional().describe('Case-sensitive exact basename.'),
  namePrefix: FilterText.optional().describe('Case-sensitive literal basename prefix.'),
  extension: FilterText.optional().describe('Case-sensitive extension including its leading dot.'),
  modifiedFrom: z.iso
    .datetime({ offset: true })
    .optional()
    .describe('Inclusive file modification time.'),
  modifiedBefore: z.iso
    .datetime({ offset: true })
    .optional()
    .describe('Exclusive file modification time.'),
  limit: z.int().min(1).max(200).default(50),
  cursor: z
    .string()
    .min(1)
    .max(65536)
    .optional()
    .describe('Return with the same arguments to get the next page.'),
});

export const SEARCH_INDEX = defineTool({
  name: 'search_index',
  title: 'Search File Catalog',
  description:
    'Search a published metadata index by exact name, name prefix, extension or file modification time. Returns a page sorted by exact relative path. Check observation times; use get_file for current file contents.',
  input: Input,
  output: z.strictObject({
    root: z.string(),
    path: z.string(),
    version: z.uuid(),
    policyExcluded: z.int().nonnegative().optional(),
    observed: z.strictObject({ startedAt: z.iso.datetime(), endedAt: z.iso.datetime() }),
    entries: z.array(
      z.strictObject({
        path: z.string(),
        name: z.string(),
        kind: z.enum(['directory', 'file']),
        length: z.int().nonnegative().nullable(),
        extension: z.string().nullable(),
        lastWriteTime: z.iso.datetime().nullable(),
        creationTime: z.iso.datetime().nullable(),
      }),
    ),
    cursor: z.string().optional(),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  defaultErrorCode: ErrorCode.IO_ERROR,
  accessPaths: (args) => [args.path],
  run: async ({ path, limit, cursor, modifiedFrom, modifiedBefore, ...filters }, ctx) => {
    const scope = await ctx.fs.pathGuard.validateExistingDirectory(path, ctx.signal);
    const from = modifiedFrom ? new Date(modifiedFrom).toISOString() : undefined;
    const before = modifiedBefore ? new Date(modifiedBefore).toISOString() : undefined;
    if (from && before && from >= before) {
      throw new FsError(ErrorCode.INVALID_INPUT, 'modifiedFrom must precede modifiedBefore');
    }
    return {
      structured: await catalog(ctx).search(
        ctx.fs,
        scope,
        { ...filters, modifiedFrom: from, modifiedBefore: before },
        limit,
        cursor,
      ),
    };
  },
});

const SqlValue = z.union([z.string().max(4096), z.number(), z.null()]);

export const QUERY_INDEX = defineTool({
  name: 'query_index',
  title: 'Query Published File Catalog',
  description:
    'Run one read-only SQLite SELECT in an indexed root or subfolder. ' +
    'Use catalog_entries for files and directories, including empty directories. Filter kind by file or directory. ' +
    'Both catalog_entries and the file-only files view have root_path, configured_root, relative_path, name, extension, size_bytes, created_at, modified_at. ' +
    'Use positional ? parameters and COUNT(*) for counts, GROUP BY for summaries, and ORDER BY with SQL LIMIT/OFFSET for pages. ' +
    'Use instr(lower(name), ?) for literal substring matching with ASCII case folding. Returns columns and rows, version, and truncation status. ' +
    'Limited by the server SQL timeout (15 seconds by default) and by 200 result rows. Dates are UTC, and creation time may be null.',
  input: z.strictObject({
    path: RequiredPath.describe(
      'Indexed root or indexed subfolder. The server fixes the query scope.',
    ),
    sql: z.string().trim().min(1).max(8192),
    params: z.array(SqlValue).max(64).default([]),
    limit: z.int().min(1).max(200).default(100),
  }),
  output: z.strictObject({
    root: z.string(),
    path: z.string(),
    version: z.uuid(),
    observed: z.strictObject({ startedAt: z.iso.datetime(), endedAt: z.iso.datetime() }),
    policyExcluded: z.int().nonnegative().optional(),
    columns: z.array(z.string()),
    rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
    truncated: z.boolean(),
  }),
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  defaultErrorCode: ErrorCode.IO_ERROR,
  accessPaths: (args) => [args.path],
  run: async ({ path, ...input }, ctx) => {
    const scope = await ctx.fs.pathGuard.validateExistingDirectory(path, ctx.signal);
    return { structured: await catalog(ctx).query(ctx.fs, scope, input, ctx.signal) };
  },
});
