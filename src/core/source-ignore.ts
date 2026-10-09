import type { Ignore } from 'ignore';
import ignore from 'ignore';

import { toPosixPath } from './primitives.js';

export class GitignoreManager {
  private matchers = new Map<string, Ignore>();

  addRules(dir: string, contents: string): void {
    const matcher = ignore();
    matcher.add(contents);
    this.matchers.set(dir === '.' ? '' : dir, matcher);
  }

  size(): number {
    return this.matchers.size;
  }

  isIgnored(relativePath: string, isDirectory: boolean): boolean {
    const normalized = toPosixPath(relativePath);
    if (normalized === '' || normalized === '.') return false;
    const parts = normalized.split('/');

    // 1. Check parent directories first
    let currentDir = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!part) continue;
      currentDir = currentDir ? `${currentDir}/${part}` : part;

      if (this.checkPath(currentDir, true)) {
        return true;
      }
    }

    // 2. Check the file/directory itself
    return this.checkPath(normalized, isDirectory);
  }

  private checkPath(posixPath: string, isDirectory: boolean): boolean {
    const parts = posixPath.split('/');
    const pathToCheck = isDirectory
      ? posixPath.endsWith('/')
        ? posixPath
        : `${posixPath}/`
      : posixPath;

    let ignored = false;

    // Check root level
    const rootMatcher = this.matchers.get('');
    if (rootMatcher) {
      const res = rootMatcher.test(pathToCheck);
      if (res.ignored) ignored = true;
      if (res.unignored) ignored = false;
    }

    // Check subdirectories
    let currentDir = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!part) continue;
      currentDir = currentDir ? `${currentDir}/${part}` : part;

      const matcher = this.matchers.get(currentDir);
      if (matcher) {
        const relParts = parts.slice(i + 1);
        const relPath = relParts.join('/');
        const relPathToCheck = isDirectory
          ? relPath.endsWith('/')
            ? relPath
            : `${relPath}/`
          : relPath;

        const res = matcher.test(relPathToCheck);
        if (res.ignored) ignored = true;
        if (res.unignored) ignored = false;
      }
    }

    return ignored;
  }
}

export const DEFAULT_EXCLUDE_PATTERNS = [
  '**/node_modules',
  '**/node_modules/**',
  '**/dist',
  '**/dist/**',
  '**/build',
  '**/build/**',
  '**/coverage',
  '**/coverage/**',
  '**/.git',
  '**/.git/**',
  '**/.vscode',
  '**/.vscode/**',
  '**/.idea',
  '**/.idea/**',
  '**/.DS_Store',
  '**/.next',
  '**/.next/**',
  '**/.nuxt',
  '**/.nuxt/**',
  '**/.output',
  '**/.output/**',
  '**/.svelte-kit',
  '**/.svelte-kit/**',
  '**/.cache',
  '**/.cache/**',
  '**/.yarn',
  '**/.yarn/**',
  '**/jspm_packages',
  '**/jspm_packages/**',
  '**/bower_components',
  '**/bower_components/**',
  '**/out',
  '**/out/**',
  '**/tmp',
  '**/tmp/**',
  '**/.temp',
  '**/.temp/**',
  '**/npm-debug.log',
  '**/yarn-debug.log',
  '**/yarn-error.log',
  '**/Thumbs.db',
];
