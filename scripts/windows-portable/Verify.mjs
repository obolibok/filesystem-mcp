import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rmdir,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { crc32, inflateRawSync } from 'node:zlib';

const input = resolve(process.argv[2] ?? '');
assert(process.argv[2], 'Usage: node Verify.mjs PATH_TO_BUILT_KIT');
assert.equal(process.platform, 'win32', 'This verifier tests the Windows kit.');
const stage = await mkdtemp(resolve('.tmp/portable-acceptance-'));
const kit = join(stage, 'Moved kit Größe Антенна');
await cp(input, kit, { recursive: true });
const original = JSON.parse(await readFile(join(kit, 'config.json'), 'utf8'));
const rootA = join(stage, 'Source A');
const rootB = await mkdtemp(join(tmpdir(), 'portable-source-B-'));
await mkdir(rootA);
await writeFile(join(rootA, 'sample.txt'), 'synthetic A');
await writeFile(join(rootB, 'sample.txt'), 'synthetic B');
const node = join(kit, 'runtime/node.exe');
const check = join(kit, 'scripts/check.mjs');
const reports = [];
async function save(config) {
  await writeFile(join(kit, 'config.json'), JSON.stringify(config, null, 2));
}
function runCheck(env = {}) {
  return JSON.parse(
    execFileSync(node, [check], {
      cwd: stage,
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
      stdio: 'pipe',
      env: { ...process.env, NODE_OPTIONS: '', ...env },
    }),
  );
}
const defaults = runCheck({ FS_SNAPSHOT_FORMAT: 'stable', FS_EXPERIMENTAL_SNAPSHOT_TREE: '1' });
assert.equal(defaults.snapshotFormat, 'tree');
const { snapshotFormat: _format, ...omittedFormat } = original;
await save({ ...omittedFormat, experimentalSnapshotTree: false });
assert.equal(runCheck({ FS_SNAPSHOT_FORMAT: 'stable' }).snapshotFormat, 'tree');
await save(original);
reports.push('default-tree-omitted-format-and-retired-false-flag: PASS');
const { transport: _transport, localHttp: _http, ...legacyConfig } = original;
await save(legacyConfig);
assert.equal(runCheck().configuredTransport, 'stdio');
await save(original);
reports.push('legacy-config-without-transport-or-localHttp: PASS');
assert.equal(defaults.result, 'LOCAL_MCP_PASS');
reports.push('relocation-space-unicode-and-foreign-cwd: PASS');
const multi = { ...original, roots: [rootA, rootB] };
await save(multi);
const result = runCheck({
  FS_ALLOWED_DIRS: stage,
  FS_ROOT_BOUNDARY: stage,
  FS_PORT: '39999',
  FS_ALLOW_SENSITIVE: 'true',
});
assert.deepEqual(
  result.roots.sort(),
  (await Promise.all([realpath(rootA), realpath(rootB)])).sort(),
);
assert.equal(result.tools.length, 13);
reports.push('multiple-roots-and-inherited-FS-isolation: PASS');
const client = new Client(
  { name: 'portable-acceptance', version: '1.0.0' },
  { versionNegotiation: { mode: 'auto' } },
);
const transport = new StdioClientTransport({
  command: node,
  args: [join(kit, 'scripts/serve.mjs')],
  cwd: stage,
  env: { ...process.env, NODE_OPTIONS: '' },
  stderr: 'pipe',
});
function bytes(response) {
  const block = response.content.find((item) => item.type === 'resource');
  assert(block?.resource?.blob, 'Missing embedded original bytes');
  return Buffer.from(block.resource.blob, 'base64');
}
async function call(name, args) {
  const response = await client.callTool({ name, arguments: args });
  assert(!response.isError, JSON.stringify(response));
  return response;
}
function unzipSingle(zip) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert(end >= 0);
  assert.equal(zip.readUInt16LE(end + 10), 1);
  const central = zip.readUInt32LE(end + 16);
  assert.equal(zip.readUInt32LE(central), 0x02014b50);
  const local = zip.readUInt32LE(central + 42);
  assert.equal(zip.readUInt32LE(local), 0x04034b50);
  const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
  const compressed = zip.subarray(start, start + zip.readUInt32LE(central + 20));
  const method = zip.readUInt16LE(central + 10);
  assert([0, 8].includes(method));
  const data = method === 8 ? inflateRawSync(compressed, { maxOutputLength: 1048576 }) : compressed;
  assert.equal(data.length, zip.readUInt32LE(central + 24));
  assert.equal(crc32(data), zip.readUInt32LE(central + 16));
  return data;
}
try {
  await client.connect(transport);
  for (const name of ['bundle', 'snapshot']) {
    const args = { path: rootA, idempotencyKey: name + '-portable-acceptance' };
    if (name === 'bundle') args.files = [{ relativePath: 'sample.txt' }];
    const submission = await call(name, args);
    const submitted = submission.structuredContent ?? submission._meta;
    const deadline = Date.now() + 15000;
    let job;
    do {
      const response = await call('job_status', { jobId: submitted.job.jobId });
      job = response.structuredContent ?? response._meta;
      if (job.state === 'completed') break;
      assert(['queued', 'running'].includes(job.state), JSON.stringify(job));
      assert(Date.now() < deadline, 'Job timeout');
      await delay(25);
    } while (Date.now() < deadline);
    assert.equal(job.state, 'completed', 'Job did not complete before the deadline');
    assert.equal(job.complete, true);
    const manifest = JSON.parse(
      bytes(await call('get_artifact', { artifactId: job.manifestArtifactId })).toString('utf8'),
    );
    assert.equal(manifest.parts.length, 1);
    const part = manifest.parts[0];
    const zip = bytes(await call('get_artifact', { artifactId: part.artifactId }));
    assert.equal(zip.length, part.zipBytes);
    assert.equal(createHash('sha256').update(zip).digest('hex'), part.sha256);
    const unpacked = unzipSingle(zip);
    if (name === 'bundle') assert.deepEqual(unpacked, Buffer.from('synthetic A'));
    else {
      assert.equal(manifest.schema, 'filesystem-mcp.snapshot-tree-manifest');
      assert.equal(manifest.layout, 'tree-depth-v1');
      assert(unpacked.toString('utf8').includes('Type,Depth,Name,Length,LastWriteTime'));
      assert(unpacked.toString('utf8').includes('sample.txt'));
    }
    reports.push(name + '-manifest-ZIP-SHA256-CRC-original: PASS');
  }
} finally {
  await client.close();
}

