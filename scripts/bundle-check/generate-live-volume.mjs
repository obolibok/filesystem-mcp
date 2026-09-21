import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const FILE_BYTES = 1024 * 1024;
const FIXED_MTIME = new Date('2026-09-21T12:00:00.000Z');
const SELECTED = [
  ['volume/alpha/shared.bin', 0],
  ['volume/beta/shared.bin', 1],
  ['volume/gamma/original-03.bin', 2],
  ['volume/deep/one/original-04.bin', 3],
  ['volume/deep/two/Größe-Антенна-05.bin', 4],
  ['volume/кириллица/original-06.bin', 5],
  ['volume/omega-Ω/original-07.bin', 6],
];
const CONTROL = ['volume/control/not-selected.bin', 99];

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error('Usage: node generate-live-volume.mjs --output PATH --manifest PATH');
    }
    values.set(key, value);
  }
  assert(values.has('--output'), '--output is required');
  assert(values.has('--manifest'), '--manifest is required');
  return {
    output: resolve(values.get('--output')),
    manifest: resolve(values.get('--manifest')),
  };
}

function deterministicBytes(size, seed) {
  const output = Buffer.allocUnsafe(size);
  let offset = 0;
  let block = 0;
  while (offset < size) {
    const digest = createHash('sha256')
      .update(`${String(seed)}:${String(block)}`)
      .digest();
    const length = Math.min(digest.length, size - offset);
    digest.copy(output, offset, 0, length);
    offset += length;
    block += 1;
  }
  return output;
}

async function writeFixture(root, relativePath, seed) {
  const path = resolve(root, ...relativePath.split('/'));
  assert(path.startsWith(`${root}\\`) || path.startsWith(`${root}/`));
  const bytes = deterministicBytes(FILE_BYTES, seed);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { flag: 'wx' });
  await utimes(path, FIXED_MTIME, FIXED_MTIME);
  return {
    relativePath,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    lastWriteTime: FIXED_MTIME.toISOString(),
    seed,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(options.output, { recursive: true });
  await mkdir(dirname(options.manifest), { recursive: true });
  const selected = [];
  for (const [relativePath, seed] of SELECTED) {
    selected.push(await writeFixture(options.output, relativePath, seed));
  }
  const control = await writeFixture(options.output, CONTROL[0], CONTROL[1]);
  const manifest = {
    schema: 'filesystem-mcp.bundle-live-volume-fixture',
    version: 1,
    generator: 'scripts/bundle-check/generate-live-volume.mjs',
    fileBytes: FILE_BYTES,
    totalSelectedBytes: selected.length * FILE_BYTES,
    selected,
    control,
  };
  await writeFile(options.manifest, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  process.stdout.write(`${options.manifest}\n`);
}

await main();
