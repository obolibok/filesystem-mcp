import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error('Usage: node hash-tree.mjs --root PATH --output PATH');
    }
    values.set(key, value);
  }
  assert(values.has('--root'), '--root is required');
  assert(values.has('--output'), '--output is required');
  return { root: resolve(values.get('--root')), output: resolve(values.get('--output')) };
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function collect(root) {
  const pending = [root];
  const files = [];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Fixture tree contains a symlink: ${entry.name}`);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        const details = await lstat(path);
        files.push({
          relativePath: relative(root, path).split(sep).join('/'),
          size: details.size,
          sha256: await hashFile(path),
        });
      } else {
        throw new Error(`Fixture tree contains a special entry: ${entry.name}`);
      }
    }
  }
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));
  return files;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const files = await collect(options.root);
  const canonical = files
    .map((file) => `${file.relativePath}\u0000${String(file.size)}\u0000${file.sha256}\n`)
    .join('');
  const report = {
    schema: 'filesystem-mcp.synthetic-hash-tree',
    version: 1,
    root: '<synthetic-root>',
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    treeSha256: createHash('sha256').update(canonical, 'utf8').digest('hex'),
    files,
  };
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${options.output}\n`);
}

await main();
