/**
 * @fileoverview Tests for the G4 wide-mode pure helper `groupResultsByOffer`,
 * which collapses the flat (offer, card) result list into one entry per offer
 * (the wide result / running tables show a row per offer with each card's
 * outcome as a chip). The retry path itself reuses the already-tested
 * `planRetry`; only this new grouping needs its own coverage.
 */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import api from '../src/amex-assistant.user.js';

const {groupResultsByOffer, ResultState} = api;

/**
 * A minimal result record.
 * @param {string} key Offer group key.
 * @param {string} token Card token.
 * @param {string} state Result state.
 * @param {string=} name Offer name (defaults to the key).
 * @return {!Object} Result.
 */
function res(key, token, state, name) {
  return {key, token, name: name || key, state};
}

test('groupResultsByOffer groups cards under their offer', () => {
  const groups = groupResultsByOffer([
    res('SIXT', 'A', ResultState.VERIFIED, 'Sixt'),
    res('SIXT', 'B', ResultState.VERIFIED, 'Sixt'),
    res('OAK', 'A', ResultState.VERIFIED, 'Oakley'),
    res('OAK', 'B', ResultState.FAILED, 'Oakley'),
  ]);

  assert.equal(groups.length, 2);
  assert.equal(groups[0].key, 'SIXT');
  assert.equal(groups[0].name, 'Sixt');
  assert.equal(groups[0].results.length, 2);
  assert.deepEqual(groups[1].results.map((r) => r.token), ['A', 'B']);
  assert.deepEqual(groups[1].results.map((r) => r.state),
    [ResultState.VERIFIED, ResultState.FAILED]);
});

test('groupResultsByOffer preserves first-seen offer order', () => {
  const groups = groupResultsByOffer([
    res('Z', 'A', ResultState.VERIFIED),
    res('M', 'A', ResultState.VERIFIED),
    res('Z', 'B', ResultState.GHOST),
    res('A', 'A', ResultState.SKIPPED),
  ]);

  assert.deepEqual(groups.map((g) => g.key), ['Z', 'M', 'A']);
  // The offer seen twice (Z) keeps both card outcomes on one entry.
  assert.equal(groups[0].results.length, 2);
});

test('groupResultsByOffer returns an empty list for no results', () => {
  assert.deepEqual(groupResultsByOffer([]), []);
});
