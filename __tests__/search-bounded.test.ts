import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import type { Dirent } from 'node:fs';
import fsPromises, { mkdir, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename, join, relative } from 'node:path';
import { it, type TestContext } from 'node:test';

import { GuardedFileSystem } from '../src/core/fs.js';
import { ArtifactJobManager } from '../src/core/job-manager.js';
import { PageSnapshotStore } from '../src/core/page-store.js';
import { searchContent, searchFiles } from '../src/core/search.js';
import { createServer } from '../src/server.js';
import { FIND_FILES } from '../src/tools/find-files.js';
import { SEARCH_TEXT } from '../src/tools/search-text.js';
import {
  cleanupTestRoot,
  createTestClientPair,
  createTestRoot,
  firstTextBlock,
  makeGuard,
  trySymlink,
  writeTestFile,
} from './helpers.js';

interface SearchMeta {
  results?: { path: string }[];
  matches?: {
    file: string;
    line: number;
    matchCount: number;
    before?: string[];
    after?: string[];
  }[];
  limit: number;
  totalMatches: number;
  filesScanned: number;
  filesMatched?: number;
  truncated: boolean;
  stoppedReason?: 'limit' | 'timeout';
  nextCursor?: string;
  resourceUri?: string;
}

const tools = ['find_files', 'search_text'] as const;
function query(name: (typeof tools)[number], path?: string) {
  return {
    ...(path ? { path } : {}),
    pattern: '**/*.txt',
    ...(name === 'search_text' ? { searchPattern: 'token' } : {}),
  };
}
function rows(meta: SearchMeta): string[] {
  return (
    meta.results?.map((r) => r.path) ??
    (meta.matches ?? []).map((m) => `${m.file}:${String(m.line)}`)
  );
}

function continuation(text: string | undefined, name: string): Record<string, unknown> {
  const json = text?.split(`Next page: ${name} `)[1];
  assert(json, text);
  return JSON.parse(json) as Record<string, unknown>;
}

it('text limit counts matching lines once, with Unicode occurrences/context and no next-file open', async (t) => {
  const root = await fixture(t);
  const file = await writeTestFile(
    root,
    'first.txt',
    'before\n🙂token 🙂token\nbetween\n🙂token\nafter\n',
  );
  await writeTestFile(root, 'second.txt', 'token\n');
  const pair = await createTestClientPair([root]);
  t.after(() => pair.close());
  const observed = observe(t, root);
  for (const isRegex of [false, true]) {
    observed.textReads.length = observed.opened.length = 0;
    const response = await pair.client.callTool({
      name: 'search_text',
      arguments: {
        path: file,
        pattern: '**/*.missing',
        searchPattern: '🙂token',
        isRegex,
        caseSensitive: true,
        limit: 1,
        pageSize: 10,
        context: 1,
        maxDepth: 0,
      },
    });
    assert.notEqual(response.isError, true, firstTextBlock(response).text);
    const meta = response._meta as unknown as SearchMeta & { matches: { column: number }[] };
    assert.equal(meta.totalMatches, 1);
    assert.equal(meta.filesMatched, 1);
    assert.equal(meta.filesScanned, 1);
    assert.equal(meta.limit, 1);
    assert.equal(meta.stoppedReason, 'limit');
    assert.equal(meta.nextCursor, undefined);
    assert.equal(meta.matches[0]?.matchCount, 2);
    assert.equal(meta.matches[0]?.column, 0);
    assert.deepEqual(meta.matches[0]?.before, ['before']);
    assert.deepEqual(meta.matches[0]?.after, ['between']);
    assert.deepEqual(observed.textReads, ['first.txt']);
    assert.deepEqual(observed.opened, []);
  }
});

