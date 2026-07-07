/**
 * @fileoverview Tests for the benefits data layer: reading each BASIC card's
 * trackers, grouping across cards by sorBenefitId, expiry sorting, the header
 * stats, and the small helpers (annual-fee lookup, period label, days-until).
 */

import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';

import api from '../src/amex-assistant.user.js';
import {createMockFetch, makeTracker, makeCatalogEntry} from './mock-fetch.mjs';

const {
  fetchAllBenefits, buildBenefitIndex, benefitStats,
  annualFeeFor, benefitPeriodLabel, daysUntil,
  decodeHtml, parseCreditAmount,
} = api;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// A fixed "today" so date math is deterministic.
const NOW = Date.parse('2026-07-06T12:00:00Z');

/**
 * @param {string} token Card token.
 * @param {string} family Product family.
 * @param {string} digits Display digits.
 * @param {string=} relationship BASIC (default) or SUPPLEMENTARY.
 * @return {!Object} A snapshot-shaped card.
 */
function card(token, family, digits, relationship = 'BASIC') {
  return {token, family, digits, art: '', relationship};
}

test('fetchAllBenefits reads only BASIC cards and tags each benefit',
  async () => {
    globalThis.fetch = createMockFetch({
      benefits: {
        PLAT: [makeTracker('Airline Fee', {target: 200, spent: 74})],
        SUPP: [makeTracker('Should be skipped')],
      },
    });

    const cards = [
      card('PLAT', 'Platinum', '1005'),
      card('SUPP', 'Platinum', '9999', 'SUPPLEMENTARY'),
    ];
    const progress = [];
    const benefits = await fetchAllBenefits(
      cards, (done, total) => progress.push(`${done}/${total}`));

    assert.equal(benefits.length, 1, 'supplementary card excluded');
    const b = benefits[0];
    assert.equal(b.name, 'Airline Fee');
    assert.equal(b.token, 'PLAT');
    assert.equal(b.family, 'Platinum');
    assert.equal(b.target, 200);
    assert.equal(b.spent, 74);
    assert.equal(b.remaining, 126); // derived when endpoint omits it
    // Progress starts at 0 and steps once per owned card.
    assert.deepEqual(progress, ['0/1', '1/1']);
  });

test('fetchAllBenefits drops spend-to-unlock and pass-based trackers',
  async () => {
    globalThis.fetch = createMockFetch({
      benefits: {
        PLAT: [
          makeTracker('$300 Digital Entertainment',
            {sor: 'DE', category: 'usage', target: 20, spent: 8}),
          // spend-to-unlock milestone (huge target) — must be dropped
          makeTracker('Centurion Lounge via spend',
            {sor: 'CENT', category: 'spend', target: 75000, spent: 2593}),
          // pass-based lounge access — must be dropped
          makeTracker('Delta Sky Club Visits',
            {sor: 'DSC', category: 'access', unit: 'PASSES',
              target: 10, spent: 3}),
        ],
      },
    });
    const benefits = await fetchAllBenefits([card('PLAT', 'Platinum', '1005')]);
    assert.deepEqual(benefits.map((b) => b.sorBenefitId), ['DE'],
      'only the usage dollar credit is kept');
  });

test('buildBenefitIndex groups by name across products (different sorIds)',
  () => {
    const benefits = [
      // Same benefit, but a different sorBenefitId on each card product —
      // grouping by name must still merge them into one multi-card row.
      {sorBenefitId: 'DINING-PLAT', name: 'Dining Credit', category: '',
        period: '月', periodEnd: '2026-07-31', target: 10, spent: 3.55,
        symbol: '$', token: 'G1', family: 'Gold', digits: '3021'},
      {sorBenefitId: 'DINING-BIZ', name: 'Dining Credit', category: '',
        period: '月', periodEnd: '2026-07-31', target: 10, spent: 10,
        symbol: '$', token: 'G2', family: 'Gold', digits: '7742'},
      {sorBenefitId: 'SAKS', name: 'Saks', category: '', period: '半年',
        periodEnd: '2026-07-11', target: 50, spent: 0, symbol: '$',
        token: 'P1', family: 'Platinum', digits: '1005'},
    ];

    const groups = buildBenefitIndex(benefits, NOW);

    // Soonest expiry first: Saks (07-11) before Dining (07-31).
    assert.deepEqual(groups.map((g) => g.name), ['Saks', 'Dining Credit']);

    const dining = groups.find((g) => g.name === 'Dining Credit');
    assert.equal(dining.entries.length, 2); // merged despite different sorIds
    assert.equal(dining.multiCard, true);
    assert.equal(dining.spent, 13.55); // summed across both Gold cards
    assert.equal(dining.target, 20);
    assert.equal(dining.remaining, 6.45);
    assert.equal(dining.fullyUsed, false);

    const saks = groups.find((g) => g.name === 'Saks');
    assert.equal(saks.multiCard, false);
    assert.equal(saks.daysLeft, 5); // 07-11 minus 07-06
  });

