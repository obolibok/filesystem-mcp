import { readFile, realpath, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const kit = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const ranges = {
  FS_MAX_FILE_SIZE: [1048576, 104857600],
  FS_SNAPSHOT_RESULT_TTL_MS: [1000, 2592000000],
  FS_SNAPSHOT_CLEANUP_INTERVAL_MS: [1000, 3600000],
  FS_SNAPSHOT_SCRATCH_QUOTA_BYTES: [1048576, 68719476736],
  FS_SNAPSHOT_MAX_JOB_MS: [1000, 86400000],
  FS_SNAPSHOT_MAX_RAW_PART_BYTES: [65536, 536870912],
  FS_SNAPSHOT_TREE_MAX_RAW_PART_BYTES: [65536, 536870912],
  FS_SNAPSHOT_MAX_ZIP_BYTES: [65536, 104857600],
  FS_SNAPSHOT_MAX_DELIVERY_BYTES: [65536, 104857600],
  FS_SNAPSHOT_MAX_JOB_RAW_BYTES: [1048576, 17179869184],
  FS_SNAPSHOT_MAX_JOB_ARTIFACT_BYTES: [1048576, 17179869184],
  FS_BUNDLE_MAX_FILES: [1, 10000],
  FS_BUNDLE_MAX_FILE_BYTES: [65536, 1073741824],
  FS_BUNDLE_MAX_RAW_PART_BYTES: [65536, 1073741824],
  FS_BUNDLE_MAX_JOB_RAW_BYTES: [1048576, 17179869184],
};

function inside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

async function destination(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await destination(parent), relative(parent, path));
  }
}

function resolvePath(value) {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n;]/.test(value))
    throw new Error('Paths must be nonempty, with no semicolon or control characters.');
  if (/^[a-z]:[^\\/]/i.test(value) || value.startsWith('\\\\?\\') || value.startsWith('\\\\.\\'))
    throw new Error('Use an absolute drive path, UNC path, or a path relative to the kit.');
  return resolve(kit, value);
}

export async function configuration({ includeHttpApiKey = false } = {}) {
  const text = (await readFile(join(kit, 'config.json'), 'utf8')).replace(/^\uFEFF/, '');
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    throw new Error('Cannot read config.json: expected valid JSON.');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error('config.json must contain an object.');
  if (config.runtimeApiKey != null && typeof config.runtimeApiKey !== 'string')
    throw new Error('runtimeApiKey must be a string or null.');
  const transport = config.transport === undefined ? 'stdio' : config.transport;
  if (!['stdio', 'http'].includes(transport)) throw new Error('transport must be stdio or http.');
  const http = config.localHttp === undefined ? {} : config.localHttp;
  if (!http || typeof http !== 'object' || Array.isArray(http))
    throw new Error('localHttp must be an object.');
  const host = http.host === undefined ? '127.0.0.1' : http.host;
  if (
    typeof host !== 'string' ||
    (host !== 'localhost' && !isIP(host)) ||
    host === '0.0.0.0' ||
    (isIP(host) === 6 && new URL('http://[' + host + ']').hostname === '[::]')
  )
    throw new Error('localHttp.host must be localhost or a concrete IP address.');
  const port = http.port === undefined ? 8766 : http.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('localHttp.port must be an integer from 1 to 65535.');
  if (http.apiKey != null && typeof http.apiKey !== 'string')
    throw new Error('localHttp.apiKey must be a string or null.');
  const httpApiKey = http.apiKey?.trim() ?? '';
  if (
    httpApiKey &&
    (httpApiKey.length < 16 || httpApiKey.length > 4096 || /[^\x21-\x7e]/u.test(httpApiKey))
  )
    throw new Error(
      'localHttp.apiKey must contain 16 to 4096 printable ASCII characters without whitespace.',
    );
  const snapshotFormat = config.snapshotFormat ?? 'tree';
  if (config.snapshotFormat !== undefined && !['tree', 'stable'].includes(config.snapshotFormat))
    throw new Error('snapshotFormat must be tree or stable.');
  if (
    config.experimentalSnapshotTree !== undefined &&
    typeof config.experimentalSnapshotTree !== 'boolean'
  )
    throw new Error('experimentalSnapshotTree must be a boolean.');
  if (!Array.isArray(config.roots) || config.roots.length === 0)
    throw new Error('config.json must contain at least one explicit source root.');
  const roots = [];
  for (const input of config.roots) {
    const path = await realpath(resolvePath(input));
    if (!(await stat(path)).isDirectory()) throw new Error('Source is not a directory: ' + input);
    if (path.includes(delimiter)) throw new Error('Root contains the platform list separator.');
    // Only the provided synthetic sample may live inside the kit.
    const sample = await realpath(join(kit, 'sample-source'));
    if (inside(path, kit) || (inside(kit, path) && !inside(sample, path)))
      throw new Error('Keep sources separate from the kit: ' + input);
    roots.push(path);
  }
  const scratch = await destination(resolvePath(config.scratchDirectory));
  for (const root of roots) {
    if (inside(root, scratch) || inside(scratch, root))
      throw new Error('Scratch and source roots must not overlap.');
  }
  const data = await destination(join(kit, 'data'));
  if (!inside(kit, data))
    throw new Error('The kit data directory must not redirect outside the kit.');
  for (const root of roots) {
    if (inside(root, data) || inside(data, root))
      throw new Error('Kit data overlaps a source root.');
  }
  if (inside(kit, scratch) && (!inside(data, scratch) || scratch === data))
    throw new Error('Scratch inside the kit must be below data, e.g. data/jobs.');
  if (inside(scratch, kit)) throw new Error('Scratch must not contain the kit.');
  if (!config.limits || typeof config.limits !== 'object' || Array.isArray(config.limits))
    throw new Error('limits must be an object.');
  for (const [key, value] of Object.entries(config.limits)) {
    const range = ranges[key];
    if (!range || !Number.isSafeInteger(value) || value < range[0] || value > range[1])
      throw new Error('Unsupported or out-of-range limit: ' + key);
  }
  const { runtimeApiKey: _runtimeApiKey, localHttp: _localHttp, ...serverConfig } = config;
  return {
    ...serverConfig,
    transport,
    localHttp: {
      host,
      port,
      ...(includeHttpApiKey && transport === 'http' ? { apiKey: httpApiKey } : {}),
    },
    snapshotFormat,
    roots: [...new Set(roots)],
    scratchDirectory: scratch,
  };
}

export function serverEnvironment(config) {
  // Do not inherit an unrelated installation's roots, HTTP listener, or policy.
  for (const name of Object.keys(process.env)) {
    if (
      name.toUpperCase().startsWith('FS_') ||
      ['NODE_OPTIONS', 'NODE_ENV', 'NODE_TEST_CONTEXT'].includes(name)
    )
      Reflect.deleteProperty(process.env, name);
  }
  process.env.FS_ROOT_BOUNDARY = config.roots.join(delimiter);
  process.env.FS_SNAPSHOT_DIR = config.scratchDirectory;
  process.env.FS_SNAPSHOT_FORMAT = config.snapshotFormat;
  for (const [key, value] of Object.entries(config.limits)) process.env[key] = String(value);
  delete process.env.CONTROL_PLANE_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.PORTABLE_HTTP_API_KEY;
}
