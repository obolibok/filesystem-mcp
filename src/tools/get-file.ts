import type { ContentBlock } from '@modelcontextprotocol/server';

import { basename } from 'node:path';

import * as z from 'zod/v4';

import { ErrorCode } from '../core/errors.js';
import { buildFileResourceLinkFor, buildFileResourceUri } from '../core/file-uri.js';
import type { GuardedFileSystem } from '../core/fs.js';
import { NonNegInt, RequiredPath } from '../core/schema.js';
import type { ToolCtx } from './define.js';
import { defineTool } from './define.js';

const GetFileInputSchema = z.strictObject({ path: RequiredPath });

const GetFileOutputSchema = z.strictObject({
  name: z.string(),
  size: NonNegInt.describe('Original file size in bytes'),
  encodedSize: NonNegInt.describe(
    'Base64 character count carried by the MCP embedded resource; not the original file size',
  ),
  mimeType: z.string(),
  resourceUri: z.string().describe('URI shared by the embedded resource and resource link'),
  delivery: z.literal('mcp-embedded-resource'),
});

type GetFileValue = z.infer<typeof GetFileOutputSchema>;

interface GetFilePayload {
  readonly value: GetFileValue;
  readonly resources: ContentBlock[];
}

/**
 * Read one guarded file and build only standard MCP tool-result content blocks.
 * Kept separate from the definition so cancellation propagation can be tested
 * without inventing a second filesystem path around GuardedFileSystem.
 */
async function readFileForDelivery(
  filePath: string,
  fs: Pick<GuardedFileSystem, 'readRaw'>,
  signal: AbortSignal,
): Promise<GetFilePayload> {
  signal.throwIfAborted();
  const raw = await fs.readRaw(filePath, { signal });
  signal.throwIfAborted();

  const uri = buildFileResourceUri(raw.validPath);
  const name = basename(filePath);
  const blob = raw.content.toString('base64');
  const mimeType = raw.mimeType || 'application/octet-stream';

  return {
    value: {
      name,
      size: raw.content.length,
      encodedSize: blob.length,
      mimeType,
      resourceUri: uri,
      delivery: 'mcp-embedded-resource',
    },
    resources: [
      {
        type: 'resource',
        resource: { uri, mimeType, blob },
        annotations: { audience: ['user', 'assistant'] },
      },
      buildFileResourceLinkFor(uri, name, mimeType, raw.content.length),
    ],
  };
}

export const GET_FILE = defineTool({
  name: 'get_file',
  title: 'Get Original File',
  description:
    'Return one file byte-exact as a standard MCP embedded resource plus a resource link. ' +
    'Use this when the client needs the original ZIP, Office, PDF, media, or other file rather than text extracted by read. ' +
    'The server enforces the configured root, sensitive-path policy, and maximum file size.',
  input: GetFileInputSchema,
  output: GetFileOutputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  defaultErrorCode: ErrorCode.NOT_FILE,
  progress: (args) => ({ label: 'Get file', subject: basename(args.path) }),
  accessPaths: (args) => [args.path],
  run: async (args, ctx: ToolCtx) => {
    const delivered = await readFileForDelivery(args.path, ctx.fs, ctx.signal);
    return {
      structured: delivered.value,
      text: `Attached "${delivered.value.name}" as a byte-exact MCP embedded resource (${String(delivered.value.size)} bytes, ${delivered.value.mimeType}).`,
      resources: delivered.resources,
    };
  },
});
