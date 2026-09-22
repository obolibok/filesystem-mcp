import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { configuration, kit, serverEnvironment } from './config.mjs';

try {
  const extra = process.argv.slice(2);
  if (extra.some((arg) => !['--print-config', '--json', '--preflight'].includes(arg)))
    throw new Error('Unsupported launcher argument.');
  const config = await configuration();
  serverEnvironment(config);
  if (extra.includes('--preflight')) {
    mkdirSync(join(kit, 'data'), { recursive: true });
    const scratch = mkdtempSync(join(kit, 'data', 'preflight-'));
    process.env.FS_SNAPSHOT_DIR = scratch;
    // This exact directory was created by this invocation, never an operator path.
    process.once('exit', () => rmSync(scratch, { recursive: true, force: true }));
  }
  const entry = join(kit, 'server', 'dist', 'index.js');
  process.argv = [
    process.execPath,
    // re2-wasm 1.2.1 copies argv[1] into an ASCII-only WASI environment.
    // The actual module URL below still resolves from the portable directory.
    'filesystem-mcp',
    '--read-only',
    ...extra.filter((arg) => arg !== '--preflight'),
    ...config.roots,
  ];
  await import(pathToFileURL(entry).href);
} catch (error) {
  process.stderr.write('Configuration failed: ' + error.message + '\n');
  process.exitCode = 1;
}
