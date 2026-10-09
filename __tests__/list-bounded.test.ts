import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import type { Dirent } from 'node:fs';
import fsPromises, { mkdir, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename, join, relative } from 'node:path';
import { it, type TestContext } from 'node:test';

import { GuardedFileSystem } from '../src/core/fs.js';
import { ArtifactJobManager } from '../src/core/job-manager.js';
import { walkListEntries } from '../src/core/list-walk.js';
import { PageSnapshotStore } from '../src/core/page-store.js';
import { createServer } from '../src/server.js';
import { LIST } from '../src/tools/list.js';
import {
  cleanupTestRoot,
  createTestClientPair,
  createTestRoot,
  firstTextBlock,
  makeGuard,
  trySymlink,
  writeTestFile,
} from './helpers.js';

interface ListMeta {
  entries: { name: string; relativePath: string; type: string }[];
  entryCount: number;
  totalEntries: number;
  totalFiles: number;
  totalDirectories: number;
  limit: number;
  truncated: boolean;
  stoppedReason?: 'limit';
  resourceUri?: string;
  nextCursor?: string;
}

async function fixture(t: TestContext) {
  const root = await createTestRoot();
  const scratch = await createTestRoot();
  const savedScratch = process.env['FS_SNAPSHOT_DIR'];
  process.env['FS_SNAPSHOT_DIR'] = scratch;
  t.after(async () => {
    if (savedScratch === undefined) Reflect.deleteProperty(process.env, 'FS_SNAPSHOT_DIR');
    else process.env['FS_SNAPSHOT_DIR'] = savedScratch;
    await cleanupTestRoot(root);
    await cleanupTestRoot(scratch);
  });
  return root;
}

function instrument(
  t: TestContext,
  root: string,
  onRead?: (entry: Dirent | null, signal?: AbortSignal) => Promise<void> | void,
) {
  const opened: string[] = [];
  const ignoreReads: string[] = [];
  let reads = 0;
  let closes = 0;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- instrumentation applies the original to the actual receiver below
  const open = GuardedFileSystem.prototype.opendir;
  t.mock.method(
    GuardedFileSystem.prototype,
    'opendir',
    async function (this: GuardedFileSystem, ...args: Parameters<GuardedFileSystem['opendir']>) {
      const result = await open.apply(this, args);
      opened.push(relative(root, args[0]).replaceAll('\\', '/'));
      const directory = result.directory;
      const read = directory.read.bind(directory);
      const close = directory.close.bind(directory);
      t.mock.method(directory, 'read', async () => {
        reads++;
        const entry = await read();
        await onRead?.(entry, args[1]?.signal);
        return entry;
      });
      t.mock.method(directory, 'close', async () => {
        closes++;
        await close();
      });
      return result;
    },
  );
  // eslint-disable-next-line @typescript-eslint/unbound-method -- instrumentation applies the original to the actual receiver below
  const original = GuardedFileSystem.prototype.openOriginal;
  t.mock.method(
    GuardedFileSystem.prototype,
    'openOriginal',
    async function (
      this: GuardedFileSystem,
      ...args: Parameters<GuardedFileSystem['openOriginal']>
    ) {
      if (basename(args[0]) === '.gitignore') {
        ignoreReads.push(relative(root, args[0]).replaceAll('\\', '/'));
      }
      return original.apply(this, args);
    },
  );
  return { opened, ignoreReads, counts: () => ({ reads, closes }) };
}

