import { Client, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

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

export async function readBlob(client, filePath) {
  const started = performance.now();
  const response = await client.readResource(
    { uri: fileResourceUri(filePath) },
    { cacheMode: 'bypass' },
  );
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

function assertOutsideSource(fixtureRoot, deliveryDir) {
  const deliveryRelative = relative(fixtureRoot, deliveryDir);
  assert.ok(
    deliveryRelative === '..' ||
      deliveryRelative.startsWith(`..${sep}`) ||
      isAbsolute(deliveryRelative),
    'delivery directory must be outside the source fixture root',
  );
}

async function canonicalDestination(directory) {
  try {
    return await realpath(directory);
  } catch (error) {
    if (error.code !== 'ENOENT' || dirname(directory) === directory) throw error;
    return join(await canonicalDestination(dirname(directory)), basename(directory));
  }
}

export async function prepareDeliveryDirectory(source, destination) {
  const fixtureRoot = await realpath(source);
  const candidate = await canonicalDestination(resolve(destination));
  // Resolve existing ancestors first: creating a missing child through a source
  // alias/junction must not create anything inside the source root.
  assertOutsideSource(fixtureRoot, candidate);
  await mkdir(candidate, { recursive: true });
  const deliveryDir = await realpath(candidate);
  assertOutsideSource(fixtureRoot, deliveryDir);
  return deliveryDir;
}

export async function checkRejection(client, filePath, expectedMessage) {
  try {
    // A successful text response is still an unauthorized read, not a blob
    // decoding failure that can stand in for a server rejection.
    await client.readResource({ uri: fileResourceUri(filePath) }, { cacheMode: 'bypass' });
    return { status: 'FAIL', error: 'unexpected success' };
  } catch (error) {
    const matches =
      error instanceof ProtocolError &&
      error.code === ProtocolErrorCode.InvalidParams &&
      error.message.includes(expectedMessage);
    return { observed: errorRecord(error), status: matches ? 'PASS' : 'FAIL' };
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  assert.ok(Number.isInteger(options.maxFileSize) && options.maxFileSize > 0);

  const repoRoot = resolve(import.meta.dirname, '..', '..');
  const fixtureRoot = await realpath(options.fixtureRoot);
  const deliveryDir = await prepareDeliveryDirectory(fixtureRoot, options.deliveryDir);
  const manifest = JSON.parse(await readFile(join(fixtureRoot, 'manifest.json'), 'utf8'));
  assert.equal(options.maxFileSize, manifest.maxFileSizeBytes);

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
    resourceCacheMode: 'bypass',
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
      const deliveredPath = join(deliveryDir, record.file);
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
    report.controls.overLimit = {
      size: overLimit.size,
      expected: 'resource read rejected above FS_MAX_FILE_SIZE',
      ...(await checkRejection(
        client,
        join(fixtureRoot, overLimit.file),
        `File exceeds size limit (${overLimit.size} > ${options.maxFileSize} bytes)`,
      )),
    };

    const outsidePath = join(outsideRoot, 'not-allowed.bin');
    await writeFile(outsidePath, Buffer.from('OUTSIDE ROOT\n', 'utf8'));
    report.controls.outsideRoot = {
      expected: 'resource read rejected outside synthetic root',
      ...(await checkRejection(client, outsidePath, 'Outside allowed directories.')),
    };
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

  const reportPath = join(deliveryDir, 'local-mcp-report.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const failed = [...Object.values(report.originals), ...Object.values(report.controls)].filter(
    (result) => result.status !== 'PASS',
  );
  assert.equal(failed.length, 0, `local MCP checks failed; inspect ${reportPath}`);
  assert.equal(report.cleanupErrors, undefined, `cleanup failed; inspect ${reportPath}`);
  process.stdout.write(`${reportPath}\n`);
}

if (
  process.argv[1] &&
  (await realpath(process.argv[1])) === (await realpath(fileURLToPath(import.meta.url)))
) {
  await main();
}
