/**
 * @fileoverview Tests for executeSelected: dry-run, that enroll uses each
 * card's own offerId (not the group key), that a whole offer's cards are fired
 * concurrently, the three-state outcome (verified / failed / ghost), progress
 * reporting, and that one failure does not abort the run.
 */

import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';

import api from '../src/amex-assistant.user.js';
import {createMockFetch, enrollHandlers, makeOffer} from './mock-fetch.mjs';

const {executeSelected, ResultState} = api;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A delay that resolves immediately so tests stay fast. */
const noDelay = () => Promise.resolve();

/**
 * Builds a task for one (offer, card).
 * @param {string} token Card token.
 * @param {string} offerId The card's own offerId.
 * @param {string} key Group key.
 * @return {!Object} Task.
 */
function task(token, offerId, key) {
  return {token, offerId, key, name: 'offer'};
}

test('dry-run expands tasks and sends no requests', async () => {
  const mock = createMockFetch({onEnroll: enrollHandlers.fail});
  globalThis.fetch = mock;

  const results = await executeSelected(
    [task('A', 'OA', 'PZ'), task('B', 'OB', 'PZ')],
    {dryRun: true, delay: noDelay});

  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.state === ResultState.DRY_RUN));
  assert.equal(mock.calls.length, 0, 'dry-run must not call fetch');
});

test('enrolls with the per-card offerId, not the group key', async () => {
  const mock = createMockFetch({
    eligiblePages: {A: [[makeOffer('OPAQUE', {pzn: 'PZN'})]]},
    enrolledState: {A: []},
    onEnroll: enrollHandlers.succeedAndAdd,
  });
  globalThis.fetch = mock;

  const results = await executeSelected(
    [task('A', 'OPAQUE', 'PZN')], {delay: noDelay});

  const enrollCall =
      mock.calls.find((c) => c.url.includes('CreateOffersHubEnrollment'));
  assert.equal(enrollCall.body.offerId, 'OPAQUE'); // the offerId, not 'PZN'
  assert.equal(results[0].state, ResultState.VERIFIED);
});

test('fires all cards of one offer concurrently', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const mock = createMockFetch({
    enrollGate: gate,
    eligiblePages: {
      A: [[makeOffer('OA', {pzn: 'PZ'})]],
      B: [[makeOffer('OB', {pzn: 'PZ'})]],
      C: [[makeOffer('OC', {pzn: 'PZ'})]],
    },
    enrolledState: {A: [], B: [], C: []},
    onEnroll: enrollHandlers.succeedAndAdd,
  });
  globalThis.fetch = mock;

  const pending = executeSelected(
    [task('A', 'OA', 'PZ'), task('B', 'OB', 'PZ'), task('C', 'OC', 'PZ')],
    {delay: noDelay});

  // Let every concurrent enroll reach the (still-closed) gate.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const enrollCalls =
      mock.calls.filter((c) => c.url.includes('CreateOffersHubEnrollment'));
  assert.equal(enrollCalls.length, 3, 'all 3 fired before any completed');

  release();
  const results = await pending;
  assert.ok(results.every((r) => r.state === ResultState.VERIFIED));
});

test('classifies verified, ghost, and failed across cards', async () => {
  const scenario = {
    eligiblePages: {
      A: [[makeOffer('OA', {pzn: 'PZ'})]],
      B: [[makeOffer('OB', {pzn: 'PZ'})]],
      C: [[makeOffer('OC', {pzn: 'PZ'})]],
    },
    enrolledState: {A: [], B: [], C: []},
    onEnroll(token, offerId, sc) {
      if (token === 'A') {
        return enrollHandlers.succeedAndAdd(token, offerId, sc);
      }
      if (token === 'B') return enrollHandlers.succeedButGhost();
      return enrollHandlers.fail();
    },
  };
  globalThis.fetch = createMockFetch(scenario);

  const results = await executeSelected(
    [task('A', 'OA', 'PZ'), task('B', 'OB', 'PZ'), task('C', 'OC', 'PZ')],
    {delay: noDelay});

  const byToken = Object.fromEntries(results.map((r) => [r.token, r.state]));
  assert.equal(byToken.A, ResultState.VERIFIED);
  assert.equal(byToken.B, ResultState.GHOST);
  assert.equal(byToken.C, ResultState.FAILED);
});

test('marks cards unverified when the post-enroll re-read fails', async () => {
  globalThis.fetch = createMockFetch({
    failVerify: true,
    eligiblePages: {A: [[makeOffer('OA', {pzn: 'PZ'})]]},
    enrolledState: {A: []},
    onEnroll: enrollHandlers.succeedAndAdd,
  });

  const results =
      await executeSelected([task('A', 'OA', 'PZ')], {delay: noDelay});

  // Enroll was sent and reported success, but verification could not run.
  assert.equal(results[0].state, ResultState.UNVERIFIED);
});

test('multi-card add: one offer verified onto several cards', async () => {
  const scenario = {
    eligiblePages: {
      A: [[makeOffer('OA', {pzn: 'PZ'})]],
      B: [[makeOffer('OB', {pzn: 'PZ'})]],
      C: [[makeOffer('OC', {pzn: 'PZ'})]],
    },
    enrolledState: {A: [], B: [], C: []},
    onEnroll: enrollHandlers.succeedAndAdd,
  };
  globalThis.fetch = createMockFetch(scenario);

  const results = await executeSelected(
    [task('A', 'OA', 'PZ'), task('B', 'OB', 'PZ'), task('C', 'OC', 'PZ')],
    {delay: noDelay});

  assert.ok(results.every((r) => r.state === ResultState.VERIFIED));
  assert.equal(results.length, 3);
});

test('reports progress once per task, in order', async () => {
  globalThis.fetch = createMockFetch({
    eligiblePages: {
      A: [[makeOffer('OA', {pzn: 'PZ'})]],
      B: [[makeOffer('OB', {pzn: 'PZ'})]],
    },
    enrolledState: {A: [], B: []},
    onEnroll: enrollHandlers.succeedAndAdd,
  });

  const progress = [];
  await executeSelected([task('A', 'OA', 'PZ'), task('B', 'OB', 'PZ')], {
    delay: noDelay,
    onProgress: (done, total) => progress.push(`${done}/${total}`),
  });

  assert.deepEqual(progress, ['1/2', '2/2']);
});

test('a single failure does not abort the run', async () => {
  let calls = 0;
  globalThis.fetch = createMockFetch({
    eligiblePages: {
      A: [[makeOffer('OA', {pzn: 'PZ'})]],
      B: [[makeOffer('OB', {pzn: 'PZ'})]],
    },
    enrolledState: {A: [], B: []},
    onEnroll(token, offerId, sc) {
      calls++;
      if (token === 'A') throw new Error('network down');
      return enrollHandlers.succeedAndAdd(token, offerId, sc);
    },
  });

  const results = await executeSelected(
    [task('A', 'OA', 'PZ'), task('B', 'OB', 'PZ')], {delay: noDelay});

  assert.equal(calls, 2, 'both cards attempted despite the first throwing');
  const byToken = Object.fromEntries(results.map((r) => [r.token, r.state]));
  assert.equal(byToken.A, ResultState.FAILED);
  assert.equal(byToken.B, ResultState.VERIFIED);
});
