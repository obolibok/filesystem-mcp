import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

// Use a real DOS short spelling of a newly created synthetic parent, not a
// junction. TEMP/TMP are changed only in the test subprocess environment.
assert.equal(process.platform, 'win32', 'This check requires Windows 8.3 paths');
const mode = process.argv[2] ?? 'suite';
assert(['targeted', 'suite', 'check'].includes(mode), 'Use targeted, suite or check');
const repo = resolve(import.meta.dirname, '..', '..');
const scratch = join(repo, '.tmp');
await mkdir(scratch, { recursive: true });
const parent = await mkdtemp(join(scratch, '010-real-eight-dot-three-temporary-parent-'));
try {
  const short = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$ErrorActionPreference = "Stop"; (New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:FSMCP_LIST_SHORT_TEMP).ShortPath',
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
      env: { ...process.env, FSMCP_LIST_SHORT_TEMP: parent },
    },
  ).trim();
  assert(/~\d/u.test(basename(short)), 'New parent has no actual 8.3 short name');
  assert.equal(await realpath(short), await realpath(parent));
  console.log(`Real Windows 8.3 TEMP/TMP parent confirmed; mode=${mode}`);
  const options = {
    cwd: repo,
    env: { ...process.env, TEMP: short, TMP: short },
    stdio: 'inherit',
    windowsHide: true,
    timeout: 300000,
  };
  const result =
    mode === 'check'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm run check'], options)
      : spawnSync(
          process.execPath,
          [
            '--test',
            '--import',
            'tsx',
            ...(mode === 'targeted'
              ? [
                  '--test-name-pattern=cancellation during ignore loading|list respects nested ignore|list wire deadline',
                ]
              : []),
            '__tests__/list-bounded.test.ts',
          ],
          options,
        );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  // Verify this exact created target stays inside the intended workspace scratch.
  const suffix = relative(scratch, resolve(parent));
  assert(suffix && !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..\\'));
  await rm(parent, { recursive: true, force: true });
}
