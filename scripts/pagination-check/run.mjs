import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { release } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  childEnvironment,
  LIMITS,
  memory,
  metadata,
  MIB,
  outputPath,
  query,
  scratchRoot,
} from './common.mjs';

const repo = await realpath(resolve(import.meta.dirname, '../..'));
const mode = process.argv[2] ?? 'smoke';
assert(
  ['smoke', 'study', 'default-pages', 'ttl', 'post-011'].includes(mode),
  'usage: node scripts/pagination-check/run.mjs smoke|study|default-pages|ttl|post-011 [--output .tmp/name.json]',
);
const flag = process.argv.indexOf('--output');
const requested = flag === -1 ? `.tmp/pagination-012-${mode}.json` : process.argv[flag + 1];
const scratch = await scratchRoot(repo);
const output = await outputPath(repo, requested);
const git = (...args) =>
  execFileSync('git', ['-c', `safe.directory=${repo.replaceAll('\\', '/')}`, ...args], {
    cwd: repo,
    encoding: 'utf8',
  }).trim();
const result = {
  complete: false,
  mode,
  date: new Date().toISOString(),
  sourceCommit: git('rev-parse', 'HEAD'),
  sourceDirty: git('status', '--porcelain', '--', 'src', 'package.json', 'package-lock.json'),
  node: process.version,
  platform: process.platform,
  osRelease: release(),
  limits: LIMITS,
  workers: [],
};
const harnessHash = createHash('sha256');
for (const name of ['common.mjs', 'worker.mjs', 'run.mjs'])
  harnessHash.update(await readFile(join(import.meta.dirname, name)));
result.harnessSha256 = harnessHash.digest('hex');
const save = () => writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
assert.equal(result.sourceDirty, '', 'rebuild/measure only an unchanged runtime source');

