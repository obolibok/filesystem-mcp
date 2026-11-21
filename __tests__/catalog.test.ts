import type { Client } from '@modelcontextprotocol/client';

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { mergeTrees, verifyTreeZip } from '../scripts/snapshot-benchmark/verify-tree.mjs';
import { verifySnapshotZip } from '../scripts/snapshot-benchmark/verify.mjs';
import { FileCatalog } from '../src/core/catalog.js';
import { isNodeError } from '../src/core/errors.js';
import { GuardedFileSystem } from '../src/core/fs.js';
import { ArtifactJobManager, fingerprintJobInput } from '../src/core/job-manager.js';
import { normalizePath } from '../src/core/path-utils.js';
import { getSnapshotConfig } from '../src/core/snapshot-config.js';
import { createStdioClient, makeGuard } from './helpers.js';

interface CatalogStatus {
  indexed: boolean;
  indexedAt?: string;
  version?: string;
  state: 'idle' | 'queued' | 'running' | 'failed';
  requestId?: string;
}

interface SearchResult {
  version: string;
  observed: { startedAt: string; endedAt: string };
  entries: { path: string; name: string }[];
  cursor?: string;
}

interface Manifest {
  schema: string;
  root: { path: string };
  observed: SearchResult['observed'] & { atomic: boolean };
  complete: boolean;
  counters: Record<string, number>;
  parts: { artifactId: string; sha256: string; zipBytes: number; rows: number }[];
}

async function call<T>(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  const value = result.structuredContent ?? result._meta;
  assert(value, JSON.stringify(result.content));
  return value as T;
}

async function waitFor<T>(read: () => Promise<T>, check: (value: T) => boolean) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    assert(Date.now() < deadline, JSON.stringify(value));
    await delay(35);
  }
}

function clientEnv(scratch: string, extra: Record<string, string> = {}) {
  return { FS_CATALOG_ENABLED: '1', FS_SNAPSHOT_DIR: scratch, LOG_LEVEL: 'error', ...extra };
}

async function statuses(client: Client) {
  const data = await call<{ rootDetails: { path: string; catalog: CatalogStatus }[] }>(
    client,
    'list_roots',
  );
  return new Map(data.rootDetails.map(({ path, catalog }) => [normalizePath(path), catalog]));
}

async function status(client: Client, root: string): Promise<CatalogStatus> {
  const result = (await statuses(client)).get(normalizePath(root));
  assert(result);
  return result;
}

async function bytes(
  client: Client,
  name: 'get_artifact' | 'get_file',
  args: Record<string, unknown>,
) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(
    result.isError,
    true,
    result.content[0]?.type === 'text' ? result.content[0].text : name,
  );
  const resource = result.content.find((block) => block.type === 'resource');
  assert(resource && 'blob' in resource.resource);
  return Buffer.from(resource.resource.blob, 'base64');
}

async function snapshot(client: Client, path: string, extra: Record<string, unknown> = {}) {
  const { job } = await call<{ job: { jobId: string } }>(client, 'snapshot', { path, ...extra });
  const terminal = await waitFor(
    () =>
      call<{ state: string; manifestArtifactId?: string }>(client, 'job_status', {
        jobId: job.jobId,
      }),
    (current) => !['queued', 'running'].includes(current.state),
  );
  assert.equal(terminal.state, 'completed', JSON.stringify(terminal));
  assert(terminal.manifestArtifactId);
  const manifest = JSON.parse(
    (await bytes(client, 'get_artifact', { artifactId: terminal.manifestArtifactId })).toString(),
  ) as Manifest;
  const archives = await Promise.all(
    manifest.parts.map(async (part) => {
      const payload = await bytes(client, 'get_artifact', { artifactId: part.artifactId });
      assert.equal(payload.length, part.zipBytes);
      assert.equal(createHash('sha256').update(payload).digest('hex'), part.sha256);
      return payload;
    }),
  );
  return { manifest, archives };
}

async function tree(client: Client, path: string, extra: Record<string, unknown> = {}) {
  const { manifest, archives } = await snapshot(client, path, extra);
  assert.equal(manifest.schema, 'filesystem-mcp.snapshot-tree-manifest');
  const parts = await Promise.all(
    archives.map(async (payload, i) => {
      const expected = manifest.parts[i];
      assert(expected);
      const part = await verifyTreeZip(payload, expected.sha256);
      assert.equal(part.rows, expected.rows);
      assert.equal(part.root, normalizePath(path));
      return part;
    }),
  );
  return { manifest, nodes: mergeTrees(parts) };
}

