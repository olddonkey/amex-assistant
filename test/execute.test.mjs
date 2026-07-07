/**
 * @fileoverview Tests for executeSelected: that enroll uses each card's own
 * offerId (not the group key), that a whole offer's cards are fired
 * concurrently, the outcome states (verified / failed / ghost / unverified /
 * skipped), progress reporting, transient-failure retries, the blocked-run
 * circuit breaker, and the second-chance verification re-read.
 */

import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';

import api from '../src/amex-assistant.user.js';
import {createMockFetch, enrollHandlers, makeOffer} from './mock-fetch.mjs';

const {executeSelected, planRetry, ResultState} = api;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A delay that resolves immediately so tests stay fast. */
const noDelay = () => Promise.resolve();

/** All injectable delays replaced with no-ops so tests stay fast. */
const fastOpts = {delay: noDelay, retryDelay: noDelay, settleDelay: noDelay};

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

test('enrolls with the per-card offerId, not the group key', async () => {
  const mock = createMockFetch({
    eligiblePages: {A: [[makeOffer('OPAQUE', {pzn: 'PZN'})]]},
    enrolledState: {A: []},
    onEnroll: enrollHandlers.succeedAndAdd,
  });
  globalThis.fetch = mock;

  const results = await executeSelected(
    [task('A', 'OPAQUE', 'PZN')], fastOpts);

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
    fastOpts);

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
    fastOpts);

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
      await executeSelected([task('A', 'OA', 'PZ')], fastOpts);

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
    fastOpts);

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
    ...fastOpts,
    onProgress: (done, total) => progress.push(`${done}/${total}`),
  });

  assert.deepEqual(progress, ['1/2', '2/2']);
});

test('a single failure does not abort the run', async () => {
  let aCalls = 0;
  let bCalls = 0;
  globalThis.fetch = createMockFetch({
    eligiblePages: {
      A: [[makeOffer('OA', {pzn: 'PZ'})]],
      B: [[makeOffer('OB', {pzn: 'PZ'})]],
    },
    enrolledState: {A: [], B: []},
    onEnroll(token, offerId, sc) {
      if (token === 'A') {
        aCalls++;
        throw new Error('network down');
      }
      bCalls++;
      return enrollHandlers.succeedAndAdd(token, offerId, sc);
    },
  });

  const results = await executeSelected(
    [task('A', 'OA', 'PZ'), task('B', 'OB', 'PZ')], fastOpts);

  // A network error is transient, so A is re-sent twice before giving up.
  assert.equal(aCalls, 3, 'initial send plus two retries');
  assert.equal(bCalls, 1, 'B attempted despite A failing');
  const byToken = Object.fromEntries(results.map((r) => [r.token, r.state]));
  assert.equal(byToken.A, ResultState.FAILED);
  assert.equal(byToken.B, ResultState.VERIFIED);
});

test('retries a transient enroll failure and then succeeds', async () => {
  let calls = 0;
  globalThis.fetch = createMockFetch({
    eligiblePages: {A: [[makeOffer('OA', {pzn: 'PZ'})]]},
    enrolledState: {A: []},
    onEnroll(token, offerId, sc) {
      calls++;
      if (calls === 1) throw new Error('socket hiccup');
      return enrollHandlers.succeedAndAdd(token, offerId, sc);
    },
  });

  const results = await executeSelected([task('A', 'OA', 'PZ')], fastOpts);

  assert.equal(calls, 2, 'the first send failed, one retry succeeded');
  assert.equal(results[0].state, ResultState.VERIFIED);
});

test('does not retry a definitive business rejection', async () => {
  let calls = 0;
  globalThis.fetch = createMockFetch({
    eligiblePages: {A: [[makeOffer('OA', {pzn: 'PZ'})]]},
    enrolledState: {A: []},
    onEnroll() {
      calls++;
      return enrollHandlers.fail();
    },
  });

  const results = await executeSelected([task('A', 'OA', 'PZ')], fastOpts);

  assert.equal(calls, 1, 'a definitive server answer is not re-sent');
  assert.equal(results[0].state, ResultState.FAILED);
  assert.equal(results[0].message, 'Not eligible.');
});

