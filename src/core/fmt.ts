import { basename } from 'node:path';
import { stripVTControlCharacters, styleText } from 'node:util';

import { MAX_SEARCH_RESULTS } from './util.js';

export interface ProgressCtx {
  label: string;
  subject?: string;
  scope?: string;
  current?: number;
  total?: number;
  detail?: string;
  error?: string;
}

type Phase = 'tick' | 'done' | 'fail';

function buildBody(ctx: ProgressCtx, phase: Phase): string {
  const items: string[] = [];
  if (ctx.subject) {
    items.push(ctx.subject);
  }

  switch (phase) {
    case 'tick':
      if (ctx.current !== undefined && ctx.total !== undefined) {
        items.push(`${ctx.current}/${ctx.total}`);
      } else if (ctx.current !== undefined) {
        items.push(String(ctx.current));
      }
      break;
    case 'done':
      if (ctx.scope) {
        items.push(ctx.scope);
      }
      if (ctx.detail) {
        items.push(ctx.detail);
      }
      break;
    case 'fail':
      if (ctx.error) {
        items.push(ctx.error);
      }
      break;
  }

  return items.join(' · ');
}

export function plainMessage(phase: Phase, ctx: ProgressCtx): string {
  const body = buildBody(ctx, phase);
  return body ? `${ctx.label}: ${body}` : `${ctx.label}:`;
}

export function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${String(count)} ${count === 1 ? singular : plural}`;
}

/**
 * Short label for a path in summary text. `basename` returns '' for a root
 * (`C:\`, `/`) and for a trailing-slash path, which rendered as a bare
 * separator in the per-path summaries, so fall back to the full path.
 */
export function pathLabel(path: string): string {
  return basename(path) || path;
}

/** Names past this point are noise in a summary line; structuredContent holds them all. */
const MAX_ROSTER_ITEMS = 20;

/**
 * Join a per-path summary roster, capped. A 1000-path delete would otherwise
 * name every entry in the text block that `structuredContent` already carries
 * in full.
 */
export function joinRoster(items: readonly string[], separator = ' · '): string {
  if (items.length <= MAX_ROSTER_ITEMS) return items.join(separator);
  const shown = items.slice(0, MAX_ROSTER_ITEMS).join(separator);
  return `${shown}${separator}+${String(items.length - MAX_ROSTER_ITEMS)} more`;
}

export function truncateProgressPattern(pattern: string, maxLength = 40): string {
  return pattern.length <= maxLength ? pattern : `${pattern.slice(0, maxLength)}…`;
}

/**
 * `stoppedReason` names the engine's own cap, and `maxResults` is also the name
 * of the caller's page-size argument — spelling the cap out keeps a caller who
 * passed `maxResults: 5` from reading their own argument back.
 */
const STOP_REASON_TEXT: Record<string, string> = {
  maxResults: `hit the server's ${String(MAX_SEARCH_RESULTS)}-result scan cap, not your maxResults`,
  timeout: 'hit the time limit, or the request was cancelled',
};

/** Put scan incompleteness before rows, where client output clipping cannot hide it. */
export function scanWarning(stoppedReason: string | undefined): string {
  if (stoppedReason === undefined) return '';
  const cause = STOP_REASON_TEXT[stoppedReason] ?? `stopped (${stoppedReason})`;
  return (
    `// scan stopped early: ${cause}. The collected total is a lower bound on matches in this scope. ` +
    'Cursors page only collected results; they do not resume the scan. Narrow path or pattern for the rest.\n\n'
  );
}

/** Position/cursor trailer, independent of the scan warning and prefixed to distinguish it from rows. */
export function pageTrailer(p: {
  offset: number;
  shown: number;
  total: number;
  noun: string;
  tool: string;
  nextCursor?: string | undefined;
}): string {
  const lines: string[] = [];
  // Position is owed on every page of a split set, including the last one —
  // which has no cursor and would otherwise read as the whole answer.
  if (p.offset > 0 || p.total > p.shown) {
    const next =
      p.nextCursor === undefined
        ? ''
        : ` Next page: ${p.tool} ${JSON.stringify({ cursor: p.nextCursor })}`;
    lines.push(
      `// showing ${String(p.offset + 1)}-${String(p.offset + p.shown)} of ${String(p.total)} ${p.noun}.${next}`,
    );
  }
  return lines.length > 0 ? `\n\n${lines.join('\n')}` : '';
}

// ---------------------------------------------------------------------------
// CLI color helpers
// ---------------------------------------------------------------------------

export function padEndVisible(s: string, width: number): string {
  const visible = stripVTControlCharacters(s).length;
  return visible >= width ? s : s + ' '.repeat(width - visible);
}

export const cliFmt = {
  bold: (t: string) => styleText('bold', t),
  dim: (t: string) => styleText('dim', t),
  cyan: (t: string) => styleText('cyan', t),
  yellow: (t: string) => styleText('yellow', t),
  flag: (t: string) => styleText('green', t),
  section: (t: string) => styleText(['cyan', 'bold'], t),
  bool: (v: boolean) => (v ? styleText('green', 'true') : styleText('red', 'false')),
};