it('list depth prunes actual opens and ignore reads, including hidden trees', async (t) => {
  const root = await fixture(t);
  const pair = await createTestClientPair([root]);
  t.after(() => pair.close());
  for (const branch of ['branch-0', 'branch-1', 'branch-2', '.hidden']) {
    for (let n = 0; n < 10; n++) {
      await writeTestFile(root, `${branch}/nested-${String(n)}/a.txt`, 'fixture');
      await writeTestFile(root, `${branch}/nested-${String(n)}/b.txt`, 'fixture');
      await writeTestFile(root, `${branch}/nested-${String(n)}/.gitignore`, '*.log\n');
    }
    await writeTestFile(root, `${branch}/.gitignore`, '*.log\n');
    await writeTestFile(root, `${branch}/skip.log`, 'ignored');
  }
  const observed = instrument(t, root);
  for (const maxDepth of [1, 2])
    for (const includeHidden of [false, true]) {
      for (const includeIgnored of [false, true]) {
        observed.opened.length = observed.ignoreReads.length = 0;
        const before = observed.counts();
        const result = await pair.client.callTool({
          name: 'list',
          arguments: {
            path: root,
            maxDepth,
            includeHidden,
            includeIgnored,
          },
        });
        assert.notEqual(result.isError, true, firstTextBlock(result).text);
        const meta = result._meta as unknown as ListMeta;
        const branches = includeHidden ? 4 : 3;
        assert.equal(observed.opened.length, maxDepth === 1 ? 1 : branches + 1);
        assert(observed.opened.every((path) => !path.includes('nested-')));
        assert.equal(observed.ignoreReads.length, includeIgnored ? 0 : observed.opened.length);
        assert(observed.ignoreReads.every((path) => !path.includes('nested-')));
        assert.equal(observed.counts().closes - before.closes, observed.opened.length);
        assert.equal(
          meta.entries.filter((e) => e.type === 'directory').length,
          maxDepth === 1 ? branches : branches * 11,
        );
        assert.equal(
          meta.entries.some((e) => e.name === 'skip.log'),
          maxDepth === 2 && includeIgnored,
        );
        assert.equal(meta.truncated, false);
      }
    }
});

it('list limit bounds collection, stops reads and keeps warnings on every cached page/resource', async (t) => {
  const root = await fixture(t);
  const pair = await createTestClientPair([root]);
  t.after(() => pair.close());
  const observed = instrument(t, root);
  for (const found of [0, 1, 2, 3, 4]) {
    const path = join(root, `count-${String(found)}`);
    await mkdir(path);
    for (let i = 0; i < found; i++) {
      if (i % 2 === 0) await mkdir(join(path, `dir-${String(i)}`));
      else await writeFile(join(path, `file-${String(i)}.txt`), 'fixture');
    }
    for (const pageSize of [1, 3, 10]) {
      const before = observed.counts();
      const opensBefore = observed.opened.length;
      const first = await pair.client.callTool({
        name: 'list',
        arguments: {
          path,
          limit: 3,
          pageSize,
          includeIgnored: true,
          maxDepth: 5,
        },
      });
      assert.notEqual(first.isError, true, firstTextBlock(first).text);
      let response = first;
      const firstMeta = first._meta as unknown as ListMeta;
      const collected = Math.min(found, 3);
      const truncated = found >= 3;
      assert.equal(firstMeta.totalEntries, collected);
      assert.equal(firstMeta.truncated, truncated);
      assert.equal(firstMeta.stoppedReason, truncated ? 'limit' : undefined);
      assert.equal(first.structuredContent, undefined);
      const afterScan = observed.counts();
      const opened = observed.opened.length - opensBefore;
      assert.equal(afterScan.closes - before.closes, opened);
      // Empty nested directories consume EOF reads; the cap consumes no N+1 read.
      assert.equal(afterScan.reads - before.reads, collected + opened - (truncated ? 1 : 0));
      const entries: ListMeta['entries'] = [];
      for (;;) {
        const meta = response._meta as unknown as ListMeta;
        entries.push(...meta.entries);
        assert.equal(meta.totalEntries, collected);
        assert.equal(meta.totalFiles + meta.totalDirectories, collected);
        assert.equal(meta.limit, 3);
        assert.equal(meta.truncated, truncated);
        const text = firstTextBlock(response).text ?? '';
        assert.equal(text.startsWith('// list stopped at limit=3;'), truncated);
        if (truncated) {
          assert(text.includes('Totals count collected entries only'));
          assert(text.includes('Cursors do not resume traversal'));
        }
        for (const entry of meta.entries) assert(text.includes(entry.name), text);
        if (!meta.nextCursor) break;
        response = await pair.client.callTool({
          name: 'list',
          arguments: {
            path,
            limit: 3,
            pageSize: 10,
            maxDepth: 5,
            includeIgnored: true,
            cursor: meta.nextCursor,
          },
        });
        assert.notEqual(response.isError, true, firstTextBlock(response).text);
        assert.equal((response._meta as unknown as ListMeta).resourceUri, undefined);
      }
      assert.equal(entries.length, collected);
      assert.equal(new Set(entries.map((e) => e.relativePath)).size, collected);
      assert.deepEqual(observed.counts(), afterScan, 'cursors must not scan');
      assert.equal(
        firstMeta.totalDirectories,
        entries.filter((e) => e.type === 'directory').length,
      );
      assert.equal(firstMeta.totalFiles, entries.filter((e) => e.type !== 'directory').length);
      if (truncated || collected > pageSize) {
        assert(firstMeta.resourceUri);
        const resource = await pair.client.readResource({ uri: firstMeta.resourceUri });
        const block = resource.contents[0];
        assert(block && 'text' in block);
        const stored = JSON.parse(block.text) as ListMeta & { markdown: string };
        assert.deepEqual(stored.entries, entries);
        for (const key of [
          'limit',
          'truncated',
          'stoppedReason',
          'totalEntries',
          'totalFiles',
          'totalDirectories',
        ] as const) {
          assert.equal(stored[key], firstMeta[key]);
        }
        assert.equal(stored.markdown.startsWith('// list stopped at limit=3;'), truncated);
      } else assert.equal(firstMeta.resourceUri, undefined);
    }
  }
});