it('content line loops observe cancellation after partial matches and in a no-match file', async (t) => {
  const root = await fixture(t);
  const file = await writeTestFile(
    root,
    'lines.txt',
    'token\n' + 'no matching line\n'.repeat(1500),
  );
  const guard = await makeGuard([root]);
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  for (const searchPattern of ['token', 'absent']) {
    const controller = new AbortController();
    const original = fsPromises.open;
    t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof original>) => {
      const handle = await original(...args);
      if (String(args[0]) === file) {
        const read = handle.read.bind(handle);
        t.mock.method(handle, 'read', async (...readArgs: Parameters<typeof read>) => {
          const result = await read(...readArgs);
          // Abort on the *second* event-loop yield in the line scan. The first
          // yield allows the first line to run before the scheduled callback.
          if (result.bytesRead === 0)
            setImmediate(() =>
              setImmediate(() => controller.abort(new DOMException('line cancel', 'AbortError'))),
            );
          return result;
        });
      }
      return handle;
    });
    syncBuiltinESMExports();
    const result = await searchContent(
      root,
      searchPattern,
      { singleFile: file, signal: controller.signal },
      guard,
    );
    assert.equal(result.summary.stoppedReason, 'timeout');
    assert.equal(result.summary.truncated, true);
    assert.equal(result.summary.matchingLines, searchPattern === 'token' ? 1 : 0);
    assert.equal(result.summary.filesMatched, searchPattern === 'token' ? 1 : 0);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

it('a text file opened after cancellation is closed when its native open eventually resolves', async (t) => {
  const root = await fixture(t);
  const file = await writeTestFile(root, 'late.txt', 'token');
  const controller = new AbortController();
  const original = fsPromises.open;
  let release!: () => void, reached!: () => void, closed!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    reached = r;
  });
  const finished = new Promise<void>((r) => {
    closed = r;
  });
  let handle: Awaited<ReturnType<typeof original>> | undefined;
  t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof original>) => {
    handle = await original(...args);
    const close = handle.close.bind(handle);
    t.mock.method(handle, 'close', async () => {
      await close();
      closed();
    });
    reached();
    await gate;
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const scan = searchContent(
    root,
    'token',
    { singleFile: file, signal: controller.signal },
    await makeGuard([root]),
  );
  await started;
  controller.abort(new DOMException('late file cancel', 'AbortError'));
  const result = await scan;
  assert.equal(result.summary.stoppedReason, 'timeout');
  assert.equal(result.matches.length, 0);
  release();
  await finished;
  assert(handle);
  assert.equal(handle.fd, -1);
});

async function fixture(t: TestContext) {
  const root = await fsPromises.realpath(await createTestRoot());
  const scratch = await fsPromises.realpath(await createTestRoot());
  const saved = process.env['FS_SNAPSHOT_DIR'];
  process.env['FS_SNAPSHOT_DIR'] = scratch;
  t.after(async () => {
    if (saved === undefined) Reflect.deleteProperty(process.env, 'FS_SNAPSHOT_DIR');
    else process.env['FS_SNAPSHOT_DIR'] = saved;
    await cleanupTestRoot(root);
    await cleanupTestRoot(scratch);
  });
  return root;
}