async function httpController(child, ready, config, command) {
  // Clients run in the parent. Every memory checkpoint sent by the HTTP child
  // therefore excludes SDK/JSON copies belonging to these clients.
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const clients = [];
  const assertions = [];
  const clientBaseline = memory();
  try {
    for (let i = 0; i < 3; i++) {
      const client = new Client({ name: `pagination-http-${i}`, version: '1' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${ready.port}/mcp`)),
      );
      clients.push(client);
    }
    const tools = await clients[0].listTools();
    const schema = tools.tools.find((t) => t.name === config.workload.tool).inputSchema;
    const { args, variant } = query(schema, config.workload, ready.source, config.pageSize);
    const fresh = async (i) => {
      const response = await clients[i % 3].callTool({
        name: config.workload.tool,
        arguments: args,
      });
      assert(!response.isError, JSON.stringify(response.content));
      const meta = metadata(response);
      assert(meta?.nextCursor && meta.resourceUri);
      return {
        cursor: meta.nextCursor,
        uri: meta.resourceUri,
        rows: meta.totalEntries ?? meta.totalMatches,
      };
    };
    const replay = (i, handle) =>
      clients[i % 3].callTool({
        name: config.workload.tool,
        arguments: { ...args, cursor: handle.cursor },
      });
    const first = await fresh(0);
    const second = await fresh(1);
    const began = Date.now();
    await command('checkpoint', {
      label: 'http-sets-2',
      details: { clients: 3, collectedPerQuery: first.rows },
    });
    if (config.realTtl) {
      const waitUntil = async (elapsed) => {
        while (Date.now() - began < elapsed)
          await delay(Math.min(1000, elapsed - (Date.now() - began)));
      };
      await waitUntil(55000);
      assert(!(await replay(2, first)).isError);
      await clients[2].readResource({ uri: first.uri });
      await command('checkpoint', {
        label: 'real-ttl-read-55s',
        details: { sinceCreationLowerBoundMs: Date.now() - began },
      });
      await waitUntil(61000);
      const idle = await command('checkpoint', {
        label: 'real-ttl-idle-61s',
        details: { sinceCreationLowerBoundMs: Date.now() - began },
      });
      assert.equal(idle.inventory.pageSets, 2);
      assert.equal(idle.inventory.resources, 2);
      const expired = await replay(0, first);
      assert.equal(expired.isError, true);
      assert.match(JSON.stringify(expired.content), /Invalid cursor/);
      await assert.rejects(
        () => clients[0].readResource({ uri: first.uri }),
        /Cached result not found or expired/,
      );
      const afterRead = await command('checkpoint', { label: 'real-ttl-expired-read' });
      assert.equal(afterRead.inventory.pageSets, 0);
      assert.equal(afterRead.inventory.resources, 1);
      await clients[0].listResources();
      const afterList = await command('checkpoint', { label: 'real-ttl-resource-list-prune' });
      assert.equal(afterList.inventory.resources, 0);
      await fresh(0);
      await command('checkpoint', { label: 'real-ttl-fresh-recovery' });
      assertions.push(
        'real wall-clock 61s: both stores retained expired entries while idle; 55s reads did not renew; cursor read pruned all pages, resource read only one URI, list pruned remaining resource; fresh query recovered',
      );
    } else {
      // Repeated identical queries from three clients create endpoint-wide sets.
      for (let i = 3; i <= 32; i++) {
        await fresh(i);
        if (i === 8) await command('checkpoint', { label: 'http-sets-8' });
      }
      const alive = await replay(2, first);
      assert(!alive.isError);
      assert.equal(metadata(alive).resourceUri, undefined);
      const before = await command('checkpoint', { label: 'http-sets-32-first-touched' });
      assert.equal(before.inventory.pageSets, 32);
      await fresh(0);
      const stale = await replay(2, second);
      assert.equal(stale.isError, true);
      assert.match(JSON.stringify(stale.content), /Invalid cursor/);
      assert(!(await replay(1, first)).isError);
      const after = await command('checkpoint', { label: 'http-sets-33' });
      assert.equal(after.inventory.pageSets, 32);
      if (config.workload.tool === 'list') {
        await clients[2].readResource({ uri: second.uri });
        assertions.push(
          'HTTP: evicted second cursor but its small resource still readable; touched first cursor survived; three clients share the 32-set capacity',
        );
      } else {
        await assert.rejects(
          () => clients[1].readResource({ uri: first.uri }),
          /Cached result not found or expired/,
        );
        assertions.push(
          'HTTP: first resource evicted by byte quota while first cursor still usable; replay minted no resource; fresh query regenerates both handles',
        );
      }
    }
    await command('checkpoint', { label: 'http-before-close' });
    child.send({ type: 'finish', assertions, schema: variant });
    return {
      baseline: clientBaseline,
      afterRequests: memory(),
      gc: 'parent not exposed/forced; excludes clients from server values',
    };
  } finally {
    for (const client of clients) await client.close();
  }
}

async function run(config) {
  const childScratch = join(scratch.root, `worker-${result.workers.length}`);
  await mkdir(childScratch);
  config = { ...config, scratch: childScratch };
  return new Promise((resolveWorker, rejectWorker) => {
    const child = fork(join(import.meta.dirname, 'worker.mjs'), [JSON.stringify(config)], {
      cwd: repo,
      env: childEnvironment(childScratch),
      execArgv: ['--expose-gc', `--max-old-space-size=${LIMITS.heapMiB}`],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    let report;
    let controller;
    let settled = false;
    let id = 0;
    const pending = new Map();
    const timeout = setTimeout(
      () => fail(new Error(`worker timeout: ${config.name}`)),
      LIMITS.timeoutMs,
    );
    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      for (const entry of pending.values()) entry.reject(error);
      rejectWorker(error);
    }
    function command(type, extra) {
      return new Promise((resolveCommand, rejectCommand) => {
        const requestId = ++id;
        pending.set(requestId, { resolve: resolveCommand, reject: rejectCommand });
        child.send({ type, id: requestId, ...extra });
      });
    }
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-12000);
    });
    child.on('error', fail);
    child.on('message', (message) => {
      if (message.type === 'failure') fail(new Error(message.error));
      if (message.type === 'memory' && message.value.rss > LIMITS.rssMiB * MIB)
        fail(new Error(`RSS safety ceiling reached: ${config.name}; no OOM claim`));
      if (message.type === 'ack') {
        pending.get(message.id)?.resolve(message);
        pending.delete(message.id);
      }
      if (message.type === 'ready') {
        controller = httpController(child, message, config, command);
        controller.catch(fail);
      }
      if (message.type === 'result') report = message.report;
    });
    child.on('exit', async (code, signal) => {
      if (settled) return;
      clearTimeout(timeout);
      if (code !== 0 || !report) {
        fail(new Error(`worker ${config.name} exited ${code}/${signal}: ${stderr}`));
        return;
      }
      if (controller) report.clientProcess = await controller;
      settled = true;
      result.workers.push(report);
      await save();
      console.log(
        `${config.name}: PASS${report.stoppedAtSafeBudget ? ` (safe budget stop at ${report.stoppedAtSafeBudget} sets)` : ''}`,
      );
      resolveWorker();
    });
  });
}

try {
  if (mode === 'smoke') {
    await run({ kind: 'lifecycle', name: 'fake-clock-and-contracts' });
    await run({
      kind: 'handler',
      name: 'smoke-search-context',
      workload: { tool: 'search_text', long: true, context: 10, matches: 24 },
      pageSize: 1,
      sets: 8,
      isolation: 'both',
    });
    await run({
      kind: 'http',
      name: 'smoke-real-http-list-33',
      workload: { tool: 'list', matches: 40 },
      pageSize: 1,
    });
  } else if (mode === 'default-pages') {
    for (const long of [false, true]) {
      for (let repeat = 1; repeat <= (long ? 3 : 1); repeat++)
        await run({
          kind: 'handler',
          name: `list-${long ? 'long' : 'short'}-default-p1000-r${repeat}`,
          workload: { tool: 'list', long },
          pageSize: 1000,
          sets: 33,
          isolation: 'both',
        });
    }
  } else if (mode === 'ttl') {
    await run({
      kind: 'http',
      name: 'real-http-ttl-61s',
      workload: { tool: 'search_text', long: true, context: 10 },
      pageSize: 1,
      realTtl: true,
    });
  } else if (mode === 'post-011') {
    for (const pageSize of [1, 100])
      await run({
        kind: 'handler',
        name: `post-011-long-context-p${pageSize}`,
        workload: { tool: 'search_text', long: true, context: 10 },
        pageSize,
        sets: 33,
        isolation: 'both',
      });
    await run({
      kind: 'http',
      name: 'post-011-http-list-33',
      workload: { tool: 'list' },
      pageSize: 100,
    });
    await run({
      kind: 'http',
      name: 'post-011-http-search-resource-eviction',
      workload: { tool: 'search_text', long: true, context: 10 },
      pageSize: 100,
    });
  } else {
    await run({ kind: 'lifecycle', name: 'fake-clock-and-contracts' });
    const workloads = [
      { tool: 'list', long: false },
      { tool: 'list', long: true },
      { tool: 'search_text', long: false, context: 0 },
      { tool: 'search_text', long: false, context: 10 },
      { tool: 'search_text', long: true, context: 0 },
      { tool: 'search_text', long: true, context: 10 },
    ];
    for (const workload of workloads) {
      for (const pageSize of [1, 100]) {
        const repeats =
          workload.long && (workload.tool === 'list' || workload.context === 10) ? 3 : 1;
        for (let repeat = 1; repeat <= repeats; repeat++)
          await run({
            kind: 'handler',
            name: `${workload.tool}-${workload.long ? 'long' : 'short'}-c${workload.context ?? 0}-p${pageSize}-r${repeat}`,
            workload,
            pageSize,
            sets: 33,
            isolation: 'both',
          });
      }
    }
    await run({
      kind: 'handler',
      name: 'regex-short-context-10',
      workload: { tool: 'search_text', regex: true, context: 10, matches: 128 },
      pageSize: 1,
      sets: 8,
      isolation: 'both',
    });
    for (const isolation of ['page', 'resource'])
      for (let repeat = 1; repeat <= 3; repeat++)
        await run({
          kind: 'handler',
          name: `isolate-${isolation}-long-context-r${repeat}`,
          workload: { tool: 'search_text', long: true, context: 10 },
          pageSize: 1,
          sets: 33,
          isolation,
        });
    for (const workload of [
      { tool: 'list', matches: 20000, width: 128 },
      { tool: 'search_text', matches: 10000, width: 64, context: 0 },
      { tool: 'search_text', matches: 10000, width: 256, context: 10 },
    ])
      await run({
        kind: 'store',
        name: `direct-cap-${workload.tool}-c${workload.context ?? 0}`,
        workload,
        isolation: 'page',
        sets: 33,
      });
    await run({
      kind: 'store',
      name: 'direct-resource-byte-quota',
      workload: { tool: 'search_text', matches: 2000, width: 512, context: 0 },
      isolation: 'resource',
      sets: 33,
    });
    await run({
      kind: 'http',
      name: 'real-http-list-33',
      workload: { tool: 'list' },
      pageSize: 100,
    });
    await run({
      kind: 'http',
      name: 'real-http-search-resource-eviction',
      workload: { tool: 'search_text', long: true, context: 10 },
      pageSize: 100,
    });
  }
  result.complete = true;
  await save();
  console.log(
    `Report: ${requested}; ${result.workers.length} bounded workers; own fixtures cleaned`,
  );
} finally {
  await scratch.cleanup();
}