it('list limit returns before descending into its Nth directory in a wide/deep tree', async (t) => {
  const root = await fixture(t);
  for (let i = 0; i < 20; i++) {
    await writeTestFile(root, `branch-${String(i)}/deep/deeper/file.txt`, 'fixture');
  }
  const pair = await createTestClientPair([root]);
  t.after(() => pair.close());
  const observed = instrument(t, root);
  for (const includeHidden of [false, true])
    for (const includeIgnored of [false, true]) {
      const before = observed.counts();
      const opens = observed.opened.length;
      const result = await pair.client.callTool({
        name: 'list',
        arguments: {
          path: root,
          maxDepth: 10,
          limit: 1,
          pageSize: 100,
          includeHidden,
          includeIgnored,
        },
      });
      assert.notEqual(result.isError, true);
      const meta = result._meta as unknown as ListMeta;
      assert.equal(meta.entries.length, 1);
      assert.equal(meta.entries[0]?.type, 'directory');
      assert.equal(meta.totalFiles, 0);
      assert.equal(meta.totalDirectories, 1);
      assert.equal(meta.truncated, true);
      assert.equal(observed.opened.length - opens, 1);
      assert.deepEqual(observed.counts(), { reads: before.reads + 1, closes: before.closes + 1 });
    }
});

it('list publishes limit/pageSize defaults and rejects removed names/invalid bounds on wire', async (t) => {
  const root = await fixture(t);
  await writeTestFile(root, 'one.txt', 'fixture');
  for (const readOnly of [false, true]) {
    const pair = await createTestClientPair([root], { readOnly });
    try {
      const { tools } = await pair.client.listTools();
      t.diagnostic(
        `tools/list ${readOnly ? 'read-only' : 'full'}: ${String(tools.length)} tools, ${String(JSON.stringify(tools).length)} chars`,
      );
      const tool = tools.find((item) => item.name === 'list');
      assert(tool);
      const properties = tool.inputSchema.properties as Record<
        string,
        { default?: number; maximum?: number; description?: string }
      >;
      assert.equal(properties['limit']?.default, 20000);
      assert.equal(properties['pageSize']?.default, 1000);
      assert.equal(properties['limit']?.maximum, 20000);
      assert.equal(properties['maxEntries'], undefined);
      assert.equal(properties['maxPages'], undefined);
      assert.equal(tool.inputSchema['additionalProperties'], false);
      assert(tool.description?.includes('Cursors page only collected'));
      for (const args of [
        { maxEntries: 1 },
        { maxPages: 1 },
        { limit: 0 },
        { limit: 20001 },
        { limit: 1.5 },
        { pageSize: 0 },
        { pageSize: 20001 },
        { pageSize: 1.5 },
        { maxDepth: 0 },
      ]) {
        const invalid = await pair.client.callTool({
          name: 'list',
          arguments: { path: root, ...args },
        });
        assert.equal(invalid.isError, true, JSON.stringify(args));
        const message = firstTextBlock(invalid).text ?? '';
        assert.match(message, /Invalid|validation|Unrecognized|too_|integer|>=|<=/i);
        if ('maxEntries' in args) assert(message.includes('maxEntries'), message);
      }
      const result = await pair.client.callTool({ name: 'list', arguments: {} });
      assert.notEqual(result.isError, true);
      const meta = result._meta as unknown as ListMeta;
      assert.equal(meta.limit, 20000);
      assert.equal(meta.truncated, false);
      assert.equal(meta.totalEntries, 1);
      assert.equal(meta.nextCursor, undefined);
      assert.equal(meta.resourceUri, undefined);
    } finally {
      await pair.close();
    }
  }
});

