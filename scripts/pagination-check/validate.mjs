import assert from 'node:assert/strict';

import { metadata } from './common.mjs';

export const SKIP_COUNTERS = [
  'skippedInaccessible',
  'skippedTooLarge',
  'skippedBinary',
  'skippedUnsupportedEncoding',
];

export function expectedScan(workload, fixture, contract) {
  const fixtureCount =
    workload.tool === 'list' ? fixture.files + fixture.directories : fixture.matches;
  const partial = workload.expectedPartial;
  return {
    category: partial ? 'intentional-partial' : 'complete',
    fixtureCount,
    collected: partial ? partial.collected : fixtureCount,
    truncated: !!partial,
    stoppedReason: partial?.reason === 'cap' ? contract.capReason : (partial?.reason ?? null),
    filesScanned: workload.tool === 'search_text' ? fixture.files : null,
    skipped: Object.fromEntries(SKIP_COUNTERS.map((key) => [key, 0])),
  };
}

// One validator for real handler and HTTP fresh requests. Only scalar metadata
// leaves the response scope. Absent optional fields are recorded as null as well
// as normalized according to the published optional-false/zero contract.
export function validateFresh(result, contract, expected) {
  const meta = metadata(result);
  assert(!result.isError && meta, 'fresh tool request must succeed with metadata');
  const rows = meta.entries ?? meta.matches;
  const rawSkipped = Object.fromEntries(SKIP_COUNTERS.map((key) => [key, meta[key] ?? null]));
  const outcome = {
    category: expected.category,
    collected: meta.totalEntries ?? meta.totalMatches,
    shown: rows?.length,
    truncated: meta.truncated ?? false,
    stoppedReason: meta.stoppedReason ?? null,
    rawTruncated: meta.truncated ?? null,
    rawSkipped,
    skipped: Object.fromEntries(SKIP_COUNTERS.map((key) => [key, meta[key] ?? 0])),
    filesScanned: meta.filesScanned ?? null,
    filesMatched: meta.filesMatched ?? null,
    totalFiles: meta.totalFiles ?? null,
    totalDirectories: meta.totalDirectories ?? null,
    reportedLimit: meta.limit ?? null,
    hasCursor: typeof meta.nextCursor === 'string',
    hasResource: typeof meta.resourceUri === 'string',
  };
  try {
    assert.equal(
      outcome.collected,
      expected.collected,
      'collected count must match expected fixture/outcome',
    );
    assert.equal(outcome.truncated, expected.truncated, 'unexpected scan truncation');
    assert.equal(outcome.stoppedReason, expected.stoppedReason, 'unexpected scan stoppedReason');
    assert.deepEqual(outcome.skipped, expected.skipped, 'unexpected skipped source files');
    assert.equal(
      outcome.shown,
      Math.min(expected.collected, contract.effectivePageSize),
      'first page row count',
    );
    if (expected.filesScanned !== null)
      assert.equal(outcome.filesScanned, expected.filesScanned, 'filesScanned must match fixture');
    if (contract.tool === 'list' && !expected.truncated) {
      assert.equal(
        outcome.totalFiles + outcome.totalDirectories,
        expected.fixtureCount,
        'list counters must match fixture',
      );
    }
    assert.equal(
      outcome.hasCursor,
      expected.collected > contract.effectivePageSize,
      'cursor presence must match pagination need',
    );
    assert.equal(
      outcome.hasResource,
      expected.truncated || outcome.hasCursor,
      'resource presence must match incomplete response',
    );
  } catch (error) {
    error.scanOutcome = outcome;
    error.effectiveContract = contract;
    error.expectedScan = expected;
    throw error;
  }
  return outcome;
}