// Restart each configured format, change the tree-only cap, then fetch both saved layouts.
const capRoot = join(stage, 'Tree cap source');
await mkdir(capRoot);
for (let offset = 0; offset < 900; offset += 50) {
  await Promise.all(
    Array.from({ length: 50 }, (_, n) =>
      writeFile(
        join(
          capRoot,
          createHash('sha256')
            .update(String(offset + n))
            .digest('hex') + '.txt',
        ),
        'synthetic',
      ),
    ),
  );
}
const capConfig = {
  ...multi,
  roots: [capRoot],
  experimentalSnapshotTree: false,
  limits: {
    ...multi.limits,
    FS_SNAPSHOT_MAX_RAW_PART_BYTES: 131072,
    FS_SNAPSHOT_TREE_MAX_RAW_PART_BYTES: 65536,
  },
};
const saved = new Map();
const savedBytes = new Map();
for (const phase of ['initial', 'changed', 'format-switch']) {
  for (const format of ['stable', 'tree']) {
    const treeCap = phase === 'initial' ? 65536 : 131072;
    await save({
      ...capConfig,
      snapshotFormat: format,
      limits: { ...capConfig.limits, FS_SNAPSHOT_TREE_MAX_RAW_PART_BYTES: treeCap },
    });
    const capClient = new Client({ name: 'portable-tree-caps', version: '1' });
    const capTransport = new StdioClientTransport({
      command: node,
      args: [join(kit, 'scripts/serve.mjs')],
      cwd: stage,
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        FS_SNAPSHOT_TREE_MAX_RAW_PART_BYTES: '536870912',
        FS_SNAPSHOT_FORMAT: format === 'tree' ? 'stable' : 'tree',
        FS_EXPERIMENTAL_SNAPSHOT_TREE: '1',
      },
      stderr: 'pipe',
    });
    const capCall = async (name, args) => {
      const response = await capClient.callTool({ name, arguments: args });
      assert(!response.isError, JSON.stringify(response));
      return response;
    };
    try {
      await capClient.connect(capTransport);
      const tools = (await capClient.listTools()).tools;
      assert.equal(tools.length, 13);
      assert(!tools.some((tool) => tool.name === 'snapshot_tree'));
      for (const name of phase === 'format-switch' ? ['stable', 'tree'] : [format]) {
        if (phase === 'format-switch') {
          const response = await capCall('job_status', { jobId: saved.get(name) });
          const job = response.structuredContent ?? response._meta;
          const cancelled = await capCall('cancel_job', { jobId: job.jobId });
          assert.equal((cancelled.structuredContent ?? cancelled._meta).state, 'completed');
          for (const artifact of job.artifacts) {
            assert.deepEqual(
              bytes(await capCall('get_artifact', { artifactId: artifact.artifactId })),
              savedBytes.get(artifact.artifactId),
            );
          }
          continue;
        }
        const response = await capCall('snapshot', { path: capRoot });
        const submission = response.structuredContent ?? response._meta;
        if (phase === 'changed') {
          assert.equal(submission.reason, name === 'stable' ? 'completed_reuse' : 'created');
          assert.equal(submission.job.jobId === saved.get(name), name === 'stable');
        }
        const deadline = Date.now() + 30000;
        let job = submission.job;
        while (['queued', 'running'].includes(job.state)) {
          assert(Date.now() < deadline, 'Tree cap job timeout');
          await delay(25);
          const status = await capCall('job_status', { jobId: job.jobId });
          job = status.structuredContent ?? status._meta;
        }
        assert.equal(job.state, 'completed', JSON.stringify(job));
        assert.equal(job.complete, true);
        assert.equal(job.counters.filesWritten, 900);
        const manifestBytes = bytes(
          await capCall('get_artifact', { artifactId: job.manifestArtifactId }),
        );
        const manifest = JSON.parse(manifestBytes.toString('utf8'));
        assert.equal(
          manifest.schema,
          name === 'stable'
            ? 'filesystem-mcp.snapshot-manifest'
            : 'filesystem-mcp.snapshot-tree-manifest',
        );
        assert.equal(manifest.layout, name === 'stable' ? undefined : 'tree-depth-v1');
        const cap = name === 'stable' ? 131072 : treeCap;
        assert.equal(manifest.policy.maxRawPartBytes, cap);
        assert.equal(manifest.policy.maxZipBytes, capConfig.limits.FS_SNAPSHOT_MAX_ZIP_BYTES);
        assert.equal(
          manifest.policy.maxDeliveryBytes,
          capConfig.limits.FS_SNAPSHOT_MAX_DELIVERY_BYTES,
        );
        if (phase === 'initial') assert(manifest.parts.length > 1);
        let rawBytes = 0;
        for (const part of manifest.parts) {
          const zip = bytes(await capCall('get_artifact', { artifactId: part.artifactId }));
          assert.equal(createHash('sha256').update(zip).digest('hex'), part.sha256);
          const unpacked = unzipSingle(zip);
          assert.equal(unpacked.length, part.rawBytes);
          assert(unpacked.length <= cap);
          rawBytes += unpacked.length;
          savedBytes.set(part.artifactId, zip);
        }
        assert.equal(rawBytes, job.counters.rawCsvBytes);
        savedBytes.set(job.manifestArtifactId, manifestBytes);
        saved.set(name, job.jobId);
      }
      reports.push(format + '-raw-caps-' + phase + '-packaged-MCP: PASS');
    } finally {
      await capClient.close();
    }
  }
}
const configuredKey = 'sk-local-configured-placeholder-not-a-real-key';
const promptKey = 'sk-local-doctor-placeholder-not-a-real-key';
const httpKey = 'portable-http-synthetic-placeholder-not-a-real-key';
const keyTypes = [false, 42, [], { secret: configuredKey }];
const cases = [
  ['invalid-format', { ...multi, snapshotFormat: 'csv' }],
  ['invalid-format-type', { ...multi, snapshotFormat: false }],
  ['null-format', { ...multi, snapshotFormat: null }],
  ['empty-roots', { ...multi, roots: [] }],
  ['missing-root', { ...multi, roots: [join(stage, 'missing-root')] }],
  ['kit-exposed-as-root', { ...multi, roots: [kit] }],
  ['source-scratch-overlap', { ...multi, scratchDirectory: join(rootA, 'missing-scratch') }],
  ['invalid-limit', { ...multi, limits: { ...multi.limits, FS_MAX_FILE_SIZE: -1 } }],
  ['unknown-limit', { ...multi, limits: { ...multi.limits, FS_ALLOW_SENSITIVE: 1 } }],
  [
    'invalid-tree-limit',
    { ...multi, limits: { ...multi.limits, FS_SNAPSHOT_TREE_MAX_RAW_PART_BYTES: '16777216' } },
  ],
];
for (const [index, runtimeApiKey] of keyTypes.entries())
  cases.push(['invalid-runtime-key-' + index, { ...multi, runtimeApiKey }]);