it('list cursor binds limit, scope and flags but accepts changed pageSize and expires', async (t) => {
  const root = await fixture(t);
  for (let i = 0; i < 4; i++) await writeTestFile(root, `file-${String(i)}.txt`, 'fixture');
  let now = 100;
  const pageStore = new PageSnapshotStore({ ttlMs: 100, now: () => now });
  const server = await createServer({ cliAllowedDirs: [root] }, { pageStore });
  const client = new Client({ name: 'list-cursor', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.mcp.connect(st)]);
  t.after(async () => {
    await client.close();
    server.disposeRuntimeState();
    await server.mcp.close();
  });
  const args = {
    path: root,
    limit: 3,
    pageSize: 1,
    maxDepth: 2,
    includeHidden: false,
    includeIgnored: true,
  };
  const first = await client.callTool({ name: 'list', arguments: args });
  const cursor = (first._meta as unknown as ListMeta).nextCursor;
  assert(cursor);
  for (const change of [
    { limit: 4 },
    { maxDepth: 1 },
    { includeHidden: true },
    { includeIgnored: false },
    { path: join(root, 'other') },
  ]) {
    const result = await client.callTool({
      name: 'list',
      arguments: { ...args, ...change, cursor },
    });
    assert.equal(result.isError, true);
    assert.match(firstTextBlock(result).text ?? '', /Invalid cursor/);
  }
  const changedSize = await client.callTool({
    name: 'list',
    arguments: { ...args, pageSize: 20000, cursor },
  });
  assert.equal((changedSize._meta as unknown as ListMeta).entryCount, 2);
  assert.equal((changedSize._meta as unknown as ListMeta).nextCursor, undefined);
  now += 100;
  const expired = await client.callTool({ name: 'list', arguments: { ...args, cursor } });
  assert.equal(expired.isError, true);
  assert.match(firstTextBlock(expired).text ?? '', /Invalid cursor/);
});

