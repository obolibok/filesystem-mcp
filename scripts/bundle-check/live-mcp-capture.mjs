import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

const TWO_MIB = 2 * 1024 * 1024;

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(
        'Usage: node live-mcp-capture.mjs --case small|volume|partial --fixture-root PATH --delivery-dir PATH --scratch-dir PATH [--selection-manifest PATH]',
      );
    }
    values.set(key, value);
  }
  for (const required of ['--case', '--fixture-root', '--delivery-dir', '--scratch-dir']) {
    assert(values.has(required), `${required} is required`);
  }
  const caseName = values.get('--case');
  assert(['small', 'volume', 'partial'].includes(caseName), 'unsupported --case');
  if (caseName === 'volume') {
    assert(values.has('--selection-manifest'), '--selection-manifest is required for volume');
  }
  return {
    caseName,
    fixtureRoot: resolve(values.get('--fixture-root')),
    deliveryDir: resolve(values.get('--delivery-dir')),
    scratchDir: resolve(values.get('--scratch-dir')),
    selectionManifest: values.has('--selection-manifest')
      ? resolve(values.get('--selection-manifest'))
      : undefined,
  };
}

function structured(result) {
  return result.structuredContent ?? result._meta;
}

function embeddedBytes(result) {
  const block = result.content.find((item) => item.type === 'resource');
  assert(block?.type === 'resource' && 'blob' in block.resource, 'artifact bytes not embedded');
  return Buffer.from(block.resource.blob, 'base64');
}

function assertOutside(source, candidate, label) {
  const fromSource = relative(source, candidate);
  assert(
    fromSource === '..' || fromSource.startsWith(`..${sep}`) || isAbsolute(fromSource),
    `${label} must be outside the fixture root`,
  );
}

async function waitForTerminal(client, jobId) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const response = await client.callTool({ name: 'job_status', arguments: { jobId } });
    assert.notEqual(response.isError, true, response.content[0]?.text ?? 'job_status failed');
    const status = structured(response);
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(status.state)) return status;
    assert(Date.now() < deadline, 'bundle did not reach a terminal state');
    await new Promise((resolveWaiter) => setTimeout(resolveWaiter, 25));
  }
}