test('a 429 stops the run: rest skipped, nothing verified', async () => {
  const mock = createMockFetch({
    eligiblePages: {
      A: [[makeOffer('OA', {pzn: 'P1'})]],
      B: [[makeOffer('OB', {pzn: 'P1'})]],
      C: [[makeOffer('OC', {pzn: 'P2'})]],
    },
    enrolledState: {A: [], B: [], C: []},
    onEnroll(token, offerId, sc) {
      if (token === 'B') return enrollHandlers.throttled();
      return enrollHandlers.succeedAndAdd(token, offerId, sc);
    },
  });
  globalThis.fetch = mock;

  // A+B share one offer; C is a second offer that must never be submitted.
  const results = await executeSelected(
    [task('A', 'OA', 'P1'), task('B', 'OB', 'P1'), task('C', 'OC', 'P2')],
    fastOpts);

  const byToken = Object.fromEntries(results.map((r) => [r.token, r]));
  assert.equal(byToken.A.state, ResultState.UNVERIFIED,
    'reported OK but verification is skipped on a blocked run');
  assert.equal(byToken.B.state, ResultState.FAILED);
  assert.equal(byToken.B.httpStatus, 429);
  assert.equal(byToken.B.blocked, true);
  assert.equal(byToken.C.state, ResultState.SKIPPED);

  const enrolls =
      mock.calls.filter((c) => c.url.includes('CreateOffersHubEnrollment'));
  assert.equal(enrolls.length, 2, 'the second offer was never submitted');
  const verifyReads = mock.calls.filter(
    (c) => c.body && c.body.requestType === 'ADDEDTOCARD_LANDING');
  assert.equal(verifyReads.length, 0, 'no re-reads after a blocked signal');
});

test('a ghost appearing on the second re-read becomes verified', async () => {
  const scenario = {
    eligiblePages: {A: [[makeOffer('OA', {pzn: 'PZ'})]]},
    enrolledState: {A: []},
    onEnroll: enrollHandlers.succeedButGhost,
  };
  globalThis.fetch = createMockFetch(scenario);

  let settles = 0;
  const results = await executeSelected([task('A', 'OA', 'PZ')], {
    ...fastOpts,
    settleDelay: () => {
      // The enrollment becomes visible only after the second settle, modeling
      // server-side propagation lag.
      if (++settles === 2) {
        scenario.enrolledState.A.push(makeOffer('OA', {pzn: 'PZ'}));
      }
      return Promise.resolve();
    },
  });

  assert.equal(settles, 2, 'ghost candidate triggered a second settle');
  assert.equal(results[0].state, ResultState.VERIFIED);
});

test('planRetry re-resolves rotated offerIds for retryable pairs', () => {
  const prior = [
    {key: 'PZ', name: 'offer', token: 'A', offerId: 'OLD-A',
      state: ResultState.FAILED, message: 'HTTP 500'},
    {key: 'PZ', name: 'offer', token: 'B', offerId: 'OLD-B',
      state: ResultState.VERIFIED, message: ''},
  ];
  const offers = [{key: 'PZ', name: 'offer', cards: [
    {token: 'A', offerId: 'NEW-A', enrolled: false},
    {token: 'B', offerId: 'NEW-B', enrolled: true},
  ]}];

  const {tasks, landed, gone} = planRetry(prior, offers);

  // A is resent with the card's CURRENT offerId, not the stored one.
  assert.deepEqual(tasks,
    [{token: 'A', offerId: 'NEW-A', key: 'PZ', name: 'offer'}]);
  assert.equal(landed.length, 0);
  assert.equal(gone.length, 0, 'verified pairs are not retry candidates');
});

test('planRetry settles landed and gone pairs without resending', () => {
  const prior = [
    {key: 'PZ', name: 'offer', token: 'A', offerId: 'OA',
      state: ResultState.FAILED, message: 'network error'},
    {key: 'PZ', name: 'offer', token: 'B', offerId: 'OB',
      state: ResultState.SKIPPED, message: ''},
  ];
  // A's card meanwhile shows the offer as added; B's no longer lists it.
  const offers = [{key: 'PZ', name: 'offer', cards: [
    {token: 'A', offerId: 'OA2', enrolled: true},
  ]}];

  const {tasks, landed, gone} = planRetry(prior, offers);

  assert.equal(tasks.length, 0);
  assert.equal(landed[0].token, 'A');
  assert.equal(landed[0].state, ResultState.VERIFIED,
    'a failure that actually landed is reclassified');
  assert.equal(gone[0].token, 'B');
  assert.equal(gone[0].state, ResultState.SKIPPED, 'original state kept');
  assert.equal(gone[0].gone, true);
  assert.match(gone[0].message, /no longer listed/);
});

test('planRetry does not offer a gone pair again', () => {
  const prior = [{key: 'PZ', name: 'offer', token: 'B', offerId: 'OB',
    state: ResultState.FAILED, message: 'x', gone: true}];

  const {tasks, landed, gone} = planRetry(prior, []);

  assert.equal(tasks.length + landed.length + gone.length, 0);
});

test('retries a failed verification read before giving up', async () => {
  globalThis.fetch = createMockFetch({
    failVerifyTimes: 1,
    eligiblePages: {A: [[makeOffer('OA', {pzn: 'PZ'})]]},
    enrolledState: {A: []},
    onEnroll: enrollHandlers.succeedAndAdd,
  });

  const results = await executeSelected([task('A', 'OA', 'PZ')], fastOpts);

  assert.equal(results[0].state, ResultState.VERIFIED,
    'the first re-read failed; the retry answered');
});