test('benefitStats sums unused-this-month, redeemed, and fee payback', () => {
  const benefits = [
    // expires this month → counts toward "unused this month"
    {sorBenefitId: 'A', name: 'A', category: 'C', period: '月',
      periodEnd: '2026-07-31', target: 20, spent: 12, remaining: 8,
      symbol: '$', token: 'PLAT', family: 'Platinum', digits: '1'},
    // expires later this year → not this month
    {sorBenefitId: 'B', name: 'B', category: 'C', period: '年',
      periodEnd: '2026-12-31', target: 200, spent: 100, remaining: 100,
      symbol: '$', token: 'PLAT', family: 'Platinum', digits: '1'},
  ];
  const groups = buildBenefitIndex(benefits, NOW);
  const cards = [card('PLAT', 'Platinum', '1005')];

  const stats = benefitStats(groups, cards, NOW);
  assert.equal(stats.thisMonthUnused, 8);
  assert.equal(stats.redeemedYtd, 112); // 12 + 100
  assert.equal(stats.annualFee, 695); // Platinum
  assert.equal(stats.paybackPct, 16); // round(112 / 695 * 100)
});

test('annualFeeFor matches exact then substring, else 0', () => {
  assert.equal(annualFeeFor('Platinum'), 695);
  assert.equal(annualFeeFor('Business Gold'), 375);
  assert.equal(annualFeeFor('Blue Cash Preferred'), 95);
  assert.equal(annualFeeFor('Some Unknown Card'), 0);
  assert.equal(annualFeeFor(''), 0);
});

test('benefitPeriodLabel derives cadence from the period span', () => {
  // Language-neutral keys; the UI localizes them via the period_* catalog.
  assert.equal(
    benefitPeriodLabel({periodStartDate: '2026-07-01',
      periodEndDate: '2026-07-31'}), 'month');
  assert.equal(
    benefitPeriodLabel({periodStartDate: '2026-01-01',
      periodEndDate: '2026-06-30'}), 'half');
  assert.equal(
    benefitPeriodLabel({periodStartDate: '2026-01-01',
      periodEndDate: '2026-12-31'}), 'year');
  // Falls back to the duration string when dates are missing.
  assert.equal(benefitPeriodLabel({trackerDuration: 'ANNUAL'}), 'year');
});

test('daysUntil counts whole days from a fixed now', () => {
  assert.equal(daysUntil('2026-07-11T12:00:00Z', NOW), 5);
  assert.equal(daysUntil('2026-07-06T12:00:00Z', NOW), 0);
  assert.equal(daysUntil('not-a-date', NOW), Infinity);
});

test('decodeHtml strips tags and decodes entities', () => {
  assert.equal(decodeHtml('&#36;209 CLEAR&#43; Credit'), '$209 CLEAR+ Credit');
  assert.equal(decodeHtml('Marriott<sup>&#174;</sup> Gold'), 'Marriott® Gold');
  assert.equal(decodeHtml('A &amp; B'), 'A & B');
});

test('parseCreditAmount pulls the dollar value from a title', () => {
  assert.equal(parseCreditAmount('$209 CLEAR+ Credit'), 209);
  assert.equal(parseCreditAmount('$1,200 Amex Travel Credit'), 1200);
  assert.equal(parseCreditAmount('Global Entry Credit'), 0);
});

test('fetchAllBenefits joins the catalog: better titles + 未激活 rows',
  async () => {
    globalThis.fetch = createMockFetch({
      benefits: {
        PLAT: [
          // tracker with a useless name (achieved) — catalog should fix it
          makeTracker('Congratulations!',
            {sor: 'DINING', target: 200, spent: 200, status: 'ACHIEVED'}),
        ],
      },
      catalog: {
        PLAT: {
          'dining': makeCatalogEntry('$200 Dining Credit',
            {sor: 'DINING', layoutType: 'ENROLLED'}),
          // enrollable + not enrolled + no tracker → a 去激活 row
          'clear': makeCatalogEntry('$209 CLEAR+ Credit',
            {sor: 'CLEAR', layoutType: 'NOTENROLLED', enrollable: true}),
          // enrolled-but-untracked and non-enrollable → must NOT appear
          'lounge': makeCatalogEntry('Global Lounge',
            {sor: 'LOUNGE', layoutType: 'ENROLLED', enrollable: false}),
        },
      },
    });

    const benefits = await fetchAllBenefits([card('PLAT', 'Platinum', '1005')]);
    const dining = benefits.find((b) => b.sorBenefitId === 'DINING');
    const clear = benefits.find((b) => b.sorBenefitId === 'CLEAR');

    // tracker kept, but renamed from the catalog title
    assert.equal(dining.name, '$200 Dining Credit');
    // the not-enrolled catalog benefit was added as a 未激活 row
    assert.ok(clear, 'not-enrolled benefit surfaced');
    assert.equal(clear.status, 'NOTENROLLED');
    assert.equal(clear.target, 209); // parsed from the title
    assert.equal(clear.spent, 0);
    // the enrolled-but-untracked, non-enrollable benefit is not surfaced
    assert.ok(!benefits.some((b) => b.sorBenefitId === 'LOUNGE'));
  });
