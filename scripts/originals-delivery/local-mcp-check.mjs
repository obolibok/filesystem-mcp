import { Client } from '@modelcontextprotocol/client';
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

function errorRecord(error) {
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    ...(typeof error === 'object' && error !== null && 'code' in error ? { code: error.code } : {}),
  };
}

export async function readEmbeddedFile(client, filePath) {
  const started = performance.now();
  const response = await client.callTool({ name: 'get_file', arguments: { path: filePath } });
  const elapsedMs = performance.now() - started;
  assert.notEqual(response.isError, true, `${filePath} get_file returned an error`);
  const content = response.content.find((block) => block.type === 'resource');
  assert.ok(content && 'resource' in content, `${filePath} did not arrive as an embedded resource`);
  assert.ok('blob' in content.resource, `${filePath} embedded resource did not contain bytes`);
  const link = response.content.find((block) => block.type === 'resource_link');
  assert.ok(link && 'uri' in link, `${filePath} did not include a resource link`);
  assert.equal(link.uri, content.resource.uri);
  const bytes = Buffer.from(content.resource.blob, 'base64');
  assert.equal(
    bytes.toString('base64'),
    content.resource.blob,
    `${filePath} blob is not canonical base64`,
  );
  assert.equal(link.name, basename(filePath));
  assert.equal(link.mimeType, content.resource.mimeType);
  assert.equal(link.size, bytes.length);
  assert.equal(response._meta?.size, bytes.length);
  assert.equal(response._meta?.encodedSize, content.resource.blob.length);
  assert.equal(response._meta?.encodedSize, 4 * Math.ceil(bytes.length / 3));
  assert.equal(response._meta?.resourceUri, content.resource.uri);
  assert.equal(response._meta?.delivery, 'mcp-embedded-resource');
  return {
    bytes,
    mimeType: content.resource.mimeType ?? 'application/octet-stream',
    encodedSize: content.resource.blob.length,
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

export async function checkRejection(client, filePath, expectedCode, expectedMessage) {
  try {
    const response = await client.callTool({
      name: 'get_file',
      arguments: { path: filePath },
    });
    const text = response.content.find((block) => block.type === 'text')?.text ?? '';
    const leakedResource = response.content.some(
      (block) => block.type === 'resource' || block.type === 'resource_link',
    );
    const matches =
      response.isError === true &&
      text.includes(`${expectedCode}:`) &&
      text.includes(expectedMessage) &&
      !leakedResource;
    return {
      observed: { isError: response.isError === true, text, leakedResource },
      status: matches ? 'PASS' : 'FAIL',
    };
  } catch (error) {
    return { observed: errorRecord(error), status: 'FAIL' };
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
    schemaVersion: 2,
    route: 'Node client -> stdio MCP -> get_file embedded resource -> delivery directory',
    fixtureRoot: '<scratch>/source',
    deliveryDir: '<scratch>/delivered',
    maxFileSizeBytes: options.maxFileSize,
    toolResultCache: 'not applicable; each repeat is a new tools/call request',
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
      'get_file',
      'list',
      'list_roots',
      'read',
      'search_text',
      'stat',
    ]);

    for (const [kind, record] of Object.entries(manifest.originals)) {
      const sourcePath = join(fixtureRoot, record.file);
      const sourceBytes = await readFile(sourcePath);
      const first = await readEmbeddedFile(client, sourcePath);
      const deliveredPath = join(deliveryDir, record.file);
      await writeFile(deliveredPath, first.bytes);
      const deliveredBytes = await readFile(deliveredPath);
      const second = await readEmbeddedFile(client, sourcePath);
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
        firstEncodedSize: first.encodedSize,
        deliveredSize: deliveredBytes.length,
        sourceSha256Node: sourceHash,
        deliveredSha256Node: deliveredHash,
        repeatedSha256Node: repeatHash,
        secondEncodedSize: second.encodedSize,
        firstReadMs: first.elapsedMs,
        secondReadMs: second.elapsedMs,
        status: 'PASS',
      };
    }

    const atLimit = manifest.limitFixtures.atLimit;
    const atLimitRead = await readEmbeddedFile(client, join(fixtureRoot, atLimit.file));
    assert.equal(atLimitRead.bytes.length, options.maxFileSize);
    assert.equal(sha256(atLimitRead.bytes), atLimit.sha256);
    report.controls.atLimit = {
      size: atLimitRead.bytes.length,
      encodedSize: atLimitRead.encodedSize,
      elapsedMs: atLimitRead.elapsedMs,
      status: 'PASS',
    };

    const overLimit = manifest.limitFixtures.overLimit;
    report.controls.overLimit = {
      size: overLimit.size,
      expected: 'get_file rejected above FS_MAX_FILE_SIZE without resource content',
      ...(await checkRejection(
        client,
        join(fixtureRoot, overLimit.file),
        'TOO_LARGE',
        `File exceeds size limit (${overLimit.size} > ${options.maxFileSize} bytes)`,
      )),
    };

    const outsidePath = join(outsideRoot, 'not-allowed.bin');
    await writeFile(outsidePath, Buffer.from('OUTSIDE ROOT\n', 'utf8'));
    report.controls.outsideRoot = {
      expected: 'get_file rejected outside synthetic root without resource content',
      ...(await checkRejection(
        client,
        outsidePath,
        'ACCESS_DENIED',
        'Outside allowed directories.',
      )),
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
