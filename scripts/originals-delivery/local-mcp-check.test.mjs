import {
  Client,
  InMemoryTransport,
  ProtocolError,
  ProtocolErrorCode,
} from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, stat, symlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';

import { checkRejection, prepareDeliveryDirectory, readBlob } from './local-mcp-check.mjs';

test('repeat reads reach the MCP server despite a fresh SDK resource cache', async () => {
  const client = new Client(
    { name: 'delivery-regression', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' }, defaultCacheTtlMs: 60_000 },
  );
  const server = new McpServer({ name: 'cached-fixture', version: '1.0.0' });
  const file = '/synthetic/original.bin';
  const uri = `filesystem-mcp://file/${file}`;
  let reads = 0;
  server.registerResource(
    'original',
    uri,
    { cacheHint: { ttlMs: 60_000, cacheScope: 'public' } },
    () => ({
      contents: [{ uri, blob: Buffer.from(String(++reads)).toString('base64') }],
    }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    await client.readResource({ uri });
    await client.readResource({ uri });
    assert.equal(reads, 1, 'the real SDK must first demonstrate a fresh cache hit');
    assert.equal((await readBlob(client, file)).bytes.toString(), '2');
    assert.equal((await readBlob(client, file)).bytes.toString(), '3');
    assert.equal(reads, 3);
  } finally {
    await client.close();
    await server.close();
  }
});

test('negative controls accept only the expected protocol rejection', async () => {
  const tooLarge = 'File exceeds size limit (1048577 > 1048576 bytes)';
  const outside = 'Outside allowed directories.';
  for (const expected of [tooLarge, outside]) {
    const rejectedClient = (error) => ({
      readResource: async () => {
        throw error;
      },
    });
    const expectedError = new ProtocolError(ProtocolErrorCode.InvalidParams, expected);
    assert.equal(
      (await checkRejection(rejectedClient(expectedError), '/file.bin', expected)).status,
      'PASS',
    );
    for (const unexpected of [
      new ProtocolError(ProtocolErrorCode.InvalidParams, 'File not found'),
      new ProtocolError(ProtocolErrorCode.InternalError, expected),
      new Error('Connection closed'),
      new assert.AssertionError({ message: 'Expected a blob' }),
    ]) {
      assert.equal(
        (await checkRejection(rejectedClient(unexpected), '/file.bin', expected)).status,
        'FAIL',
      );
    }
    for (const content of [{ text: 'read succeeded' }, { blob: 'Ynl0ZXM=' }]) {
      const client = {
        readResource: async () => ({ contents: [{ uri: '/file.bin', ...content }] }),
      };
      assert.equal((await checkRejection(client, '/file.bin', expected)).status, 'FAIL');
    }
  }
});

test('delivery rejects source children and canonical aliases before creating output', async () => {
  const scratch = resolve(import.meta.dirname, '..', '..', '.tmp');
  await mkdir(scratch, { recursive: true });
  const temp = await mkdtemp(join(scratch, 'delivery-regression-'));
  try {
    const source = join(temp, 'source');
    await mkdir(source);
    for (const destination of [source, join(source, 'child'), join(source, '..delivered')]) {
      await assert.rejects(
        prepareDeliveryDirectory(source, destination),
        /outside the source fixture root/,
      );
    }
    await assert.rejects(stat(join(source, 'child')), { code: 'ENOENT' });
    await assert.rejects(stat(join(source, '..delivered')), { code: 'ENOENT' });

    const alias = join(temp, 'source-alias');
    await symlink(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(
      prepareDeliveryDirectory(source, alias),
      /outside the source fixture root/,
    );
    await assert.rejects(
      prepareDeliveryDirectory(source, join(alias, 'child')),
      /outside the source fixture root/,
    );
    await assert.rejects(stat(join(source, 'child')), { code: 'ENOENT' });

    const sibling = join(temp, 'delivered', 'nested');
    assert.equal(await prepareDeliveryDirectory(source, sibling), await realpath(sibling));
  } finally {
    const withinScratch = relative(scratch, temp);
    assert.ok(
      withinScratch &&
        withinScratch !== '..' &&
        !withinScratch.startsWith(`..${sep}`) &&
        !isAbsolute(withinScratch),
    );
    await rm(temp, { recursive: true, force: true });
  }
});
