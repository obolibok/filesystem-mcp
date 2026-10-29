import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { GuardedFileSystem } from '../src/core/fs.js';
import { requestStateCodec } from '../src/core/input-required.js';
import { isSamePath } from '../src/core/path-utils.js';
import { cleanupTestRoot, createElicitationClientPair, createTestRoot } from './helpers.js';

type Op = 'create' | 'move' | 'copy' | 'delete';

describe('identity-bound destructive MCP confirmations (synthetic roots)', () => {
  let root: string;
  let serial: number;

  beforeEach(async () => {
    root = await fs.realpath(await createTestRoot());
    serial = 0;
  });
  afterEach(async () => {
    await cleanupTestRoot(root);
  });

  async function fixture(op: Op, name = 'target') {
    const target = join(root, name);
    const source = join(root, `${name}-source`);
    const directory = op === 'delete';
    const seed = async (content: string) => {
      if (directory) await fs.mkdir(target);
      await fs.writeFile(directory ? join(target, 'child.txt') : target, content);
    };
    await seed('original');
    await fs.writeFile(source, 'source bytes');
    return {
      target,
      source,
      tool: op === 'copy' ? 'move' : op,
      args:
        op === 'create'
          ? { files: [{ path: target, content: 'new bytes' }] }
          : op === 'delete'
            ? { paths: [target], recursive: true }
            : { moves: [{ source, destination: target }], copy: op === 'copy' },
      read: () => fs.readFile(directory ? join(target, 'child.txt') : target, 'utf8'),
      // Retain old entries: no inode reuse or timestamp sleeps in these tests.
      replace: async () => {
        await fs.rename(target, join(root, `saved-${++serial}`));
        await seed(`replacement-${serial}`);
      },
    };
  }

  for (const op of ['create', 'move', 'copy', 'delete'] as const) {
    const accept = op === 'delete' ? 'delete' : 'overwrite';

    for (const answer of ['approve', 'skip', 'decline'] as const) {
      it(`${op}: unchanged identity honors ${answer}`, async () => {
        const f = await fixture(op);
        let prompts = 0;
        const pair = await createElicitationClientPair([root], () => {
          prompts++;
          return answer === 'decline'
            ? { action: 'decline' }
            : { action: 'accept', content: { choice: answer === 'skip' ? 'skip' : accept } };
        });
        try {
          const result = await pair.client.callTool({ name: f.tool, arguments: f.args });
          assert.equal(prompts, 1);
          assert.equal(result.isError === true, answer === 'decline');
          if (answer !== 'approve') assert.equal(await f.read(), 'original');
          else if (op === 'delete') await assert.rejects(fs.access(f.target));
          else assert.equal(await f.read(), op === 'create' ? 'new bytes' : 'source bytes');
        } finally {
          await pair.close();
        }
      });
    }

    for (const secondChoice of ['approve', 'skip'] as const) {
      it(`${op}: a replacement gets one new prompt, then ${secondChoice}`, async () => {
        const f = await fixture(op);
        let prompts = 0;
        const pair = await createElicitationClientPair([root], async () => {
          prompts++;
          if (prompts === 1) await f.replace();
          else {
            assert.equal(prompts, 2);
            assert.equal(await f.read(), 'replacement-1', 'old answer caused no mutation');
            assert.equal(await fs.readFile(f.source, 'utf8'), 'source bytes');
          }
          return {
            action: 'accept',
            content: { choice: prompts === 2 && secondChoice === 'skip' ? 'skip' : accept },
          };
        });
        try {
          const result = await pair.client.callTool({ name: f.tool, arguments: f.args });
          assert.notEqual(result.isError, true);
          assert.equal(prompts, 2);
          if (secondChoice === 'skip') assert.equal(await f.read(), 'replacement-1');
          else if (op === 'delete') await assert.rejects(fs.access(f.target));
          else assert.equal(await f.read(), op === 'create' ? 'new bytes' : 'source bytes');
        } finally {
          await pair.close();
        }
      });
    }

    it(`${op}: a second swap cancels without a third prompt or mutation`, async () => {
      const f = await fixture(op);
      let prompts = 0;
      const pair = await createElicitationClientPair([root], async () => {
        assert.ok(++prompts <= 2);
        await f.replace();
        return { action: 'accept', content: { choice: accept } };
      });
      try {
        const result = await pair.client.callTool({ name: f.tool, arguments: f.args });
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result), /CANCELLED/);
        assert.equal(prompts, 2);
        assert.equal(await f.read(), 'replacement-2');
        assert.equal(await fs.readFile(f.source, 'utf8'), 'source bytes');
      } finally {
        await pair.close();
      }
    });

    it(`${op}: legacy path-only HMAC state cannot authorize mutation`, async (t) => {
      const f = await fixture(op);
      const mint = requestStateCodec.mint.bind(requestStateCodec);
      t.mock.method(requestStateCodec, 'mint', (...[pending, ctx]: Parameters<typeof mint>) =>
        mint({ op: pending.op, paths: pending.paths }, ctx),
      );
      const pair = await createElicitationClientPair([root], () => ({
        action: 'accept',
        content: { choice: accept },
      }));
      try {
        const result = await pair.client.callTool({ name: f.tool, arguments: f.args });
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result), /CANCELLED/);
        assert.equal(await f.read(), 'original');
      } finally {
        await pair.close();
      }
    });

    it(`${op}: foreign operation state asks afresh before reading its answer`, async (t) => {
      const f = await fixture(op);
      const mint = requestStateCodec.mint.bind(requestStateCodec);
      t.mock.method(
        requestStateCodec,
        'mint',
        (...[pending, ctx]: Parameters<typeof mint>) =>
          mint({ ...pending, op: op === 'create' ? 'copy' : 'create' }, ctx),
        { times: 1 },
      );
      let prompts = 0;
      const pair = await createElicitationClientPair([root], () => ({
        action: 'accept',
        content: { choice: ++prompts === 1 ? accept : 'skip' },
      }));
      try {
        const result = await pair.client.callTool({ name: f.tool, arguments: f.args });
        assert.notEqual(result.isError, true);
        assert.equal(prompts, 2);
        assert.equal(await f.read(), 'original');
      } finally {
        await pair.close();
      }
    });

    it(`${op}: a vanished last target cannot bypass pending-set binding`, async () => {
      const f = await fixture(op);
      const pair = await createElicitationClientPair([root], async () => {
        await fs.rename(f.target, join(root, 'vanished'));
        return { action: 'accept', content: { choice: accept } };
      });
      try {
        const result = await pair.client.callTool({ name: f.tool, arguments: f.args });
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result), /INVALID_INPUT/);
        await assert.rejects(fs.access(f.target));
        assert.equal(await fs.readFile(f.source, 'utf8'), 'source bytes');
      } finally {
        await pair.close();
      }
    });

    it(`${op}: a newly pending target rejects the old batch answers`, async () => {
      const a = await fixture(op, 'a-target');
      const b = await fixture(op, 'b-target');
      if (op === 'delete') await fs.unlink(join(b.target, 'child.txt'));
      else await fs.unlink(b.target);
      const pair = await createElicitationClientPair([root], async () => {
        await fs.writeFile(op === 'delete' ? join(b.target, 'child.txt') : b.target, 'new arrival');
        return { action: 'accept', content: { choice: accept } };
      });
      const args =
        op === 'create'
          ? {
              files: [
                { path: a.target, content: 'new' },
                { path: b.target, content: 'new' },
              ],
            }
          : op === 'delete'
            ? { paths: [a.target, b.target], recursive: true }
            : {
                moves: [
                  { source: a.source, destination: a.target },
                  { source: b.source, destination: b.target },
                ],
                copy: op === 'copy',
              };
      try {
        const result = await pair.client.callTool({ name: a.tool, arguments: args });
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result), /INVALID_INPUT/);
        assert.equal(await a.read(), 'original');
        assert.equal(await b.read(), 'new arrival');
      } finally {
        await pair.close();
      }
    });

    it(`${op}: reverse batch order keeps sorted confirmation keys attached to paths`, async () => {
      const a = await fixture(op, 'a-target');
      const z = await fixture(op, 'z-target');
      const pair = await createElicitationClientPair([root], (request) => ({
        action: 'accept',
        content: { choice: request.params.message.includes('a-target') ? 'skip' : accept },
      }));
      const args =
        op === 'create'
          ? {
              files: [
                { path: z.target, content: 'new' },
                { path: a.target, content: 'new' },
              ],
            }
          : op === 'delete'
            ? { paths: [z.target, a.target], recursive: true }
            : {
                moves: [
                  { source: z.source, destination: z.target },
                  { source: a.source, destination: a.target },
                ],
                copy: op === 'copy',
              };
      try {
        const result = await pair.client.callTool({ name: a.tool, arguments: args });
        assert.notEqual(result.isError, true);
        assert.equal(await a.read(), 'original');
        if (op === 'delete') await assert.rejects(fs.access(z.target));
        else assert.equal(await z.read(), op === 'create' ? 'new' : 'source bytes');
      } finally {
        await pair.close();
      }
    });

    it(`${op}: swap after accepted-answer planning fails at the mutation recheck`, async (t) => {
      const f = await fixture(op);
      let armed = false;
      let probes = 0;
      const pair = await createElicitationClientPair([root], () => {
        armed = true;
        return { action: 'accept', content: { choice: accept } };
      });
      if (op === 'delete') {
        const lstat = Object.getOwnPropertyDescriptor(GuardedFileSystem.prototype, 'lstat')
          ?.value as GuardedFileSystem['lstat'];
        t.mock.method(
          GuardedFileSystem.prototype,
          'lstat',
          async function (
            this: GuardedFileSystem,
            path: string,
            options: Parameters<typeof lstat>[1],
          ) {
            if (armed && isSamePath(path, f.target) && ++probes === 2) await f.replace();
            return lstat.call(this, path, options);
          },
        );
      } else {
        const mkdir = Object.getOwnPropertyDescriptor(GuardedFileSystem.prototype, 'mkdir')
          ?.value as GuardedFileSystem['mkdir'];
        t.mock.method(
          GuardedFileSystem.prototype,
          'mkdir',
          async function (
            this: GuardedFileSystem,
            path: string,
            options: Parameters<typeof mkdir>[1],
          ) {
            if (armed && probes++ === 0) await f.replace();
            return mkdir.call(this, path, options);
          },
        );
      }
      try {
        const result = await pair.client.callTool({ name: f.tool, arguments: f.args });
        assert.equal(serial, 1, `mutation hook triggered (${probes} probes)`);
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result), /CANCELLED/);
        assert.equal(await f.read(), 'replacement-1');
        assert.equal(await fs.readFile(f.source, 'utf8'), 'source bytes');
      } finally {
        await pair.close();
      }
    });
  }

  it('create: rechecks identity after writing the temporary file, before rename', async (t) => {
    const f = await fixture('create');
    let armed = false;
    const pair = await createElicitationClientPair([root], () => {
      armed = true;
      return { action: 'accept', content: { choice: 'overwrite' } };
    });
    const write = fs.writeFile;
    t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof write>) => {
      await write(...args);
      if (armed && typeof args[0] === 'string' && args[0].endsWith('.tmp')) {
        armed = false;
        await f.replace();
      }
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    try {
      const result = await pair.client.callTool({ name: f.tool, arguments: f.args });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result), /CANCELLED/);
      assert.equal(await f.read(), 'replacement-1');
      assert.equal(
        (await fs.readdir(root)).some((p) => p.endsWith('.tmp')),
        false,
      );
    } finally {
      await pair.close();
    }
  });

  it('delete: emptying the same directory still honors Skip', async () => {
    const f = await fixture('delete');
    const pair = await createElicitationClientPair([root], async () => {
      await fs.unlink(join(f.target, 'child.txt'));
      return { action: 'accept', content: { choice: 'skip' } };
    });
    try {
      const result = await pair.client.callTool({ name: f.tool, arguments: f.args });
      assert.notEqual(result.isError, true);
      assert.deepEqual(await fs.readdir(f.target), []);
    } finally {
      await pair.close();
    }
  });

  it('delete: a directory replaced by a file is prompted again', async () => {
    const f = await fixture('delete');
    let prompts = 0;
    const pair = await createElicitationClientPair([root], async () => {
      if (++prompts === 1) {
        await fs.rename(f.target, join(root, 'saved-directory'));
        await fs.writeFile(f.target, 'replacement file');
      }
      return { action: 'accept', content: { choice: prompts === 1 ? 'delete' : 'skip' } };
    });
    try {
      const result = await pair.client.callTool({ name: f.tool, arguments: f.args });
      assert.notEqual(result.isError, true);
      assert.equal(prompts, 2);
      assert.equal(await fs.readFile(f.target, 'utf8'), 'replacement file');
    } finally {
      await pair.close();
    }
  });

  it('create: disappearance of the first batch key never shifts its answer to the next', async () => {
    const a = await fixture('create', 'a-target');
    const z = await fixture('create', 'z-target');
    const pair = await createElicitationClientPair([root], async (request) => {
      if (request.params.message.includes('a-target')) {
        await fs.rename(a.target, join(root, 'vanished'));
        return { action: 'accept', content: { choice: 'overwrite' } };
      }
      return { action: 'accept', content: { choice: 'skip' } };
    });
    try {
      const result = await pair.client.callTool({
        name: 'create',
        arguments: {
          files: [
            { path: z.target, content: 'new' },
            { path: a.target, content: 'new' },
          ],
        },
      });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result), /INVALID_INPUT/);
      assert.equal(await z.read(), 'original');
      await assert.rejects(fs.access(a.target));
    } finally {
      await pair.close();
    }
  });

  it('create/copy: explicit overwrite:true keeps the no-prompt behavior', async () => {
    const pair = await createElicitationClientPair([root], () => {
      throw new Error('explicit overwrite must not prompt');
    });
    try {
      for (const op of ['create', 'copy'] as const) {
        const f = await fixture(op, op);
        const args =
          op === 'create'
            ? { files: [{ path: f.target, content: 'new bytes', overwrite: true }] }
            : { ...f.args, overwrite: true };
        const result = await pair.client.callTool({ name: f.tool, arguments: args });
        assert.notEqual(result.isError, true);
        assert.equal(await f.read(), op === 'create' ? 'new bytes' : 'source bytes');
      }
    } finally {
      await pair.close();
    }
  });
});
