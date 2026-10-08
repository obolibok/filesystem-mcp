import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { pageQueryKey } from '../src/core/cursor.js';
import { PageSnapshotStore } from '../src/core/page-store.js';
import { MAX_SEARCH_RESULTS } from '../src/core/util.js';
import { createServer } from '../src/server.js';
import type { JobStatusValue } from '../src/tools/job-shared.js';
import {
  cleanupTestRoot,
  createTestClientPair,
  createTestRoot,
  firstTextBlock,
  writeTestFile,
} from './helpers.js';

it('cached find_files pages expose scan incompleteness before paths without resuming the scan', async () => {
  const root = await createTestRoot();
  const pageStore = new PageSnapshotStore();
  const server = await createServer({ cliAllowedDirs: [root] }, { pageStore });
  const client = new Client({ name: 'search-warning-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.mcp.connect(serverTransport)]);
  try {
    const path = await server.pathGuard.resolvePathOrRoot(root);
    const args = {
      path,
      pattern: '**/*.txt',
      includeHidden: false,
      includeIgnored: true,
      maxDepth: 5,
      sortBy: 'path',
    };
    const queryKey = pageQueryKey({
      method: 'find_files',
      path,
      pattern: args.pattern,
      includeIgnored: args.includeIgnored,
      includeHidden: args.includeHidden,
      sortBy: args.sortBy,
      maxDepth: args.maxDepth,
    });
    for (const stoppedReason of ['maxResults', 'timeout', undefined] as const) {
      // Replay the existing page-store seam: no 10,000-file disk fixture or timing race.
      // offset=0 exercises the first-row renderer; these are cached scan results,
      // so resourceUri is intentionally absent, just as on every continuation.
      const count = stoppedReason === 'maxResults' ? MAX_SEARCH_RESULTS : 2;
      const items = Array.from({ length: count }, (_, i) => ({
        path: `nested/file-${String(i)}.txt`,
      }));
      const metadata = {
        root: path,
        totalMatches: count,
        filesScanned: count + 1,
        skippedInaccessible: 1,
        ...(stoppedReason ? { stoppedReason } : {}),
      };
      const snapshotId = pageStore.create({ queryKey, items, metadata });
      const cursor = Buffer.from(JSON.stringify({ snapshotId, offset: 0 })).toString('base64url');
      const first = await client.callTool({
        name: 'find_files',
        arguments: { ...args, cursor, maxResults: 1 },
      });
      assert.notEqual(first.isError, true, firstTextBlock(first).text);
      const firstMeta = first._meta as typeof metadata & {
        results: typeof items;
        nextCursor?: string;
        resourceUri?: string;
      };
      assert.equal(first.structuredContent, undefined);
      assert.equal(firstMeta.stoppedReason, stoppedReason);
      assert.equal(firstMeta.filesScanned, count + 1);
      assert.equal(firstMeta.skippedInaccessible, 1);
      assert.equal(firstMeta.root, path);
      assert.equal(firstMeta.resourceUri, undefined);
      assert.deepEqual(firstMeta.results, items.slice(0, 1));
      assert(firstMeta.nextCursor);
      const text = firstTextBlock(first).text ?? '';
      if (stoppedReason) {
        assert(text.startsWith('// scan stopped early:'), text);
        assert(text.indexOf('\n\nnested/file-0.txt') > 0, text);
        assert(
          text.includes(stoppedReason === 'maxResults' ? String(MAX_SEARCH_RESULTS) : 'time limit'),
          text,
        );
      } else {
        assert(text.startsWith('nested/file-0.txt'), text);
        assert(!text.includes('scan stopped early'), text);
      }
      assert(text.includes(firstMeta.nextCursor), 'text must expose the actual next cursor');
      const last = await client.callTool({
        name: 'find_files',
        arguments: { ...args, cursor: firstMeta.nextCursor, maxResults: MAX_SEARCH_RESULTS },
      });
      const lastMeta = last._meta as typeof firstMeta;
      assert.notEqual(last.isError, true);
      assert.deepEqual(lastMeta.results, items.slice(1), 'all collected results survive rendering');
      assert.equal(lastMeta.nextCursor, undefined, 'cursor ends at the collected set');
      assert.equal(lastMeta.resourceUri, undefined);
      assert.equal(lastMeta.totalMatches, count);
      assert.equal(lastMeta.filesScanned, count + 1);
      assert.equal(lastMeta.skippedInaccessible, 1);
      assert.equal(lastMeta.stoppedReason, stoppedReason);
      const lastText = firstTextBlock(last).text ?? '';
      assert.equal(lastText.startsWith('// scan stopped early:'), stoppedReason !== undefined);
      assert(
        !lastText.includes('Next page:'),
        'final collected page must not promise another scan',
      );
    }
  } finally {
    await client.close();
    server.disposeRuntimeState();
    await server.mcp.close();
    await cleanupTestRoot(root);
  }
});

it('job_status keeps visible JSON, exact snapshot counters and completeness for read-only sources', async () => {
  const root = await createTestRoot();
  const scratch = await createTestRoot();
  const previousScratch = process.env['FS_SNAPSHOT_DIR'];
  process.env['FS_SNAPSHOT_DIR'] = scratch;
  const pair = await createTestClientPair([root], { readOnly: true });
  try {
    await writeTestFile(root, 'allowed.txt', 'one');
    await writeTestFile(root, 'nested/other.txt', 'two');
    await writeFile(join(root, '.env'), 'SYNTHETIC=fixture');
    await mkdir(join(root, 'empty'));
    const { tools } = await pair.client.listTools();
    assert.equal(tools.length, 13);
    for (const name of ['snapshot', 'bundle', 'cancel_job']) {
      assert.equal(tools.find((t) => t.name === name)?.annotations?.readOnlyHint, false);
    }
    for (const includeHidden of [false, true]) {
      const submitted = await pair.client.callTool({
        name: 'snapshot',
        arguments: { path: root, includeHidden },
      });
      assert.notEqual(submitted.isError, true);
      const submission = submitted._meta as { job: JobStatusValue };
      const jobId = submission.job.jobId;
      const deadline = Date.now() + 10_000;
      let status;
      for (;;) {
        status = await pair.client.callTool({ name: 'job_status', arguments: { jobId } });
        const job = status.structuredContent as JobStatusValue;
        assert(job, 'job_status JSON must remain in structuredContent');
        assert.equal(status._meta, undefined);
        assert.deepEqual(JSON.parse(firstTextBlock(status).text ?? ''), job);
        if (['completed', 'failed', 'cancelled', 'interrupted'].includes(job.state)) break;
        assert(Date.now() < deadline, 'snapshot did not finish');
        await delay(10);
      }
      const job = status.structuredContent as JobStatusValue;
      assert.equal(job.state, 'completed');
      assert.equal(job.complete, !includeHidden);
      assert('filesWritten' in job.counters);
      assert.equal(job.counters.filesWritten, 2);
      assert.equal(job.counters.entriesSeen, 5);
      assert.equal(job.counters.directoriesVisited, 3);
      assert.equal(job.counters.inaccessibleSkipped, includeHidden ? 1 : 0);
      assert.equal(job.counters.hiddenExcluded, includeHidden ? 0 : 1);
      assert.equal(job.errors.length, includeHidden ? 1 : 0);
      assert(job.startedAt && job.finishedAt);
      assert(job.manifestArtifactId);
      const manifestResult = await pair.client.callTool({
        name: 'get_artifact',
        arguments: { artifactId: job.manifestArtifactId },
      });
      const embedded = manifestResult.content.find((block) => block.type === 'resource');
      assert(embedded?.type === 'resource' && 'blob' in embedded.resource);
      const manifest = JSON.parse(
        Buffer.from(embedded.resource.blob, 'base64').toString('utf8'),
      ) as {
        complete: boolean;
        counters: JobStatusValue['counters'];
        policy: { includeHidden: boolean };
      };
      assert.equal(manifest.complete, job.complete);
      assert.deepEqual(manifest.counters, job.counters);
      assert.equal(manifest.policy.includeHidden, includeHidden);
      if (!includeHidden) {
        const reused = await pair.client.callTool({
          name: 'snapshot',
          arguments: { path: root, includeHidden },
        });
        const reuse = reused._meta as { reason: string; job: JobStatusValue };
        assert.equal(reuse.reason, 'completed_reuse');
        assert.deepEqual(reuse.job, job, 'reuse preserves the earlier observation and counters');
      }
    }
  } finally {
    await pair.close();
    if (previousScratch === undefined) Reflect.deleteProperty(process.env, 'FS_SNAPSHOT_DIR');
    else process.env['FS_SNAPSHOT_DIR'] = previousScratch;
    await cleanupTestRoot(root);
    await cleanupTestRoot(scratch);
  }
});
