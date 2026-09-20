import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, stat, symlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';

import { checkRejection, prepareDeliveryDirectory, readEmbeddedFile } from './local-mcp-check.mjs';

test('repeat get_file calls reach the MCP server and return fresh embedded bytes', async () => {
  const client = new Client(
    { name: 'delivery-regression', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  const server = new McpServer({ name: 'tool-fixture', version: '1.0.0' });
  const file = '/synthetic/original.bin';
  const uri = `filesystem-mcp://file/${file}`;
  let reads = 0;
  server.registerTool('get_file', { description: 'fixture', inputSchema: {} }, () => {
    const bytes = Buffer.from(String(++reads));
    const blob = bytes.toString('base64');
    return {
      content: [
        { type: 'resource', resource: { uri, blob } },
        { type: 'resource_link', uri, name: 'original.bin', size: bytes.length },
      ],
      _meta: {
        size: bytes.length,
        encodedSize: blob.length,
        resourceUri: uri,
        delivery: 'mcp-embedded-resource',
      },
    };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    assert.equal((await readEmbeddedFile(client, file)).bytes.toString(), '1');
    assert.equal((await readEmbeddedFile(client, file)).bytes.toString(), '2');
    assert.equal(reads, 2);
  } finally {
    await client.close();
    await server.close();
  }
});

test('negative controls accept only the expected protocol rejection', async () => {
  const cases = [
    ['TOO_LARGE', 'File exceeds size limit (1048577 > 1048576 bytes)'],
    ['ACCESS_DENIED', 'Outside allowed directories.'],
  ];
  for (const [expectedCode, expectedMessage] of cases) {
    const rejectedClient = (result) => ({
      callTool: async () => result,
    });
    const expectedResult = {
      isError: true,
      content: [{ type: 'text', text: `${expectedCode}: ${expectedMessage}` }],
    };
    assert.equal(
      (
        await checkRejection(
          rejectedClient(expectedResult),
          '/file.bin',
          expectedCode,
          expectedMessage,
        )
      ).status,
      'PASS',
    );
    for (const unexpected of [
      { isError: true, content: [{ type: 'text', text: `NOT_FOUND: ${expectedMessage}` }] },
      { isError: true, content: [{ type: 'text', text: `${expectedCode}: other` }] },
      { content: [{ type: 'text', text: `${expectedCode}: ${expectedMessage}` }] },
      {
        isError: true,
        content: [
          { type: 'text', text: `${expectedCode}: ${expectedMessage}` },
          { type: 'resource', resource: { uri: '/file.bin', blob: 'Ynl0ZXM=' } },
        ],
      },
    ]) {
      assert.equal(
        (
          await checkRejection(
            rejectedClient(unexpected),
            '/file.bin',
            expectedCode,
            expectedMessage,
          )
        ).status,
        'FAIL',
      );
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
