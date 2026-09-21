import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(
        'Usage: node local-mcp-check.mjs --fixture-root PATH --delivery-dir PATH --scratch-dir PATH',
      );
    }
    values.set(key, value);
  }
  for (const required of ['--fixture-root', '--delivery-dir', '--scratch-dir']) {
    assert(values.has(required), `${required} is required`);
  }
  return {
    fixtureRoot: resolve(values.get('--fixture-root')),
    deliveryDir: resolve(values.get('--delivery-dir')),
    scratchDir: resolve(values.get('--scratch-dir')),
  };
}

function assertOutside(source, candidate, label) {
  const fromSource = relative(source, candidate);
  assert(
    fromSource === '..' || fromSource.startsWith(`..${sep}`) || isAbsolute(fromSource),
    `${label} must be outside the fixture root`,
  );
}

async function resolveDestination(candidate) {
  let current = resolve(candidate);
  const missing = [];
  for (;;) {
    try {
      const existing = await realpath(current);
      return resolve(existing, ...missing.reverse());
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(basename(current));
      current = parent;
    }
  }
}

function structured(result) {
  return result.structuredContent ?? result._meta;
}

function embeddedBytes(result) {
  const block = result.content.find((item) => item.type === 'resource');
  assert(block?.type === 'resource' && 'blob' in block.resource, 'artifact bytes not embedded');
  return Buffer.from(block.resource.blob, 'base64');
}

async function waitForTerminal(client, jobId) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const response = await client.callTool({ name: 'job_status', arguments: { jobId } });
    assert.notEqual(response.isError, true, response.content[0]?.text ?? 'job_status failed');
    const status = structured(response);
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(status.state)) return status;
    assert(Date.now() < deadline, 'bundle did not reach a terminal state');
    await new Promise((resolveWaiter) => setTimeout(resolveWaiter, 25));
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = resolve(import.meta.dirname, '..', '..');
  const fixtureRoot = await realpath(options.fixtureRoot);
  const deliveryDir = await resolveDestination(options.deliveryDir);
  const scratchDir = await resolveDestination(options.scratchDir);
  assertOutside(fixtureRoot, deliveryDir, 'delivery directory');
  assertOutside(fixtureRoot, scratchDir, 'scratch directory');
  await mkdir(deliveryDir, { recursive: true });
  await mkdir(scratchDir, { recursive: true });
  const fixtureManifest = JSON.parse(await readFile(join(fixtureRoot, 'manifest.json'), 'utf8'));
  const selectedRecords = [fixtureManifest.originals.zip, fixtureManifest.originals.xls];
  const files = [];
  for (const record of selectedRecords) {
    const details = await stat(join(fixtureRoot, record.file));
    files.push({
      relativePath: record.file,
      expected: { size: details.size, lastWriteTime: details.mtime.toISOString() },
    });
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      join(repoRoot, 'dist', 'index.js'),
      '--read-only',
      '--root-boundary',
      fixtureRoot,
      fixtureRoot,
    ],
    cwd: repoRoot,
    env: { ...getDefaultEnvironment(), FS_SNAPSHOT_DIR: scratchDir },
  });
  const client = new Client(
    { name: 'bundle-local-check', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  const report = {
    schemaVersion: 1,
    resultClass: 'LOCAL_ONLY_NOT_CHATGPT',
    route: 'Node client -> stdio MCP -> bundle/job_status/get_artifact -> artifact files',
    source: '<scratch>/source',
    delivery: '<scratch>/delivered',
    selected: files.map((file) => file.relativePath),
    submitMs: 0,
    buildMs: 0,
    artifacts: [],
  };
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert(
      tools.tools.some((tool) => tool.name === 'bundle'),
      'bundle missing in read-only mode',
    );
    const idempotencyKey = `bundle-local-${Date.now().toString(36)}`;
    const submitStarted = performance.now();
    const submitted = await client.callTool({
      name: 'bundle',
      arguments: { path: fixtureRoot, idempotencyKey, files: [...files].reverse() },
    });
    report.submitMs = Number((performance.now() - submitStarted).toFixed(1));
    assert.notEqual(submitted.isError, true, submitted.content[0]?.text ?? 'bundle failed');
    const jobId = structured(submitted).job.jobId;

    const reused = await client.callTool({
      name: 'bundle',
      arguments: { path: fixtureRoot, idempotencyKey, files },
    });
    assert.equal(structured(reused).reused, true);
    assert.equal(structured(reused).job.jobId, jobId);

    const buildStarted = performance.now();
    const status = await waitForTerminal(client, jobId);
    report.buildMs = Number((performance.now() - buildStarted).toFixed(1));
    assert.equal(status.state, 'completed', status.stopReason ?? 'bundle failed');
    assert.equal(status.complete, true);
    report.jobId = jobId;
    report.counters = status.counters;

    const manifestResponse = await client.callTool({
      name: 'get_artifact',
      arguments: { artifactId: status.manifestArtifactId },
    });
    const manifestBytes = embeddedBytes(manifestResponse);
    await writeFile(join(deliveryDir, 'bundle-manifest.json'), manifestBytes);
    const bundleManifest = JSON.parse(manifestBytes.toString('utf8'));
    assert.equal(bundleManifest.complete, true);
    assert.deepEqual(
      new Set(bundleManifest.files.map((file) => file.relativePath)),
      new Set(files.map((file) => file.relativePath)),
    );
    report.artifacts.push({
      name: 'bundle-manifest.json',
      bytes: manifestBytes.length,
      fetchMs: undefined,
    });

    let repeat;
    for (const part of bundleManifest.parts) {
      const started = performance.now();
      const response = await client.callTool({
        name: 'get_artifact',
        arguments: { artifactId: part.artifactId },
      });
      const bytes = embeddedBytes(response);
      const fetchMs = Number((performance.now() - started).toFixed(1));
      assert.equal(bytes.length, part.zipBytes);
      await writeFile(join(deliveryDir, basename(part.name)), bytes);
      report.artifacts.push({ name: part.name, bytes: bytes.length, fetchMs });
      if (!repeat || bytes.length > repeat.bytes.length) repeat = { part, bytes };
    }
    assert(repeat, 'bundle produced no ZIP parts');
    const repeated = embeddedBytes(
      await client.callTool({
        name: 'get_artifact',
        arguments: { artifactId: repeat.part.artifactId },
      }),
    );
    assert.deepEqual(repeated, repeat.bytes);
    await writeFile(join(deliveryDir, `${basename(repeat.part.name)}.repeat`), repeated);
    report.repeat = { name: repeat.part.name, bytes: repeated.length, equal: true };
    await writeFile(
      join(deliveryDir, 'local-mcp-report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    );
    process.stdout.write(`${join(deliveryDir, 'local-mcp-report.json')}\n`);
  } finally {
    await client.close().catch(() => undefined);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await main();
}
