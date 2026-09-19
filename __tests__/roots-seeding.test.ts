import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/client';

import * as assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import type { FilesystemServerContext } from '../src/server.js';
import { seedRootsFromClient } from '../src/transport/stdio.js';
import { cleanupTestRoot, createTestRoot, createTestServer } from './helpers.js';

describe('Client roots seeding (legacy era)', () => {
  let tmpDir: string;
  let serverCtx: FilesystemServerContext;
  let client: Client;

  before(async () => {
    tmpDir = await createTestRoot();
    await writeFile(join(tmpDir, 'a.txt'), 'hello');
    // No CLI allowed dirs: everything must come from the client's roots.
    serverCtx = await createTestServer([]);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'roots-test', version: '1.0.0' }, { capabilities: { roots: {} } });
    client.setRequestHandler('roots/list', () => ({
      roots: [
        { uri: pathToFileURL(tmpDir).href, name: 'workspace' },
        // Unsafe root: must be refused by applyGrant's guards. (A non-file://
        // uri never reaches seeding — the SDK rejects the whole roots/list
        // result at the wire, so only file:// roots can arrive.)
        { uri: pathToFileURL(homedir()).href, name: 'home' },
      ],
    }));
    await Promise.all([client.connect(clientTransport), serverCtx.mcp.connect(serverTransport)]);
  });

  after(async () => {
    await client.close();
    serverCtx.disposeRuntimeState();
    await serverCtx.mcp.close();
    await cleanupTestRoot(tmpDir);
  });

  it('TC-ROOTS-001: grants declared file:// roots, refuses unsafe roots', async () => {
    const file = join(tmpDir, 'a.txt');
    // Before seeding: nothing allowed.
    await assert.rejects(serverCtx.pathGuard.validateExistingPath(file));

    const granted = await seedRootsFromClient(serverCtx);
    assert.equal(granted, 1);

    // The declared workspace root now validates; home was refused.
    await serverCtx.pathGuard.validateExistingPath(file);
    await assert.rejects(serverCtx.pathGuard.validateExistingPath(join(homedir(), '.gitconfig')));
  });

  it('TC-ROOTS-002: re-seeding is idempotent', async () => {
    // Establish the state inside this test rather than relying on TC-ROOTS-001
    // having run first (test-name filtering may select this case alone).
    assert.equal(await seedRootsFromClient(serverCtx), 1);
    const before = serverCtx.pathGuard.getAllowedDirectories();

    // Every root is now already granted or refused: the visible access set
    // must remain byte-for-byte stable even when it contains requested+real
    // aliases for one logical root.
    const granted = await seedRootsFromClient(serverCtx);
    assert.equal(granted, 1); // a repeated accepted grant still reports true
    const after = serverCtx.pathGuard.getAllowedDirectories();
    assert.deepStrictEqual(after, before);
  });
});
