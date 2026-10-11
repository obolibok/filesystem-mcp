import assert from 'node:assert/strict';
import { mkdir, rename, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { fixtures, gc, LIMITS, memory, metadata, MIB, query } from './common.mjs';

const config = JSON.parse(process.argv[2]);
const cold = memory();
const { PageSnapshotStore } = await import('../../dist/core/page-store.js');
const { ResourceStore } = await import('../../dist/core/store.js');
const { paginate } = await import('../../dist/core/cursor.js');
const { createServer } = await import('../../dist/server.js');
const { InMemoryTransport, Client } = await import('@modelcontextprotocol/client');
const { startHttpServer } = await import('../../dist/transport/http.js');
const { ArtifactJobManager } = await import('../../dist/core/job-manager.js');

const report = {
  config: { ...config, scratch: undefined },
  cold,
  checkpoints: [],
  assertions: [],
  sampledPeak: memory(),
};
const peak = () => {
  const value = memory();
  for (const key of Object.keys(value))
    report.sampledPeak[key] = Math.max(report.sampledPeak[key], value[key]);
  process.send?.({ type: 'memory', value });
};
const timer = setInterval(peak, 20);
timer.unref();

// Read-only inspection of TS-private Maps in the diagnostic process. Assert the
// layout explicitly so a future implementation change fails visibly. No arrays,
// result objects or text strings are saved in the report.
function inventory(pages, resources) {
  if (pages) assert(pages.byId instanceof Map);
  if (resources) assert(resources.byUri instanceof Map);
  return {
    pageSets: pages?.byId.size ?? 0,
    pageItems: pages
      ? [...pages.byId.values()].reduce((sum, entry) => sum + entry.items.length, 0)
      : 0,
    resources: resources?.byUri.size ?? 0,
    resourceBytes: resources?._totalBytes ?? 0,
  };
}

async function checkpoint(label, pages, resources, details = {}) {
  peak();
  const natural = memory();
  await gc();
  const retained = memory();
  report.checkpoints.push({
    label,
    elapsedMs: Math.round(performance.now()),
    natural,
    retained,
    ...inventory(pages, resources),
    ...details,
  });
  peak();
  return retained.heapUsed < LIMITS.softHeapMiB * MIB && retained.rss < LIMITS.rssMiB * MIB;
}

function payloadBytes(pages) {
  // Measurement only, outside operation peak sampling. One item at a time avoids
  // a second complete serialized copy; compact JSON bytes are NOT heap bytes.
  let bytes = 0;
  for (const entry of pages.byId.values()) {
    bytes += 2 + Math.max(0, entry.items.length - 1);
    for (const item of entry.items) bytes += Buffer.byteLength(JSON.stringify(item));
  }
  return bytes;
}

function note(text) {
  report.assertions.push(text);
}

class DropResources extends ResourceStore {
  putText(params) {
    const entry = super.putText(params);
    this.byUri.clear();
    this._totalBytes = 0;
    return entry;
  }
}

class DropPages extends PageSnapshotStore {
  create(params) {
    const id = super.create(params);
    this.clear();
    return id;
  }
}

async function pair(pages, resources, jobManager, source) {
  const server = await createServer(
    { cliAllowedDirs: [source], readOnly: true },
    { pageStore: pages, resourceStore: resources, jobManager },
  );
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'pagination-study', version: '1' });
  await Promise.all([client.connect(ct), server.mcp.connect(st)]);
  return {
    client,
    async close() {
      await client.close();
      server.disposeRuntimeState();
      await server.mcp.close();
    },
  };
}

async function fresh(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert(!result.isError, JSON.stringify(result.content));
  const meta = metadata(result);
  assert(meta?.nextCursor, 'fixture must span multiple pages');
  return {
    cursor: meta.nextCursor,
    uri: meta.resourceUri,
    count: meta.totalEntries ?? meta.totalMatches,
    wireBytes: Buffer.byteLength(JSON.stringify(result)),
  };
}

