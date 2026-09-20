import { ErrorCode } from '../core/errors.js';
import { defineTool, type ToolCtx } from './define.js';
import { JobIdInputSchema, JobStatusOutputSchema, jobStatusValue } from './job-shared.js';

export const JOB_STATUS = defineTool({
  name: 'job_status',
  title: 'Get Job Status',
  description:
    'Return bounded status, exact counters, error samples, expiry, and artifact IDs for one durable background job. It never returns the inventory itself.',
  input: JobIdInputSchema,
  output: JobStatusOutputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  defaultErrorCode: ErrorCode.NOT_FOUND,
  run: async (args, ctx: ToolCtx) => ({
    structured: jobStatusValue(await ctx.jobManager.getJob(args.jobId, ctx.fs.pathGuard)),
  }),
});
