/**
 * @fileoverview Tests for the i18n layer: catalog parity between zh and en,
 * placeholder interpolation, language switching, and fallbacks. Catalog
 * parity is the load-bearing test — a string added in one language but not
 * the other fails here instead of silently rendering half-translated UI.
 */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import api from '../src/amex-assistant.user.js';

const {MESSAGES, t, setLanguage, getLanguage} = api;

test('zh and en catalogs carry exactly the same keys', () => {
  assert.deepEqual(
    Object.keys(MESSAGES.zh).sort(), Object.keys(MESSAGES.en).sort());
});

test('no catalog entry is empty', () => {
  for (const lang of Object.keys(MESSAGES)) {
    for (const [key, value] of Object.entries(MESSAGES[lang])) {
      assert.ok(String(value).length > 0, `${lang}.${key} is empty`);
    }
  }
});

test('t interpolates params and follows the active language', () => {
  setLanguage('en');
  assert.equal(getLanguage(), 'en');
  assert.equal(t('daysLeft', {n: 5}), 'Days remaining: 5');
  assert.equal(t('loadingCardN', {done: 2, total: 7}), 'Card 2 / 7');
  setLanguage('zh');
  assert.equal(getLanguage(), 'zh');
  assert.equal(t('daysLeft', {n: 5}), '还剩 5 天');
});

test('t returns the key itself for unknown ids', () => {
  setLanguage('zh');
  assert.equal(t('definitely_not_a_key'), 'definitely_not_a_key');
});

test('setLanguage falls back to en for unknown codes', () => {
  setLanguage('fr');
  assert.equal(getLanguage(), 'en');
  setLanguage('zh'); // restore the default for any later assertions
});
