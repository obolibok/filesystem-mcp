import { ErrorCode } from '../core/errors.js';
import { defineTool, type ToolCtx } from './define.js';
import { JobIdInputSchema, JobStatusOutputSchema, jobStatusValue } from './job-shared.js';

export const JOB_STATUS = defineTool({
  name: 'job_status',
  title: 'Get Job Status',
  description:
    'Get snapshot/bundle progress, counters, errors, expiry and artifact IDs. queued/running counters are provisional; ' +
    'completed may have complete=false and does not mean full-disk coverage. ' +
    'Snapshot filesWritten counts indexed file records, not original bytes; never add inaccessibleSkipped as files. ' +
    'Report scope/exclusions and observation time; reuse is not current source state. get_artifact delivers index/originals.',
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