async function handlerStudy() {
  const { source, description } = await fixtures(config.scratch, config.workload);
  process.env.FS_ROOT_BOUNDARY = source;
  await checkpoint('modules-loaded');
  const pages = config.isolation === 'resource' ? new DropPages() : new PageSnapshotStore();
  let resources = config.isolation === 'page' ? new DropResources() : new ResourceStore();
  const jobs = new ArtifactJobManager();
  await jobs.initialize();
  const peers = [];
  try {
    for (let i = 0; i < 3; i++) peers.push(await pair(pages, resources, jobs, source));
    const listed = await peers[0].client.listTools();
    const schema = listed.tools.find((t) => t.name === config.workload.tool).inputSchema;
    const { args, variant } = query(schema, config.workload, source, config.pageSize);
    report.schema = variant;
    report.fixture = description;
    await checkpoint('ready', pages, resources);
    let first;
    let second;
    const started = performance.now();
    for (let i = 1; i <= (config.sets ?? 33); i++) {
      const handle = await fresh(peers[(i - 1) % peers.length].client, config.workload.tool, args);
      if (i === 1) first = handle;
      if (i === 2) second = handle;
      peak();
      if ([1, 8, 32, 33].includes(i)) {
        const safe = await checkpoint(`sets-${i}`, pages, resources, {
          queries: i,
          collectedPerQuery: handle.count,
          pageSize: config.pageSize,
          firstResponseBytes: first.wireBytes,
          queryMs: Math.round(performance.now() - started),
        });
        if (!safe) {
          report.stoppedAtSafeBudget = i;
          break;
        }
      }
      if (i === 32 && config.isolation !== 'resource') {
        const before = pages.byId.size;
        const replay = await peers[1].client.callTool({
          name: config.workload.tool,
          arguments: { ...args, cursor: first.cursor },
        });
        assert(!replay.isError);
        assert.equal(pages.byId.size, before);
        assert.equal(metadata(replay).resourceUri, undefined);
        note('32 sets: another client replayed first cursor; replay created no snapshot/resource');
      }
    }
    report.pageCompactJsonBytes = payloadBytes(pages);
    await checkpoint('after-byte-estimate', pages, resources);
    if (
      (config.sets ?? 33) === 33 &&
      !report.stoppedAtSafeBudget &&
      config.isolation !== 'resource'
    ) {
      assert.equal(pages.byId.size, 32);
      const stale = await peers[2].client.callTool({
        name: config.workload.tool,
        arguments: { ...args, cursor: second.cursor },
      });
      assert.equal(stale.isError, true);
      assert.match(JSON.stringify(stale.content), /Invalid cursor/);
      const alive = await peers[2].client.callTool({
        name: config.workload.tool,
        arguments: { ...args, cursor: first.cursor },
      });
      assert(!alive.isError);
      note('33rd fresh identical query evicted second LRU snapshot; touched first cursor survived');
    }
    // Demonstrate transport/consumer copies separately while stores are intact.
    if (config.isolation === 'both' && resources.byUri.size > 0) {
      await checkpoint('before-client-copy', pages, resources);
      await (async () => {
        const entry = resources.byUri.values().next().value;
        const serializedEnvelope = JSON.stringify({
          contents: [{ uri: entry.uri, text: entry.text }],
        });
        const decodedEnvelope = JSON.parse(serializedEnvelope);
        const decodedPayload = JSON.parse(decodedEnvelope.contents[0].text);
        assert(decodedPayload.entries || decodedPayload.matches);
        await checkpoint('client-copy-held', pages, resources, {
          envelopeBytes: Buffer.byteLength(serializedEnvelope),
        });
        // Keep references live across the measured await.
        assert(decodedPayload.entries || decodedPayload.matches);
        assert(serializedEnvelope.length > 0);
      })();
      await checkpoint('client-copy-released', pages, resources);
    }
    if (config.isolation !== 'resource' && !report.stoppedAtSafeBudget) {
      // After memory samples, replace the synthetic source with an empty
      // directory at the SAME path. A rescan cannot produce the cached rows.
      const parked = join(config.scratch, 'parked-source');
      await rename(source, parked);
      try {
        await mkdir(source);
        const cached = await peers[2].client.callTool({
          name: config.workload.tool,
          arguments: { ...args, cursor: first.cursor },
        });
        assert(!cached.isError);
        assert.equal(metadata(cached).totalEntries ?? metadata(cached).totalMatches, first.count);
        assert((metadata(cached).entries ?? metadata(cached).matches).length > 0);
        note(
          'real handler cursor returned old rows after source became empty at same path: no rescan',
        );
      } finally {
        await rmdir(source);
        await rename(parked, source);
      }
    }
    pages.clear();
    await checkpoint('page-clear', pages, resources);
  } finally {
    for (const peer of peers) await peer.close();
    peers.length = 0;
    await jobs.close();
  }
  resources = undefined;
  await checkpoint('teardown', pages);
}

