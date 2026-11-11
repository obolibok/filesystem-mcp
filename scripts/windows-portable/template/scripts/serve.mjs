import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { configuration, kit, serverEnvironment } from './config.mjs';

try {
  const extra = process.argv.slice(2);
  if (extra.some((arg) => !['--print-config', '--json', '--preflight'].includes(arg)))
    throw new Error('Unsupported launcher argument.');
  const preflight = extra.includes('--preflight');
  const config = await configuration({ includeHttpApiKey: !preflight });
  const http = !preflight && config.transport === 'http';
  const apiKey = http ? config.localHttp.apiKey || process.env.PORTABLE_HTTP_API_KEY?.trim() : '';
  if (
    http &&
    (!apiKey || apiKey.length < 16 || apiKey.length > 4096 || /[^\x21-\x7e]/u.test(apiKey))
  )
    throw new Error(
      'HTTP requires an API key of 16 to 4096 printable ASCII characters without whitespace. Use Start.ps1 for hidden input.',
    );
  serverEnvironment(config);
  if (http) process.env.FS_API_KEY = apiKey;
  if (preflight) {
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
    ...(http
      ? ['--port', String(config.localHttp.port), '--http-host', config.localHttp.host]
      : []),
    ...extra.filter((arg) => arg !== '--preflight'),
    ...config.roots,
  ];
  await import(pathToFileURL(entry).href);
} catch (error) {
  process.stderr.write('Configuration failed: ' + error.message + '\n');
  process.exitCode = 1;
}
