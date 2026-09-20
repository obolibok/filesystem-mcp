import assert from 'node:assert/strict';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { ErrorCode } from '../src/core/errors.js';
import { extractPath } from '../src/core/file-uri.js';
import { GuardedFileSystem } from '../src/core/fs.js';
import { isSamePath } from '../src/core/path-utils.js';
import type { TestClientContext } from './helpers.js';
import {
  cleanupTestRoot,
  createTestClientPair,
  createTestRoot,
  firstTextBlock,
  trySymlink,
  waitFor,
  withBoundary,
} from './helpers.js';

interface EmbeddedBlock {
  type: 'resource';
  resource: { uri: string; mimeType?: string; blob?: string };
}

interface LinkBlock {
  type: 'resource_link';
  uri: string;
  name: string;
  mimeType?: string;
  size?: number;
}

function embeddedBlock(result: { content: readonly unknown[] }): EmbeddedBlock {
  const block = result.content.find(
    (candidate) => (candidate as { type?: string }).type === 'resource',
  ) as EmbeddedBlock | undefined;
  assert.ok(block, 'expected an embedded MCP resource');
  return block;
}

function linkBlock(result: { content: readonly unknown[] }): LinkBlock {
  const block = result.content.find(
    (candidate) => (candidate as { type?: string }).type === 'resource_link',
  ) as LinkBlock | undefined;
  assert.ok(block, 'expected an MCP resource link');
  return block;
}

