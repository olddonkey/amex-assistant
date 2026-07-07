/**
 * @fileoverview Tests for the added (redeem-tracking) sub-view's core:
 * fetching the savings list, grouping added offers across cards with their
 * redemption records, urgency sorting, header stats, and expiry parsing.
 */

import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';

import api from '../src/amex-assistant.user.js';
import {createMockFetch, makeOffer} from './mock-fetch.mjs';

const {fetchRedeemedOffers, buildAddedIndex, addedStats, offerExpiryDays} =
    api;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const noDelay = () => Promise.resolve();

/** A fixed "today" so expiry math is deterministic: 2026-07-07 12:00. */
const NOW = new Date(2026, 6, 7, 12, 0, 0).getTime();

/**
 * Builds a minimal snapshot card carrying enrolled offers.
 * @param {string} token Card token.
 * @param {!Array<!Object>} enrolled Raw enrolled offers.
 * @return {!Object} Card.
 */
function card(token, enrolled) {
  return {token, enrolled, eligible: [], enrolledKeys: new Set()};
}

/**
 * A raw enrolled/redeemed offer with an expiry text.
 * @param {string} offerId Per-card offerId.
 * @param {string} pzn Group key.
 * @param {!Object=} extra Extra fields.
 * @return {!Object} Raw offer.
 */
function offer(offerId, pzn, extra = {}) {
  return {...makeOffer(offerId, {pzn}), ...extra};
}

test('fetchRedeemedOffers reads the savings page1 list', async () => {
  globalThis.fetch = createMockFetch({
    redeemedState: {A: [offer('OA', 'PZ', {savingsAmount: '$10'})]},
  });

  const items = await fetchRedeemedOffers('A', noDelay);

  assert.equal(items.length, 1);
  assert.equal(items[0].savingsAmount, '$10');
});

test('fetchRedeemedOffers tolerates a flat-array savings list', async () => {
  globalThis.fetch = createMockFetch({
    onReadOffers(token, body) {
      if (body.requestType === 'SAVINGS_LANDING') {
        return {offersSavingsViewAll:
            {savingsOffers: {offersList: [offer('OA', 'PZ')]}}};
      }
    },
  });

  const items = await fetchRedeemedOffers('A', noDelay);

  assert.equal(items.length, 1);
});

test('buildAddedIndex groups across cards and attaches redemptions', () => {
  const cards = [
    card('A', [offer('OA', 'WF', {title: 'Whole Foods',
      expiration: {text: 'Expires 7/9'}})]),
    card('B', [offer('OB', 'WF', {title: 'Whole Foods',
      expiration: {text: 'Expires 7/9'}})]),
  ];
  const redeemed = new Map([
    ['A', [offer('OA', 'WF',
      {savingsAmount: '$15', redemptionDate: '2026-07-02'})]],
  ]);

  const groups = buildAddedIndex(cards, redeemed, NOW);

  assert.equal(groups.length, 1);
  const g = groups[0];
  assert.equal(g.cards.length, 2);
  assert.equal(g.daysLeft, 2, 'expires 7/9 with "today" of 7/7');
  const byToken = Object.fromEntries(g.cards.map((c) => [c.token, c]));
  assert.equal(byToken.A.redeemed.amount, 15);
  assert.equal(byToken.A.redeemed.date, '7/2');
  assert.equal(byToken.B.redeemed, null);
  assert.equal(g.redeemedCount, 1);
  assert.equal(g.fullyRedeemed, false);
});

test('a redeemed-only offer still appears, and full sinks last', () => {
  const cards = [card('A', [
    offer('O1', 'URGENT', {expiration: {text: 'til 7/8'}}),
    offer('O2', 'LATER', {expiration: {text: 'til 8/30'}}),
  ])];
  // HILTON no longer sits on the added list, only in savings.
  const redeemed = new Map([
    ['A', [offer('O3', 'HILTON', {title: 'Hilton', savingsAmount: 50})]],
  ]);

  const groups = buildAddedIndex(cards, redeemed, NOW);

  assert.deepEqual(groups.map((g) => g.key), ['URGENT', 'LATER', 'HILTON'],
    'urgency ascending, fully-redeemed last');
  const hilton = groups[2];
  assert.equal(hilton.fullyRedeemed, true);
  assert.equal(hilton.totalRedeemedUsd, 50);
});

test('points postings stay apart from dollars', () => {
  const mrWording = {title: 'Best Buy',
    shortDescription: 'Earn +1 Membership Rewards® point per dollar'};
  const cards = [
    card('A', [offer('O1', 'BB', mrWording)]),
    card('B', [offer('O2', 'BB', mrWording)]),
  ];
  const redeemed = new Map([
    ['A', [offer('O1', 'BB', {...mrWording, savingsAmount: 5000})]],
  ]);

  const groups = buildAddedIndex(cards, redeemed, NOW);
  const g = groups[0];
  const cardA = g.cards.find((c) => c.token === 'A');

  assert.equal(cardA.redeemed.unit, 'points');
  assert.equal(cardA.redeemed.amount, 5000);
  assert.equal(g.totalRedeemedUsd, 0, 'points never counted as money');
  assert.equal(g.totalRedeemedPoints, 5000);
  assert.equal(g.redeemedCount, 1, 'a points posting still counts as posted');

  const stats = addedStats(groups);
  assert.equal(stats.redeemedAmount, 0);
  assert.equal(stats.redeemedPoints, 5000);
});

test('addedStats sums postings and counts pending/expiring', () => {
  const cards = [card('A', [
    offer('O1', 'SOON', {expiration: {text: 'til 7/9'}}),
    offer('O2', 'FAR', {expiration: {text: 'til 9/1'}}),
  ]), card('B', [
    offer('O3', 'SOON', {expiration: {text: 'til 7/9'}}),
  ])];
  const redeemed = new Map([
    ['A', [offer('O1', 'SOON', {savingsAmount: '$15'})]],
    ['B', [offer('O4', 'DONE', {savingsAmount: '$50'})]],
  ]);

  const stats = addedStats(buildAddedIndex(cards, redeemed, NOW));

  assert.equal(stats.redeemedAmount, 65);
  // SOON (1/2 posted) and FAR are pending; DONE is fully redeemed.
  assert.equal(stats.pending, 2);
  assert.equal(stats.expiring, 1, 'only SOON is within 7 days');
});

test('offerExpiryDays parses text dates and rolls past m/d forward', () => {
  assert.equal(
    offerExpiryDays({expiration: {text: 'Expires 7/9'}}, NOW), 2);
  // 1/5 has already passed this year → assume the upcoming occurrence.
  assert.equal(
    offerExpiryDays({expiration: {text: 'by 1/5'}}, NOW) > 150, true);
  assert.equal(
    offerExpiryDays({expiration: {text: 'Expires 7/9/2026'}}, NOW), 2);
  assert.equal(offerExpiryDays({}, NOW), Infinity);
});