const alias = join(stage, 'source-alias');
await symlink(rootA, alias, 'junction');
cases.push([
  'junction-missing-scratch',
  { ...multi, scratchDirectory: join(alias, 'missing', 'scratch') },
]);
for (const [label, config] of cases) {
  await save(config);
  const expected = {
    'invalid-format': /snapshotFormat must be tree or stable/,
    'invalid-format-type': /snapshotFormat must be tree or stable/,
    'null-format': /snapshotFormat must be tree or stable/,
    'empty-roots': /at least one explicit source root/,
    'missing-root': /ENOENT/,
    'kit-exposed-as-root': /Keep sources separate/,
    'source-scratch-overlap': /Scratch and source roots must not overlap/,
    'invalid-limit': /out-of-range limit: FS_MAX_FILE_SIZE/,
    'unknown-limit': /out-of-range limit: FS_ALLOW_SENSITIVE/,
    'invalid-tree-limit': /out-of-range limit: FS_SNAPSHOT_TREE_MAX_RAW_PART_BYTES/,
    'junction-missing-scratch': /Scratch and source roots must not overlap/,
    ...Object.fromEntries(
      keyTypes.map((_, index) => [
        'invalid-runtime-key-' + index,
        /runtimeApiKey must be a string or null/,
      ]),
    ),
  };
  assert.throws(
    () => runCheck(),
    (error) => expected[label].test(error.stderr),
    label,
  );
  assert.deepEqual(await readdir(rootA), ['sample.txt']);
  assert.equal(await readFile(join(rootA, 'sample.txt'), 'utf8'), 'synthetic A');
  reports.push(label + ': PASS');
}
// Only local doctor with synthetic keys; no tunnel run or cloud requests.
function runDoctor(promptExpected, doctorOnly = true) {
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    '$global:portablePromptCalls = 0',
    promptExpected
      ? 'function Read-Host { param([string]$Prompt,[switch]$AsSecureString) $global:portablePromptCalls++; $value = New-Object System.Security.SecureString; foreach ($c in "' +
        promptKey +
        '".ToCharArray()) { $value.AppendChar($c) }; return $value }'
      : "function Read-Host { throw 'Unexpected runtime key prompt.' }",
    'try {',
    "& '" + join(kit, 'Start.ps1').replaceAll("'", "''") + "'" + (doctorOnly ? ' -DoctorOnly' : ''),
    '} finally { if ((Test-Path Env:CONTROL_PLANE_API_KEY) -or (Test-Path Env:PORTABLE_HTTP_API_KEY)) { throw "Key environment was not cleared." } }',
    'if ($global:portablePromptCalls -ne ' +
      (promptExpected ? 1 : 0) +
      ') { throw "Unexpected prompt count." }',
    'Write-Output "RUNTIME_KEY_CLEANUP_PASS"',
  ].join('\n');
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    {
      cwd: stage,
      encoding: 'utf8',
      timeout: 60000,
      windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: '' },
    },
  );
  if (result.error) throw result.error;
  noKeys(result.stderr);
  if (result.status !== 0) {
    const error = new Error('Local doctor failed.');
    error.stderr = result.stderr;
    throw error;
  }
  return result.stdout;
}
function noKeys(text) {
  for (const key of [configuredKey, promptKey, httpKey]) assert(!String(text).includes(key));
}
const { runtimeApiKey: _key, ...withoutKey } = multi;
const doctorCases = [
  ['omitted-runtime-key', withoutKey, true],
  ['empty-runtime-key', { ...multi, runtimeApiKey: '' }, true],
  ['null-runtime-key', { ...multi, runtimeApiKey: null }, true],
  ['whitespace-runtime-key', { ...multi, runtimeApiKey: ' \t ' }, true],
  ['configured-runtime-key', { ...multi, runtimeApiKey: ' ' + configuredKey + ' ' }, false],
];
for (const [label, config, promptExpected] of doctorCases) {
  await save({ ...config, tunnelId: 'tunnel_0123456789abcdef0123456789abcdef' });
  const before = await readFile(join(kit, 'config.json'), 'utf8');
  const output = runDoctor(promptExpected);
  assert(output.includes('RUNTIME_KEY_CLEANUP_PASS'));
  noKeys(output);
  const profile = await readFile(join(kit, 'data/tunnel/profile/portable.yaml'), 'utf8');
  assert(profile.includes('env:CONTROL_PLANE_API_KEY'));
  noKeys(profile);
  assert.equal(await readFile(join(kit, 'config.json'), 'utf8'), before);
  reports.push('PowerShell-5.1-DoctorOnly-' + label + '-no-secret-output-or-writeback: PASS');
}
const configModule = join(kit, 'scripts/config.mjs');
const redactionProbe = [
  "import { pathToFileURL } from 'node:url';",
  'const { configuration } = await import(pathToFileURL(' +
    JSON.stringify(configModule) +
    ').href);',
  "const config = await configuration(); if ('runtimeApiKey' in config) throw new Error('Runtime key escaped configuration.');",
  "if ('apiKey' in config.localHttp) throw new Error('HTTP key escaped configuration.');",
  "console.log('CONFIG_RUNTIME_KEY_REDACTION_PASS');",
].join('\n');
assert(
  execFileSync(node, ['--input-type=module', '-e', redactionProbe], {
    encoding: 'utf8',
    windowsHide: true,
  }).includes('CONFIG_RUNTIME_KEY_REDACTION_PASS'),
);
noKeys(JSON.stringify(runCheck()));
reports.push('configured-runtime-key-redacted-from-MCP-configuration: PASS');
const servePath = join(kit, 'scripts/serve.mjs');
const originalServe = await readFile(servePath, 'utf8');
const warning =
  '[warning] [source-provenance] {"query":"machine","reason":"process_error","code":"EPERM"}';
