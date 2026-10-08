import {
  DEFAULT_SEARCH_CONTENT_RESULTS,
  getMaxTextFileSize,
  MAX_SEARCH_RESULTS,
} from './core/util.js';
import {
  BUNDLE,
  CANCEL_JOB,
  FIND_FILES,
  GET_ARTIFACT,
  GET_FILE,
  JOB_STATUS,
  LIST,
  LIST_ROOTS,
  MUTATING_TOOL_NAMES,
  READ,
  SEARCH_TEXT,
  SNAPSHOT,
  STAT,
} from './tools/index.js';

function buildToolsOverview(readOnly: boolean): string {
  const rows: [string, string[]][] = [
    ['Navigate', [LIST_ROOTS.name, LIST.name, FIND_FILES.name]],
    ['Inspect', [STAT.name, SEARCH_TEXT.name]],
    ['Read', [READ.name, GET_FILE.name]],
    ['Jobs', [SNAPSHOT.name, BUNDLE.name, JOB_STATUS.name, CANCEL_JOB.name, GET_ARTIFACT.name]],
  ];

  // Under --read-only the mutating tools are never registered, so advertising
  // them here would point the model at tools that are not there. Drop the row
  // rather than emit an empty one.
  if (!readOnly) {
    rows.push(['Write', [...MUTATING_TOOL_NAMES]]);
  }

  const rowLines = rows.map(([cat, names]) => `${cat}: ${names.join(', ')}`);
  return `\`\`\`\n${rowLines.join('\n')}\n\`\`\``;
}

export const INSTRUCTIONS_URI = 'internal://instructions';

/**
 * The one statement of what this server is and how to approach it. The server's
 * `instructions`, the `get-help` prompt, and the instructions resource all
 * describe the same document, and three hand-maintained paraphrases of it drift
 * against each other and cost the client the same sentence three times.
 */
export const INSTRUCTIONS_SUMMARY =
  'Navigation guide for filesystem-mcp. Never guess paths: use list_roots and select the requested scope. ' +
  'Choose list for one folder, find_files for names/globs, search_text for content, ' +
  'snapshot -> job_status for recursive inventories/file totals (get_artifact for the index), ' +
  'read for text, get_file for one original, bundle -> job_status -> get_artifact for selected originals. ' +
  'A known root needs no broad find_files before snapshot.';

