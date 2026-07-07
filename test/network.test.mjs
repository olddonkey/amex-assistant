/**
 * @fileoverview Tests for the network layer against the fetch mock: account
 * listing, eligible-offer pagination and filtering, and the snapshot builder.
 */

import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';

import api from '../src/amex-assistant.user.js';
import {createMockFetch, makeOffer} from './mock-fetch.mjs';

const {
  fetchAccounts, fetchEligibleOffers, snapshot, buildOfferIndex, mapLimit,
} = api;

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