try {
  await writeFile(
    servePath,
    'process.stderr.write(' +
      JSON.stringify(warning + '\nprivate-stderr-sentinel\n') +
      ');\n' +
      originalServe,
  );
  const checked = spawnSync(node, [check], {
    cwd: stage,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).result, 'LOCAL_MCP_PASS');
  assert(checked.stderr.includes(warning));
  assert(!checked.stderr.includes('private-stderr-sentinel'));
  assert(runDoctor(false).includes('RUNTIME_KEY_CLEANUP_PASS'));
} finally {
  await writeFile(servePath, originalServe);
}
reports.push('provenance-warning-visible-with-successful-JSON-and-PowerShell-5.1-doctor: PASS');
// Force a local profile write failure after the key and lock have been acquired.
const profilePath = join(kit, 'data/tunnel/profile/portable.yaml');
const savedProfilePath = profilePath + '.saved';
await rename(profilePath, savedProfilePath);
await mkdir(profilePath);
try {
  assert.throws(
    () => runDoctor(false),
    (error) => /Local doctor failed/.test(error.message),
  );
} finally {
  await rmdir(profilePath);
  await rename(savedProfilePath, profilePath);
}
assert(runDoctor(false).includes('RUNTIME_KEY_CLEANUP_PASS'));
reports.push('configured-runtime-key-failure-clears-environment-and-releases-lock: PASS');
for (const runtimeApiKey of keyTypes) {
  await save({ ...multi, runtimeApiKey });
  assert.throws(
    () => runDoctor(false),
    (error) => {
      noKeys(error.stderr);
      return /runtimeApiKey must be a string or null/.test(error.stderr);
    },
  );
}
await writeFile(join(kit, 'config.json'), '{"runtimeApiKey":"' + configuredKey + '\n');
for (const run of [() => runCheck(), () => runDoctor(false)]) {
  assert.throws(run, (error) => {
    noKeys(error.stderr);
    return /Cannot read config.json: expected valid JSON/.test(error.stderr);
  });
}
reports.push('malformed-config-diagnostics-do-not-echo-runtime-key: PASS');
await save({ ...multi, tunnelId: 'tunnel_0123456789abcdef0123456789abcdef' });
// Protect against stale PID reuse: this verifier is not the recorded tunnel.
await writeFile(join(kit, 'data/tunnel/tunnel.pid'), String(process.pid));
await writeFile(join(kit, 'data/tunnel/started-at.txt'), new Date().toISOString());
assert.throws(
  () =>
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(kit, 'Stop.ps1'), '-Force'],
      { encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: 'pipe' },
    ),
  (error) => /PID identity does not match/.test(error.stderr),
);
reports.push('emergency-stop-refuses-unrelated-PID: PASS');