function syntheticItems(workload, set) {
  const count = workload.matches;
  return Array.from({ length: count }, (_, i) => {
    // Flat, unique strings: ropes or shared padding would understate this
    // deliberately independent synthetic store load.
    const text = (prefix) =>
      Buffer.from(`${prefix}-${set}-${i}:`.padEnd(workload.width, 'x')).toString();
    if (workload.tool === 'list')
      return { name: text('name'), relativePath: text('path'), type: 'file' };
    return {
      file: 'synthetic.txt',
      line: i * 21 + 11,
      column: 0,
      content: text('study-token'),
      matchCount: 1,
      ...(workload.context
        ? {
            before: Array.from({ length: 10 }, (_, j) => text(`before-${j}`)),
            after: Array.from({ length: 10 }, (_, j) => text(`after-${j}`)),
          }
        : {}),
    };
  });
}

async function storeStudy() {
  await checkpoint('modules-loaded');
  const pages = new PageSnapshotStore();
  let resources = new ResourceStore();
  await checkpoint('ready', pages, resources);
  let first;
  let second;
  for (let i = 1; i <= (config.sets ?? 33); i++) {
    await (async () => {
      const items = syntheticItems(config.workload, i);
      if (config.isolation !== 'resource') {
        const id = pages.create({ queryKey: 'synthetic', items });
        if (i === 1) first = id;
        if (i === 2) second = id;
      }
      if (config.isolation !== 'page')
        resources.putText({ name: `set-${i}`, text: JSON.stringify(items, null, 2) });
      peak();
    })();
    if ([1, 8, 32, 33].includes(i) || memory().heapUsed > LIMITS.softHeapMiB * MIB) {
      if (!(await checkpoint(`sets-${i}`, pages, resources, { queries: i }))) {
        report.stoppedAtSafeBudget = i;
        break;
      }
    }
    if (i === 32 && first) pages.read(first, 'synthetic');
  }
  if (!report.stoppedAtSafeBudget && (config.sets ?? 33) === 33 && first) {
    assert.throws(() => pages.read(second, 'synthetic'), /Invalid cursor/);
    pages.read(first, 'synthetic');
    note('direct PageSnapshotStore count/LRU eviction confirmed at 33');
  }
  report.pageCompactJsonBytes = payloadBytes(pages);
  await checkpoint('after-byte-estimate', pages, resources);
  pages.clear();
  await checkpoint('page-clear', pages, resources);
  resources = undefined;
  await checkpoint('resource-owner-dropped', pages);
}

async function lifecycle() {
  let now = 0;
  const pages = new PageSnapshotStore({ now: () => now });
  const one = pages.create({ queryKey: 'q', items: ['a', 'b'] });
  now = 59999;
  pages.read(one, 'q');
  now = 60000;
  assert.equal(pages.byId.size, 1);
  assert.throws(() => pages.read(one, 'q'), /Invalid cursor/);
  assert.equal(pages.byId.size, 0);
  note(
    'fake clock PageSnapshotStore: read at 59999 did not renew TTL; exact 60000 rejected and pruned',
  );
  const two = pages.create({ queryKey: 'q', items: ['a', 'b'] });
  now = 120000;
  pages.create({ queryKey: 'q', items: ['new'] });
  assert.throws(() => pages.read(two, 'q'), /Invalid cursor/);
  note('fake clock create pruned expired pages');
  pages.clear();
  let produced = 0;
  const options = {
    store: pages,
    queryKey: 'q',
    pageSize: 1,
    cursor: undefined,
    produce: async () => {
      produced++;
      return { items: ['a', 'b', 'c'], metadata: {}, truncated: false };
    },
  };
  const first = await paginate(options);
  await paginate({ ...options, cursor: first.nextCursor });
  assert.equal(produced, 1);
  await paginate(options);
  assert.equal(produced, 2);
  const complete = await paginate({ ...options, pageSize: 3 });
  assert.equal(complete.nextCursor, undefined);
  assert.equal(pages.byId.size, 2);
  note(
    'paginate: cursor did not call produce; fresh identical query did; complete single page added no snapshot',
  );
  // ResourceStore does not have a clock injection. Pin both Date.now and new
  // Date() only for this synchronous diagnostic case, restoring immediately.
  const OriginalDate = Date;
  class FakeDate extends OriginalDate {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() {
      return now;
    }
  }
  globalThis.Date = FakeDate;
  try {
    const resources = new ResourceStore();
    now = 0;
    const uri = resources.putText({ name: 'ttl', text: 'one' }).uri;
    now = 59999;
    resources.getEntry(uri);
    now = 60000;
    assert.equal(resources.byUri.size, 1);
    assert.throws(() => resources.getEntry(uri), /Resource expired/);
    assert.equal(resources.byUri.size, 0);
    const uris = [];
    now = 0;
    for (let i = 0; i < 65; i++) uris.push(resources.putText({ name: 'count', text: 'x' }).uri);
    assert.equal(resources.byUri.size, 64);
    assert.throws(() => resources.getEntry(uris[0]), /Resource not found/);
    now = 60000;
    assert.equal(resources.byUri.size, 64);
    resources.putText({ name: 'new', text: 'new' });
    assert.equal(resources.byUri.size, 1);
    now = 120000;
    assert.deepEqual(resources.keys(), []);
    const large = 'z'.repeat(1024 * 1024);
    now = 0;
    const a = resources.putText({ name: 'byte', text: large }).uri;
    for (let i = 0; i < 25; i++) resources.putText({ name: 'byte', text: large });
    assert.equal(resources._totalBytes, 25 * MIB);
    assert.throws(() => resources.getEntry(a), /Resource not found/);
    assert.throws(
      () => resources.putText({ name: 'too-large', text: 'z'.repeat(10 * MIB + 1) }),
      /Resource too large/,
    );
    note(
      'fake Date ResourceStore: fixed TTL, expired/not-found errors, put/list cleanup, 64/65 count and 25 MiB quota, 10 MiB entry rejection',
    );
    // Quota counts logical serialized bytes even if identical strings share
    // one physical V8 allocation; this case asserts behavior, NOT memory.
  } finally {
    globalThis.Date = OriginalDate;
  }
  await checkpoint('lifecycle-complete');
}

