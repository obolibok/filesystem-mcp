import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

export const MIB = 1024 * 1024;
export const MEMORY_KEYS = ['rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers'];
export const LIMITS = { heapMiB: 384, softHeapMiB: 180, rssMiB: 512, timeoutMs: 180000 };

export function inside(parent, target) {
  const rel = relative(parent, target);
  return (
    rel !== '' &&
    !isAbsolute(rel) &&
    rel !== '..' &&
    !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  );
}

// Only a newly created, marked directory below this checkout's canonical .tmp
// can be removed. No user-provided directory is ever recursively removed.
export async function scratchRoot(repo) {
  const canonicalRepo = await realpath(repo);
  const tmp = join(canonicalRepo, '.tmp');
  await mkdir(tmp, { recursive: true });
  const canonicalTmp = await realpath(tmp);
  assert(inside(canonicalRepo, canonicalTmp), '.tmp must resolve inside this checkout');
  const root = await realpath(await mkdtemp(join(canonicalTmp, 'pagination-012-')));
  assert(inside(canonicalTmp, root));
  await writeFile(join(root, '.pagination-study'), '012 synthetic scratch\n');
  return {
    root,
    async cleanup() {
      const target = await realpath(root);
      assert(inside(canonicalTmp, target));
      assert.equal(
        await readFile(join(target, '.pagination-study'), 'utf8'),
        '012 synthetic scratch\n',
      );
      await rm(target, { recursive: true, force: true });
    },
  };
}

export async function outputPath(repo, requested) {
  const tmp = await realpath(join(repo, '.tmp'));
  const output = resolve(repo, requested);
  assert(inside(tmp, output), 'output must be below ignored .tmp');
  assert(
    inside(tmp, await realpath(resolve(output, '..'))) ||
      (await realpath(resolve(output, '..'))) === tmp,
  );
  return output;
}

export function childEnvironment(scratch) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(FS_|API_KEY$|HTTP_HOST$|PORT$)/i.test(key)) Reflect.deleteProperty(env, key);
  }
  return {
    ...env,
    LOG_LEVEL: 'error',
    FS_SNAPSHOT_DIR: join(scratch, 'jobs'),
    TEMP: scratch,
    TMP: scratch,
  };
}

export function memory() {
  const value = process.memoryUsage();
  return Object.fromEntries(MEMORY_KEYS.map((key) => [key, value[key]]));
}

export async function gc() {
  assert.equal(typeof global.gc, 'function', 'diagnostic worker requires --expose-gc');
  for (let i = 0; i < 3; i++) {
    global.gc();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export async function fixtures(root, workload) {
  const source = join(root, 'source');
  await mkdir(source, { recursive: true });
  if (workload.tool === 'list') {
    const count = workload.matches ?? 1200;
    const folder = workload.long ? join(source, 'a'.repeat(48), 'b'.repeat(48)) : source;
    await mkdir(folder, { recursive: true });
    for (let i = 0; i < count; i++) {
      const name = `file-${String(i).padStart(5, '0')}${workload.long ? `-${'p'.repeat(55)}` : ''}.txt`;
      await writeFile(join(folder, name), 'synthetic\n');
    }
    return {
      source,
      description: {
        files: count,
        directories: workload.long ? 2 : 0,
        maxRelativePathChars: workload.long ? 168 : 14,
      },
    };
  }
  const matches = workload.matches ?? (workload.long ? 128 : 1000);
  const width = workload.width ?? (workload.long ? 1024 : 64);
  const spacing = 21;
  const file = join(source, 'sample.txt');
  // Stream fixture generation one block at a time; don't retain source text.
  const { open } = await import('node:fs/promises');
  const handle = await open(file, 'w');
  try {
    for (let i = 0; i < matches; i++) {
      const lines = [];
      for (let j = 0; j < spacing; j++) {
        const prefix = `${j === 10 ? 'study-token' : 'context-row'}-${String(i).padStart(5, '0')}-${String(j).padStart(2, '0')}:`;
        lines.push(prefix.padEnd(width, 'x'));
      }
      await handle.write(`${lines.join('\n')}\n`);
    }
  } finally {
    await handle.close();
  }
  return {
    source,
    description: {
      files: 1,
      matches,
      width,
      spacing,
      sourceBytes: matches * spacing * (width + 1),
    },
  };
}

export function metadata(result) {
  return result._meta ?? result.structuredContent;
}

export function query(schema, workload, source, pageSize) {
  const properties = schema.properties;
  const modern = 'limit' in properties && 'pageSize' in properties;
  assert(modern || 'maxResults' in properties, 'unrecognized published pagination schema');
  const args = { path: source, includeHidden: true, includeIgnored: true };
  if (workload.tool === 'list') args.maxDepth = 3;
  else
    Object.assign(args, {
      searchPattern: workload.regex ? 'study-[a-z]+' : 'study-token',
      isRegex: !!workload.regex,
      caseSensitive: true,
      context: workload.context ?? 0,
    });
  Object.assign(
    args,
    modern
      ? { limit: workload.tool === 'list' ? 20000 : 10000, pageSize }
      : { maxResults: pageSize },
  );
  return { args, variant: modern ? 'limit+pageSize' : 'maxResults' };
}