// The HTTP leg uses the same relocated kit and synthetic sources, without a tunnel.
const reservation = createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const httpPort = reservation.address().port;
await new Promise((resolve, reject) =>
  reservation.close((error) => (error ? reject(error) : resolve())),
);
const httpConfig = {
  ...capConfig,
  transport: 'http',
  localHttp: { host: '127.0.0.1', port: httpPort, apiKey: ' ' + httpKey + ' ' },
  scratchDirectory: './data/http-jobs',
};
delete httpConfig.tunnelId;
delete httpConfig.runtimeApiKey;
const launcher = join(kit, 'scripts/serve.mjs');
function effective() {
  const output = execFileSync(node, [launcher, '--print-config', '--json'], {
    cwd: stage,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      FS_API_KEY: configuredKey,
      FS_PORT: '39999',
      PORTABLE_HTTP_API_KEY: '',
    },
  });
  noKeys(output);
  return JSON.parse(output);
}
await save({ ...httpConfig, transport: 'stdio' });
const stdioEffective = effective();
await save(httpConfig);
const httpEffective = effective();
assert.equal(stdioEffective.transport, 'stdio');
assert.equal(httpEffective.transport, 'http://127.0.0.1:' + httpPort);
assert.equal(stdioEffective.apiKey, null);
assert.equal(httpEffective.apiKey, '***');
assert.deepEqual(httpEffective.allowedRoots, stdioEffective.allowedRoots);
assert.deepEqual(httpEffective.limits, stdioEffective.limits);
assert.equal(httpEffective.snapshotFormat, stdioEffective.snapshotFormat);
assert.equal(httpEffective.limits.snapshot.scratchDirectory, join(kit, 'data/http-jobs'));
assert.equal(httpEffective.limits.snapshot.maxTreeRawPartBytes, 65536);
assert.equal(runCheck().configuredTransport, 'http');
reports.push('stdio-http-effective-config-parity-and-isolated-preflight: PASS');
noKeys(
  execFileSync(node, ['--input-type=module', '-e', redactionProbe], {
    encoding: 'utf8',
    windowsHide: true,
  }),
);
reports.push('http-key-redacted-from-default-configuration: PASS');