test(
  'catalog startup keeps active job files with the scratch owner',
  { timeout: 15_000 },
  async (t) => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'filemcp-catalog-owner-')));
    t.after(() => rm(base, { recursive: true, force: true }));
    const root = join(base, 'Source Archive');
    const scratch = join(base, 'Private Jobs');
    await mkdir(root);
    const guard = await makeGuard([root]);
    const config = {
      ...getSnapshotConfig(),
      catalogEnabled: true,
      scratchDirectory: scratch,
      ephemeralScratch: false,
    };
    const nested = join(root, 'New Scratch');
    const overlapping = new ArtifactJobManager({ ...config, scratchDirectory: nested });
    await assert.rejects(
      () => overlapping.initialize(guard),
      /scratch and allowed roots must be disjoint/u,
    );
    await assert.rejects(() => stat(nested), { code: 'ENOENT' });

    const owner = new ArtifactJobManager(config);
    const workerReady = Promise.withResolvers<string>();
    const finish = Promise.withResolvers<string>();
    try {
      await owner.initialize(guard);
      const submitted = await owner.submit({
        kind: 'snapshot',
        fingerprint: fingerprintJobInput(root),
        sourceRoot: root,
        sourceRootId: 'owner-test',
        input: {},
        run: async (ctx) => {
          const partial = ctx.tempPath('owner-test.zip');
          await writeFile(partial, 'unpublished');
          workerReady.resolve(partial);
          return finish.promise;
        },
      });
      const partial = await workerReady.promise;
      const jobFile = join(owner.jobDirectory(submitted.job.jobId), 'job.json');
      const before = await readFile(jobFile);
      const contender = new ArtifactJobManager(config);
      await assert.rejects(
        () => contender.initialize(guard),
        /Cannot open the local catalog database/u,
      );
      assert.deepEqual(await readFile(jobFile), before);
      assert.equal(await readFile(partial, 'utf8'), 'unpublished');
    } finally {
      finish.resolve('test-ended');
      await owner.close();
    }
  },
);

