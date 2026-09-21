import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { cleanupTestRoot, createTestRoot, trySymlink } from './helpers.js';

function windowsShortPath(path: string): string {
  return execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$ErrorActionPreference = "Stop"; (New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:FSMCP_BUNDLE_LIVE_SOURCE).ShortPath',
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
      env: { ...process.env, FSMCP_BUNDLE_LIVE_SOURCE: path },
    },
  ).trim();
}

describe('bundle live capture destination containment', () => {
  for (const destination of ['delivery', 'scratch'] as const) {
    for (const spelling of ['canonical', 'junction', 'short'] as const) {
      it(
        `rejects ${destination} ${spelling} paths inside source before any output writes`,
        { skip: spelling === 'short' && process.platform !== 'win32' },
        async (t) => {
          const container = await realpath(await createTestRoot());
          const source = join(container, 'bundle live source with long spelling');
          const existing = join(source, 'existing');
          const sentinels = [
            [join(source, 'bundle-manifest.json'), Buffer.from('source manifest sentinel')],
            [join(existing, 'bundle-00001.zip'), Buffer.from('source archive sentinel')],
          ] as const;
          try {
            await mkdir(existing, { recursive: true });
            for (const [path, bytes] of sentinels) await writeFile(path, bytes);
            let candidateRoot = source;
            if (spelling === 'junction') {
              candidateRoot = join(container, 'external-source-alias');
              if (
                !(await trySymlink(source, candidateRoot, () => t.skip('junction unavailable')))
              ) {
                return;
              }
            } else if (spelling === 'short') {
              candidateRoot = windowsShortPath(source);
              if (!candidateRoot.includes('~')) {
                t.skip('8.3 alias unavailable on this volume');
                return;
              }
              assert.equal(await realpath(candidateRoot), source);
            }
            const before = (await readdir(source, { recursive: true })).sort();
            // Cover an existing target and reconstruction through an existing ancestor.
            const candidates = [
              candidateRoot,
              join(candidateRoot, 'existing'),
              join(candidateRoot, 'new', 'nested'),
            ];
            for (const [index, candidate] of candidates.entries()) {
              const safeOutput = join(container, `safe-${destination}-${String(index)}`);
              const result = spawnSync(
                process.execPath,
                [
                  join(process.cwd(), 'scripts', 'bundle-check', 'live-mcp-capture.mjs'),
                  '--case',
                  'small',
                  '--fixture-root',
                  source,
                  '--delivery-dir',
                  destination === 'delivery' ? candidate : safeOutput,
                  '--scratch-dir',
                  destination === 'scratch' ? candidate : safeOutput,
                ],
                { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
              );
              assert.equal(result.error, undefined);
              assert.deepEqual((await readdir(source, { recursive: true })).sort(), before);
              for (const [path, bytes] of sentinels) {
                assert.deepEqual(await readFile(path), bytes);
              }
              await assert.rejects(stat(safeOutput), { code: 'ENOENT' });
              assert.notEqual(result.status, 0, 'unsafe output unexpectedly succeeded');
              assert.match(result.stderr, new RegExp(`${destination} directory must be outside`));
            }
          } finally {
            await cleanupTestRoot(container);
          }
        },
      );
    }
  }
});
