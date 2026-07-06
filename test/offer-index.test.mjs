/**
 * @fileoverview Unit tests for the pure helpers: group-key selection, path
 * reads, offer aggregation (group by pzn, keep each card's own offerId), and
 * attempt classification.
 */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import api from '../src/amex-assistant.user.js';
import {makeOffer} from './mock-fetch.mjs';

const {offerGroupKey, getPath, cardName, cardDisplayDigits, flattenAccounts,
  buildOfferIndex, addableCards, classifyAttempts, ResultState} = api;

test('offerGroupKey prefers pznAnalyticsId, falls back to offerId', () => {
  assert.equal(offerGroupKey({offerId: 'O1', pznAnalyticsId: 'P1'}), 'P1');
  assert.equal(offerGroupKey({offerId: 'O1'}), 'O1');
  assert.equal(offerGroupKey({pznAnalyticsId: 42}), '42');
  assert.equal(offerGroupKey({}), null);
});

test('getPath reads nested values and tolerates gaps', () => {
  const obj = {a: {b: {c: 7}}};
  assert.equal(getPath(obj, 'a.b.c'), 7);
  assert.equal(getPath(obj, 'a.x.c'), undefined);
  assert.equal(getPath(null, 'a.b'), null);
});

test('cardName combines product description and last digits', () => {
  // Real Amex shape: the display number is nested under `account`.
  const account = {
    account: {display_account_number: '31004'},
    product: {description: 'Platinum Card®'},
    profile: {embossed_name: 'YICONG WANG'},
  };
  assert.equal(cardName(account, '6AVNG6KRI9520RB'), 'Platinum Card® ••31004');
});

test('cardName falls back to embossed name then token tail', () => {
  assert.equal(cardName({profile: {embossed_name: 'Y WANG'}}, 'AAAA1234'),
    'Y WANG …1234');
  assert.equal(cardName({}, 'AAAA1234'), '…1234');
});

test('cardDisplayDigits extracts last digits, tolerating masks', () => {
  assert.equal(
    cardDisplayDigits({account: {display_account_number: '31004'}}), '31004');
  assert.equal(cardDisplayDigits({display_account_number: '-98765'}), '98765');
  assert.equal(cardDisplayDigits({}), '');
});

test('buildOfferIndex groups by pzn but keeps each card\'s offerId', () => {
  // Same merchant offer on 3 cards: shared pzn, distinct per-card offerId.
  const cards = [
    {token: 'A', enrolledKeys: new Set(),
      eligible: [makeOffer('OA', {pzn: 'PZ'}), makeOffer('X')]},
    {token: 'B', enrolledKeys: new Set(['PZ']),
      eligible: [makeOffer('OB', {pzn: 'PZ'})]},
    {token: 'C', enrolledKeys: new Set(),
      eligible: [makeOffer('OC', {pzn: 'PZ'})]},
  ];

  const groups = buildOfferIndex(cards);
  const group = groups.find((g) => g.key === 'PZ');

  // Most widely eligible group sorts first.
  assert.equal(groups[0].key, 'PZ');
  assert.equal(groups.length, 2);
  // Each card contributes its OWN opaque offerId (what we enroll with).
  assert.deepEqual(
    group.cards.map((c) => [c.token, c.offerId]),
    [['A', 'OA'], ['B', 'OB'], ['C', 'OC']]);
  // Card B already has it; A and C do not.
  assert.equal(group.cards.find((c) => c.token === 'B').enrolled, true);
  assert.equal(group.cards.find((c) => c.token === 'A').enrolled, false);
});

test('addableCards excludes already-enrolled cards', () => {
  const cards = [
    {token: 'A', enrolledKeys: new Set(['PZ']),
      eligible: [makeOffer('OA', {pzn: 'PZ'})]},
    {token: 'B', enrolledKeys: new Set(),
      eligible: [makeOffer('OB', {pzn: 'PZ'})]},
  ];
  const [group] = buildOfferIndex(cards);
  assert.deepEqual(addableCards(group).map((c) => c.token), ['B']);
});

test('buildOfferIndex skips offers without an offerId', () => {
  const cards = [{
    token: 'A',
    enrolledKeys: new Set(),
    eligible: [
      {offerType: 'MERCHANT', title: 'no id', pznAnalyticsId: 'P'},
      makeOffer('O9'),
    ],
  }];
  const groups = buildOfferIndex(cards);
  assert.deepEqual(groups.map((g) => g.key), ['O9']);
});

test('flattenAccounts includes supplementary cards', () => {
  const accounts = [
    {
      account_token: 'BASIC1', product: {description: 'Gold'},
      supplementary_accounts: [
        {account: {account_token: 'SUPP1', display_account_number: '55555'}},
      ],
    },
    {account_token: 'BASIC2'},
    {supplementary_accounts: [{account: {}}]}, // no token → skipped
  ];

  const cards = flattenAccounts(accounts);

  assert.deepEqual(
    cards.map((c) => c.account_token), ['BASIC1', 'SUPP1', 'BASIC2']);
  const supp = cards.find((c) => c.account_token === 'SUPP1');
  assert.equal(supp.product.description, 'Gold'); // inherited from parent
});

test('classifyAttempts marks unverified when a re-read is missing', () => {
  // Token 'A' absent from the map → its re-read failed.
  const attempts = [{
    key: 'PZ', name: 'x', token: 'A', offerId: 'OA', reportedOk: true,
    message: '',
  }];
  const results = classifyAttempts(attempts, new Map());
  assert.equal(results[0].state, ResultState.UNVERIFIED);
});

test('classifyAttempts maps attempts to final states by group key', () => {
  const attempts = [
    {key: 'PZ', name: 'x', token: 'A', offerId: 'OA', reportedOk: true,
      message: ''},
    {key: 'PZ', name: 'x', token: 'B', offerId: 'OB', reportedOk: true,
      message: ''},
    {key: 'PZ', name: 'x', token: 'C', offerId: 'OC', reportedOk: false,
      message: 'nope'},
  ];
  const enrolledByToken = new Map([
    ['A', new Set(['PZ'])], // verified on A
    ['B', new Set()], // ghost on B
  ]);

  const results = classifyAttempts(attempts, enrolledByToken);

  assert.equal(results[0].state, ResultState.VERIFIED);
  assert.equal(results[1].state, ResultState.GHOST);
  assert.equal(results[2].state, ResultState.FAILED);
  assert.equal(results[0].offerId, 'OA');
  assert.equal(results[2].message, 'nope');
});