test(
  'built MCP exports a cold subtree and reads the saved generation after restart',
  { timeout: 90_000 },
  async (t) => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'filemcp-catalog-')));
    t.after(() => rm(base, { recursive: true, force: true }));
    const root = join(base, 'Source Archive');
    const scope = join(root, 'Selected Scope');
    const scratch = join(base, 'Private Jobs');
    await mkdir(join(scope, 'a', 'empty'), { recursive: true });
    const report = join(scope, 'a', 'Report, Ω.DAT');
    const lowercaseReport = join(scope, 'a', 'report, Ω.DAT');
    await writeFile(report, 'old');
    await utimes(report, new Date('2024-01-02T03:04:05Z'), new Date('2024-01-02T03:04:05Z'));
    const distinctCase = await writeFile(lowercaseReport, 'different file', { flag: 'wx' }).then(
      () => true,
      (error: unknown) => {
        if (isNodeError(error) && error.code === 'EEXIST') return false;
        throw error;
      },
    );
    await writeFile(join(scope, 'a-file.txt'), 'neighbor');
    await writeFile(join(scope, '.hidden'), 'hidden');
    await writeFile(join(scope, 'omit.log'), 'ignored');
    await writeFile(join(scope, '.gitignore'), 'omit.log\n');
    await writeFile(join(root, 'outside.txt'), 'other scope');
    const outside = join(base, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'private.txt'), 'external');
    await symlink(
      outside,
      join(scope, 'outside-link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const expected = [
      JSON.stringify(['a']),
      JSON.stringify(['a', 'empty']),
      JSON.stringify(['a', 'Report, Ω.DAT']),
      JSON.stringify(['a-file.txt']),
      ...(distinctCase ? [JSON.stringify(['a', 'report, Ω.DAT'])] : []),
    ].sort();
    const live = await createStdioClient(
      root,
      clientEnv(join(base, 'Legacy Jobs'), { FS_CATALOG_ENABLED: '0' }),
      ['--read-only'],
    );
    const baseline = await tree(live.client, scope).finally(() => live.close());
    assert.deepEqual([...baseline.nodes.keys()].sort(), expected);

    const first = await createStdioClient(root, clientEnv(scratch), ['--read-only']);
    let observed: SearchResult['observed'];
    let version: string;
    try {
      const names = (await first.client.listTools()).tools.map((tool) => tool.name);
      assert.equal(names.length, 15);
      assert(names.includes('index_root') && names.includes('search_index'));
      assert.equal((await status(first.client, root)).indexed, false);
      const result = await tree(first.client, scope);
      assert.deepEqual(result.nodes, baseline.nodes);
      assert.deepEqual(result.manifest.counters, baseline.manifest.counters);
      assert.equal(result.manifest.complete, true);
      assert.equal(result.manifest.counters['symlinksSkipped'], 1);
      const hits = await call<SearchResult>(first.client, 'search_index', {
        path: scope,
        extension: '.DAT',
        modifiedFrom: '2024-01-02T04:04:05+01:00',
        modifiedBefore: '2024-01-02T03:04:06Z',
      });
      assert.deepEqual(
        hits.entries.map((entry) => entry.path),
        [normalizePath(report)],
      );
      const lower = await call<SearchResult>(first.client, 'search_index', {
        path: scope,
        name: 'report, Ω.DAT',
      });
      assert.deepEqual(
        lower.entries.map((entry) => entry.path),
        distinctCase ? [normalizePath(lowercaseReport)] : [],
      );
      observed = hits.observed;
      version = hits.version;
      assert.deepEqual(result.manifest.observed, { ...observed, atomic: false });
      assert.equal((await status(first.client, root)).indexedAt, observed.endedAt);
      const denied = await first.client.callTool({
        name: 'get_file',
        arguments: { path: join(scratch, 'catalog.sqlite') },
      });
      assert.equal(denied.isError, true);
      const link = await first.client.callTool({
        name: 'search_index',
        arguments: { path: join(scope, 'outside-link') },
      });
      assert.equal(link.isError, true);
    } finally {
      await first.close();
    }

    await writeFile(report, 'current bytes');
    await writeFile(join(scope, 'new.txt'), 'created after catalog');
    const restarted = await createStdioClient(
      root,
      clientEnv(scratch, { FS_SNAPSHOT_FORMAT: 'stable' }),
      ['--read-only'],
    );
    try {
      assert.equal((await status(restarted.client, root)).version, version);
      assert.deepEqual(
        (await call<SearchResult>(restarted.client, 'search_index', { path: scope })).observed,
        observed,
      );
      const stable = await snapshot(restarted.client, scope);
      assert.equal(stable.manifest.schema, 'filesystem-mcp.snapshot-manifest');
      assert.equal(stable.manifest.root.path, normalizePath(scope));
      assert.deepEqual(stable.manifest.observed, { ...observed, atomic: false });
      const paths = (
        await Promise.all(stable.archives.map((zip) => verifySnapshotZip(zip, true)))
      ).flatMap((part) => [...part.paths]);
      assert.deepEqual(paths.sort(), [
        'a-file.txt',
        'a/Report, Ω.DAT',
        ...(distinctCase ? ['a/report, Ω.DAT'] : []),
      ]);
      assert.equal(
        (await bytes(restarted.client, 'get_file', { path: report })).toString(),
        'current bytes',
      );
      const hidden = await snapshot(restarted.client, scope, { includeHidden: true });
      const hiddenPaths = (
        await Promise.all(hidden.archives.map((zip) => verifySnapshotZip(zip, true)))
      ).flatMap((part) => [...part.paths]);
      assert(hiddenPaths.includes('.hidden') && hiddenPaths.includes('new.txt'));

      await writeFile(join(root, '.gitignore'), 'Selected Scope/new.txt\n');
      const request = await call<{ requestId: string }>(restarted.client, 'index_root', {
        path: root,
      });
      await waitFor(
        () => status(restarted.client, root),
        (value) => value.version === request.requestId,
      );
      const indexed = await call<SearchResult>(restarted.client, 'search_index', {
        path: scope,
        name: 'new.txt',
      });
      assert.deepEqual(indexed.entries, []);
      const direct = await snapshot(restarted.client, scope);
      const directPaths = (
        await Promise.all(direct.archives.map((zip) => verifySnapshotZip(zip, true)))
      ).flatMap((part) => [...part.paths]);
      assert(
        directPaths.includes('new.txt'),
        'a scoped walk does not inherit rules above its root',
      );
    } finally {
      await restarted.close();
    }
  },
);