function observe(
  t: TestContext,
  root: string,
  onRead?: (entry: Dirent | null, signal?: AbortSignal) => void | Promise<void>,
) {
  const opened: string[] = [];
  const ignoreReads: string[] = [];
  const textReads: string[] = [];
  let reads = 0,
    closes = 0;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- applied to original receiver below
  const open = GuardedFileSystem.prototype.opendir;
  t.mock.method(
    GuardedFileSystem.prototype,
    'opendir',
    async function (this: GuardedFileSystem, ...args: Parameters<GuardedFileSystem['opendir']>) {
      const result = await open.apply(this, args);
      opened.push(relative(root, result.validPath).replaceAll('\\', '/'));
      const read = result.directory.read.bind(result.directory);
      const close = result.directory.close.bind(result.directory);
      t.mock.method(result.directory, 'read', async () => {
        reads++;
        const entry = await read();
        await onRead?.(entry, args[1]?.signal);
        return entry;
      });
      t.mock.method(result.directory, 'close', async () => {
        closes++;
        await close();
      });
      return result;
    },
  );
  // eslint-disable-next-line @typescript-eslint/unbound-method -- applied to original receiver below
  const original = GuardedFileSystem.prototype.openOriginal;
  t.mock.method(
    GuardedFileSystem.prototype,
    'openOriginal',
    function (this: GuardedFileSystem, ...args: Parameters<GuardedFileSystem['openOriginal']>) {
      ignoreReads.push(relative(root, args[0]).replaceAll('\\', '/'));
      return original.apply(this, args);
    },
  );
  const native = fsPromises.open;
  t.mock.method(fsPromises, 'open', (...args: Parameters<typeof native>) => {
    if (basename(String(args[0])) !== '.gitignore')
      textReads.push(relative(root, String(args[0])).replaceAll('\\', '/'));
    return native(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return { opened, ignoreReads, textReads, counts: () => ({ reads, closes }) };
}

it('search depth 0/1/2 prunes actual opens and ignore discovery for hidden/ignored and unmatched globs', async (t) => {
  const root = await fixture(t);
  await writeTestFile(root, 'root.txt', 'token');
  for (const branch of ['branch', '.hidden']) {
    await writeTestFile(root, `${branch}/a.txt`, 'token');
    await writeTestFile(root, `${branch}/.gitignore`, '*.log\n');
    await writeTestFile(root, `${branch}/skip.log`, 'token');
    await writeTestFile(root, `${branch}/nested/b.txt`, 'token');
    await writeTestFile(root, `${branch}/nested/.gitignore`, '*.log\n');
    await writeTestFile(root, `${branch}/nested/deeper/c.txt`, 'token');
    await writeTestFile(root, `${branch}/nested/deeper/.gitignore`, '*.txt\n');
  }
  const pair = await createTestClientPair([root]);
  t.after(() => pair.close());
  const observed = observe(t, root);
  for (const name of tools)
    for (const maxDepth of [0, 1, 2])
      for (const includeHidden of [false, true])
        for (const includeIgnored of [false, true])
          for (const pattern of ['**/*.txt', '**/*.missing']) {
            observed.opened.length = observed.ignoreReads.length = observed.textReads.length = 0;
            const before = observed.counts();
            const response = await pair.client.callTool({
              name,
              arguments: { ...query(name, root), pattern, maxDepth, includeHidden, includeIgnored },
            });
            assert.notEqual(response.isError, true, firstTextBlock(response).text);
            const meta = response._meta as unknown as SearchMeta;
            const branches = includeHidden ? 2 : 1;
            assert.equal(observed.opened.length, 1 + maxDepth * branches);
            assert(observed.opened.every((p) => !p.includes('deeper')));
            assert.equal(observed.ignoreReads.length, includeIgnored ? 0 : observed.opened.length);
            assert(observed.ignoreReads.every((p) => !p.includes('deeper')));
            assert.equal(observed.counts().closes - before.closes, observed.opened.length);
            assert.equal(
              meta.totalMatches,
              pattern.endsWith('missing') ? 0 : 1 + maxDepth * branches,
            );
            assert.equal(meta.truncated, false);
            assert.equal(meta.limit, 10000);
            assert.equal(observed.textReads.length, name === 'search_text' ? meta.totalMatches : 0);
          }
});

it('search limit stops on N without an N+1 read and retains warnings/counters/resource on every page', async (t) => {
  const root = await fixture(t);
  const pair = await createTestClientPair([root]);
  t.after(() => pair.close());
  const observed = observe(t, root);
  for (const found of [0, 1, 2, 3, 4]) {
    const path = join(root, `count-${String(found)}`);
    await mkdir(path);
    for (let n = 0; n < found; n++)
      await writeFile(join(path, `file-${String(n)}.txt`), 'token token\n');
    for (const name of tools)
      for (const pageSize of [1, 3, 10]) {
        const args = {
          ...query(name, path),
          limit: 3,
          pageSize,
          includeIgnored: true,
          maxDepth: 0,
        };
        const before = observed.counts();
        const beforeText = observed.textReads.length;
        let response = await pair.client.callTool({ name, arguments: args });
        assert.notEqual(response.isError, true, firstTextBlock(response).text);
        const meta = response._meta as unknown as SearchMeta;
        const collected = Math.min(found, 3),
          truncated = found >= 3;
        assert.equal(observed.counts().reads - before.reads, collected + (truncated ? 0 : 1));
        assert.equal(observed.counts().closes - before.closes, 1);
        assert.equal(
          observed.textReads.length - beforeText,
          name === 'search_text' ? collected : 0,
        );
        const afterScan = observed.counts();
        const all: string[] = [];
        for (;;) {
          const page = response._meta as unknown as SearchMeta;
          all.push(...rows(page));
          assert.equal(page.limit, 3);
          assert.equal(page.totalMatches, collected);
          assert.equal(page.filesScanned, collected);
          assert.equal(page.truncated, truncated);
          assert.equal(page.stoppedReason, truncated ? 'limit' : undefined);
          assert.equal(response.structuredContent, undefined);
          const text = firstTextBlock(response).text ?? '';
          assert.equal(text.startsWith('// scan stopped early: reached limit=3;'), truncated);
          if (truncated) {
            assert(text.includes('Totals count collected matches only'));
            assert(text.includes('do not resume the scan'));
          }
          if (!page.nextCursor) {
            assert(!text.includes('Next page:'));
            break;
          }
          const next = continuation(text, name);
          response = await pair.client.callTool({ name, arguments: next });
          assert.notEqual(response.isError, true, firstTextBlock(response).text);
          assert.equal((response._meta as unknown as SearchMeta).resourceUri, undefined);
        }
        assert.equal(all.length, collected);
        assert.equal(new Set(all).size, collected);
        assert.deepEqual(observed.counts(), afterScan);
        if (meta.resourceUri) {
          const resource = await pair.client.readResource({ uri: meta.resourceUri });
          const content = resource.contents[0];
          assert(content && 'text' in content);
          const stored = JSON.parse(content.text) as SearchMeta;
          assert.equal(stored.limit, 3);
          assert.equal(stored.truncated, truncated);
          assert.equal(stored.stoppedReason, meta.stoppedReason);
          assert.equal(stored.totalMatches, collected);
          assert.equal(stored.filesScanned, collected);
          assert.deepEqual(rows(stored), all);
        } else assert(!truncated && collected <= pageSize);
      }
  }
});

it('finite globs and fixed prefixes avoid opening unrelated or impossibly deep directories', async (t) => {
  const root = await fixture(t);
  await writeTestFile(root, 'root.txt', 'token');
  for (const branch of ['wanted', 'unrelated']) {
    await writeTestFile(root, `${branch}/a.txt`, 'token');
    await writeTestFile(root, `${branch}/nested/b.txt`, 'token');
    await writeTestFile(root, `${branch}/nested/.gitignore`, '*.log\n');
    await writeTestFile(root, `${branch}/nested/deep/c.txt`, 'token');
  }
  const pair = await createTestClientPair([root]);
  t.after(() => pair.close());
  const observed = observe(t, root);
  for (const name of tools)
    for (const [pattern, expected] of [
      ['*.txt', ['']],
      ['wanted/*.txt', ['', 'wanted']],
      ['wanted/a.txt', ['', 'wanted']],
      ['wanted/*/*.missing', ['', 'wanted', 'wanted/nested']],
      ['wanted/**/*.missing', ['', 'wanted', 'wanted/nested', 'wanted/nested/deep']],
    ] as const) {
      observed.opened.length = observed.ignoreReads.length = 0;
      const response = await pair.client.callTool({
        name,
        arguments: { ...query(name, root), pattern, maxDepth: 100 },
      });
      assert.notEqual(response.isError, true, firstTextBlock(response).text);
      assert.deepEqual(observed.opened, expected);
      assert.equal(observed.ignoreReads.length, expected.length);
    }
});

it('literal search continuation preserves all nondefault flags, explicit file, multiple roots and changed pageSize', async (t) => {
  const root = await fixture(t);
  const other = await createTestRoot();
  t.after(() => cleanupTestRoot(other));
  await writeTestFile(other, 'outside.txt', 'token');
  for (const file of ['.hidden/a.txt', '.hidden/b.txt', 'folder/c.txt'])
    await writeTestFile(root, file, 'before\nGröße token token\nbetween\nGröße token\nafter\n');
  const explicit = await writeTestFile(
    root,
    '.hidden/[literal].txt',
    'before\nGröße token token\nbetween\nGröße token\nafter\n',
  );
  const pair = await createTestClientPair([root, other]);
  t.after(() => pair.close());
  const observed = observe(t, root);
  for (const name of tools)
    for (const singleFile of name === 'search_text' ? [false, true] : [false]) {
      const args = {
        ...query(name, singleFile ? explicit : root),
        pattern: singleFile ? '**/*.missing' : '**/*.txt',
        includeHidden: true,
        includeIgnored: true,
        maxDepth: 2,
        limit: 3,
        pageSize: 1,
        ...(name === 'find_files'
          ? { sortBy: 'name' }
          : { isRegex: true, caseSensitive: true, context: 1, searchPattern: 'Größe\\s+token' }),
      };
      let response = await pair.client.callTool({ name, arguments: args });
      assert.notEqual(response.isError, true, firstTextBlock(response).text);
      const afterScan = observed.counts();
      const filesAfterScan = observed.textReads.length;
      const seen: string[] = [];
      for (;;) {
        const meta = response._meta as unknown as SearchMeta;
        seen.push(...rows(meta));
        assert.equal(meta.limit, 3);
        assert.equal(meta.totalMatches, singleFile ? 2 : 3);
        const text = firstTextBlock(response).text ?? '';
        if (name === 'search_text') {
          assert(meta.matches?.every((m) => m.before?.length === 1 && m.after?.length === 1));
          if (meta.nextCursor) assert(text.includes('// showing 1-1 of '), text);
        }
        if (!meta.nextCursor) break;
        const next = continuation(text, name);
        for (const key of Object.keys(args).filter((k) => k !== 'path' && k !== 'pageSize'))
          assert.equal(next[key], args[key as keyof typeof args]);
        assert.equal(next['path'], singleFile ? explicit : root);
        next['pageSize'] = 2;
        response = await pair.client.callTool({ name, arguments: next });
        assert.notEqual(response.isError, true, firstTextBlock(response).text);
        assert.deepEqual(observed.counts(), afterScan);
        assert.equal(observed.textReads.length, filesAfterScan);
      }
      assert.equal(seen.length, singleFile ? 2 : 3);
      assert.equal(new Set(seen).size, seen.length);
    }
});

it('wire search schemas publish limit/pageSize/default depth and reject bounds, legacy keys and cursor mismatches', async (t) => {
  const root = await fixture(t);
  for (let n = 0; n < 3; n++) await writeTestFile(root, `${String(n)}.txt`, 'token');
  const pair = await createTestClientPair([root]);
  t.after(() => pair.close());
  const listed = await pair.client.listTools();
  for (const name of tools) {
    const tool = listed.tools.find((tool) => tool.name === name);
    assert(tool);
    const properties = tool.inputSchema.properties as Record<
      string,
      { default?: number; maximum?: number }
    >;
    assert.equal(properties['maxResults'], undefined);
    assert.equal(properties['limit']?.default, 10000);
    assert.equal(properties['limit']?.maximum, 10000);
    assert.equal(properties['pageSize']?.default, name === 'find_files' ? 100 : 500);
    assert.equal(properties['maxDepth']?.default, 100);
    assert.equal(properties['includeHidden']?.default, false);
    assert.equal(properties['includeIgnored']?.default, false);
    for (const invalid of [
      { limit: 0 },
      { limit: 10001 },
      { limit: 1.5 },
      { pageSize: 0 },
      { pageSize: 10001 },
      { maxDepth: -1 },
      { maxDepth: 101 },
      { maxResults: 1 },
    ]) {
      let message: string;
      try {
        const response = await pair.client.callTool({
          name,
          arguments: { ...query(name, root), ...invalid },
        });
        assert.equal(response.isError, true);
        message = firstTextBlock(response).text ?? '';
      } catch (error) {
        message = String(error);
      }
      assert(message);
      if ('maxResults' in invalid)
        assert.match(message, /maxResults.*no longer accepted; use limit.*pageSize/su);
    }
    const args = { ...query(name, root), limit: 3, pageSize: 1 };
    const first = await pair.client.callTool({ name, arguments: args });
    const cursor = (first._meta as unknown as SearchMeta).nextCursor;
    assert(cursor);
    for (const mismatch of [
      { limit: 4 },
      { maxDepth: 0 },
      { includeHidden: true },
      { includeIgnored: true },
      { pattern: '*.txt' },
      ...(name === 'search_text'
        ? [
            { searchPattern: 'different' },
            { context: 1 },
            { isRegex: true },
            { caseSensitive: true },
          ]
        : [{ sortBy: 'name' }]),
    ]) {
      const replay = await pair.client.callTool({
        name,
        arguments: { ...args, ...mismatch, cursor },
      });
      assert.equal(replay.isError, true);
      assert.match(firstTextBlock(replay).text ?? '', /Invalid cursor/u);
    }
  }
});

it('search cancellation on hidden, ignored, unmatched and no-content-match entries closes every handle and reports timeout', async (t) => {
  for (const filter of ['hidden', 'ignored', 'unmatched', 'content'])
    for (const name of tools) {
      const root = await fixture(t);
      const target =
        filter === 'hidden' ? '.hidden.txt' : filter === 'ignored' ? 'skip.log' : 'a.txt';
      await writeTestFile(root, target, 'no matching content');
      await writeTestFile(root, '.gitignore', '*.log\n');
      const controller = new AbortController();
      const observed = observe(t, root, (entry) => {
        if (entry?.name === target)
          controller.abort(new DOMException('fixture cancellation', 'AbortError'));
      });
      const guard = await makeGuard([root]);
      const options = {
        maxDepth: 5,
        skipIgnored: true,
        signal: controller.signal,
        filePattern: filter === 'unmatched' ? '**/*.missing' : '**/*',
      };
      const result =
        name === 'find_files'
          ? await searchFiles(root, options.filePattern, options, guard)
          : await searchContent(root, 'token', options, guard);
      assert.equal(result.summary.stoppedReason, 'timeout');
      assert.equal(result.summary.truncated, true);
      assert.equal(observed.counts().closes, observed.opened.length);
      assert.equal(observed.textReads.length, 0);
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
});

it('search cancellation during .gitignore read closes the rules and directory handles before enumeration', async (t) => {
  const root = await fixture(t);
  await writeTestFile(root, '.gitignore', '*.log\n');
  const observed = observe(t, root);
  const controller = new AbortController();
  // eslint-disable-next-line @typescript-eslint/unbound-method -- applied to original receiver below
  const original = GuardedFileSystem.prototype.openOriginal;
  let closes = 0;
  t.mock.method(
    GuardedFileSystem.prototype,
    'openOriginal',
    async function (
      this: GuardedFileSystem,
      ...args: Parameters<GuardedFileSystem['openOriginal']>
    ) {
      const result = await original.apply(this, args);
      const close = result.handle.close.bind(result.handle);
      t.mock.method(result.handle, 'close', async () => {
        closes++;
        await close();
      });
      t.mock.method(result.handle, 'readFile', () => {
        controller.abort(new DOMException('rule deadline', 'TimeoutError'));
        return Promise.reject(new DOMException('rule deadline', 'TimeoutError'));
      });
      return result;
    },
  );
  const result = await searchFiles(
    root,
    '**/*.missing',
    { skipIgnored: true, signal: controller.signal },
    await makeGuard([root]),
  );
  assert.equal(result.summary.stoppedReason, 'timeout');
  assert.equal(result.summary.matched, 0);
  assert.equal(closes, 1);
  assert.deepEqual(observed.counts(), { reads: 0, closes: 1 });
});

it('search cancellation during a late native opendir closes the eventual handle', async (t) => {
  const root = await fixture(t);
  const controller = new AbortController();
  const original = fsPromises.opendir;
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const opened = new Promise<void>((r) => {
    reached = r;
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
  const scan = searchContent(root, 'token', { signal: controller.signal }, await makeGuard([root]));
  await opened;
  controller.abort(new DOMException('late cancellation', 'AbortError'));
  release();
  const result = await scan;
  assert.equal(result.summary.stoppedReason, 'timeout');
  assert.equal(result.matches.length, 0);
  assert(handle);
  await assert.rejects(handle.read(), { code: 'ERR_DIR_CLOSED' });
});

it('search wire deadline with zero matches yields a visible partial warning and no continuation', async (t) => {
  const root = await fixture(t);
  await writeTestFile(root, '.hidden.txt', 'token');
  const pair = await createTestClientPair([root]);
  t.after(() => pair.close());
  const observed = observe(t, root, async (_entry, signal) => {
    assert(signal);
    if (!signal.aborted)
      await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
  });
  for (const name of tools) {
    const response = await pair.client.callTool({
      name,
      arguments: { ...query(name, root), limit: 2 },
    });
    const text = firstTextBlock(response).text ?? '';
    if (response.isError) assert.match(text, /^(TIMEOUT|CANCELLED):/u);
    else {
      const meta = response._meta as unknown as SearchMeta;
      assert.equal(meta.totalMatches, 0);
      assert.equal(meta.stoppedReason, 'timeout');
      assert.equal(meta.truncated, true);
      assert.equal(meta.limit, 2);
      assert.equal(meta.nextCursor, undefined);
      assert(text.startsWith('// scan stopped early:'));
      assert(text.includes('limit=2'));
    }
  }
  assert.deepEqual(observed.counts(), { reads: 2, closes: 2 });
});

it('search ignore negation, complex globs, source boundaries and no-follow junctions are preserved', async (t) => {
  const root = await fixture(t);
  const outside = await createTestRoot();
  t.after(() => cleanupTestRoot(outside));
  for (const file of [
    'nested/keep.log',
    'nested/drop.log',
    'ignored/deep/a.txt',
    'dist/a.txt',
    '.hidden/a.txt',
    'nested/one.ts',
    'nested/two.tsx',
    'nested/three.js',
    '.env',
    'nested/.env',
    'private.pem',
  ])
    await writeTestFile(root, file, 'token');
  await writeTestFile(root, '.gitignore', '*.log\nignored/\n');
  await writeTestFile(root, 'nested/.gitignore', '!keep.log\n');
  await writeTestFile(outside, 'outside.txt', 'token');
  if (!(await trySymlink(outside, join(root, 'escape'), () => t.skip('junction unavailable'))))
    return;
  if (
    !(await trySymlink(join(root, 'nested'), join(root, 'alias'), () =>
      t.skip('junction unavailable'),
    ))
  )
    return;
  const pair = await createTestClientPair([root]);
  t.after(() => pair.close());
  const observed = observe(t, root);
  for (const name of tools)
    for (const pattern of [
      '**/*',
      'nested/*.{ts,tsx}',
      'nested/@(one).*',
      '@(nested)/*.ts',
      '+(nested)/*.tsx',
      '{nested/one,nested/two}.{ts,tsx}',
      'nested/[ot]*.*',
      'nested\\*.ts',
      'nested/**',
      '**/.hidden/*.txt',
    ]) {
      observed.opened.length = 0;
      const response = await pair.client.callTool({
        name,
        arguments: { ...query(name, root), pattern, includeHidden: true },
      });
      assert.notEqual(response.isError, true, firstTextBlock(response).text);
      const meta = response._meta as unknown as SearchMeta;
      const paths = meta.results?.map((r) => r.path) ?? (meta.matches ?? []).map((m) => m.file);
      assert(
        !paths.some(
          (p) =>
            p.includes('drop.log') ||
            p.startsWith('ignored/') ||
            p.startsWith('dist/') ||
            p.startsWith('alias/') ||
            p.startsWith('escape/') ||
            p.endsWith('.env') ||
            p.endsWith('.pem'),
        ),
      );
      assert(
        !observed.opened.some((p) =>
          ['ignored', 'dist', 'alias', 'escape'].some((prefix) => p.startsWith(prefix)),
        ),
      );
      if (pattern === '**/*')
        assert.deepEqual(
          new Set(paths),
          new Set([
            'nested/keep.log',
            '.hidden/a.txt',
            'nested/one.ts',
            'nested/two.tsx',
            'nested/three.js',
            ...(name === 'find_files' ? ['nested/.gitignore', '.gitignore'] : []),
          ]),
        );
      if (pattern === 'nested/*.{ts,tsx}')
        assert.deepEqual(paths, ['nested/one.ts', 'nested/two.tsx']);
      if (pattern === 'nested/@(one).*') assert.deepEqual(paths, ['nested/one.ts']);
      if (pattern === '@(nested)/*.ts') assert.deepEqual(paths, ['nested/one.ts']);
      if (pattern === '+(nested)/*.tsx') assert.deepEqual(paths, ['nested/two.tsx']);
      if (pattern === '{nested/one,nested/two}.{ts,tsx}')
        assert.deepEqual(paths, ['nested/one.ts', 'nested/two.tsx']);
      if (pattern === 'nested/[ot]*.*')
        assert.deepEqual(paths, ['nested/one.ts', 'nested/three.js', 'nested/two.tsx']);
      if (pattern === 'nested\\*.ts') assert.deepEqual(paths, ['nested/one.ts']);
      if (pattern === '**/.hidden/*.txt') assert.deepEqual(paths, ['.hidden/a.txt']);
    }
});

it('search without resourceStore keeps the same collect semantics and rejects expired cursors', async (t) => {
  const root = await fixture(t);
  for (let n = 0; n < 4; n++) await writeTestFile(root, `${String(n)}.txt`, 'token');
  let now = 0;
  const pageStore = new PageSnapshotStore({ now: () => now, ttlMs: 100 });
  const jobManager = new ArtifactJobManager();
  await jobManager.initialize();
  const runtime = await createServer({ cliAllowedDirs: [root] }, { pageStore, jobManager });
  const mcp = new McpServer({ name: 'no-resources-search', version: '1' });
  for (const tool of [FIND_FILES, SEARCH_TEXT])
    tool.register({
      server: mcp,
      pathGuard: runtime.pathGuard,
      pageStore,
      resourceStore: undefined,
      jobManager,
    });
  const client = new Client({ name: 'no-resources', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), mcp.connect(st)]);
  t.after(async () => {
    await client.close();
    await mcp.close();
    runtime.disposeRuntimeState();
    await runtime.mcp.close();
    await jobManager.close();
  });
  for (const name of tools) {
    const args = { ...query(name), limit: 3, pageSize: 1 };
    const first = await client.callTool({ name, arguments: args });
    const meta = first._meta as unknown as SearchMeta;
    assert.equal(meta.resourceUri, undefined);
    assert.equal(meta.limit, 3);
    assert.equal(meta.truncated, true);
    assert.equal(meta.stoppedReason, 'limit');
    assert.equal(meta.totalMatches, 3);
    assert.equal(first.structuredContent, undefined);
    const next = continuation(firstTextBlock(first).text, name);
    const last = await client.callTool({ name, arguments: { ...next, pageSize: 10 } });
    assert.notEqual(last.isError, true, firstTextBlock(last).text);
    assert.equal((last._meta as unknown as SearchMeta).nextCursor, undefined);
    assert(firstTextBlock(last).text?.startsWith('// scan stopped early:'));
    now += 101;
    const expired = await client.callTool({ name, arguments: next });
    assert.equal(expired.isError, true);
    assert.match(firstTextBlock(expired).text ?? '', /Invalid cursor/u);
  }
});

it(
  'Windows canonical root aliases and actual 8.3 spelling preserve bounded search and ignore rules',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await fixture(t);
    const target = join(root, 'long synthetic source directory');
    await mkdir(target);
    await writeTestFile(target, 'one.txt', 'token');
    await writeTestFile(target, 'two.txt', 'token');
    await writeTestFile(target, 'skip.log', 'token');
    await writeTestFile(target, '.gitignore', '*.log\n');
    await writeTestFile(target, 'nested/deep/file.txt', 'token');
    const alias = join(root, 'alias');
    if (!(await trySymlink(target, alias, () => t.skip('junction unavailable')))) return;
    const short = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:FSMCP_SEARCH_SHORT_ROOT).ShortPath',
      ],
      {
        env: { ...process.env, FSMCP_SEARCH_SHORT_ROOT: target },
        encoding: 'utf8',
        windowsHide: true,
      },
    ).trim();
    if (!/~\d/u.test(basename(short))) {
      t.skip('actual 8.3 short name unavailable on fixture volume');
      return;
    }
    assert.equal(await fsPromises.realpath(short), await fsPromises.realpath(target));
    const pair = await createTestClientPair([alias, short]);
    t.after(() => pair.close());
    const observed = observe(t, root);
    for (const name of tools) {
      observed.opened.length = 0;
      const response = await pair.client.callTool({
        name,
        arguments: { ...query(name), maxDepth: 0, pageSize: 1 },
      });
      assert.notEqual(response.isError, true, firstTextBlock(response).text);
      const meta = response._meta as unknown as SearchMeta;
      assert.equal(meta.totalMatches, 2);
      assert.deepEqual(observed.opened, ['long synthetic source directory']);
      const next = continuation(firstTextBlock(response).text, name);
      const second = await pair.client.callTool({ name, arguments: next });
      assert.notEqual(second.isError, true, firstTextBlock(second).text);
      assert.equal(rows(second._meta as unknown as SearchMeta).length, 1);
    }
  },
);