async function selectionsFor(options) {
  if (options.caseName === 'volume') {
    const manifest = JSON.parse(await readFile(options.selectionManifest, 'utf8'));
    return manifest.selected.map((file) => ({
      relativePath: file.relativePath,
      expected: { size: file.size, lastWriteTime: file.lastWriteTime },
    }));
  }
  const fixture = JSON.parse(await readFile(join(options.fixtureRoot, 'manifest.json'), 'utf8'));
  const zip = fixture.originals.zip;
  const xls = fixture.originals.xls;
  const selected = options.caseName === 'partial' ? [zip] : [zip, xls];
  const files = [];
  for (const file of selected) {
    const details = await stat(join(options.fixtureRoot, file.file));
    files.push({
      relativePath: file.file,
      expected: { size: details.size, lastWriteTime: details.mtime.toISOString() },
    });
  }
  if (options.caseName === 'partial') files.push({ relativePath: 'missing-control.bin' });
  return files;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = resolve(import.meta.dirname, '..', '..');
  const fixtureRoot = await realpath(options.fixtureRoot);
  assertOutside(fixtureRoot, options.deliveryDir, 'delivery directory');
  assertOutside(fixtureRoot, options.scratchDir, 'scratch directory');
  await mkdir(options.deliveryDir, { recursive: true });
  await mkdir(options.scratchDir, { recursive: true });
  const files = await selectionsFor({ ...options, fixtureRoot });
  const environment = {
    ...getDefaultEnvironment(),
    FS_SNAPSHOT_DIR: options.scratchDir,
    FS_BUNDLE_MAX_RAW_PART_BYTES: String(TWO_MIB),
    FS_SNAPSHOT_MAX_ZIP_BYTES: String(TWO_MIB),
    FS_SNAPSHOT_MAX_DELIVERY_BYTES: String(TWO_MIB),
    FS_MAX_FILE_SIZE: String(TWO_MIB),
    FS_BUNDLE_MAX_FILE_BYTES: String(TWO_MIB),
    FS_BUNDLE_MAX_JOB_RAW_BYTES: String(8 * 1024 * 1024),
    FS_SNAPSHOT_MAX_JOB_ARTIFACT_BYTES: String(16 * 1024 * 1024),
    FS_SNAPSHOT_SCRATCH_QUOTA_BYTES: String(32 * 1024 * 1024),
  };
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
    env: environment,
  });
  const client = new Client(
    { name: `bundle-live-${options.caseName}-capture`, version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  const report = {
    schemaVersion: 1,
    resultClass: 'LOCAL_ONLY_NOT_CHATGPT',
    case: options.caseName,
    selected: files.map((file) => file.relativePath),
    effectiveCaps: {
      rawPartBytes: TWO_MIB,
      zipBytes: TWO_MIB,
      deliveryBytes: TWO_MIB,
      maxFileSizeBytes: TWO_MIB,
    },
    artifacts: [],
  };
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 13);
    assert(tools.tools.some((tool) => tool.name === 'bundle'));
    const idempotencyKey = `bundle-live-local-${options.caseName}-${Date.now().toString(36)}`;
    const submitStarted = performance.now();
    const submitted = await client.callTool({
      name: 'bundle',
      arguments: { path: fixtureRoot, idempotencyKey, files: [...files].reverse() },
    });
    report.submitMs = Number((performance.now() - submitStarted).toFixed(1));
    assert.notEqual(submitted.isError, true, submitted.content[0]?.text ?? 'bundle failed');
    const jobId = structured(submitted).job.jobId;
    report.jobId = jobId;

    const reused = await client.callTool({
      name: 'bundle',
      arguments: { path: fixtureRoot, idempotencyKey, files },
    });
    assert.equal(structured(reused).reused, true);
    assert.equal(structured(reused).job.jobId, jobId);
    report.reused = true;

    const conflict = await client.callTool({
      name: 'bundle',
      arguments: { path: fixtureRoot, idempotencyKey, files: files.slice(0, -1) },
    });
    assert.equal(conflict.isError, true);
    report.conflictRejected = true;

    const buildStarted = performance.now();
    const status = await waitForTerminal(client, jobId);
    report.buildMs = Number((performance.now() - buildStarted).toFixed(1));
    assert.equal(status.state, 'completed', status.stopReason ?? 'bundle failed');
    assert.equal(status.complete, options.caseName !== 'partial');
    report.complete = status.complete;
    report.counters = status.counters;

    const manifestResponse = await client.callTool({
      name: 'get_artifact',
      arguments: { artifactId: status.manifestArtifactId },
    });
    const manifestBytes = embeddedBytes(manifestResponse);
    const manifestPath = join(options.deliveryDir, 'bundle-manifest.json');
    await writeFile(manifestPath, manifestBytes);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    report.policy = manifest.policy;
    report.rootId = manifest.root.id;
    report.artifacts.push({ name: 'bundle-manifest.json', bytes: manifestBytes.length });

    let largest;
    for (const part of manifest.parts) {
      const started = performance.now();
      const response = await client.callTool({
        name: 'get_artifact',
        arguments: { artifactId: part.artifactId },
      });
      const bytes = embeddedBytes(response);
      const fetchMs = Number((performance.now() - started).toFixed(1));
      await writeFile(join(options.deliveryDir, basename(part.name)), bytes);
      report.artifacts.push({
        artifactId: part.artifactId,
        name: part.name,
        bytes: bytes.length,
        sha256: part.sha256,
        fetchMs,
      });
      if (!largest || bytes.length > largest.bytes.length) largest = { part, bytes };
    }
    if (options.caseName !== 'partial') {
      assert(largest, 'positive case produced no ZIP parts');
      const repeated = embeddedBytes(
        await client.callTool({
          name: 'get_artifact',
          arguments: { artifactId: largest.part.artifactId },
        }),
      );
      assert.deepEqual(repeated, largest.bytes);
      const repeatName = `${basename(largest.part.name)}.repeat`;
      await writeFile(join(options.deliveryDir, repeatName), repeated);
      report.repeat = { name: repeatName, bytes: repeated.length, equal: true };
    }
    await writeFile(
      join(options.deliveryDir, 'capture-report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    );
    process.stdout.write(`${join(options.deliveryDir, 'capture-report.json')}\n`);
  } finally {
    await client.close().catch(() => undefined);
  }
}

await main();
