import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(
        'Usage: node local-mcp-check.mjs --fixture-root PATH --delivery-dir PATH [--max-file-size BYTES]',
      );
    }
    values.set(key, value);
  }
  const fixtureRoot = values.get('--fixture-root');
  const deliveryDir = values.get('--delivery-dir');
  if (!fixtureRoot || !deliveryDir) {
    throw new Error('--fixture-root and --delivery-dir are required');
  }
  return {
    fixtureRoot: resolve(fixtureRoot),
    deliveryDir: resolve(deliveryDir),
    maxFileSize: Number(values.get('--max-file-size') ?? 1024 * 1024),
  };
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function fileResourceUri(path) {
  const posix = path.replaceAll('\\', '/');
  return `filesystem-mcp://file/${encodeURIComponent(posix).replaceAll('%2F', '/')}`;
}

function errorRecord(error) {
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    ...(typeof error === 'object' && error !== null && 'code' in error ? { code: error.code } : {}),
  };
}

async function readBlob(client, filePath) {
  const started = performance.now();
  const response = await client.readResource({ uri: fileResourceUri(filePath) });
  const elapsedMs = performance.now() - started;
  assert.equal(response.contents.length, 1);
  const [content] = response.contents;
  assert.ok(content && 'blob' in content, `${filePath} did not arrive as a binary blob`);
  return {
    bytes: Buffer.from(content.blob, 'base64'),
    mimeType: content.mimeType ?? 'application/octet-stream',
    elapsedMs: Number(elapsedMs.toFixed(1)),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  assert.ok(Number.isInteger(options.maxFileSize) && options.maxFileSize > 0);

  const repoRoot = resolve(import.meta.dirname, '..', '..');
  const fixtureRoot = await realpath(options.fixtureRoot);
  const deliveryRelative = relative(fixtureRoot, options.deliveryDir);
  assert.ok(
    deliveryRelative.startsWith('..') || isAbsolute(deliveryRelative),
    'delivery directory must be outside the source fixture root',
  );
  const manifest = JSON.parse(await readFile(join(fixtureRoot, 'manifest.json'), 'utf8'));
  assert.equal(options.maxFileSize, manifest.maxFileSizeBytes);
  await mkdir(options.deliveryDir, { recursive: true });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      join(repoRoot, 'dist', 'index.js'),
      '--read-only',
      '--root-boundary',
      fixtureRoot,
      '--max-file-size',
      String(options.maxFileSize),
      fixtureRoot,
    ],
    cwd: repoRoot,
    env: getDefaultEnvironment(),
  });
  const client = new Client(
    { name: 'originals-delivery-local-check', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  const outsideRoot = await mkdtemp(join(dirname(fixtureRoot), 'outside-root-'));

  const report = {
    schemaVersion: 1,
    route: 'Node client -> stdio MCP -> resources/read blob -> delivery directory',
    fixtureRoot: '<scratch>/source',
    deliveryDir: '<scratch>/delivered',
    maxFileSizeBytes: options.maxFileSize,
    originals: {},
    controls: {},
  };

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    report.protocolEra = client.getProtocolEra();
    report.readOnlyToolNames = tools.tools.map((tool) => tool.name).sort();
    assert.deepEqual(report.readOnlyToolNames, [
      'diff',
      'find_files',
      'list',
      'list_roots',
      'read',
      'search_text',
      'stat',
    ]);

    for (const [kind, record] of Object.entries(manifest.originals)) {
      const sourcePath = join(fixtureRoot, record.file);
      const sourceBytes = await readFile(sourcePath);
      const first = await readBlob(client, sourcePath);
      const deliveredPath = join(options.deliveryDir, record.file);
      await writeFile(deliveredPath, first.bytes);
      const deliveredBytes = await readFile(deliveredPath);
      const second = await readBlob(client, sourcePath);
      const sourceHash = sha256(sourceBytes);
      const deliveredHash = sha256(deliveredBytes);
      const repeatHash = sha256(second.bytes);
      assert.equal(sourceHash, record.sha256);
      assert.equal(deliveredHash, sourceHash);
      assert.equal(repeatHash, sourceHash);
      report.originals[kind] = {
        file: record.file,
        mimeType: first.mimeType,
        sourceSize: sourceBytes.length,
        deliveredSize: deliveredBytes.length,
        sourceSha256Node: sourceHash,
        deliveredSha256Node: deliveredHash,
        repeatedSha256Node: repeatHash,
        firstReadMs: first.elapsedMs,
        secondReadMs: second.elapsedMs,
        status: 'PASS',
      };
    }

    const atLimit = manifest.limitFixtures.atLimit;
    const atLimitRead = await readBlob(client, join(fixtureRoot, atLimit.file));
    assert.equal(atLimitRead.bytes.length, options.maxFileSize);
    assert.equal(sha256(atLimitRead.bytes), atLimit.sha256);
    report.controls.atLimit = {
      size: atLimitRead.bytes.length,
      elapsedMs: atLimitRead.elapsedMs,
      status: 'PASS',
    };

    const overLimit = manifest.limitFixtures.overLimit;
    try {
      await readBlob(client, join(fixtureRoot, overLimit.file));
      report.controls.overLimit = { status: 'FAIL', error: 'unexpected success' };
    } catch (error) {
      report.controls.overLimit = {
        size: overLimit.size,
        expected: 'resource read rejected above FS_MAX_FILE_SIZE',
        observed: errorRecord(error),
        status: 'PASS',
      };
    }

    const outsidePath = join(outsideRoot, 'not-allowed.bin');
    await writeFile(outsidePath, Buffer.from('OUTSIDE ROOT\n', 'utf8'));
    try {
      await readBlob(client, outsidePath);
      report.controls.outsideRoot = { status: 'FAIL', error: 'unexpected success' };
    } catch (error) {
      report.controls.outsideRoot = {
        expected: 'resource read rejected outside synthetic root',
        observed: errorRecord(error),
        status: 'PASS',
      };
    }
  } finally {
    const cleanupErrors = [];
    try {
      await client.close();
    } catch (error) {
      cleanupErrors.push(errorRecord(error));
    }
    try {
      await transport.close();
    } catch (error) {
      cleanupErrors.push(errorRecord(error));
    }
    if (cleanupErrors.length > 0) report.cleanupErrors = cleanupErrors;
    await rm(outsideRoot, { recursive: true, force: true });
  }

  const reportPath = join(options.deliveryDir, 'local-mcp-report.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const failed = [...Object.values(report.originals), ...Object.values(report.controls)].filter(
    (result) => result.status !== 'PASS',
  );
  assert.equal(failed.length, 0, `local MCP checks failed; inspect ${reportPath}`);
  assert.equal(report.cleanupErrors, undefined, `cleanup failed; inspect ${reportPath}`);
  process.stdout.write(`${reportPath}\n`);
}

await main();
