import assert from 'node:assert/strict';
import { join } from 'node:path';
import { it, type TestContext } from 'node:test';

import {
  cleanupTestRoot,
  createTestClientPair,
  createTestRoot,
  firstTextBlock,
  writeTestFile,
} from './helpers.js';

interface Match {
  file: string;
  line: number;
  column: number;
  content: string;
  clippedBefore?: true;
  clippedAfter?: true;
  matchClipped?: true;
  before?: string[];
  after?: string[];
}

interface SearchMeta {
  matches: Match[];
  totalMatches: number;
  stoppedReason?: string;
  contextReduced?: true;
  nextCursor?: string;
  resourceUri?: string;
}

async function fixture(t: TestContext) {
  const root = await createTestRoot();
  const scratch = await createTestRoot();
  const previous = process.env['FS_SNAPSHOT_DIR'];
  process.env['FS_SNAPSHOT_DIR'] = scratch;
  t.after(async () => {
    if (previous === undefined) Reflect.deleteProperty(process.env, 'FS_SNAPSHOT_DIR');
    else process.env['FS_SNAPSHOT_DIR'] = previous;
    await cleanupTestRoot(root);
    await cleanupTestRoot(scratch);
  });
  const pair = await createTestClientPair([root], { readOnly: true });
  t.after(() => pair.close());
  return { root, ...pair };
}

function checkPage(result: {
  isError?: boolean | undefined;
  content: readonly unknown[];
  _meta?: unknown;
}) {
  const text = firstTextBlock(result).text ?? '';
  assert.notEqual(result.isError, true, text);
  assert(text.isWellFormed(), 'UTF-8 must not require replacing split surrogate pairs');
  const bytes =
    Buffer.byteLength(text, 'utf8') +
    result.content
      .slice(1)
      .reduce<number>((sum, block) => sum + Buffer.byteLength(JSON.stringify(block), 'utf8'), 0);
  assert(bytes <= 16384, `Page has ${String(bytes)} bytes`);
  const meta = result._meta as SearchMeta;
  for (const match of meta.matches) {
    for (const line of [match.content, ...(match.before ?? []), ...(match.after ?? [])]) {
      assert(line.isWellFormed());
      assert(Array.from(line).length <= 500);
    }
  }
  return { text, meta };
}

function continuation(text: string): Record<string, unknown> {
  const json = text.split('Next page: search_text ')[1];
  assert(json);
  return JSON.parse(json) as Record<string, unknown>;
}

it('search_text bounds realistic .mbt output and retains original coordinates and originals', async (t) => {
  const { root, client } = await fixture(t);
  const line = '1234567890 '.repeat(2636) + '9160';
  await Promise.all(
    Array.from({ length: 9 }, (_, i) =>
      writeTestFile(root, `sample-${String(i)}.mbt`, `header\n${line}\ntrailer\n`),
    ),
  );
  const shortLines = ['Short reference 9160', '9160 notes'] as const;
  await writeTestFile(root, 'a.txt', shortLines[0] + '\n');
  await writeTestFile(root, 'b.txt', shortLines[1] + '\n');
  const name = 'search_text';
  const page = checkPage(
    await client.callTool({ name, arguments: { path: root, searchPattern: '9160', limit: 60 } }),
  );
  assert.equal(page.meta.totalMatches, 11);
  assert.equal(page.meta.nextCursor, undefined);
  assert.deepEqual(
    page.meta.matches.filter((match) => match.file.endsWith('.txt')).map((match) => match.content),
    shortLines,
  );
  const mbt = page.meta.matches.filter((match) => match.file.endsWith('.mbt'));
  assert.equal(mbt.length, 9);
  for (const match of mbt) {
    assert.equal(match.line, 2);
    assert.equal(match.column, 28996);
    assert(match.content.endsWith('9160'));
    assert.equal(match.clippedBefore, true);
    assert.equal(match.clippedAfter, undefined);
    assert.match(page.text, /9160 \[column 28996, left clipped\]/u);
  }

  const file = join(root, 'sample-0.mbt');
  const single = checkPage(
    await client.callTool({ name, arguments: { path: file, searchPattern: '9160', limit: 1 } }),
  );
  assert.deepEqual(single.meta.matches, [mbt[0]]);
  assert.equal(single.meta.stoppedReason, 'limit');
  const match = single.meta.matches[0];
  assert(match);
  const path = join(root, match.file);
  const read = await client.callTool({
    name: 'read',
    arguments: { path, startLine: match.line, endLine: match.line },
  });
  assert.notEqual(read.isError, true, firstTextBlock(read).text);
  assert(firstTextBlock(read).text?.includes(line));
  const original = await client.callTool({ name: 'get_file', arguments: { path } });
  assert.notEqual(original.isError, true, firstTextBlock(original).text);
  const embedded = original.content.find((block) => block.type === 'resource');
  assert(embedded?.type === 'resource' && 'blob' in embedded.resource);
  assert.equal(
    Buffer.from(embedded.resource.blob, 'base64').toString('utf8'),
    `header\n${line}\ntrailer\n`,
  );
});

