import assert from 'node:assert/strict';
import { test } from 'node:test';

import { query } from './common.mjs';
import { expectedScan, validateFresh } from './validate.mjs';

const workload = { tool: 'search_text', context: 10 };
const schema = { properties: { maxResults: { default: 500, maximum: 10000 } } };
const { contract } = query(schema, workload, 'synthetic-source');
const fixture = (matches) => ({ matches, files: 1 });
const response = (collected, fields = {}) => ({
  _meta: {
    matches: Array.from({ length: Math.min(collected, 500) }, () => ({})),
    totalMatches: collected,
    filesScanned: 1,
    ...fields,
  },
});

test('real-default query omits page/limit arguments and reads both published schema variants', () => {
  for (const inputSchema of [
    schema,
    { properties: { pageSize: { default: 500 }, limit: { default: 10000 } } },
  ]) {
    const built = query(inputSchema, workload, 'synthetic-source');
    assert(!Object.hasOwn(built.args, built.contract.pageParameter));
    assert(!Object.hasOwn(built.args, 'limit'));
    assert.equal(built.contract.requestedPageSize, null);
    assert.equal(built.contract.effectivePageSize, 500);
    assert.equal(built.contract.collectionLimit, 10000);
  }
});

test('complete default-page result needs neither cursor nor resource; paginated result needs both', () => {
  const fit = validateFresh(
    response(128),
    contract,
    expectedScan(workload, fixture(128), contract),
  );
  assert.equal(fit.hasCursor, false);
  assert.equal(fit.rawTruncated, null);
  assert.equal(fit.rawSkipped.skippedBinary, null);
  const paged = validateFresh(
    response(600, { nextCursor: 'cursor', resourceUri: 'resource' }),
    contract,
    expectedScan(workload, fixture(600), contract),
  );
  assert.equal(paged.hasCursor, true);
});

test('unexpected count/cap is rejected; intentional capped scan records its separate category', () => {
  const capped = response(10000, {
    truncated: true,
    stoppedReason: 'maxResults',
    nextCursor: 'cursor',
    resourceUri: 'resource',
  });
  assert.throws(
    () => validateFresh(capped, contract, expectedScan(workload, fixture(10001), contract)),
    (error) => {
      assert.match(error.message, /collected count/);
      assert.equal(error.scanOutcome.collected, 10000);
      assert.equal(error.scanOutcome.stoppedReason, 'maxResults');
      return true;
    },
  );
  const intentional = { ...workload, expectedPartial: { reason: 'cap', collected: 10000 } };
  const observed = validateFresh(
    capped,
    contract,
    expectedScan(intentional, fixture(10001), contract),
  );
  assert.equal(observed.category, 'intentional-partial');
  assert.equal(observed.truncated, true);
});

test('simulated successful timeout response cannot pass as a complete scan', () => {
  assert.throws(
    () =>
      validateFresh(
        response(128, { truncated: true, stoppedReason: 'timeout', resourceUri: 'resource' }),
        contract,
        expectedScan(workload, fixture(128), contract),
      ),
    (error) => {
      assert.match(error.message, /unexpected scan truncation/);
      assert.equal(error.scanOutcome.stoppedReason, 'timeout');
      return true;
    },
  );
});

test('unexpected skipped files and missing pagination handles are rejected', () => {
  assert.throws(
    () =>
      validateFresh(
        response(128, { skippedBinary: 1 }),
        contract,
        expectedScan(workload, fixture(128), contract),
      ),
    /unexpected skipped source files/,
  );
  assert.throws(
    () => validateFresh(response(600), contract, expectedScan(workload, fixture(600), contract)),
    /cursor presence/,
  );
});
