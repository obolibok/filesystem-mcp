import type { ContentBlock } from '@modelcontextprotocol/server';

import * as z from 'zod/v4';

import { ErrorCode } from '../core/errors.js';
import { NonNegInt, Sha256Hex } from '../core/schema.js';
import { defineTool, type ToolCtx } from './define.js';

const GetArtifactInputSchema = z.strictObject({
  artifactId: z
    .uuid()
    .describe('Opaque artifact ID from job_status or the snapshot manifest; pass unchanged.'),
});

const GetArtifactOutputSchema = z.strictObject({
  artifactId: z.string(),
  jobId: z.string(),
  name: z.string(),
  kind: z.enum(['manifest', 'snapshot-part']),
  size: NonNegInt,
  encodedSize: NonNegInt,
  sha256: Sha256Hex,
  mimeType: z.string(),
  resourceUri: z.string(),
  delivery: z.literal('mcp-embedded-resource'),
});

export const GET_ARTIFACT = defineTool({
  name: 'get_artifact',
  title: 'Get Snapshot Artifact',
  description:
    'Return one immutable ready manifest or ZIP part by opaque artifact ID as a standard MCP embedded resource plus matching resource link. Current source-root access and separate delivery limits are rechecked on every call.',
  input: GetArtifactInputSchema,
  output: GetArtifactOutputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  defaultErrorCode: ErrorCode.NOT_FOUND,
  run: async (args, ctx: ToolCtx) => {
    const payload = await ctx.jobManager.getArtifact(args.artifactId, ctx.fs.pathGuard);
    const blob = payload.bytes.toString('base64');
    const uri = `filesystem-mcp://artifact/${payload.artifact.artifactId}`;
    const resources: ContentBlock[] = [
      {
        type: 'resource',
        resource: { uri, mimeType: payload.artifact.mimeType, blob },
        annotations: { audience: ['user', 'assistant'] },
      },
      {
        type: 'resource_link',
        uri,
        name: payload.artifact.name,
        mimeType: payload.artifact.mimeType,
        size: payload.artifact.size,
        annotations: { audience: ['user', 'assistant'] },
      },
    ];
    const value = {
      artifactId: payload.artifact.artifactId,
      jobId: payload.job.jobId,
      name: payload.artifact.name,
      kind: payload.artifact.kind,
      size: payload.artifact.size,
      encodedSize: blob.length,
      sha256: payload.artifact.sha256,
      mimeType: payload.artifact.mimeType,
      resourceUri: uri,
      delivery: 'mcp-embedded-resource' as const,
    };
    return {
      structured: value,
      text: `Attached immutable ${payload.artifact.kind} "${payload.artifact.name}" (${String(payload.artifact.size)} bytes, SHA-256 ${payload.artifact.sha256}).`,
      resources,
    };
  },
});
