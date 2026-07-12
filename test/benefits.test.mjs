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
  collectUntrackableBenefits, benefitPeriodTone, buildBenefitPeriodGroups,
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
    const fetch = createMockFetch({
      benefits: {
        PLAT: [makeTracker('Airline Fee', {target: 200, spent: 74})],
        SUPP: [makeTracker('Should be skipped')],
      },
    });
    globalThis.fetch = fetch;

    const cards = [
      card('PLAT', 'Platinum', '1005'),
      card('SUPP', 'Platinum', '9999', 'SUPPLEMENTARY'),
    ];
    const progress = [];
    const benefits = await fetchAllBenefits(
      cards, (done, total) => progress.push(`${done}/${total}`));

    // The trackers endpoint answers to `Accept: */*`, not application/json.
    const benefitsCall = fetch.calls.find((c) => c.url.includes('Trackers'));
    assert.equal(benefitsCall.headers['Accept'], '*/*');

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

test('benefitStats narrows to a single card via cardFilter', () => {
  // Same benefit on two cards; the group merges them but per-card stats must
  // count only the filtered card's own spend / remaining / annual fee.
  const benefits = [
    {sorBenefitId: 'A', name: 'Dining', category: '', period: 'month',
      periodEnd: '2026-07-31', target: 20, spent: 15, remaining: 5,
      symbol: '$', token: 'PLAT', family: 'Platinum', digits: '1'},
    {sorBenefitId: 'A2', name: 'Dining', category: '', period: 'month',
      periodEnd: '2026-07-31', target: 20, spent: 5, remaining: 15,
      symbol: '$', token: 'GOLD', family: 'Gold', digits: '2'},
  ];
  const groups = buildBenefitIndex(benefits, NOW);
  const cards = [card('PLAT', 'Platinum', '1005'), card('GOLD', 'Gold', '2')];

  const all = benefitStats(groups, cards, NOW);
  assert.equal(all.redeemedYtd, 20); // 15 + 5
  assert.equal(all.thisMonthUnused, 20); // group remaining, expires this month

  const plat = benefitStats(groups, cards, NOW, 'PLAT');
  assert.equal(plat.redeemedYtd, 15); // only the Platinum entry
  assert.equal(plat.thisMonthUnused, 5); // 20 - 15 on the Platinum card
  assert.equal(plat.annualFee, 695); // only the Platinum fee
});

test('benefitPeriodTone goes amber only below 25% of the period', () => {
  // Documented anchors: 每月 19/31 stays grey, 每半年 38/182 turns amber.
  assert.equal(benefitPeriodTone('month', 19), 'gray');
  assert.equal(benefitPeriodTone('half', 38), 'amber');
  assert.equal(benefitPeriodTone('year', 172), 'gray');
  assert.equal(benefitPeriodTone('quarter', 10), 'amber');
  assert.equal(benefitPeriodTone('month', -3), 'amber'); // expired
  assert.equal(benefitPeriodTone('year', Infinity), 'gray'); // no end date
});

test('buildBenefitPeriodGroups buckets by cadence with summaries', () => {
  const groups = [
    {name: 'M1', period: 'month', daysLeft: 19, target: 25, spent: 0,
      remaining: 25, fullyUsed: false, status: 'ACTIVE'},
    {name: 'M2', period: 'month', daysLeft: 12, target: 40, spent: 8.63,
      remaining: 31.37, fullyUsed: false, status: 'ACTIVE'},
    {name: 'H1', period: 'half', daysLeft: 38, target: 1500, spent: 0,
      remaining: 1500, fullyUsed: false, status: 'ACTIVE'},
    {name: 'Y1', period: 'year', daysLeft: 172, target: 219, spent: 219,
      remaining: 0, fullyUsed: true, status: 'ACHIEVED'},
    {name: 'Y2', period: 'year', daysLeft: Infinity, target: 189, spent: 0,
      remaining: 189, fullyUsed: false, status: 'NOTENROLLED'},
  ];
  const sections = buildBenefitPeriodGroups(groups);

  // Only non-empty periods, in cadence order (no 每季 here).
  assert.deepEqual(sections.map((s) => s.period), ['month', 'half', 'year']);

  const month = sections[0];
  assert.equal(month.count, 2);
  assert.equal(month.amount, 56.37); // 25 + 31.37 remaining
  assert.equal(month.activation, false);
  assert.equal(month.daysLeft, 12); // soonest reset in the bucket

  const year = sections[2];
  assert.equal(year.count, 2);
  assert.equal(year.amount, 189); // done Y1 contributes 0; inactive Y2 target
  assert.equal(year.activation, true); // only pending is a not-activated perk
  assert.equal(year.daysLeft, 172); // Infinity ignored
});

test('collectUntrackableBenefits gathers dropped trackers + untracked perks',
  () => {
    const perCard = [{
      card: {token: 'PLAT', family: 'Platinum', digits: '1005'},
      trackers: [
        makeTracker('Airline Fee', {sor: 'AIR', target: 200, spent: 50}),
        makeTracker('Centurion via spend',
          {sor: 'CENT', category: 'spend', target: 75000, spent: 100}),
        makeTracker('Delta Sky Club',
          {sor: 'DSC', category: 'access', unit: 'PASSES',
            target: 10, spent: 3}),
      ],
      catalog: {
        air: makeCatalogEntry('$200 Airline Fee Credit',
          {sor: 'AIR', layoutType: 'ENROLLED'}),
        uber: makeCatalogEntry('Uber Cash',
          {sor: 'UBER', layoutType: 'ENROLLED', enrollable: false}),
        clear: makeCatalogEntry('$189 CLEAR+ Credit',
          {sor: 'CLEAR', layoutType: 'NOTENROLLED', enrollable: true}),
      },
    }];

    const names = collectUntrackableBenefits(perCard).map((u) => u.name);
    // Spend-to-unlock + pass-based trackers, and the enrolled untracked perk.
    assert.ok(names.includes('Centurion via spend'));
    assert.ok(names.includes('Delta Sky Club'));
    assert.ok(names.includes('Uber Cash'));
    // The tracked dollar credit and its catalog twin are excluded, and the
    // not-enrolled enrollable credit stays a 去激活 row (not untrackable).
    assert.ok(!names.some((n) => /Airline Fee/.test(n)));
    assert.ok(!names.some((n) => /CLEAR/.test(n)));
    assert.equal(names.length, 3);
  });

test('fetchAllBenefits attaches an untrackable summary without changing rows',
  async () => {
    globalThis.fetch = createMockFetch({
      benefits: {
        PLAT: [
          makeTracker('$300 Dining', {sor: 'DINE', target: 20, spent: 8}),
          makeTracker('Delta Sky Club',
            {sor: 'DSC', unit: 'PASSES', target: 10, spent: 3}),
        ],
      },
    });
    const benefits = await fetchAllBenefits([card('PLAT', 'Platinum', '1005')]);
    // The tracked list still holds only the dollar credit.
    assert.deepEqual(benefits.map((b) => b.sorBenefitId), ['DINE']);
    // The pass-based tracker rides along as an untrackable summary item.
    assert.ok(Array.isArray(benefits.untrackable));
    assert.deepEqual(
      benefits.untrackable.map((u) => u.name), ['Delta Sky Club']);
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
