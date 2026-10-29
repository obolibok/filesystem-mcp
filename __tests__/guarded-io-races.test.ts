import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants, type Stats } from 'node:fs';
import fsPromises from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, type TestContext } from 'node:test';

import { GuardedFileSystem } from '../src/core/fs.js';
import { isSamePath } from '../src/core/path-utils.js';
import { PathGuard } from '../src/core/path.js';
import { readFileWithStats } from '../src/core/read.js';
import {
  cleanupTestRoot,
  createElicitationClientPair,
  createTestClientPair,
  createTestRoot,
  trySymlink,
} from './helpers.js';

describe('guarded I/O races (synthetic roots)', () => {
  let root: string;
  let outside: string;
  let guard: PathGuard;
  let fs: GuardedFileSystem;

  beforeEach(async () => {
    root = await fsPromises.realpath(await createTestRoot());
    outside = await fsPromises.realpath(await createTestRoot());
    guard = new PathGuard();
    guard.initialize([root]);
    fs = new GuardedFileSystem(guard);
  });

  afterEach(async () => {
    await cleanupTestRoot(root);
    await cleanupTestRoot(outside);
  });

  async function linkSupported(t: TestContext): Promise<boolean> {
    const probe = join(root, 'probe');
    if (!(await trySymlink(outside, probe, () => t.skip('file symlinks not permitted'), 'file'))) {
      return false;
    }
    await fsPromises.unlink(probe);
    return true;
  }

  it('raw original read refuses a final symlink installed after validation', async (t) => {
    if (!(await linkSupported(t))) return;
    const path = join(root, 'original.txt');
    const secret = join(outside, 'secret.txt');
    await fsPromises.writeFile(path, 'inside');
    await fsPromises.writeFile(secret, 'outside bytes');
    const validate = guard.validateExistingPath.bind(guard);
    t.mock.method(
      guard,
      'validateExistingPath',
      async (input: string) => {
        const result = await validate(input);
        await fsPromises.unlink(path);
        await fsPromises.symlink(secret, path, 'file');
        return result;
      },
      { times: 1 },
    );
    await assert.rejects(fs.readRaw(path));
    assert.equal(await fsPromises.readFile(secret, 'utf8'), 'outside bytes');
  });

  it('append refuses a final symlink installed at the open syscall', async (t) => {
    if (!(await linkSupported(t))) return;
    const path = join(root, 'append.txt');
    const secret = join(outside, 'secret.txt');
    await fsPromises.writeFile(path, 'inside');
    await fsPromises.writeFile(secret, 'outside bytes');
    const open = fsPromises.open;
    t.mock.method(
      fsPromises,
      'open',
      async (...args: Parameters<typeof open>) => {
        if (typeof args[0] === 'string' && isSamePath(args[0], path)) {
          await fsPromises.unlink(path);
          await fsPromises.symlink(secret, path, 'file');
        }
        return open(...args);
      },
      { times: 1 },
    );
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    await assert.rejects(fs.appendFile(path, 'INJECTED'));
    assert.equal(await fsPromises.readFile(secret, 'utf8'), 'outside bytes');
  });

  it('read refuses a directory junction/symlink installed after validation', async (t) => {
    const parent = join(root, 'parent');
    await fsPromises.mkdir(parent);
    const path = join(parent, 'read.txt');
    await fsPromises.writeFile(path, 'inside');
    await fsPromises.writeFile(join(outside, 'read.txt'), 'outside bytes');
    const validate = guard.validateExistingPath.bind(guard);
    t.mock.method(
      guard,
      'validateExistingPath',
      async (input: string) => {
        const result = await validate(input);
        await fsPromises.rename(parent, join(root, 'saved'));
        await fsPromises.symlink(
          outside,
          parent,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
        return result;
      },
      { times: 1 },
    );
    await assert.rejects(fs.readRaw(path));
  });

  it('create preserves a file appearing after its plan in the same call', async (t) => {
    const harness = await createTestClientPair([root]);
    const path = join(root, 'new.txt');
    const mkdir = fsPromises.mkdir;
    let injected = false;
    t.mock.method(fsPromises, 'mkdir', async (...args: Parameters<typeof mkdir>) => {
      const result = await mkdir(...args);
      if (typeof args[0] === 'string' && isSamePath(args[0], root)) {
        await fsPromises.writeFile(path, 'concurrent winner');
        injected = true;
      }
      return result;
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    try {
      const result = await harness.client.callTool({
        name: 'create',
        arguments: { files: [{ path, content: 'loser' }] },
      });
      assert.equal(injected, true, 'race hook ran after planning');
      assert.equal(result.isError, true);
      assert.equal(await fsPromises.readFile(path, 'utf8'), 'concurrent winner');
    } finally {
      await harness.close();
    }
  });

  const readers: Record<string, (path: string) => Promise<unknown>> = {
    full: (path) => fs.readFile(path, { kind: 'full' }),
    head: (path) => fs.readFile(path, { kind: 'head', lines: 1 }),
    tail: (path) => fs.readFile(path, { kind: 'tail', lines: 1 }),
    range: (path) => fs.readFile(path, { kind: 'range', start: 1, end: 1 }),
    editable: (path) => fs.readEditableText(path),
    raw: (path) => fs.readRaw(path),
    sample: (path) => fs.readLeadingSample(path, 32),
    lines: (path) => fs.countFileLines(path),
    open: async (path) => {
      await using handle = await fs.open(path);
      return await handle.readFile();
    },
    original: async (path) => {
      const opened = await fs.openOriginal(path, { root });
      await using handle = opened.handle;
      return await handle.readFile();
    },
    cached: async (path) =>
      readFileWithStats(path, path, await fsPromises.stat(path), { kind: 'full' }, guard),
  };

  for (const [name, read] of Object.entries(readers)) {
    it(`${name} refuses a parent swap at open before returning any bytes`, async (t) => {
      const parent = join(root, 'parent');
      await fsPromises.mkdir(parent);
      const path = join(parent, 'read.txt');
      await fsPromises.writeFile(path, 'inside\n');
      await fsPromises.writeFile(join(outside, 'read.txt'), 'outside bytes\n');
      const open = fsPromises.open;
      let injected = false;
      t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof open>) => {
        if (!injected && typeof args[0] === 'string' && isSamePath(args[0], path)) {
          injected = true;
          await fsPromises.rename(parent, join(root, 'saved'));
          await fsPromises.symlink(
            outside,
            parent,
            process.platform === 'win32' ? 'junction' : 'dir',
          );
        }
        return open(...args);
      });
      syncBuiltinESMExports();
      t.after(() => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      });
      await assert.rejects(read(path));
      assert.equal(injected, true);
    });
  }

  it('append refuses a parent swap before its pre-open stat', async (t) => {
    const parent = join(root, 'parent');
    await fsPromises.mkdir(parent);
    const path = join(parent, 'append.txt');
    await fsPromises.writeFile(path, 'inside');
    const secret = join(outside, 'append.txt');
    await fsPromises.writeFile(secret, 'outside');
    const validate = guard.validatePathForWrite.bind(guard);
    t.mock.method(
      guard,
      'validatePathForWrite',
      async (input: string) => {
        const result = await validate(input);
        await fsPromises.rename(parent, join(root, 'saved'));
        await fsPromises.symlink(
          outside,
          parent,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
        return result;
      },
      { times: 1 },
    );
    await assert.rejects(fs.appendFile(path, 'INJECTED'));
    assert.equal(await fsPromises.readFile(secret, 'utf8'), 'outside');
  });

  it('ordinary in-root directory aliases keep read/append semantics', async () => {
    const target = join(root, 'target');
    await fsPromises.mkdir(target);
    const alias = join(root, 'alias');
    await fsPromises.symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await fsPromises.writeFile(join(target, 'data.txt'), 'inside\n');
    const path = join(alias, 'data.txt');
    assert.equal((await fs.readRaw(path)).content.toString(), 'inside\n');
    await fs.appendFile(path, 'more\n');
    assert.equal((await fs.readFile(path, { kind: 'full' })).content, 'inside\nmore\n');
    await assert.rejects(fs.openOriginal(path, { root }));
  });

  it('a newly created append also verifies containment before writing bytes', async (t) => {
    const parent = join(root, 'parent');
    await fsPromises.mkdir(parent);
    const path = join(parent, 'new.txt');
    const validate = guard.validatePathForWrite.bind(guard);
    t.mock.method(
      guard,
      'validatePathForWrite',
      async (input: string) => {
        const result = await validate(input);
        await fsPromises.rename(parent, join(root, 'saved'));
        await fsPromises.symlink(
          outside,
          parent,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
        return result;
      },
      { times: 1 },
    );
    await assert.rejects(fs.appendFile(path, 'INJECTED'));
    // O_EXCL open can leave an empty entry after a parent escape. Cleanup must
    // not bypass PathGuard to remove it; no supplied bytes may reach it.
    assert.equal((await fsPromises.readFile(join(outside, 'new.txt'))).length, 0);
  });

  it('an in-root alias still cannot read or append a sensitive target', async () => {
    const target = join(root, 'target');
    await fsPromises.mkdir(target);
    await fsPromises.writeFile(join(target, '.env'), 'SECRET=unchanged');
    const alias = join(root, 'alias');
    await fsPromises.symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(fs.readRaw(join(alias, '.env')));
    await assert.rejects(fs.appendFile(join(alias, '.env'), 'INJECTED'));
    assert.equal(await fsPromises.readFile(join(target, '.env'), 'utf8'), 'SECRET=unchanged');
  });

  it('exclusive create is checked by the open syscall itself', async (t) => {
    const path = join(root, 'create.txt');
    const open = fsPromises.open;
    let injected = false;
    t.mock.method(
      fsPromises,
      'open',
      async (...args: Parameters<typeof open>) => {
        if (typeof args[0] === 'string' && isSamePath(args[0], path)) {
          injected = true;
          await fsPromises.writeFile(path, 'winner');
        }
        return open(...args);
      },
      { times: 1 },
    );
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    await assert.rejects(fs.writeFile(path, 'loser', { exclusive: true }), { code: 'EEXIST' });
    assert.equal(injected, true);
    assert.equal(await fsPromises.readFile(path, 'utf8'), 'winner');
  });

  for (const swap of ['parent', 'leaf'] as const) {
    it(`accepted overwrite refuses a canonical target redirected by a ${swap} link`, async (t) => {
      if (swap === 'leaf' && !(await linkSupported(t))) return;
      const parent = join(root, 'approved');
      const wrong = join(root, 'unapproved');
      await fsPromises.mkdir(parent);
      await fsPromises.mkdir(wrong);
      const path = join(parent, 'data.txt');
      const other = join(wrong, 'data.txt');
      await fsPromises.writeFile(path, 'approved original');
      await fsPromises.writeFile(other, 'unapproved original');
      const harness = await createElicitationClientPair([root], async () => ({
        action: 'accept' as const,
        content: { choice: 'overwrite' },
      }));
      const mkdir = fsPromises.mkdir;
      let injected = false;
      t.mock.method(fsPromises, 'mkdir', async (...args: Parameters<typeof mkdir>) => {
        const result = await mkdir(...args);
        if (!injected && typeof args[0] === 'string' && isSamePath(args[0], parent)) {
          injected = true;
          if (swap === 'parent') {
            await fsPromises.rename(parent, join(root, 'saved'));
            await fsPromises.symlink(
              wrong,
              parent,
              process.platform === 'win32' ? 'junction' : 'dir',
            );
          } else {
            await fsPromises.rename(path, join(parent, 'saved.txt'));
            await fsPromises.symlink(other, path, 'file');
          }
        }
        return result;
      });
      syncBuiltinESMExports();
      t.after(() => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      });
      try {
        const result = await harness.client.callTool({
          name: 'create',
          arguments: { files: [{ path, content: 'replacement' }] },
        });
        assert.equal(injected, true);
        assert.equal(result.isError, true);
        assert.equal(await fsPromises.readFile(other, 'utf8'), 'unapproved original');
      } finally {
        await harness.close();
      }
    });
  }

  it('a missing append that loses creation reopens safely and preserves the winner', async (t) => {
    const path = join(root, 'append.txt');
    const controller = new AbortController();
    const open = fsPromises.open;
    t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof open>) => {
      if (typeof args[1] === 'number' && (args[1] & constants.O_EXCL) !== 0) {
        await fsPromises.writeFile(path, 'winner');
      } else {
        controller.abort(new Error('stop before append'));
      }
      return open(...args);
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    await assert.rejects(fs.appendFile(path, 'loser', { signal: controller.signal }));
    assert.equal(await fsPromises.readFile(path, 'utf8'), 'winner');
  });

  it('aborting after exclusive open removes only the owned new file', async (t) => {
    const path = join(root, 'append.txt');
    const controller = new AbortController();
    const open = fsPromises.open;
    t.mock.method(
      fsPromises,
      'open',
      async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        controller.abort(new Error('stop after creation'));
        return handle;
      },
      { times: 1 },
    );
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    await assert.rejects(fs.appendFile(path, 'no bytes', { signal: controller.signal }));
    // Cleanup may finish after an aborted fstat has settled.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(fsPromises.stat(path), { code: 'ENOENT' });
  });

  it('failed append cleanup preserves an entry replaced by another writer', async (t) => {
    const path = join(root, 'new.txt');
    const open = fsPromises.open;
    t.mock.method(
      fsPromises,
      'open',
      async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        t.mock.method(handle, 'writeFile', async () => {
          await fsPromises.rename(path, join(root, 'our-file'));
          await fsPromises.writeFile(path, 'replacement winner');
          throw new Error('synthetic failed append');
        });
        return handle;
      },
      { times: 1 },
    );
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    await assert.rejects(fs.appendFile(path, 'no bytes'), /synthetic failed append/);
    assert.equal(await fsPromises.readFile(path, 'utf8'), 'replacement winner');
  });

  it('aborting a stalled fstat releases the late descriptor without holding the caller', async (t) => {
    const path = join(root, 'read.txt');
    await fsPromises.writeFile(path, 'inside');
    const controller = new AbortController();
    const gate = Promise.withResolvers<Stats>();
    const entered = Promise.withResolvers<undefined>();
    const closed = Promise.withResolvers<undefined>();
    const open = fsPromises.open;
    let handle: FileHandle | undefined;
    t.mock.method(
      fsPromises,
      'open',
      async (...args: Parameters<typeof open>) => {
        handle = await open(...args);
        const close = handle.close.bind(handle);
        t.mock.method(handle, 'stat', () => {
          entered.resolve(undefined);
          return gate.promise;
        });
        t.mock.method(handle, 'close', async () => {
          await close();
          closed.resolve(undefined);
        });
        return handle;
      },
      { times: 1 },
    );
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    const reading = fs.readRaw(path, { signal: controller.signal });
    await entered.promise;
    controller.abort(new Error('stop stalled fstat'));
    try {
      await assert.rejects(reading, /stop stalled fstat/);
    } finally {
      gate.resolve(await fsPromises.stat(path));
      await closed.promise;
    }
  });

  it(
    'Linux refuses unavailable descriptor verification',
    { skip: process.platform !== 'linux' },
    async (t) => {
      const path = join(root, 'read.txt');
      await fsPromises.writeFile(path, 'inside');
      const readlink = fsPromises.readlink;
      t.mock.method(fsPromises, 'readlink', (...args: Parameters<typeof readlink>) => {
        if (String(args[0]).startsWith('/proc/self/fd/'))
          return Promise.reject(new Error('procfs unavailable'));
        return readlink(...args);
      });
      syncBuiltinESMExports();
      t.after(() => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      });
      await assert.rejects(fs.readRaw(path), /procfs unavailable/);
    },
  );

  it(
    'Linux rejects a FIFO swapped onto an append path without blocking',
    { skip: process.platform !== 'linux' },
    async (t) => {
      const path = join(root, 'append.txt');
      await fsPromises.writeFile(path, 'inside');
      const open = fsPromises.open;
      t.mock.method(
        fsPromises,
        'open',
        async (...args: Parameters<typeof open>) => {
          await fsPromises.unlink(path);
          execFileSync('mkfifo', [path]);
          return open(...args);
        },
        { times: 1 },
      );
      syncBuiltinESMExports();
      t.after(() => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      });
      await assert.rejects(fs.appendFile(path, 'no bytes'));
    },
  );
});