export function buildSectionsRecord(readOnly: boolean): Record<string, string> {
  const maxFileMb = Math.floor(getMaxTextFileSize() / 1024 / 1024);
  return {
    guidelines: [
      'Guidelines:',
      '```',
      `root_access: ${LIST_ROOTS.name} lists configured or accepted roots; every other tool is scoped to them.`,
      'root_selection: Select the scope requested by the user; never silently choose the first of several roots. Omit path only when root entries resolve to exactly one filesystem location; with roots at multiple locations, provide an explicit path.',
      'modern_root_grants: Modern clients do not automatically send workspace roots. Call a tool with a concrete path and approve its grant when elicitation is available.',
      `path_resolution: Use returned roots/paths or concrete user-provided paths. Discover unknown children with ${LIST.name} or ${FIND_FILES.name}; a known root can go straight to ${SNAPSHOT.name}.`,
      '```',
    ].join('\n'),
    tools_overview: [
      'Tools Overview:',
      buildToolsOverview(readOnly),
      '',
      INSTRUCTIONS_SUMMARY,
      'Full schemas, descriptions, and annotations are in `tools/list`.',
    ].join('\n'),
    constraints: [
      'Constraints:',
      '```',
      `allowed_roots: Startup roots come from CLI paths, FS_ALLOWED_DIRS, or --allow-cwd; accepted modern grants are additive. Call ${LIST_ROOTS.name} to read the current set.`,
      'legacy_roots: Legacy clients may additionally seed roots through the deprecated roots/list flow.',
      'sensitive_paths: Sensitive file paths (.env, *.pem, *id_rsa*) are denied by default.',
      `enforced_limits: max file size ${maxFileMb} MB, file search cap ${MAX_SEARCH_RESULTS} results, content search cap ${MAX_SEARCH_RESULTS} matches (default page ${DEFAULT_SEARCH_CONTENT_RESULTS}).`,
      `${GET_FILE.name}: Returns one byte-exact, size-limited file as an MCP embedded resource plus a resource_link; the receiving host decides whether to materialize it as a file.`,
      `${FIND_FILES.name}: Targeted name/glob search, capped at ${MAX_SEARCH_RESULTS} collected matches regardless of maxResults page size. Cursors only page that collected set; they do not resume a capped/timed-out scan. For a recursive index or file total use ${SNAPSHOT.name}.`,
      `${SNAPSHOT.name}: Creates or reuses a recursive CSV/ZIP metadata index, without copying original contents. Reads guarded sources and writes separate scratch under policy, quota and deadline limits. Reuses a matching completed, complete snapshot up to maxAgeMs (default one hour from walk start), joins matching queued/running work, or starts a job. maxAgeMs=0 forbids completed reuse but still joins running work. Poll ${JOB_STATUS.name} for summary counters; fetch manifest/ZIP parts with ${GET_ARTIFACT.name} only when the index is needed. forceRefresh starts a new scan; use an optional idempotencyKey for safe retries, especially with forceRefresh. A forced retry without a key starts another scan. Reuse does not extend artifact TTL (default 24 hours after completion). Shared cancellation affects all observers; closing a request does not cancel the job. Source/.gitignore changes are not detected automatically; choose maxAgeMs for the requested freshness, and forceRefresh only when a new walk is required.`,
      `${JOB_STATUS.name}: queued/running counters are provisional progress. completed means the producer finished successfully, but may have complete=false; failed/cancelled/interrupted are not successful inventories. Check complete, stopReason, errors/fatalError, metadataPersistence and resultExpired before reporting a result. For a completed snapshot, complete=true means the walk finished within its selected scope and exclusions, not coverage of every physical file on a disk.`,
      'snapshot_counters: filesWritten counts file records written to CSV, not original bytes or guaranteed unique physical files. directoriesVisited counts opened directories including the root; entriesSeen counts enumerated entries without the root, not files. inaccessibleSkipped counts access failures including directory/iteration/ignore-rule failures; never add it to filesWritten as a file total.',
      'snapshot_scope: Report the requested root, flags/exclusions and startedAt/finishedAt observation interval. Hidden/ignored, symlink, sensitive and scratch policies affect coverage. The manifest records scope/policy details when needed. A snapshot is not atomic; reused results describe their earlier interval, not the source now.',
      `${BUNDLE.name}: Submits a durable job for an explicit bounded set of relative file paths under one guarded directory. Fetch the external manifest and every independent ZIP part; skipped or changed originals make complete=false.`,
      `ephemeral_results: When a result carries only a resource_link or resourceUri (in structuredContent or _meta), call resources/read immediately — cached results are ephemeral and expire after ~60 seconds, eviction, or restart. ${GET_FILE.name} already embeds the file bytes in its tool result and needs no resources/read follow-up.`,
      'pagination: nextCursor appears in the result text and in _meta, backed by a snapshot on the same ~60s clock. Page through promptly; if a cursor is rejected, start again without one. resourceUri appears on the first page only.',
      '```',
    ].join('\n'),
    error_recovery: [
      'Error Recovery:',
      '```',
      `ACCESS_DENIED: Run ${LIST_ROOTS.name}; configure a missing startup root or retry a concrete path and approve the grant.`,
      `NOT_FOUND: Run ${LIST.name} or ${FIND_FILES.name} to verify the path.`,
      `TOO_LARGE: Use ${READ.name} with head/tail or startLine/endLine, or split across several calls.`,
      'TIMEOUT: Narrow path/pattern or depth; maxResults only changes page size, not scan work.',
      'INVALID_INPUT: Re-read the tool schema in tools/list.',
      '```',
    ].join('\n'),
  };
}

export function renderSections(sections: Record<string, string>): string {
  return `\n${Object.values(sections).join('\n\n')}\n`;
}