for (const [label, apiKey, promptExpected] of [
  ['configured', httpKey, false],
  ['empty', '', true],
  ['null', null, true],
  ['omitted', undefined, true],
  ['whitespace', ' \t ', true],
]) {
  await save({ ...httpConfig, localHttp: { ...httpConfig.localHttp, apiKey } });
  const before = await readFile(join(kit, 'config.json'), 'utf8');
  const output = runDoctor(promptExpected);
  assert(output.includes(httpEffective.transport));
  assert(output.includes('"apiKey": "***"'));
  noKeys(output);
  assert.equal(await readFile(join(kit, 'config.json'), 'utf8'), before);
  reports.push('PowerShell-5.1-http-doctor-' + label + '-key-no-tunnel-or-writeback: PASS');
}

await save(httpConfig);
const binaryPath = join(capRoot, 'original.bin');
const binary = Buffer.from([0, 255, 1, 128, 13, 10]);
await writeFile(binaryPath, binary);
const endpoint = 'http://127.0.0.1:' + httpPort;
const httpArtifacts = new Map();
let httpJobId;
for (const phase of ['initial', 'restart']) {
  let stderr = '';
  const child = spawn(node, [launcher], {
    cwd: stage,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      FS_API_KEY: configuredKey,
      FS_SNAPSHOT_DIR: rootA,
      FS_ALLOWED_HOSTS: 'evil.example',
      FS_ALLOW_UNRESTRICTED_HOSTS: '1',
    },
  });
  const exited = once(child, 'exit');
  child.stdout.on('data', (chunk) => noKeys(chunk));
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-16000);
  });
  const httpClient = new Client({ name: 'portable-http-acceptance', version: '1' });
  try {
    const deadline = Date.now() + 30000;
    while (true) {
      assert.equal(child.exitCode, null, stderr);
      try {
        const health = await fetch(endpoint + '/healthz', { signal: AbortSignal.timeout(1000) });
        if (health.ok) break;
      } catch {
        /* Startup is bounded by the deadline below. */
      }
      assert(Date.now() < deadline, 'HTTP startup timed out: ' + stderr);
      await delay(50);
    }
    const status = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(kit, 'Status.ps1')],
      { encoding: 'utf8', timeout: 15000, windowsHide: true },
    );
    assert(status.includes('HTTP MCP available: ' + endpoint + '/mcp'));
    noKeys(status);
    for (const token of ['', configuredKey]) {
      const denied = await fetch(endpoint + '/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      assert.equal(denied.status, 401);
      noKeys(await denied.text());
    }
    await httpClient.connect(
      new StreamableHTTPClientTransport(new URL(endpoint + '/mcp'), {
        requestInit: { headers: { Authorization: 'Bearer ' + httpKey } },
      }),
    );
    const tools = (await httpClient.listTools()).tools;
    assert.deepEqual(tools.map((tool) => tool.name).sort(), httpEffective.tools.sort());
    assert.equal(tools.length, 13);
    const httpCall = async (name, args) => {
      const response = await httpClient.callTool({ name, arguments: args });
      assert(!response.isError, JSON.stringify(response));
      return response;
    };
    assert.deepEqual(bytes(await httpCall('get_file', { path: binaryPath })), binary);
    const submission = await httpCall('snapshot', { path: capRoot });
    const submitted = submission.structuredContent ?? submission._meta;
    if (phase === 'restart') {
      assert.equal(submitted.reason, 'completed_reuse');
      assert.equal(submitted.job.jobId, httpJobId);
    }
    let job = submitted.job;
    while (['queued', 'running'].includes(job.state)) {
      assert(Date.now() < deadline, 'HTTP snapshot timed out');
      await delay(50);
      const result = await httpCall('job_status', { jobId: job.jobId });
      job = result.structuredContent ?? result._meta;
    }
    assert.equal(job.state, 'completed', JSON.stringify(job));
    httpJobId = job.jobId;
    const manifest = JSON.parse(
      bytes(await httpCall('get_artifact', { artifactId: job.manifestArtifactId })),
    );
    assert.equal(manifest.layout, 'tree-depth-v1');
    assert.equal(manifest.policy.maxRawPartBytes, 65536);
    assert(manifest.parts.length > 1);
    for (const part of manifest.parts) {
      const zip = bytes(await httpCall('get_artifact', { artifactId: part.artifactId }));
      assert.equal(createHash('sha256').update(zip).digest('hex'), part.sha256);
      const raw = unzipSingle(zip);
      assert.equal(raw.length, part.rawBytes);
      assert(raw.length <= 65536);
      if (phase === 'restart') assert.deepEqual(zip, httpArtifacts.get(part.artifactId));
      httpArtifacts.set(part.artifactId, zip);
    }
    reports.push('http-auth-discovery-original-multipart-SHA-CRC-' + phase + ': PASS');
  } finally {
    try {
      await httpClient.close();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
      noKeys(stderr);
    }
  }
}

