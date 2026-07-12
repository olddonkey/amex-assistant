/**
 * @fileoverview Tests for the G2 added-view logic: the offer-category probe,
 * category carried into the added index, the three grouping modes
 * (expiry/card/category), and the card-filtered header stats. These are the
 * pure functions behind design 8final's five states (A default, B menu,
 * C by-card, D single-card, E by-category).
 */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import api from '../src/amex-assistant.user.js';
import {makeOffer} from './mock-fetch.mjs';

const {offerCategory, buildAddedIndex, buildAddedByCard, groupAddedBy,
  groupAddedByCategory, addedStats} = api;

/** A fixed "today" so expiry math is deterministic: 2026-07-07 12:00. */
const NOW = new Date(2026, 6, 7, 12, 0, 0).getTime();

/**
 * A minimal snapshot card carrying enrolled offers.
 * @param {string} token Card token.
 * @param {!Array<!Object>} enrolled Raw enrolled offers.
 * @return {!Object} Card.
 */
function card(token, enrolled) {
  return {token, enrolled, eligible: [], enrolledKeys: new Set()};
}

/**
 * A raw offer with a group key and optional extra fields.
 * @param {string} offerId Per-card offerId.
 * @param {string} pzn Group key.
 * @param {!Object=} extra Extra fields (category, expiration, ...).
 * @return {!Object} Raw offer.
 */
function offer(offerId, pzn, extra = {}) {
  return {...makeOffer(offerId, {pzn}), ...extra};
}

test('offerCategory probes candidate paths and normalizes', () => {
  assert.equal(offerCategory({category: 'Shopping'}), 'Shopping');
  assert.equal(offerCategory({offerCategory: {name: 'Travel'}}), 'Travel');
  assert.equal(offerCategory({industry: 'Dining'}), 'Dining');
  assert.equal(offerCategory({merchantCategory: 'Gas'}), 'Gas');
  assert.equal(offerCategory({category: {name: 'Retail'}}), 'Retail');
});

test('offerCategory reads array forms (string or {name})', () => {
  assert.equal(offerCategory({categories: ['Gas']}), 'Gas');
  assert.equal(offerCategory({categories: [{name: 'Gas'}]}), 'Gas');
  assert.equal(offerCategory({offerCategories: [{name: 'Air'}]}), 'Air');
});

test('offerCategory trims, collapses whitespace, and gives up cleanly', () => {
  assert.equal(offerCategory({category: '  Home   Goods  '}), 'Home Goods');
  assert.equal(offerCategory({category: '   '}), '');
  assert.equal(offerCategory({category: ''}), '');
  assert.equal(offerCategory({category: 5}), '');
  assert.equal(offerCategory({}), '');
  assert.equal(offerCategory(null), '');
});

test('buildAddedIndex carries the probed category onto each group', () => {
  const cards = [card('A', [
    offer('O1', 'WF', {title: 'Whole Foods', category: 'Shopping'}),
    offer('O2', 'AL', {offerCategory: {name: 'Travel'}}),
    offer('O3', 'NC'),
  ])];

  const byKey = Object.fromEntries(
    buildAddedIndex(cards, new Map(), NOW).map((g) => [g.key, g.category]));

  assert.equal(byKey.WF, 'Shopping');
  assert.equal(byKey.AL, 'Travel');
  assert.equal(byKey.NC, '', 'no category → empty string, never invented');
});

test('a later sighting can fill in a missing category', () => {
  const cards = [card('A', [offer('O1', 'P', {title: 'Sweetgreen'})])];
  const redeemed = new Map([
    ['A', [offer('O1', 'P', {category: 'Dining', savingsAmount: '$5'})]],
  ]);

  const [g] = buildAddedIndex(cards, redeemed, NOW);

  assert.equal(g.category, 'Dining');
});

test('groupAddedByCategory sorts names alpha with uncategorized last', () => {
  const cards = [card('A', [
    offer('O1', 'WF', {category: 'Shopping'}),
    offer('O2', 'AL', {category: 'Travel'}),
    offer('O3', 'NC'),
    offer('O4', 'DN', {category: 'Dining'}),
  ])];

  const sections = groupAddedByCategory(buildAddedIndex(cards, new Map(), NOW));

  assert.deepEqual(sections.map((s) => s.category),
    ['Dining', 'Shopping', 'Travel', '']);
  assert.equal(sections[3].offers.length, 1, 'the NC offer is uncategorized');
});

test('groupAddedBy dispatches by mode', () => {
  const cards = [
    card('A', [offer('O1', 'WF', {category: 'Shopping'})]),
    card('B', [offer('O2', 'WF', {category: 'Shopping'})]),
  ];
  const groups = buildAddedIndex(cards, new Map(), NOW);

  // expiry → the flat groups, untouched.
  assert.equal(groupAddedBy(groups, 'expiry'), groups);
  // category → sections.
  const cat = groupAddedBy(groups, 'category');
  assert.equal(cat.length, 1);
  assert.equal(cat[0].category, 'Shopping');
  // card → per-card groups, ordered by the injected card order.
  const byCard = groupAddedBy(groups, 'card', ['B', 'A']);
  assert.deepEqual(byCard.map((c) => c.token), ['B', 'A']);
});

test('buildAddedByCard takes an injected order and keeps descriptions', () => {
  const cards = [
    card('A', [offer('O1', 'WF',
      {title: 'Whole Foods', shortDescription: 'Spend $5, get $5'})]),
    card('B', [offer('O2', 'WF', {title: 'Whole Foods'})]),
  ];
  const groups = buildAddedIndex(cards, new Map(), NOW);

  const byCard = buildAddedByCard(groups, ['B', 'A']);

  assert.deepEqual(byCard.map((c) => c.token), ['B', 'A']);
  const cardA = byCard.find((c) => c.token === 'A');
  assert.equal(cardA.offers[0].description, 'Spend $5, get $5');
});

test('addedStats narrows to a single card when filtered', () => {
  const cards = [
    card('A', [
      offer('O1', 'SOON', {expiration: {text: 'til 7/9'}}),
      offer('O2', 'LATER', {expiration: {text: 'til 9/1'}}),
    ]),
    card('B', [offer('O3', 'SOON', {expiration: {text: 'til 7/9'}})]),
  ];
  const redeemed = new Map([
    ['A', [offer('O1', 'SOON', {savingsAmount: '$15'})]],
  ]);
  const groups = buildAddedIndex(cards, redeemed, NOW);

  // Across all cards: $15 posted, SOON + LATER pending, only SOON expiring.
  assert.deepEqual(addedStats(groups),
    {redeemedAmount: 15, redeemedPoints: 0, pending: 2, expiring: 1});
  // Card A: its own $15 posting, only LATER still pending (not expiring).
  assert.deepEqual(addedStats(groups, 'A'),
    {redeemedAmount: 15, redeemedPoints: 0, pending: 1, expiring: 0});
  // Card B: nothing posted, its SOON is pending and expiring within 7 days.
  assert.deepEqual(addedStats(groups, 'B'),
    {redeemedAmount: 0, redeemedPoints: 0, pending: 1, expiring: 1});
});