it('search_text clips around Unicode matches and marks clipping of the match itself', async (t) => {
  const { root, client } = await fixture(t);
  const prefix = '🙂Жä'.repeat(240);
  const contextLine = 'Ä🙂ю'.repeat(230);
  const longMatch = 'X' + 'яä🙂'.repeat(220) + 'Y';
  const short = '🙂'.repeat(300) + '9160';
  const name = 'search_text';
  const path = await writeTestFile(
    root,
    'unicode.txt',
    [
      contextLine,
      prefix + '9160' + prefix,
      contextLine,
      prefix + longMatch + prefix,
      contextLine,
      short,
    ].join('\n'),
  );
  const literal = checkPage(
    await client.callTool({ name, arguments: { path, searchPattern: '9160', context: 1 } }),
  );
  const [middle, last] = literal.meta.matches;
  assert(middle && last);
  assert.equal(middle.column, prefix.length);
  assert.equal(Array.from(middle.content).length, 500);
  assert(middle.content.includes('9160'));
  assert.equal(middle.clippedBefore, true);
  assert.equal(middle.clippedAfter, true);
  assert.equal(middle.matchClipped, undefined);
  assert.match(literal.text, /left clipped, right clipped/u);
  for (const line of [...(middle.before ?? []), ...(middle.after ?? [])]) {
    assert.equal(Array.from(line).length, 500);
    assert(line.endsWith('…'));
  }
  assert.equal(last.content, short);
  assert.equal(last.clippedBefore, undefined);
  assert.equal(last.clippedAfter, undefined);

  const regex = checkPage(
    await client.callTool({
      name,
      arguments: { path, searchPattern: 'X(?:яä🙂){220}Y', isRegex: true, context: 1 },
    }),
  );
  const [fragment] = regex.meta.matches;
  assert(fragment);
  assert.equal(fragment.column, prefix.length);
  assert.equal(fragment.content, Array.from(longMatch).slice(0, 500).join(''));
  assert.equal(fragment.matchClipped, true);
  assert.match(regex.text, /match clipped/u);
});

it('search_text prioritizes matching rows and replays all collected results within the byte budget', async (t) => {
  const { root, client } = await fixture(t);
  const neighboring = 'Ä🙂ю'.repeat(240);
  const line = '🙂'.repeat(296) + '9160' + '🙂'.repeat(296);
  const path = await writeTestFile(
    root,
    'pages.txt',
    Array.from({ length: 60 }, () => [neighboring, line, neighboring].join('\n')).join('\n'),
  );
  const name = 'search_text';
  const args = { path, searchPattern: '9160', pageSize: 10000, limit: 100 };
  const withoutContext = checkPage(await client.callTool({ name, arguments: args }));
  let page = checkPage(await client.callTool({ name, arguments: { ...args, context: 10 } }));
  assert(page.meta.matches.length < page.meta.totalMatches);
  assert.equal(page.meta.matches.length, withoutContext.meta.matches.length);
  assert.equal(page.meta.contextReduced, true);
  assert.match(page.text, /Context reduced to fit the page/u);
  assert(page.meta.resourceUri);
  const originalResource = await client.readResource({ uri: page.meta.resourceUri });
  const stored = originalResource.contents[0];
  assert(stored && 'text' in stored);
  const collected = (JSON.parse(stored.text) as SearchMeta).matches;
  assert.equal(collected.length, 60);
  assert(collected.every((match) => Array.from(match.content).length === 500));
  const seen: number[] = [];
  for (;;) {
    assert.equal(page.meta.totalMatches, 60);
    assert.equal(page.meta.stoppedReason, undefined);
    seen.push(...page.meta.matches.map((match) => match.line));
    if (!page.meta.nextCursor) break;
    assert(seen.length < 60);
    const next = continuation(page.text);
    assert.equal(next['cursor'], page.meta.nextCursor);
    page = checkPage(await client.callTool({ name, arguments: next }));
    assert.equal(page.meta.resourceUri, undefined);
  }
  assert.deepEqual(
    seen,
    Array.from({ length: 60 }, (_, i) => i * 3 + 2),
  );
});