const invalidHttp = [
  ['transport', { ...httpConfig, transport: 'HTTP' }],
  ['transport-null', { ...httpConfig, transport: null }],
  ['http-object', { ...httpConfig, localHttp: null }],
  ...['0.0.0.0', '::', '0:0:0:0:0:0:0:0', 'http://127.0.0.1', ''].map((host) => [
    'host',
    { ...httpConfig, localHttp: { ...httpConfig.localHttp, host } },
  ]),
  ...[0, 65536, '8766', 1.5].map((port) => [
    'port',
    { ...httpConfig, localHttp: { ...httpConfig.localHttp, port } },
  ]),
  ...[
    false,
    42,
    [],
    {},
    'short',
    'has whitespace in this key',
    'sixteen-characters\0suffix',
    'unicode-Антенна-key',
  ].map((apiKey) => ['key', { ...httpConfig, localHttp: { ...httpConfig.localHttp, apiKey } }]),
];
for (const [label, config] of invalidHttp) {
  await save(config);
  assert.throws(
    () => effective(),
    (error) => {
      noKeys(error.stderr);
      return /transport must|localHttp\./.test(error.stderr) || /localHttp must/.test(error.stderr);
    },
    label,
  );
}
reports.push('invalid-http-transport-host-port-key-types-and-values: PASS');
await save({ ...httpConfig, localHttp: { ...httpConfig.localHttp, apiKey: '' } });
assert.throws(
  () => effective(),
  (error) => /HTTP requires an API key/.test(error.stderr),
);
reports.push('direct-http-launch-refuses-missing-key-and-inherited-FS-key: PASS');

