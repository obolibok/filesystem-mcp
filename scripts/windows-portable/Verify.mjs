import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
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
const defaults = runCheck();
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
    else assert(unpacked.toString('utf8').includes('sample.txt'));
    reports.push(name + '-manifest-ZIP-SHA256-CRC-original: PASS');
  }
} finally {
  await client.close();
}
const cases = [
  ['empty-roots', { ...multi, roots: [] }],
  ['missing-root', { ...multi, roots: [join(stage, 'missing-root')] }],
  ['kit-exposed-as-root', { ...multi, roots: [kit] }],
  ['source-scratch-overlap', { ...multi, scratchDirectory: join(rootA, 'missing-scratch') }],
  ['invalid-limit', { ...multi, limits: { ...multi.limits, FS_MAX_FILE_SIZE: -1 } }],
  ['unknown-limit', { ...multi, limits: { ...multi.limits, FS_ALLOW_SENSITIVE: 1 } }],
];
const alias = join(stage, 'source-alias');
await symlink(rootA, alias, 'junction');
cases.push([
  'junction-missing-scratch',
  { ...multi, scratchDirectory: join(alias, 'missing', 'scratch') },
]);
for (const [label, config] of cases) {
  await save(config);
  const expected = {
    'empty-roots': /at least one explicit source root/,
    'missing-root': /ENOENT/,
    'kit-exposed-as-root': /Keep sources separate/,
    'source-scratch-overlap': /Scratch and source roots must not overlap/,
    'invalid-limit': /out-of-range limit: FS_MAX_FILE_SIZE/,
    'unknown-limit': /out-of-range limit: FS_ALLOW_SENSITIVE/,
    'junction-missing-scratch': /Scratch and source roots must not overlap/,
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
await save({ ...multi, tunnelId: 'tunnel_0123456789abcdef0123456789abcdef' });
// A dummy key is sufficient for local doctor; no tunnel run or cloud requests.
const ps = [
  "$ErrorActionPreference = 'Stop'",
  'function Read-Host { param([string]$Prompt,[switch]$AsSecureString) $value = New-Object System.Security.SecureString; foreach ($c in "sk-local-doctor-placeholder-not-a-real-key".ToCharArray()) { $value.AppendChar($c) }; return $value }',
  "& '" + join(kit, 'Start.ps1').replaceAll("'", "''") + "' -DoctorOnly",
].join('\n');
execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
  cwd: stage,
  encoding: 'utf8',
  timeout: 60000,
  windowsHide: true,
  env: { ...process.env, NODE_OPTIONS: '' },
});
const profile = await readFile(join(kit, 'data/tunnel/profile/portable.yaml'), 'utf8');
assert(profile.includes('env:CONTROL_PLANE_API_KEY'));
assert(!profile.includes('sk-local-doctor-placeholder'));
reports.push('PowerShell-5.1-Start-DoctorOnly-relative-stdio-and-secret-reference: PASS');
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
assert.equal(await readFile(join(rootB, 'sample.txt'), 'utf8'), 'synthetic B');
const report = { result: 'PORTABLE_ACCEPTANCE_PASS', reports, kit, rootA, rootB };
await writeFile(join(stage, 'result.json'), JSON.stringify(report, null, 2));
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