describe('get_file tool', () => {
  let root: string;
  let outsideRoot: string;
  let harness: TestClientContext;

  before(async () => {
    root = await createTestRoot();
    outsideRoot = await createTestRoot();
    harness = await withBoundary(root, () => createTestClientPair([root], { readOnly: true }));
  });

  after(async () => {
    if (harness) await harness.close();
    if (root) await cleanupTestRoot(root);
    if (outsideRoot) await cleanupTestRoot(outsideRoot);
  });

  it('GET-FILE-001: read-only inventory returns byte-exact embedded content and a matching link', async () => {
    const filePath = join(root, 'original.bin');
    const bytes = Buffer.from(Array.from({ length: 256 }, (_value, index) => index));
    await writeFile(filePath, bytes);

    const listed = await harness.client.listTools();
    const definition = listed.tools.find((tool) => tool.name === 'get_file');
    assert.ok(definition, 'get_file must be registered in read-only mode');
    assert.strictEqual(definition.annotations?.readOnlyHint, true);

    const result = await harness.client.callTool({
      name: 'get_file',
      arguments: { path: filePath },
    });

    assert.notStrictEqual(result.isError, true);
    assert.match(firstTextBlock(result).text ?? '', /byte-exact MCP embedded resource/);
    assert.doesNotMatch(firstTextBlock(result).text ?? '', /data:|base64/i);

    const embedded = embeddedBlock(result);
    const link = linkBlock(result);
    assert.ok(embedded.resource.blob);
    assert.deepStrictEqual(Buffer.from(embedded.resource.blob, 'base64'), bytes);
    assert.strictEqual(link.uri, embedded.resource.uri);
    assert.strictEqual(link.name, basename(filePath));
    assert.strictEqual(link.mimeType, embedded.resource.mimeType);
    assert.strictEqual(link.size, bytes.length);

    const metadata = result._meta as {
      size?: number;
      encodedSize?: number;
      resourceUri?: string;
      delivery?: string;
    };
    assert.strictEqual(metadata.size, bytes.length);
    assert.strictEqual(metadata.encodedSize, 4 * Math.ceil(bytes.length / 3));
    assert.strictEqual(metadata.encodedSize, embedded.resource.blob.length);
    assert.strictEqual(metadata.resourceUri, embedded.resource.uri);
    assert.strictEqual(metadata.delivery, 'mcp-embedded-resource');

    const xlsPath = join(root, 'legacy.xls');
    await writeFile(xlsPath, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    const xlsResult = await harness.client.callTool({
      name: 'get_file',
      arguments: { path: xlsPath },
    });
    assert.strictEqual(embeddedBlock(xlsResult).resource.mimeType, 'application/vnd.ms-excel');
  });

  it('GET-FILE-002: outside-root and traversal inputs fail without resource content', async () => {
    const outside = join(outsideRoot, 'outside.bin');
    await writeFile(outside, Buffer.from('outside'));

    const denied = await harness.client.callTool({
      name: 'get_file',
      arguments: { path: outside },
    });
    assert.strictEqual(denied.isError, true);
    assert.match(firstTextBlock(denied).text ?? '', new RegExp(ErrorCode.ACCESS_DENIED));
    assert.strictEqual(
      denied.content.some((block) => block.type === 'resource' || block.type === 'resource_link'),
      false,
    );

    const traversal = await harness.client.callTool({
      name: 'get_file',
      arguments: {
        path: `${root}${sep}..${sep}${basename(outsideRoot)}${sep}outside.bin`,
      },
    });
    assert.strictEqual(traversal.isError, true);
    assert.match(firstTextBlock(traversal).text ?? '', /traversal|\.\./i);
    assert.strictEqual(
      traversal.content.some(
        (block) => block.type === 'resource' || block.type === 'resource_link',
      ),
      false,
    );
  });

  it('GET-FILE-003: canonical in-root symlinks resolve and escaping symlinks are denied', async (t) => {
    const targetDir = join(root, 'canonical-target');
    const target = join(targetDir, 'canonical.bin');
    const insideLink = join(root, 'inside-link');
    const outside = join(outsideRoot, 'escape-target.bin');
    const escapeLink = join(root, 'escape-link');
    await mkdir(targetDir);
    await writeFile(target, Buffer.from('inside'));
    await writeFile(outside, Buffer.from('outside'));

    if (!(await trySymlink(targetDir, insideLink, () => t.skip()))) return;
    if (!(await trySymlink(outsideRoot, escapeLink, () => t.skip()))) return;

    const allowed = await harness.client.callTool({
      name: 'get_file',
      arguments: { path: join(insideLink, 'canonical.bin') },
    });
    assert.notStrictEqual(allowed.isError, true);
    const uriPath = extractPath(embeddedBlock(allowed).resource.uri);
    assert.ok(uriPath);
    assert.ok(isSamePath(uriPath, await realpath(target)));

    const denied = await harness.client.callTool({
      name: 'get_file',
      arguments: { path: join(escapeLink, 'escape-target.bin') },
    });
    assert.strictEqual(denied.isError, true);
    assert.match(firstTextBlock(denied).text ?? '', new RegExp(ErrorCode.ACCESS_DENIED));
  });

  it('GET-FILE-004: raw size limit rejects before any embedded bytes are returned', async () => {
    const filePath = join(root, 'too-large.bin');
    const limit = 1024 * 1024;
    await writeFile(filePath, Buffer.alloc(limit + 1, 0x5a));
    const previous = process.env['FS_MAX_FILE_SIZE'];
    process.env['FS_MAX_FILE_SIZE'] = String(limit);
    try {
      const result = await harness.client.callTool({
        name: 'get_file',
        arguments: { path: filePath },
      });
      assert.strictEqual(result.isError, true);
      assert.match(firstTextBlock(result).text ?? '', new RegExp(ErrorCode.TOO_LARGE));
      assert.match(
        firstTextBlock(result).text ?? '',
        new RegExp(`${String(limit + 1)} > ${String(limit)} bytes`),
      );
      assert.strictEqual(
        result.content.some((block) => block.type === 'resource' || block.type === 'resource_link'),
        false,
      );
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, 'FS_MAX_FILE_SIZE');
      else process.env['FS_MAX_FILE_SIZE'] = previous;
    }
  });

  it('GET-FILE-005: client cancellation reaches the guarded raw read', async () => {
    const filePath = join(root, 'cancel.bin');
    await writeFile(filePath, Buffer.from('cancel me'));

    // eslint-disable-next-line @typescript-eslint/unbound-method -- restore the exact prototype method after the cancellation probe.
    const original = GuardedFileSystem.prototype.readRaw;
    let observedSignal: AbortSignal | undefined;
    let enteredResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });

    GuardedFileSystem.prototype.readRaw = async function (_path, options) {
      observedSignal = options?.signal;
      enteredResolve?.();
      await Promise.race([
        new Promise<never>((_resolve, reject) => {
          const signal = options?.signal;
          if (!signal) return;
          const abortError = () =>
            signal.reason instanceof Error ? signal.reason : new Error('readRaw was aborted');
          if (signal.aborted) reject(abortError());
          else signal.addEventListener('abort', () => reject(abortError()), { once: true });
        }),
        delay(1000).then(() => {
          throw new Error('request cancellation did not reach readRaw');
        }),
      ]);
      throw new Error('unreachable');
    };

    const controller = new AbortController();
    try {
      const pending = harness.client.callTool(
        { name: 'get_file', arguments: { path: filePath } },
        { signal: controller.signal },
      );
      await entered;
      controller.abort(new DOMException('test cancellation', 'AbortError'));
      await assert.rejects(pending);
      await waitFor(() => observedSignal?.aborted === true);
      assert.strictEqual(observedSignal?.aborted, true);
    } finally {
      GuardedFileSystem.prototype.readRaw = original;
    }
  });
});
