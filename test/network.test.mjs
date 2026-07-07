/**
 * @fileoverview Tests for the network layer against the fetch mock: account
 * listing, eligible-offer pagination and filtering, the snapshot builder,
 * transient-read retries, and per-card degradation on failed reads.
 */

import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';

import api from '../src/amex-assistant.user.js';
import {createMockFetch, jsonResponse, makeOffer} from './mock-fetch.mjs';

const {
  fetchAccounts, fetchEligibleOffers, snapshot, buildOfferIndex, mapLimit,
  retryTransient,
} = api;

/** A delay that resolves immediately so tests stay fast. */
const noDelay = () => Promise.resolve();

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** @param {!Object} scenario Scenario for the mock. */
function useScenario(scenario) {
  globalThis.fetch = createMockFetch(scenario);
}

test('mapLimit caps concurrency and preserves order', async () => {
  let active = 0;
  let peak = 0;
  const fn = async (x) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return x * 2;
  };
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, fn);
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14, 16], 'order preserved');
  assert.ok(peak <= 3, `never more than 3 at once (peak was ${peak})`);
});

test('fetchAccounts returns the accounts array', async () => {
  useScenario({accounts: [{account_token: 'A'}, {account_token: 'B'}]});
  const accounts = await fetchAccounts();
  assert.deepEqual(accounts.map((a) => a.account_token), ['A', 'B']);
});

test('fetchEligibleOffers walks pages until an empty page', async () => {
  useScenario({
    eligiblePages: {
      A: [
        [makeOffer('O1'), makeOffer('O2')],
        [makeOffer('O3')],
        [], // stop here
        [makeOffer('O4')], // never reached
      ],
    },
  });
  const offers = await fetchEligibleOffers('A');
  assert.deepEqual(offers.map((o) => o.offerId), ['O1', 'O2', 'O3']);
});

test('fetchEligibleOffers keeps only MERCHANT offers', async () => {
  useScenario({
    eligiblePages: {
      A: [[
        makeOffer('O1'),
        makeOffer('B1', {type: 'BENEFIT'}),
        makeOffer('O2'),
      ]],
    },
  });
  const offers = await fetchEligibleOffers('A');
  assert.deepEqual(offers.map((o) => o.offerId), ['O1', 'O2']);
});

test('snapshot builds per-card eligible + enrolled keys', async () => {
  useScenario({
    accounts: [
      {account_token: 'TOKENA', profile: {embossed_name: 'CARD A'},
        display_account_number: '-31004'},
      {account_token: 'TOKENB'},
    ],
    eligiblePages: {
      // Same offer (pzn PZ) on both cards, different per-card offerId.
      TOKENA: [[makeOffer('OA', {pzn: 'PZ'})]],
      TOKENB: [[makeOffer('OB', {pzn: 'PZ'}), makeOffer('O2')]],
    },
    enrolledState: {
      TOKENA: [makeOffer('OA', {pzn: 'PZ'})],
      TOKENB: [],
    },
  });

  const cards = await snapshot();
  const cardA = cards.find((c) => c.token === 'TOKENA');

  assert.equal(cards.length, 2);
  assert.equal(cardA.name, 'CARD A ••31004'); // product + last digits
  assert.ok(cardA.enrolledKeys.has('PZ'));

  // Aggregation: PZ is eligible on both cards, already added on A only.
  const groups = buildOfferIndex(cards);
  const group = groups.find((g) => g.key === 'PZ');
  assert.deepEqual(group.cards.map((c) => c.token), ['TOKENA', 'TOKENB']);
  assert.deepEqual(group.cards.map((c) => c.offerId), ['OA', 'OB']);
  assert.equal(group.cards.find((c) => c.token === 'TOKENA').enrolled, true);
  assert.equal(group.cards.find((c) => c.token === 'TOKENB').enrolled, false);
});

test('retryTransient retries transient errors and then succeeds', async () => {
  let calls = 0;
  const fn = async () => {
    calls++;
    if (calls === 1) {
      throw Object.assign(new Error('boom'), {transient: true});
    }
    return 'ok';
  };

  assert.equal(await retryTransient(fn, noDelay), 'ok');
  assert.equal(calls, 2);
});

test('retryTransient throws definitive errors through untouched', async () => {
  let calls = 0;
  const fn = async () => {
    calls++;
    throw Object.assign(new Error('HTTP 400'), {transient: false});
  };

  await assert.rejects(() => retryTransient(fn, noDelay), /HTTP 400/);
  assert.equal(calls, 1, 'a definitive answer is not re-sent');
});

test('snapshot retries a flaky read and recovers the card', async () => {
  let failed = false;
  useScenario({
    accounts: [{account_token: 'A'}],
    eligiblePages: {A: [[makeOffer('OA')]]},
    enrolledState: {A: []},
    onReadOffers(token, body) {
      if (!failed && body.requestType === 'OFFERSHUB_LANDING') {
        failed = true;
        throw new Error('flaky read');
      }
    },
  });

  const cards = await snapshot(undefined, {retryDelay: noDelay});

  assert.equal(cards[0].readFailed, false);
  assert.deepEqual(cards[0].eligible.map((o) => o.offerId), ['OA']);
});

test('snapshot skips a card whose reads keep failing', async () => {
  useScenario({
    accounts: [{account_token: 'A'}, {account_token: 'B'}],
    eligiblePages: {A: [[makeOffer('OA')]], B: [[makeOffer('OB')]]},
    enrolledState: {A: [], B: []},
    onReadOffers(token) {
      if (token === 'B') throw new Error('read down');
    },
  });

  const cards = await snapshot(undefined, {retryDelay: noDelay});

  const cardA = cards.find((c) => c.token === 'A');
  const cardB = cards.find((c) => c.token === 'B');
  assert.equal(cards.length, 2, 'the failing card is kept, not dropped');
  assert.equal(cardA.readFailed, false);
  assert.deepEqual(cardA.eligible.map((o) => o.offerId), ['OA']);
  assert.equal(cardB.readFailed, true);
  assert.deepEqual(cardB.eligible, []);
  assert.deepEqual(cardB.enrolled, []);
});

test('snapshot aborts on a blocked read instead of degrading', async () => {
  useScenario({
    accounts: [{account_token: 'A'}],
    eligiblePages: {A: [[makeOffer('OA')]]},
    enrolledState: {A: []},
    onReadOffers: () => jsonResponse({}, false, 429),
  });

  await assert.rejects(() => snapshot(undefined, {retryDelay: noDelay}),
    (error) => error.httpStatus === 429 && error.blocked === true);
});

test('snapshot reports progress with the real card count', async () => {
  useScenario({
    accounts: [
      {account_token: 'A'}, {account_token: 'B'}, {account_token: 'C'},
    ],
    eligiblePages: {A: [[makeOffer('OA')]], B: [], C: []},
    enrolledState: {A: [], B: [], C: []},
  });

  const progress = [];
  await snapshot((done, total) => progress.push(`${done}/${total}`));

  // The total is the real account count from the first fetch (not hardcoded),
  // and progress steps once per card from 0 to N — never jumping straight to
  // the end.
  assert.deepEqual(progress, ['0/3', '1/3', '2/3', '3/3']);
});