it('search_text emits a replayable compact cursor for a maximum-length escaped Unicode query', async (t) => {
  const { root, client, serverCtx } = await fixture(t);
  const searchPattern = '[' + '\tä'.repeat(4999) + ']';
  assert.equal(searchPattern.length, 10000);
  assert(Buffer.byteLength(JSON.stringify(searchPattern), 'utf8') > 16384);
  const path = await writeTestFile(root, 'long-query.txt', 'ä\nä\n');
  const name = 'search_text';
  const page = checkPage(
    await client.callTool({
      name,
      arguments: { path, searchPattern, isRegex: true, pageSize: 1, includeHidden: true },
    }),
  );
  assert.equal(page.meta.totalMatches, 2);
  assert(page.meta.nextCursor);
  const next = continuation(page.text);
  assert.deepEqual(next, { cursor: page.meta.nextCursor, pageSize: 1 });
  const resumed = checkPage(await client.callTool({ name, arguments: next }));
  assert.deepEqual(
    resumed.meta.matches.map((match) => match.line),
    [2],
  );
  assert.equal(resumed.meta.nextCursor, undefined);

  const mismatch = await client.callTool({
    name,
    arguments: { ...next, path, searchPattern, isRegex: true, includeHidden: false },
  });
  assert(mismatch.isError);
  assert.match(firstTextBlock(mismatch).text ?? '', /Invalid cursor/u);

  await assert.rejects(async () => {
    const rejected = await client.callTool({ name, arguments: { ...next, includeHidden: false } });
    if (rejected.isError) throw new Error(firstTextBlock(rejected).text);
  }, /includeHidden/u);

  await writeTestFile(root, 'no-match.txt', 'ordinary text\n');
  const noMatch = checkPage(
    await client.callTool({
      name,
      arguments: { path: join(root, 'no-match.txt'), searchPattern, isRegex: true },
    }),
  );
  assert.equal(noMatch.meta.totalMatches, 0);
  assert.match(noMatch.text, /^No matches for '.*…'/u);

  const otherTool = await client.callTool({
    name: 'find_files',
    arguments: { path: root, pattern: '**/*.txt', pageSize: 1 },
  });
  assert.notEqual(otherTool.isError, true, firstTextBlock(otherTool).text);
  const otherCursor = (otherTool._meta as { nextCursor?: string }).nextCursor;
  assert(otherCursor);
  const crossTool = await client.callTool({ name, arguments: { cursor: otherCursor } });
  assert(crossTool.isError);
  assert.match(firstTextBlock(crossTool).text ?? '', /Invalid cursor/u);

  const outside = await createTestRoot();
  t.after(() => cleanupTestRoot(outside));
  serverCtx.pathGuard.initialize([outside]);
  const denied = await client.callTool({ name, arguments: next });
  assert(denied.isError);
  assert.match(firstTextBlock(denied).text ?? '', /ACCESS_DENIED/u);
});

it('search_text can page results when optional cached JSON exceeds the resource limit', async (t) => {
  const { root, client } = await fixture(t);
  const line = '🙂'.repeat(500) + 'token';
  const path = await writeTestFile(
    root,
    'resource-limit.txt',
    Array.from({ length: 300 }, () => line).join('\n'),
  );
  const name = 'search_text';
  const first = checkPage(
    await client.callTool({
      name,
      arguments: { path, searchPattern: 'token', context: 10, pageSize: 10000 },
    }),
  );
  assert.equal(first.meta.totalMatches, 300);
  assert(first.meta.nextCursor);
  assert.equal(first.meta.resourceUri, undefined);
  const second = checkPage(await client.callTool({ name, arguments: continuation(first.text) }));
  assert.equal(second.meta.matches[0]?.line, first.meta.matches.length + 1);
});

it('search_text bounds large RE2 diagnostics and preserves the ordinary error', async (t) => {
  const { root, client } = await fixture(t);
  const path = await writeTestFile(root, 'regex-error.txt', 'test\n');
  const name = 'search_text';
  const small = await client.callTool({
    name,
    arguments: { path, searchPattern: '[', isRegex: true },
  });
  assert.equal(small.isError, true);
  const smallText = firstTextBlock(small).text ?? '';
  assert.match(smallText, /^UNKNOWN: .*missing \]/u);
  assert.doesNotMatch(smallText, /error text clipped/u);

  const searchPattern = '[' + 'ä'.repeat(9999);
  const large = await client.callTool({ name, arguments: { path, searchPattern, isRegex: true } });
  assert.equal(large.isError, true);
  const text = firstTextBlock(large).text ?? '';
  assert(text.isWellFormed());
  assert(Buffer.byteLength(text, 'utf8') <= 16384);
  assert.match(text, /^UNKNOWN: /u);
  assert.match(text, /\[error text clipped\]$/u);
});