test(
  'shutdown during a staged refresh keeps the published catalog readable on reopen',
  { timeout: 30_000 },
  async (t) => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'filemcp-catalog-cancel-')));
    t.after(() => rm(base, { recursive: true, force: true }));
    const root = normalizePath(join(base, 'source'));
    const scratch = join(base, 'jobs');
    await Promise.all([mkdir(root), mkdir(scratch)]);
    await writeFile(join(root, 'original.txt'), 'published');
    const fs = new GuardedFileSystem(await makeGuard([root]));
    const config = getSnapshotConfig();
    const initial = await FileCatalog.open(scratch, config);
    try {
      const request = await initial.request(fs, root);
      await waitFor(
        () => initial.describeRoots(fs, [root]),
        ([status]) => status?.version === request.requestId,
      );
      await assert.rejects(
        () => FileCatalog.open(scratch, config),
        /Cannot open the local catalog database/u,
      );
      for (let i = 0; i < 270; i++)
        await writeFile(join(root, `draft-${String(i)}.txt`), 'staging');
      const stat = fs.statDetailed.bind(fs);
      const reached = Promise.withResolvers<undefined>();
      let files = 0;
      t.mock.method(
        fs,
        'statDetailed',
        async (path: string, options?: { signal?: AbortSignal }) => {
          if (path !== root && ++files === 260) {
            assert(options?.signal);
            reached.resolve(undefined);
            await new Promise<void>((resolve) =>
              options.signal?.addEventListener('abort', () => resolve(), { once: true }),
            );
          }
          return stat(path, options);
        },
      );
      await initial.request(fs, root);
      await reached.promise;
      assert.deepEqual(
        (await initial.search(fs, root, {}, 10)).entries.map((row) => row.name),
        ['original.txt'],
      );
      await initial.close();
      const reopened = await FileCatalog.open(scratch, config);
      try {
        const previous = await reopened.search(fs, root, {}, 10);
        assert.equal(previous.version, request.requestId);
        assert.deepEqual(
          previous.entries.map((row) => row.name),
          ['original.txt'],
        );
      } finally {
        await reopened.close();
      }
    } finally {
      await initial.close();
    }
  },
);

test(
  'catalog queues roots once, expires cursors on publication and preserves the last good generation',
  { timeout: 90_000 },
  async (t) => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'filemcp-catalog-queue-')));
    t.after(() => rm(base, { recursive: true, force: true }));
    const root = join(base, 'source');
    const other = join(base, 'other');
    const scratch = join(base, 'jobs');
    await Promise.all([mkdir(root), mkdir(other)]);
    const names = Array.from({ length: 330 }, (_, i) => `report-${String(i).padStart(3, '0')}.txt`);
    for (const name of names) await writeFile(join(root, name), 'synthetic');
    await writeFile(join(other, 'different.txt'), 'synthetic');
    const env = clientEnv(scratch, {
      FS_ALLOWED_DIRS: [other].join(delimiter),
      FS_SNAPSHOT_MAX_WALK_DEPTH: '8',
    });
    const { client, close } = await createStdioClient(root, env, ['--read-only']);
    try {
      const request = await call<{ requestId: string; message: string }>(client, 'index_root', {
        path: root,
      });
      const [duplicate, queued] = await Promise.all([
        call<typeof request>(client, 'index_root', { path: root }),
        call<typeof request & { state: string }>(client, 'index_root', { path: other }),
      ]);
      assert.equal(duplicate.requestId, request.requestId);
      assert.equal(duplicate.message, 'Already requested');
      assert.equal(queued.state, 'queued');
      await waitFor(
        () => status(client, other),
        (value) => value.indexed,
      );
      const before = await status(client, root);
      assert.equal(before.version, request.requestId);
      const args = { path: root, namePrefix: 'report-', extension: '.txt', limit: 87 };
      const first = await call<SearchResult>(client, 'search_index', args);
      assert(first.cursor);
      const wrong = await client.callTool({
        name: 'search_index',
        arguments: { ...args, limit: 86, cursor: first.cursor },
      });
      assert.equal(wrong.isError, true);
      const entries = [...first.entries];
      let cursor = first.cursor as string | undefined;
      while (cursor) {
        const page = await call<SearchResult>(client, 'search_index', { ...args, cursor });
        assert.equal(page.version, first.version);
        entries.push(...page.entries);
        assert(entries.length <= names.length);
        cursor = page.cursor;
      }
      assert.deepEqual(
        entries.map((entry) => entry.name),
        names,
      );

      await writeFile(join(root, 'new.txt'), 'refresh');
      const fresh = await tree(client, root, { forceRefresh: true, maxAgeMs: 0 });
      assert(fresh.nodes.has(JSON.stringify(['new.txt'])));
      const refreshed = await status(client, root);
      assert.notEqual(refreshed.version, before.version);
      const expired = await client.callTool({
        name: 'search_index',
        arguments: { ...args, cursor: first.cursor },
      });
      assert.equal(expired.isError, true);

      await mkdir(join(root, 'zz-deep', ...Array.from({ length: 9 }, () => 'nested')), {
        recursive: true,
      });
      const broken = await call<typeof request>(client, 'index_root', { path: root });
      const afterFailure = await waitFor(
        () => status(client, root),
        (value) => value.state === 'failed',
      );
      assert.equal(afterFailure.version, refreshed.version);
      assert.equal(afterFailure.requestId, broken.requestId);
      assert.equal(
        (await call<SearchResult>(client, 'search_index', { path: root })).version,
        refreshed.version,
      );
    } finally {
      await close();
    }

    // A changed guard policy invalidates old results even though the file exists.
    const restricted = await createStdioClient(
      root,
      clientEnv(scratch, { FS_SNAPSHOT_MAX_WALK_DEPTH: '8' }),
      ['--read-only'],
    );
    try {
      assert.equal((await status(restricted.client, root)).indexed, false);
      const result = await restricted.client.callTool({
        name: 'search_index',
        arguments: { path: root },
      });
      assert.equal(result.isError, true);
    } finally {
      await restricted.close();
    }
  },
);

