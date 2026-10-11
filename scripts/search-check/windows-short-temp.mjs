import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

// Own synthetic TEMP parent; never alter the caller's environment or service.
assert.equal(process.platform, 'win32', 'This check requires Windows 8.3 paths');
const repo = resolve(import.meta.dirname, '..', '..');
const scratch = join(repo, '.tmp');
await mkdir(scratch, { recursive: true });
const parent = await mkdtemp(join(scratch, '011-real-eight-dot-three-temporary-parent-'));
try {
  const short = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$ErrorActionPreference = "Stop"; (New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:FSMCP_SEARCH_SHORT_TEMP).ShortPath',
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
      env: { ...process.env, FSMCP_SEARCH_SHORT_TEMP: parent },
    },
  ).trim();
  assert(/~\d/u.test(basename(short)), 'New parent has no actual 8.3 short name');
  assert.equal(await realpath(short), await realpath(parent));
  console.log('Real Windows 8.3 TEMP/TMP parent confirmed for search + list regressions');
  const result = spawnSync(
    process.execPath,
    [
      '--test',
      '--import',
      'tsx',
      '__tests__/search-bounded.test.ts',
      '__tests__/list-bounded.test.ts',
    ],
    {
      cwd: repo,
      env: { ...process.env, TEMP: short, TMP: short },
      stdio: 'inherit',
      windowsHide: true,
      timeout: 120000,
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  const suffix = relative(scratch, resolve(parent));
  assert(suffix && !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..\\'));
  await rm(parent, { recursive: true, force: true });
}
