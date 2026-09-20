import { ErrorCode } from '../core/errors.js';
import { defineTool, type ToolCtx } from './define.js';
import { JobIdInputSchema, JobStatusOutputSchema, jobStatusValue } from './job-shared.js';

export const CANCEL_JOB = defineTool({
  name: 'cancel_job',
  title: 'Cancel Job',
  description:
    'Idempotently cancel a queued or running background job and discard incomplete artifacts. Completed and other terminal jobs are returned unchanged.',
  input: JobIdInputSchema,
  output: JobStatusOutputSchema,
  annotations: {
    readOnlyHint: false,
    idempotentHint: true,
    destructiveHint: true,
    openWorldHint: false,
  },
  sourceMutating: false,
  defaultErrorCode: ErrorCode.NOT_FOUND,
  run: async (args, ctx: ToolCtx) => ({
    structured: jobStatusValue(await ctx.jobManager.cancel(args.jobId, ctx.fs.pathGuard)),
  }),
});