test(
  'catalog resolves genuine Windows 8.3 source, scratch parent, scope and file aliases',
  { skip: process.platform !== 'win32', timeout: 60_000 },
  async (t) => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'FileMCP Long Short Alias Parent ')));
    t.after(() => rm(base, { recursive: true, force: true }));
    const root = join(base, 'Long Source Archive');
    const scope = join(root, 'Long Selected Scope');
    const file = join(scope, 'Long File Report.txt');
    await mkdir(scope, { recursive: true });
    await writeFile(file, 'DOS alias');
    const [shortBase, shortRoot, shortScope, shortFile] = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$fs = New-Object -ComObject Scripting.FileSystemObject; $fs.GetFolder($env:FSMCP_BASE).ShortPath; $fs.GetFolder($env:FSMCP_SOURCE).ShortPath; $fs.GetFolder($env:FSMCP_SCOPE).ShortPath; $fs.GetFile($env:FSMCP_FILE).ShortPath',
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000,
        env: {
          ...process.env,
          FSMCP_BASE: base,
          FSMCP_SOURCE: root,
          FSMCP_SCOPE: scope,
          FSMCP_FILE: file,
        },
      },
    )
      .trim()
      .split(/\r?\n/u);
    if (
      !shortBase ||
      !shortRoot ||
      !shortScope ||
      !shortFile ||
      ![shortBase, shortRoot, shortScope, shortFile].every((path) => /~\d/u.test(basename(path)))
    ) {
      t.skip('The fixture volume does not assign short names');
      return;
    }
    assert.deepEqual(
      await Promise.all(
        [shortBase, shortRoot, shortScope, shortFile].map((path) => realpath(path)),
      ),
      [base, root, scope, file],
    );
    const { client, close } = await createStdioClient(
      shortRoot,
      clientEnv(join(shortBase, 'jobs'), { TEMP: shortBase, TMP: shortBase }),
      ['--read-only'],
    );
    try {
      await tree(client, scope);
      const long = await call<SearchResult>(client, 'search_index', { path: scope });
      const short = await call<SearchResult>(client, 'search_index', { path: shortScope });
      assert.deepEqual(long, short);
      assert.deepEqual(
        short.entries.map((entry) => entry.path),
        [normalizePath(file)],
      );
      assert.equal((await bytes(client, 'get_file', { path: shortFile })).toString(), 'DOS alias');
    } finally {
      await close();
    }
  },
);