async function httpStudy() {
  const { source, description } = await fixtures(config.scratch, config.workload);
  process.env.FS_ROOT_BOUNDARY = source;
  report.fixture = description;
  await checkpoint('modules-loaded');
  let pages;
  let resources;
  const originalCreate = PageSnapshotStore.prototype.create;
  const originalPut = ResourceStore.prototype.putText;
  PageSnapshotStore.prototype.create = function (params) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- diagnostic observer of the actual endpoint-owned instance
    pages = this;
    return originalCreate.call(this, params);
  };
  ResourceStore.prototype.putText = function (params) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- diagnostic observer of the actual endpoint-owned instance
    resources = this;
    return originalPut.call(this, params);
  };
  // Only observe real stores constructed by unmodified startHttpServer. No
  // substitution or external cleanup happens before endpoint teardown.
  let server = await startHttpServer(
    0,
    { cliAllowedDirs: [source], readOnly: true },
    { httpHost: '127.0.0.1' },
  );
  await checkpoint('ready', pages, resources);
  process.send({ type: 'ready', port: server.address().port, source });
  await new Promise((resolve, reject) => {
    let queue = Promise.resolve();
    process.on('message', (message) => {
      queue = queue
        .then(async () => {
          if (message.type === 'checkpoint') {
            await checkpoint(message.label, pages, resources, message.details ?? {});
            process.send({ type: 'ack', id: message.id, inventory: inventory(pages, resources) });
          } else if (message.type === 'finish') {
            report.assertions.push(...message.assertions);
            report.schema = message.schema;
            report.pageCompactJsonBytes = payloadBytes(pages);
            await new Promise((done, fail) =>
              server.close((error) => (error ? fail(error) : done())),
            );
            assert.equal(pages.byId.size, 0);
            await checkpoint('http-close-pages-cleared-resource-observer-held', pages, resources);
            server = undefined;
            pages = undefined;
            resources = undefined;
            await checkpoint('http-observers-dropped');
            resolve();
          }
        })
        .catch(reject);
    });
  });
  PageSnapshotStore.prototype.create = originalCreate;
  ResourceStore.prototype.putText = originalPut;
}

try {
  if (config.kind === 'handler') await handlerStudy();
  else if (config.kind === 'store') await storeStudy();
  else if (config.kind === 'lifecycle') await lifecycle();
  else if (config.kind === 'http') await httpStudy();
  else throw new Error('unknown worker kind');
  // Complete the async scenario before measuring owner release: coroutine
  // locals/closed SDK transports can still be live at an in-scope teardown.
  await checkpoint('worker-scope-released');
  clearInterval(timer);
  report.maxRssBytes = process.resourceUsage().maxRSS * 1024;
  process.send({ type: 'result', report });
  process.disconnect();
} catch (error) {
  clearInterval(timer);
  process.send?.({ type: 'failure', error: error.stack });
  process.exitCode = 1;
  process.disconnect?.();
}
