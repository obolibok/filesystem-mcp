import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';

import { configuration, kit } from './config.mjs';

const config = await configuration();
const child = spawn(process.execPath, [join(kit, 'scripts', 'serve.mjs'), '--preflight'], {
  cwd: kit,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  env: { ...process.env, NODE_OPTIONS: '' },
});
const pending = new Map();
let sequence = 0;
let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr = (stderr + chunk).slice(-8000);
});
const lines = createInterface({ input: child.stdout });
const timer = setTimeout(() => {
  for (const item of pending.values())
    item.reject(new Error('MCP preflight timed out.\n' + stderr));
  child.kill();
}, 20000);
child.on('error', (error) => {
  for (const item of pending.values()) item.reject(error);
});
child.on('exit', () => {
  for (const item of pending.values()) item.reject(new Error('MCP exited early.\n' + stderr));
});
lines.on('line', (line) => {
  try {
    const message = JSON.parse(line);
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    if (message.error) item.reject(new Error(JSON.stringify(message.error)));
    else item.resolve(message.result);
  } catch (error) {
    for (const item of pending.values()) item.reject(error);
  }
});
function request(method, params) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
try {
  await request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'portable-preflight', version: '1.0.0' },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tools = await request('tools/list', {});
  const names = tools.tools.map((tool) => tool.name);
  for (const name of ['list_roots', 'snapshot', 'bundle', 'get_artifact', 'get_file'])
    assert(names.includes(name), 'Missing tool: ' + name);
  for (const name of ['create', 'edit', 'delete', 'move', 'copy', 'patch', 'replace_text'])
    assert(!names.includes(name), 'Unexpected write tool: ' + name);
  const roots = await request('tools/call', { name: 'list_roots', arguments: {} });
  assert(!roots.isError, 'list_roots returned an error');
  const actualRoots = [
    ...new Set(await Promise.all(roots.structuredContent.roots.map((root) => realpath(root)))),
  ].sort();
  assert.deepEqual(
    actualRoots,
    [...config.roots].sort(),
    'Published roots differ from config.json',
  );
  process.stdout.write(
    JSON.stringify(
      {
        result: 'LOCAL_MCP_PASS',
        roots: config.roots,
        scratch: config.scratchDirectory,
        tools: names,
        rootResponse: roots,
        limits: config.limits,
        note: 'This checks local MCP only. Tunnel readiness and ChatGPT delivery are separate.',
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  clearTimeout(timer);
  lines.close();
  child.stdin.end();
  const killTimer = setTimeout(() => child.kill(), 6000);
  child.once('exit', () => clearTimeout(killTimer));
}