it('list retains bounded metadata and page text without a resourceStore, including orphan parents', async (t) => {
  const root = await fixture(t);
  await writeTestFile(root, 'parent/a.txt', 'fixture');
  await writeTestFile(root, 'parent/b.txt', 'fixture');
  const pathGuard = await makeGuard([root]);
  const server = new McpServer({ name: 'list-no-resource', version: '1' });
  const jobManager = new ArtifactJobManager();
  await jobManager.initialize();
  LIST.register({
    server,
    pathGuard,
    pageStore: new PageSnapshotStore(),
    resourceStore: undefined,
    jobManager,
  });
  const client = new Client({ name: 'list-no-resource', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  t.after(async () => {
    await client.close();
    await server.close();
    await jobManager.close();
  });
  const args = { path: root, maxDepth: 2, includeIgnored: true, limit: 3, pageSize: 1 };
  const observed = instrument(t, root);
  let output = await client.callTool({ name: 'list', arguments: args });
  let metadata = output._meta as unknown as ListMeta;
  const afterScan = observed.counts();
  const all = [...metadata.entries];
  assert.equal(metadata.resourceUri, undefined);
  assert.equal(output.content.length, 1);
  while (metadata.nextCursor) {
    output = await client.callTool({
      name: 'list',
      arguments: { ...args, cursor: metadata.nextCursor },
    });
    metadata = output._meta as unknown as ListMeta;
    all.push(...metadata.entries);
    const text = firstTextBlock(output).text ?? '';
    assert(text.startsWith('// list stopped at limit=3;'));
    assert(text.includes('parent/'));
    for (const entry of metadata.entries) assert(text.includes(entry.name));
  }
  assert.equal(all.length, 3);
  assert.deepEqual(observed.counts(), afterScan);
});

it('filtered entries observe cancellation during a delayed read and close all nested handles', async (t) => {
  const root = await fixture(t);
  await writeTestFile(root, 'parent/.hidden/deep/file.txt', 'fixture');
  const controller = new AbortController();
  const reason = new DOMException('fixture cancelled', 'AbortError');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached!: () => void;
  const pending = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const observed = instrument(t, root, async (entry) => {
    if (entry?.name === '.hidden') {
      reached();
      await gate;
    }
  });
  const fs = new GuardedFileSystem(await makeGuard([root]));
  const scan = (async () => {
    for await (const _ of walkListEntries({
      fs,
      root,
      maxDepth: 10,
      includeHidden: false,
      includeIgnored: true,
      signal: controller.signal,
    })) {
      /* consume */
    }
  })();
  await pending;
  controller.abort(reason);
  release();
  await assert.rejects(scan, (error: unknown) => error === reason);
  assert.deepEqual(observed.opened, ['', 'parent']);
  assert.deepEqual(observed.counts(), { reads: 2, closes: 2 });
});

it('cancellation during ignore loading stops before any directory read and closes rule/directory handles', async (t) => {
  const root = await fixture(t);
  await writeTestFile(root, '.gitignore', '*.log\n');
  await writeTestFile(root, 'parent/deep/file.txt', 'fixture');
  const controller = new AbortController();
  const reason = new DOMException('fixture deadline', 'TimeoutError');
  const observed = instrument(t, root);
  const fs = new GuardedFileSystem(await makeGuard([root]));
  const original = fs.openOriginal.bind(fs);
  let ruleCloses = 0;
  t.mock.method(fs, 'openOriginal', async (...args: Parameters<typeof fs.openOriginal>) => {
    const result = await original(...args);
    const close = result.handle.close.bind(result.handle);
    t.mock.method(result.handle, 'close', async () => {
      ruleCloses++;
      await close();
    });
    controller.abort(reason);
    return result;
  });
  const scan = (async () => {
    for await (const _ of walkListEntries({
      fs,
      root,
      maxDepth: 10,
      includeHidden: true,
      includeIgnored: false,
      signal: controller.signal,
    })) {
      /* consume */
    }
  })();
  await assert.rejects(scan, (error: unknown) => error === reason);
  assert.equal(ruleCloses, 1);
  assert.deepEqual(observed.counts(), { reads: 0, closes: 1 });
});

it('an opendir that finishes after cancellation closes its late native handle', async (t) => {
  const root = await fixture(t);
  const fs = new GuardedFileSystem(await makeGuard([root]));
  const controller = new AbortController();
  const original = fsPromises.opendir;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached!: () => void;
  const opened = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let handle: Awaited<ReturnType<typeof original>> | undefined;
  t.mock.method(fsPromises, 'opendir', async (path: string) => {
    handle = await original(path);
    reached();
    await gate;
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const opening = fs.opendir(root, { signal: controller.signal });
  await opened;
  controller.abort(new DOMException('fixture cancelled', 'AbortError'));
  release();
  await assert.rejects(opening, /fixture cancelled/);
  assert(handle);
  await assert.rejects(handle.read(), { code: 'ERR_DIR_CLOSED' });
});

it('list respects nested ignore negation, exclusions, sensitive paths and no-follow junctions', async (t) => {
  const root = await fixture(t);
  const outside = await createTestRoot();
  t.after(() => cleanupTestRoot(outside));
  await writeTestFile(root, '.gitignore', '*.log\nignored/\n');
  await writeTestFile(root, 'nested/.gitignore', '!keep.log\n');
  await writeTestFile(root, 'nested/keep.log', 'fixture');
  await writeTestFile(root, 'nested/drop.log', 'fixture');
  await writeTestFile(root, 'ignored/deep/file.txt', 'fixture');
  await writeTestFile(root, 'dist/file.txt', 'fixture');
  await writeTestFile(root, '.env', 'SYNTHETIC=fixture');
  await writeTestFile(root, 'nested/.env', 'SYNTHETIC=fixture');
  await writeTestFile(root, '.hidden/allowed.txt', 'fixture');
  await writeTestFile(outside, 'external.txt', 'fixture');
  if (!(await trySymlink(outside, join(root, 'escape'), () => t.skip('junction not permitted'))))
    return;
  if (
    !(await trySymlink(join(root, 'nested'), join(root, 'alias'), () =>
      t.skip('junction not permitted'),
    ))
  )
    return;
  const pair = await createTestClientPair([root]);
  t.after(() => pair.close());
  const observed = instrument(t, root);
  const result = await pair.client.callTool({
    name: 'list',
    arguments: { path: root, maxDepth: 5, includeHidden: true },
  });
  assert.notEqual(result.isError, true, firstTextBlock(result).text);
  const entries = (result._meta as unknown as ListMeta).entries;
  const paths = entries.map((e) => e.relativePath);
  assert(paths.includes('nested/keep.log'));
  assert(paths.includes('.hidden/allowed.txt'));
  assert(entries.some((e) => e.relativePath === 'alias' && e.type === 'symlink'));
  assert(
    !paths.some(
      (path) =>
        path.includes('drop.log') ||
        path.startsWith('ignored') ||
        path.startsWith('dist') ||
        path.startsWith('escape') ||
        path.endsWith('.env'),
    ),
  );
  assert(!paths.some((path) => path.startsWith('alias/')));
  assert.deepEqual(new Set(observed.opened), new Set(['', 'nested', '.hidden']));
});

it('list wire deadline is TIMEOUT and closes a delayed filtered iterator without more reads', async (t) => {
  const root = await fixture(t);
  await writeTestFile(root, '.hidden/deep/file.txt', 'fixture');
  const pair = await createTestClientPair([root]);
  t.after(() => pair.close());
  const observed = instrument(t, root, async (_entry, signal) => {
    assert(signal);
    if (!signal.aborted)
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
  });
  const result = await pair.client.callTool({
    name: 'list',
    arguments: { path: root, maxDepth: 10 },
  });
  assert.equal(result.isError, true);
  assert.match(firstTextBlock(result).text ?? '', /^TIMEOUT:/);
  assert.equal(result._meta, undefined);
  assert.deepEqual(observed.opened, ['']);
  assert.deepEqual(observed.counts(), { reads: 1, closes: 1 });
});

it('an already cancelled list walk starts no directory or ignore operations', async (t) => {
  const root = await fixture(t);
  const fs = new GuardedFileSystem(await makeGuard([root]));
  const observed = instrument(t, root);
  const controller = new AbortController();
  controller.abort(new DOMException('fixture cancelled', 'AbortError'));
  const scan = (async () => {
    for await (const _ of walkListEntries({
      fs,
      root,
      maxDepth: 2,
      includeHidden: true,
      includeIgnored: false,
      signal: controller.signal,
    })) {
      /* consume */
    }
  })();
  await assert.rejects(scan, /fixture cancelled/);
  assert.deepEqual(observed.opened, []);
  assert.deepEqual(observed.ignoreReads, []);
});

it('a configured root junction resolves canonically and preserves relative paths', async (t) => {
  const root = await fixture(t);
  await writeTestFile(root, 'source/parent/file.txt', 'fixture');
  const alias = join(root, 'source-alias');
  if (!(await trySymlink(join(root, 'source'), alias, () => t.skip('junction not permitted'))))
    return;
  const pair = await createTestClientPair([alias]);
  t.after(() => pair.close());
  const result = await pair.client.callTool({
    name: 'list',
    arguments: { path: alias, maxDepth: 2 },
  });
  assert.notEqual(result.isError, true, firstTextBlock(result).text);
  const paths = (result._meta as unknown as ListMeta).entries.map((e) => e.relativePath);
  assert.deepEqual(paths, ['parent', 'parent/file.txt']);
});

it('cancellation during canonical validation starts no stat, ancestor probe or opendir', async (t) => {
  const root = await fixture(t);
  const guard = await makeGuard([root]);
  const fs = new GuardedFileSystem(guard);
  const realpath = fsPromises.realpath;
  let controller = new AbortController();
  let stats = 0;
  let lstats = 0;
  let opens = 0;
  t.mock.method(fsPromises, 'realpath', async (path: string) => {
    try {
      return await realpath(path);
    } finally {
      controller.abort(new DOMException('fixture cancelled in validation', 'AbortError'));
    }
  });
  t.mock.method(fsPromises, 'stat', () => {
    stats++;
    throw new Error('unexpected stat');
  });
  t.mock.method(fsPromises, 'lstat', () => {
    lstats++;
    throw new Error('unexpected ancestor probe');
  });
  t.mock.method(fsPromises, 'opendir', () => {
    opens++;
    throw new Error('unexpected open');
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(
    fs.opendir(root, { signal: controller.signal }),
    /fixture cancelled in validation/,
  );
  controller = new AbortController();
  await assert.rejects(
    guard.isEntryAccessible(join(root, 'missing'), controller.signal),
    /fixture cancelled in validation/,
  );
  assert.deepEqual({ stats, lstats, opens }, { stats: 0, lstats: 0, opens: 0 });
});
