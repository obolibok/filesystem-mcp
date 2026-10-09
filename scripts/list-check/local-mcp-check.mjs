import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Self-contained synthetic stdio smoke. Source and scratch are distinct, and
// only the source is granted. No installed server, tunnel or caller roots.
const base = await mkdtemp(join(tmpdir(), 'fsmcp-list-check-'));
const root = join(base, 'source');
const repo = resolve(import.meta.dirname, '..', '..');
try {
  await mkdir(root);
  for (let b = 0; b < 3; b++)
    for (let n = 0; n < 10; n++) {
      const dir = join(root, `branch-${String(b)}`, `nested-${String(n)}`);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'a.txt'), 'synthetic');
      await writeFile(join(dir, 'b.txt'), 'synthetic');
      await writeFile(join(dir, '.gitignore'), '*.log\n');
    }
  for (let i = 0; i < 1005; i++) await writeFile(join(root, `file-${String(i)}.txt`), 'synthetic');
  for (const readOnly of [false, true]) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        join(repo, 'dist/index.js'),
        ...(readOnly ? ['--read-only'] : []),
        '--root-boundary',
        root,
        root,
      ],
      cwd: repo,
      env: {
        ...getDefaultEnvironment(),
        FS_SNAPSHOT_DIR: join(base, readOnly ? 'scratch-ro' : 'scratch-full'),
        LOG_LEVEL: 'error',
      },
    });
    const client = new Client({ name: 'bounded-list-check', version: '1' });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      assert.equal(tools.length, readOnly ? 13 : 19);
      const schema = tools.find((tool) => tool.name === 'list')?.inputSchema.properties;
      assert.equal(schema?.limit?.default, 20000);
      assert.equal(schema?.pageSize?.default, 1000);
      assert.equal(schema?.maxEntries, undefined);
      const defaults = await client.callTool({ name: 'list', arguments: {} });
      assert.notEqual(defaults.isError, true);
      assert.equal(defaults.structuredContent, undefined);
      assert.equal(defaults._meta.limit, 20000);
      assert.equal(defaults._meta.entryCount, 1000);
      assert.equal(defaults._meta.totalEntries, 1008);
      assert.equal(defaults._meta.truncated, false);
      const args = {
        path: root,
        maxDepth: 1,
        includeHidden: true,
        includeIgnored: false,
        limit: 100,
        pageSize: 25,
      };
      const first = await client.callTool({ name: 'list', arguments: args });
      assert.notEqual(first.isError, true);
      assert(first._meta.resourceUri);
      const resource = await client.readResource({ uri: first._meta.resourceUri });
      const stored = JSON.parse(resource.contents[0].text);
      const entries = [];
      const pageSizes = [];
      let result = first;
      for (;;) {
        const meta = result._meta;
        assert.equal(meta.limit, 100);
        assert.equal(meta.totalEntries, 100);
        assert.equal(meta.truncated, true);
        assert.equal(meta.stoppedReason, 'limit');
        assert(result.content[0].text.startsWith('// list stopped at limit=100;'));
        entries.push(...meta.entries);
        assert(entries.length <= 100, 'continuation must advance');
        pageSizes.push(meta.entryCount);
        if (!meta.nextCursor) break;
        const continuation =
          /^\/\/ showing \d+-\d+ of \d+ entries\. Next page: list (\{.*\})$/m.exec(
            result.content[0].text,
          );
        assert(continuation?.[1]);
        // Execute the literal text command: no manual reconstruction of scope.
        result = await client.callTool({ name: 'list', arguments: JSON.parse(continuation[1]) });
        assert.notEqual(result.isError, true);
        assert.equal(result._meta.resourceUri, undefined);
      }
      assert.equal(entries.length, 100);
      assert.equal(new Set(entries.map((entry) => entry.relativePath)).size, 100);
      assert.deepEqual(pageSizes, [25, 25, 25, 25]);
      assert.deepEqual(stored.entries, entries);
      assert.equal(stored.truncated, true);
      assert.equal(stored.stoppedReason, 'limit');
      assert(!result.content[0].text.includes('Next page:'));
      const removed = await client.callTool({
        name: 'list',
        arguments: { path: root, maxEntries: 1 },
      });
      assert.equal(removed.isError, true);
      assert(removed.content[0].text.includes('maxEntries'));
      console.log(
        JSON.stringify({
          profile: readOnly ? 'read-only' : 'full',
          tools: tools.length,
          catalogChars: JSON.stringify(tools).length,
          defaultPage: defaults._meta.entryCount,
          defaultCollected: defaults._meta.totalEntries,
          limit: 100,
          pageSizes,
          uniqueEntries: entries.length,
          truncated: true,
          stoppedReason: 'limit',
          resourceMatches: true,
          lastPageWarns: true,
          maxEntriesRejected: true,
          status: 'PASS',
        }),
      );
    } finally {
      await client.close();
      await transport.close();
    }
  }
} finally {
  await rm(base, { recursive: true, force: true });
}