// A post-prompt launch failure must clear the secret and release the common lock.
const savedServe = await readFile(launcher, 'utf8');
try {
  await writeFile(
    launcher,
    "if (!process.argv.includes('--preflight')) { if (!process.env.PORTABLE_HTTP_API_KEY) process.exit(92); process.exit(23); }\n" +
      savedServe,
  );
  assert.throws(
    () => runDoctor(true, false),
    (error) => /Local doctor failed/.test(error.message),
  );
} finally {
  await writeFile(launcher, savedServe);
}
assert(runDoctor(true).includes('RUNTIME_KEY_CLEANUP_PASS'));
reports.push('http-failed-launch-clears-key-and-releases-lock: PASS');

// Holding the lock must prevent a second Start before it prompts for credentials.
const lockProbe = [
  "$ErrorActionPreference = 'Stop'",
  "function Read-Host { throw 'UNEXPECTED_PROMPT' }",
  "$lock = [IO.File]::Open('" +
    join(kit, 'data/run.lock').replaceAll("'", "''") +
    "', [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)",
  "try { & '" +
    join(kit, 'Start.ps1').replaceAll("'", "''") +
    "' -DoctorOnly; throw 'START_WAS_NOT_BLOCKED' } catch { if ($_.Exception.Message -match 'UNEXPECTED_PROMPT|START_WAS_NOT_BLOCKED') { throw }; Write-Output 'RUN_LOCK_PASS' } finally { $lock.Dispose() }",
].join('\n');
assert(
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', lockProbe],
    { encoding: 'utf8', timeout: 60000, windowsHide: true },
  ).includes('RUN_LOCK_PASS'),
);
reports.push('http-start-refuses-concurrent-kit-run-before-prompt: PASS');
assert.throws(
  () =>
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(kit, 'Stop.ps1'), '-Force'],
      { encoding: 'utf8', timeout: 15000, windowsHide: true },
    ),
  (error) => /HTTP mode: use Ctrl\+C/.test(error.stderr),
);
reports.push('http-force-stop-refuses-to-touch-recorded-tunnel-PID: PASS');
assert.equal(await readFile(join(rootB, 'sample.txt'), 'utf8'), 'synthetic B');
const report = { result: 'PORTABLE_ACCEPTANCE_PASS', reports, kit, rootA, rootB };
await writeFile(join(stage, 'result.json'), JSON.stringify(report, null, 2));
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
