// ==UserScript==
// @name         Amex Assistant
// @namespace    https://github.com/olddonkey/amex-assistant
// @version      0.11.0
// @description  Pick an Amex Offer and add it to multiple cards from one panel; verifies which cards actually got it. Local-only, no telemetry.
// @author       olddonkey
// @match        https://global.americanexpress.com/*
// @grant        none
// @run-at       document-idle
// @license      MIT
// @homepageURL  https://github.com/olddonkey/amex-assistant
// @supportURL   https://github.com/olddonkey/amex-assistant/issues
// @updateURL    https://raw.githubusercontent.com/olddonkey/amex-assistant/main/src/amex-assistant.user.js
// @downloadURL  https://raw.githubusercontent.com/olddonkey/amex-assistant/main/src/amex-assistant.user.js
// ==/UserScript==

/**
 * @fileoverview Amex Assistant is a Tampermonkey userscript that lets you
 * pick an American Express Offer and enroll it onto several cards at once,
 * then re-reads each card to report which cards actually received it.
 *
 * It talks only to americanexpress.com using the logged-in browser session
 * (`credentials: 'include'`). It makes no third-party requests, collects no
 * credentials, reads no cookies, and has no backend — hence `@grant none`.
 *
 * The whole script is a single IIFE so it can be installed directly. Under
 * Node (the test suite) there is no `window`/`document`, so it skips all DOM
 * work and instead exports its testable functions via `module.exports`.
 *
 * Two ids matter and must not be confused (both come from the offers hub):
 * - `offerId`: an opaque per-card token. This is what you enroll with, and it
 *   differs for the same merchant offer across cards.
 * - `pznAnalyticsId`: a stable analytics id shared by the same offer across
 *   cards. Used only to group/deduplicate offers for display.
 *
 * The Amex endpoints and payloads used here are undocumented and were derived
 * by observing the public web app; see docs/FINDINGS.md.
 */

/* global module */

(function() {
  'use strict';

  /**
   * @typedef {{token: string, tag: string, name: string, shortName: string,
   *            art: string, eligible: !Array<!Object>,
   *            enrolled: !Array<!Object>, enrolledKeys: !Set<string>}}
   *     CardSnapshot
   */

  /**
   * A merchant offer grouped across the cards that can add it. `cards[i]`
   * carries that card's own `offerId` (the token to enroll with).
   * @typedef {{key: string, name: string, description: string, image: string,
   *            expiry: string, cards: !Array<{token: string, offerId: string,
   *                           enrolled: boolean}>}} OfferGroup
   */

  /**
   * @typedef {{token: string, offerId: string, key: string,
   *            name: string}} Task
   */

  /**
   * @typedef {{key: string, name: string, token: string, offerId: string,
   *            state: string, message: string, httpStatus: number,
   *            blocked: boolean}} EnrollResult
   */

  /** Origin that serves Amex's internal "functions" RPC endpoints. */
  const FUNCTIONS_ORIGIN = 'https://functions.americanexpress.com';

  /** Endpoint that lists the logged-in member's card accounts. */
  const MEMBER_URL =
      'https://global.americanexpress.com/api/servicing/v1/member';

  /** Endpoint that reads the offers hub (eligible / added-to-card lists). */
  const READ_OFFERS_URL =
      `${FUNCTIONS_ORIGIN}/ReadOffersHubPresentation.web.v1`;

  /** Endpoint that enrolls a single offer onto a single card. */
  const ENROLL_URL = `${FUNCTIONS_ORIGIN}/CreateOffersHubEnrollment.web.v1`;

  /** Endpoint that reads a card's loyalty benefit trackers (credits/perks). */
  const READ_BENEFITS_URL =
      `${FUNCTIONS_ORIGIN}/ReadBestLoyaltyBenefitsTrackers.v1`;

  /** `limit` value that asks the benefits endpoint for every tracker. */
  const BENEFIT_LIMIT = 'ALL';

  /** Locale sent with every offers request. */
  const LOCALE = 'en-US';

  /** Only these offer types are shown; matches the web app's default filter. */
  const OFFER_TYPE = 'MERCHANT';

  /** Highest offers-hub page index to walk before giving up. */
  const MAX_PAGES = 20;

  /** Minimum and maximum delay (ms) between enroll calls. */
  const MIN_DELAY_MS = 1500;
  const MAX_DELAY_MS = 4000;

  /**
   * Max automatic re-sends after a transient enroll failure (network error or
   * 5xx). Retries are fast on purpose: if the same offer just succeeded on a
   * sibling card, a slow retry could fall outside the window in which Amex
   * still accepts the offer on this card.
   */
  const MAX_ENROLL_RETRIES = 2;

  /** Minimum and maximum delay (ms) before re-sending a transient failure. */
  const RETRY_MIN_MS = 300;
  const RETRY_MAX_MS = 600;

  /**
   * Delay (ms) before re-reading added-to-card lists to verify a run. Enrolls
   * take a moment to become visible on the added list; reading too early
   * misclassifies real successes as GHOST.
   */
  const VERIFY_SETTLE_MS = 2500;

  /**
   * `requestType` values understood by the offers hub. `OFFERSHUB_LANDING`
   * returns eligible offers; `ADDEDTOCARD_LANDING` returns already-added ones.
   * @enum {string}
   */
  const RequestType = {
    ELIGIBLE: 'OFFERSHUB_LANDING',
    ENROLLED: 'ADDEDTOCARD_LANDING',
  };

  /**
   * Final classification of a single (offer, card) enrollment attempt.
   * @enum {string}
   */
  const ResultState = {
    /** The enroll request errored or did not report success. */
    FAILED: 'failed',
    /** Enroll reported success and the offer was found on re-read. */
    VERIFIED: 'verified',
    /** Enroll reported success but the offer was absent on re-read. */
    GHOST: 'ghost',
    /** Enroll reported success but the re-read could not be performed. */
    UNVERIFIED: 'unverified',
    /** Never submitted: the run stopped early after a blocked request. */
    SKIPPED: 'skipped',
  };

  // ---------------------------------------------------------------------------
  // Pure helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns the key used to group/deduplicate an offer across cards.
   *
   * Prefers the stable `pznAnalyticsId` (shared by the same offer on every
   * card) and falls back to the per-card `offerId` when it is absent. This is
   * NOT the value to enroll with — enroll uses the raw per-card `offerId`.
   *
   * @param {!Object} offer Raw offer object from the offers hub.
   * @return {?string} The group key, or null if the offer has neither id.
   */
  function offerGroupKey(offer) {
    const id = offer.pznAnalyticsId || offer.offerId;
    return id ? String(id) : null;
  }

  /**
   * Safely reads a dotted path out of a nested object.
   *
   * @param {?Object} obj Object to read from.
   * @param {string} path Dot-separated path, e.g. `'a.b.c'`.
   * @return {*} The value at `path`, or undefined if any segment is missing.
   */
  function getPath(obj, path) {
    return path.split('.').reduce(
      (value, key) => (value == null ? value : value[key]), obj);
  }

  /**
   * Builds an offer-centric index from a per-card snapshot.
   *
   * Offers that appear on more than one card are merged into a single group
   * keyed by {@link offerGroupKey}. Each group keeps, per card, that card's own
   * `offerId` (needed to enroll) and whether the card already has the offer.
   *
   * @param {!Array<!CardSnapshot>} cards Per-card snapshot.
   * @return {!Array<!OfferGroup>} Grouped offers, most widely eligible first.
   */
  function buildOfferIndex(cards) {
    /** @type {!Map<string, !OfferGroup>} */
    const byKey = new Map();
    for (const card of cards) {
      // Include both eligible and already-added offers so the panel can show
      // offers a card already has, deduping within the card by group key.
      const seen = new Set();
      for (const offer of [...card.eligible, ...(card.enrolled || [])]) {
        const key = offerGroupKey(offer);
        if (!key || !offer.offerId || seen.has(key)) continue;
        seen.add(key);
        let group = byKey.get(key);
        if (!group) {
          group = {
            key,
            name: offer.title || offer.name || key,
            description: offer.shortDescription || '',
            image: offer.image || '',
            expiry: getPath(offer, 'expiration.text') || '',
            cards: [],
          };
          byKey.set(key, group);
        }
        group.cards.push({
          token: card.token,
          offerId: String(offer.offerId),
          enrolled: card.enrolledKeys.has(key),
        });
      }
    }
    const addable = (g) => g.cards.filter((c) => !c.enrolled).length;
    return [...byKey.values()].sort((a, b) => {
      // Fully-added offers sink to the bottom; otherwise most-eligible first.
      const aDone = addable(a) === 0;
      const bDone = addable(b) === 0;
      if (aDone !== bDone) return aDone ? 1 : -1;
      return b.cards.length - a.cards.length;
    });
  }

  /**
   * Cards in a group that can still receive the offer (not already added).
   * @param {!OfferGroup} group Offer group.
   * @return {!Array<{token: string, offerId: string, enrolled: boolean}>} The
   *     addable cards.
   */
  function addableCards(group) {
    return group.cards.filter((card) => !card.enrolled);
  }

  /**
   * Classifies enrollment attempts using a re-read of each card's added
   * offers. Pure: does no I/O.
   *
   * @param {!Array<!Object>} attempts Attempts tagged with `reportedOk`.
   * @param {!Map<string, !Set<string>>} enrolledByToken Added-offer group keys
   *     per card token, read after enrolling. A token absent from the map means
   *     its re-read failed (its reported-ok attempts are then UNVERIFIED).
   * @return {!Array<!EnrollResult>} One result per attempt with a final state.
   */
  function classifyAttempts(attempts, enrolledByToken) {
    return attempts.map((attempt) => {
      let state;
      if (attempt.skipped) {
        state = ResultState.SKIPPED;
      } else if (!attempt.reportedOk) {
        state = ResultState.FAILED;
      } else if (!enrolledByToken.has(attempt.token)) {
        state = ResultState.UNVERIFIED;
      } else if (enrolledByToken.get(attempt.token).has(attempt.key)) {
        state = ResultState.VERIFIED;
      } else {
        state = ResultState.GHOST;
      }
      return {
        key: attempt.key,
        name: attempt.name,
        token: attempt.token,
        offerId: attempt.offerId,
        state,
        httpStatus: attempt.httpStatus || 0,
        blocked: !!attempt.blocked,
        message: attempt.message || '',
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Network layer (uses the logged-in session; talks only to Amex)
  // ---------------------------------------------------------------------------

  /**
   * Performs a JSON request with the logged-in session and returns the parsed
   * body. Throws a classified error on failure, tagged with:
   * - `httpStatus`: the HTTP status (0 for network-level failures).
   * - `transient`: worth an automatic quick retry (network error or 5xx).
   * - `blocked`: the session is being throttled or intercepted (429, 401/403,
   *   or a non-JSON body such as an interstitial page) — the caller should
   *   stop sending further requests rather than push through.
   *
   * @param {string} url Request URL.
   * @param {!Object} options `fetch` options (method/headers/body).
   * @return {!Promise<!Object>} Parsed JSON response.
   */
  async function requestJson(url, options) {
    let response;
    try {
      response = await fetch(url, options);
    } catch (cause) {
      throw Object.assign(new Error(`network error: ${cause.message}`),
        {httpStatus: 0, transient: true, blocked: false});
    }
    if (!response.ok) {
      const status = response.status;
      throw Object.assign(new Error(`HTTP ${status}`), {
        httpStatus: status,
        transient: status >= 500,
        blocked: status === 429 || status === 403 || status === 401,
      });
    }
    try {
      return await response.json();
    } catch {
      // A 2xx that isn't JSON is an interstitial (login / challenge) page.
      throw Object.assign(
        new Error('non-JSON response (blocked or logged out?)'),
        {httpStatus: response.status, transient: false, blocked: true});
    }
  }

  /**
   * Issues a GET carrying the session cookies.
   * @param {string} url Request URL.
   * @return {!Promise<!Object>} Parsed JSON response.
   */
  function getJson(url) {
    return requestJson(url, {
      credentials: 'include',
      headers: {'Accept': 'application/json'},
    });
  }

  /**
   * Issues a POST carrying the session cookies. `Origin` is intentionally not
   * set — the browser adds it automatically on cross-origin requests.
   * @param {string} url Request URL.
   * @param {!Object} body JSON-serializable request body.
   * @return {!Promise<!Object>} Parsed JSON response.
   */
  function postJson(url, body) {
    return requestJson(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  /**
   * Reads one page of the offers hub for a card.
   *
   * @param {string} token The card's `account_token`.
   * @param {RequestType} requestType Which list to read.
   * @param {string=} page Page name such as `'page1'`; omit for the default
   *     (non-paginated) read.
   * @return {!Promise<!Object>} Parsed offers-hub response.
   */
  function readOffersHub(token, requestType, page) {
    const body = {accountNumberProxy: token, locale: LOCALE, requestType};
    if (page) body.offerPage = page;
    return postJson(READ_OFFERS_URL, body);
  }

  /**
   * Lists the logged-in member's card accounts.
   * @return {!Promise<!Array<!Object>>} Raw account objects.
   */
  async function fetchAccounts() {
    const data = await getJson(MEMBER_URL);
    return Array.isArray(data.accounts) ? data.accounts : [];
  }

  /**
   * Flattens the member's accounts into one entry per enrollable card,
   * including supplementary / authorized-user cards nested under
   * `supplementary_accounts[].account`. Supplementary cards inherit the parent
   * card's product for display. Cards without an `account_token` are skipped.
   *
   * @param {!Array<!Object>} accounts Raw account objects from the member API.
   * @return {!Array<!Object>} One account-like object per card, each with an
   *     `account_token`.
   */
  function flattenAccounts(accounts) {
    const cards = [];
    for (const account of accounts) {
      if (account.account_token) cards.push(account);
      for (const supp of account.supplementary_accounts || []) {
        const sub = supp && supp.account;
        if (sub && sub.account_token) {
          cards.push({...sub, product: sub.product || account.product});
        }
      }
    }
    return cards;
  }

  /**
   * Fetches every eligible MERCHANT offer for a card, walking pages until an
   * empty page is returned.
   *
   * @param {string} token The card's `account_token`.
   * @return {!Promise<!Array<!Object>>} Raw eligible offers.
   */
  async function fetchEligibleOffers(token) {
    const offers = [];
    for (let i = 1; i <= MAX_PAGES; i++) {
      const page = `page${i}`;
      const data = await readOffersHub(token, RequestType.ELIGIBLE, page);
      const items = getPath(data, `recommendedOffers.offersList.${page}`);
      if (!Array.isArray(items) || items.length === 0) break;
      for (const offer of items) {
        if (offer.offerType === OFFER_TYPE) offers.push(offer);
      }
    }
    return offers;
  }

  /**
   * Fetches the offers already added to a card (single page).
   *
   * @param {string} token The card's `account_token`.
   * @return {!Promise<!Array<!Object>>} Raw added-to-card offers.
   */
  async function fetchEnrolledOffers(token) {
    const data = await readOffersHub(token, RequestType.ENROLLED);
    const items = getPath(data, 'addedToCardViewAll.offersList.page1');
    return Array.isArray(items) ? items : [];
  }

  /**
   * Reads a card's added offers and returns their group keys as a set.
   * @param {string} token The card's `account_token`.
   * @return {!Promise<!Set<string>>} Added-offer group keys.
   */
  async function fetchEnrolledKeys(token) {
    const offers = await fetchEnrolledOffers(token);
    return new Set(offers.map(offerGroupKey).filter(Boolean));
  }

  /**
   * Enrolls a single offer onto a single card.
   *
   * @param {string} token The card's `account_token`.
   * @param {string} offerId The card's own opaque `offerId` (NOT the group
   *     key).
   * @return {!Promise<!Object>} Parsed enroll response.
   */
  function enrollOffer(token, offerId) {
    return postJson(ENROLL_URL, {
      accountNumberProxy: token,
      offerId,
      locale: LOCALE,
      enrollmentTrigger: 'OFFERSHUB_TILE',
      requestType: 'OFFERSHUB_ENROLLMENT',
      synchronizeOnly: false,
      offerUnencrypted: false,
    });
  }

  /**
   * Whether an enroll response reports success.
   * @param {!Object} response Parsed enroll response.
   * @return {boolean} True if the server reported success.
   */
  function isEnrollSuccess(response) {
    return String(getPath(response, 'status.purpose') || '').toUpperCase() ===
        'SUCCESS';
  }

  // ---------------------------------------------------------------------------
  // Snapshot + execution
  // ---------------------------------------------------------------------------

  /**
   * Builds a human label for a card from the best fields available, falling
   * back to the last 4 of the account token.
   * @param {!Object} account Raw account object.
   * @param {string} token The card's `account_token`.
   * @return {string} Display label.
   */
  function cardName(account, token) {
    const product =
        getPath(account, 'product.description') ||
        getPath(account, 'product.product_description') ||
        getPath(account, 'profile.embossed_name') || '';
    const digits = cardDisplayDigits(account);
    const suffix = digits ? `••${digits}` : `…${String(token).slice(-4)}`;
    return `${product} ${suffix}`.trim();
  }

  /**
   * Finds a card's display digits (last 4-5) from whatever member field holds
   * them, tolerating masking characters.
   * @param {!Object} account Raw account object.
   * @return {string} Last 4-5 digits, or '' if none found.
   */
  function cardDisplayDigits(account) {
    const candidates = [
      // Amex nests the display number under an inner `account` object.
      getPath(account, 'account.display_account_number'),
      getPath(account, 'account.account_number'),
      account.display_account_number,
      account.account_number,
      account.display_number,
      account.card_number,
    ];
    for (const value of candidates) {
      if (value) {
        const digits = String(value).replace(/\D/g, '');
        if (digits) return digits.slice(-5);
      }
    }
    return '';
  }

  /**
   * Builds a compact card label (product family + last digits) for tabs and
   * chips, e.g. `Platinum ···31004`.
   * @param {!Object} account Raw account object.
   * @param {string} token The card's `account_token`.
   * @return {string} Compact display label.
   */
  function cardShortName(account, token) {
    const base = cardFamily(account, token);
    const digits = cardDisplayDigits(account);
    return digits ? `${base} ···${digits}` : base;
  }

  /**
   * The card's product family alone (no digits), e.g. `Platinum`,
   * `Blue Cash Preferred`. Falls back to `…1234` when the product is unknown.
   * @param {!Object} account Raw account object.
   * @param {string} token The card's `account_token`.
   * @return {string} Product family label.
   */
  function cardFamily(account, token) {
    const product = getPath(account, 'product.description') ||
        getPath(account, 'profile.embossed_name') || '';
    const family = product.replace(/\s*Card\b/gi, '').replace(/[®™]/g, '').trim();
    return family || `…${String(token).slice(-4)}`;
  }

  /**
   * Reads all cards and their eligible offers plus already-added group keys.
   *
   * The account list is fetched first so the real card count is known before
   * any card is read; `onProgress` then fires once per card (starting at 0)
   * with the running total, letting the loading UI show honest progress.
   *
   * @param {function(number, number)=} onProgress Called `(done, total)` as
   *     each card finishes reading. Defaults to a no-op.
   * @return {!Promise<!Array<!CardSnapshot>>} Per-card snapshot.
   */
  async function snapshot(onProgress = () => {}) {
    const accounts = flattenAccounts(await fetchAccounts())
      .filter((account) => account.account_token);
    const total = accounts.length;
    onProgress(0, total);
    const cards = [];
    for (const account of accounts) {
      const token = account.account_token;
      const eligible = await fetchEligibleOffers(token);
      const enrolled = await fetchEnrolledOffers(token);
      const enrolledKeys =
          new Set(enrolled.map(offerGroupKey).filter(Boolean));
      cards.push({
        token,
        tag: String(token).slice(-4),
        name: cardName(account, token),
        shortName: cardShortName(account, token),
        family: cardFamily(account, token),
        digits: cardDisplayDigits(account) || String(token).slice(-4),
        relationship: account.relationship || 'BASIC',
        art: getPath(account, 'product.small_card_art') || '',
        eligible,
        enrolled,
        enrolledKeys,
      });
      onProgress(cards.length, total);
    }
    return cards;
  }

  // ---------------------------------------------------------------------------
  // Benefits (loyalty benefit trackers): read each card's credits/perks and
  // aggregate them across cards. Read-only — no write endpoint exists here.
  // ---------------------------------------------------------------------------

  /**
   * Published annual fees (USD) by product family, used only to show the
   * "annual-fee payback" stat. Not available from any API, so this is a small
   * static table; a family not listed contributes 0 (the stat degrades
   * gracefully). Matched by exact family first, then substring.
   * @const {!Object<string, number>}
   */
  const ANNUAL_FEES = {
    'Platinum': 695,
    'Business Platinum': 695,
    'Gold': 325,
    'Business Gold': 375,
    'Green': 150,
    'Blue Cash Preferred': 95,
    'Delta SkyMiles Gold': 150,
    'Delta SkyMiles Platinum': 350,
    'Delta SkyMiles Reserve': 650,
    'Hilton Honors Surpass': 150,
    'Hilton Honors Aspire': 550,
    'Marriott Bonvoy Brilliant': 650,
  };

  /**
   * Rounds a currency amount to whole cents (kills float drift from summing).
   * @param {number} n Amount.
   * @return {number} Amount rounded to two decimals.
   */
  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  /**
   * Looks up a card's published annual fee.
   * @param {string} family Product family (e.g. `Platinum`).
   * @return {number} Annual fee in USD, or 0 when unknown.
   */
  function annualFeeFor(family) {
    if (!family) return 0;
    if (ANNUAL_FEES[family] != null) return ANNUAL_FEES[family];
    const hit = Object.keys(ANNUAL_FEES).find((k) => family.includes(k));
    return hit ? ANNUAL_FEES[hit] : 0;
  }

  /**
   * Reads one card's benefit trackers. The endpoint takes an array with a
   * single request object and returns an array of `{trackers: [...]}` blocks.
   * @param {string} token The card's `account_token`.
   * @return {!Promise<!Array<!Object>>} Raw tracker objects for the card.
   */
  async function fetchAccountBenefits(token) {
    const data = await postJson(READ_BENEFITS_URL,
      [{accountToken: token, locale: LOCALE, limit: BENEFIT_LIMIT}]);
    const blocks = Array.isArray(data) ? data : [];
    return blocks.flatMap((block) => block.trackers || []);
  }

  /**
   * Whole days from `now` until an ISO date string (negative once past).
   * @param {string} dateStr A date the endpoint returns (`periodEndDate`).
   * @param {number=} now Epoch ms treated as "today"; defaults to real time.
   * @return {number} Days remaining, or `Infinity` when the date is unparsable.
   */
  function daysUntil(dateStr, now = Date.now()) {
    const end = Date.parse(dateStr);
    if (Number.isNaN(end)) return Infinity;
    return Math.ceil((end - now) / 86400000);
  }

  /**
   * A human period label for a tracker, from its reset cadence. Uses the span
   * between period dates (robust to unknown `trackerDuration` enum values),
   * falling back to the raw duration string.
   * @param {!Object} tracker Raw tracker object.
   * @return {string} One of `月` / `季` / `半年` / `年`, or `''`.
   */
  function benefitPeriodLabel(tracker) {
    const start = Date.parse(tracker.periodStartDate);
    const end = Date.parse(tracker.periodEndDate);
    if (!Number.isNaN(start) && !Number.isNaN(end)) {
      const days = Math.round((end - start) / 86400000);
      if (days <= 45) return '月';
      if (days <= 135) return '季';
      if (days <= 250) return '半年';
      return '年';
    }
    const dur = String(tracker.trackerDuration || '').toUpperCase();
    if (dur.includes('MONTH')) return '月';
    if (dur.includes('QUARTER')) return '季';
    if (dur.includes('SEMI') || dur.includes('HALF')) return '半年';
    if (dur.includes('YEAR') || dur.includes('ANNUAL')) return '年';
    return '';
  }

  /**
   * Normalizes a raw tracker into our benefit shape, tagged with its card.
   * @param {!Object} tracker Raw tracker object.
   * @param {!Object} card A snapshot card (`token`, `family`, `digits`, `art`).
   * @return {!Object} Normalized benefit.
   */
  function normalizeBenefit(tracker, card) {
    const tr = tracker.tracker || {};
    const target = round2(parseFloat(tr.targetAmount) || 0);
    const spent = round2(parseFloat(tr.spentAmount) || 0);
    const remaining = tr.remainingAmount != null ?
      round2(parseFloat(tr.remainingAmount) || 0) :
      round2(Math.max(0, target - spent));
    return {
      sorBenefitId: tracker.sorBenefitId || tracker.benefitId || '',
      benefitId: tracker.benefitId || '',
      name: tracker.benefitName || '',
      category: tracker.category || '',
      status: tracker.status || '',
      period: benefitPeriodLabel(tracker),
      periodEnd: tracker.periodEndDate || '',
      symbol: tr.targetCurrencySymbol || '$',
      target,
      spent,
      remaining,
      token: card.token,
      family: card.family,
      digits: card.digits,
      art: card.art,
    };
  }

  /**
   * Reads benefits for every BASIC (owned, non-supplementary) card and returns
   * one flat, card-tagged list. `onProgress(done, total)` fires per card.
   * @param {!Array<!Object>} cards Snapshot cards.
   * @param {function(number, number)=} onProgress Progress callback.
   * @return {!Promise<!Array<!Object>>} Card-tagged benefits.
   */
  async function fetchAllBenefits(cards, onProgress = () => {}) {
    const owned = cards.filter((c) => (c.relationship || 'BASIC') === 'BASIC');
    const total = owned.length;
    onProgress(0, total);
    const out = [];
    let done = 0;
    for (const card of owned) {
      const trackers = await fetchAccountBenefits(card.token);
      for (const tracker of trackers) out.push(normalizeBenefit(tracker, card));
      onProgress(++done, total);
    }
    return out;
  }

  /**
   * Finalizes a benefit group: sums amounts across its cards, picks the
   * soonest period end, and flags multi-card / fully-used.
   * @param {!Object} group Partial group with `entries`.
   * @param {number} now Epoch ms treated as "today".
   * @return {!Object} Finalized group.
   */
  function finalizeBenefitGroup(group, now) {
    const spent = round2(group.entries.reduce((s, e) => s + e.spent, 0));
    const target = round2(group.entries.reduce((s, e) => s + e.target, 0));
    const ends = group.entries.map((e) => e.periodEnd).filter(Boolean).sort();
    const periodEnd = ends[0] || '';
    return {
      ...group,
      spent,
      target,
      remaining: round2(Math.max(0, target - spent)),
      periodEnd,
      daysLeft: daysUntil(periodEnd, now),
      multiCard: group.entries.length > 1,
      fullyUsed: target > 0 && spent >= target,
      symbol: group.entries[0] ? group.entries[0].symbol : '$',
    };
  }

  /**
   * Groups card-tagged benefits across cards by `sorBenefitId` (the stable
   * cross-card id) and sorts by soonest expiry first.
   * @param {!Array<!Object>} benefits Card-tagged benefits.
   * @param {number=} now Epoch ms treated as "today".
   * @return {!Array<!Object>} Grouped benefits, soonest-to-expire first.
   */
  function buildBenefitIndex(benefits, now = Date.now()) {
    const byKey = new Map();
    for (const b of benefits) {
      const key = b.sorBenefitId || `${b.token}:${b.benefitId}`;
      let group = byKey.get(key);
      if (!group) {
        group = {key, name: b.name, category: b.category, period: b.period,
          status: b.status, entries: []};
        byKey.set(key, group);
      }
      group.entries.push(b);
    }
    return [...byKey.values()]
      .map((group) => finalizeBenefitGroup(group, now))
      .sort((a, b) => a.daysLeft - b.daysLeft);
  }

  /**
   * Computes the benefits header stats from grouped benefits.
   * @param {!Array<!Object>} groups Grouped benefits.
   * @param {!Array<!Object>} cards Snapshot cards (for annual-fee lookup).
   * @param {number=} now Epoch ms treated as "today".
   * @return {{thisMonthUnused: number, redeemedYtd: number,
   *           annualFee: number, paybackPct: number}} Stats.
   */
  function benefitStats(groups, cards, now = Date.now()) {
    const nowDate = new Date(now);
    let thisMonthUnused = 0;
    let redeemedYtd = 0;
    for (const g of groups) {
      redeemedYtd += g.spent;
      const end = new Date(g.periodEnd);
      if (!Number.isNaN(end.getTime()) &&
          end.getFullYear() === nowDate.getFullYear() &&
          end.getMonth() === nowDate.getMonth()) {
        thisMonthUnused += g.remaining;
      }
    }
    const owned = cards.filter((c) => (c.relationship || 'BASIC') === 'BASIC');
    const annualFee = owned.reduce((s, c) => s + annualFeeFor(c.family), 0);
    const paybackPct =
        annualFee > 0 ? Math.round(redeemedYtd / annualFee * 100) : 0;
    return {
      thisMonthUnused: round2(thisMonthUnused),
      redeemedYtd: round2(redeemedYtd),
      annualFee,
      paybackPct,
    };
  }

  /**
   * Sleeps for a random duration within `[min, max]` ms.
   * @param {number} min Minimum delay.
   * @param {number} max Maximum delay.
   * @return {!Promise<void>} Resolves after the delay.
   */
  function sleepBetween(min, max) {
    const ms = min + Math.random() * (max - min);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Default pacing between offer groups. Kept as a default so callers (tests)
   * can inject a no-op.
   * @return {!Promise<void>} Resolves after the delay.
   */
  function randomDelay() {
    return sleepBetween(MIN_DELAY_MS, MAX_DELAY_MS);
  }

  /** @return {!Promise<void>} Short pause before re-sending a failure. */
  function randomRetryDelay() {
    return sleepBetween(RETRY_MIN_MS, RETRY_MAX_MS);
  }

  /** @return {!Promise<void>} Pause for the server to settle before verify. */
  function verifySettleDelay() {
    return sleepBetween(VERIFY_SETTLE_MS, VERIFY_SETTLE_MS);
  }

  /**
   * Enrolls one task, never throwing; returns a tagged attempt.
   *
   * Transient failures (network error, 5xx) are re-sent quickly up to
   * {@link MAX_ENROLL_RETRIES} times so a hiccup does not permanently lose a
   * card that is still inside the enrollment window. Definitive server answers
   * — a 2xx business rejection, or a blocked signal (429/401/403/non-JSON) —
   * are never re-sent.
   *
   * @param {!Task} task The (offer, card) work item.
   * @param {function(): !Promise<void>=} retryDelay Pause between re-sends.
   * @return {!Promise<!Object>} Attempt tagged with `reportedOk`, `message`,
   *     and on failure `httpStatus` and `blocked`.
   */
  async function attemptEnroll(task, retryDelay = randomRetryDelay) {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await enrollOffer(task.token, task.offerId);
        return {
          ...task,
          reportedOk: isEnrollSuccess(response),
          message: getPath(response, 'status.message') || '',
        };
      } catch (error) {
        if (error.transient && attempt < MAX_ENROLL_RETRIES) {
          await retryDelay();
          continue;
        }
        return {...task, reportedOk: false,
          httpStatus: error.httpStatus || 0, blocked: !!error.blocked,
          message: error.message || 'request failed'};
      }
    }
  }

  /**
   * Groups tasks by offer group key, preserving first-seen order.
   * @param {!Array<!Task>} tasks Tasks.
   * @return {!Array<!Array<!Task>>} Tasks grouped by offer.
   */
  function groupTasksByOffer(tasks) {
    const byKey = new Map();
    for (const task of tasks) {
      if (!byKey.has(task.key)) byKey.set(task.key, []);
      byKey.get(task.key).push(task);
    }
    return [...byKey.values()];
  }

  /**
   * Reads a card's added-offer keys, retrying once on a transient failure.
   * Reads are idempotent, so one cheap retry converts most would-be UNVERIFIED
   * outcomes into real answers. A blocked signal is not retried.
   *
   * @param {string} token The card's `account_token`.
   * @param {function(): !Promise<void>} retryDelay Pause before the retry.
   * @return {!Promise<?Set<string>>} Added-offer keys, or null if unreadable.
   */
  async function readEnrolledKeysSafe(token, retryDelay) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fetchEnrolledKeys(token);
      } catch (error) {
        if (error.blocked || attempt >= 1) return null;
        await retryDelay();
      }
    }
  }

  /**
   * Enrolls the given (offer, card) tasks, then re-reads the affected cards and
   * classifies each attempt.
   *
   * Each task enrolls with the card's own `offerId`. All cards for the SAME
   * offer are fired concurrently: once one card enrolls an offer, Amex can make
   * it ineligible on the others, so a sequential pass would let only the first
   * card win. Different offers are paced apart by `delay`.
   *
   * A single failure is recorded and does not abort the run — but a blocked
   * signal (429 / interception) does: remaining groups are not submitted (their
   * tasks come back SKIPPED) and the verification re-read is skipped too, so
   * the tool never pushes through a throttle.
   *
   * Verification waits `settleDelay` for the server to settle, then re-reads
   * each card that reported success. Cards whose reported-ok offers are still
   * missing get one more settle + re-read before being classified GHOST, since
   * a fresh enrollment can take a moment to appear on the added list.
   *
   * @param {!Array<!Task>} tasks Flattened (offer, card) work items.
   * @param {{onProgress: (function(number, number)|undefined),
   *          onSettle: (function(!Object)|undefined),
   *          delay: (function(): !Promise<void>|undefined),
   *          retryDelay: (function(): !Promise<void>|undefined),
   *          settleDelay: (function(): !Promise<void>|undefined)}=} options
   *     Behavior overrides. `onSettle` fires with each attempt as its enroll
   *     settles (before verification). `delay` (between offers) defaults to
   *     {@link randomDelay}; `retryDelay` (before re-sends/re-reads) to
   *     {@link randomRetryDelay}; `settleDelay` (before verification reads) to
   *     {@link verifySettleDelay}.
   * @return {!Promise<!Array<!EnrollResult>>} One result per task.
   */
  async function executeSelected(tasks, options = {}) {
    const {
      onProgress = () => {},
      onSettle = () => {},
      delay = randomDelay,
      retryDelay = randomRetryDelay,
      settleDelay = verifySettleDelay,
    } = options;

    const offerGroups = groupTasksByOffer(tasks);
    const attempts = [];
    let done = 0;
    let blocked = false;
    for (let i = 0; i < offerGroups.length; i++) {
      if (blocked) {
        for (const task of offerGroups[i]) {
          const attempt = {...task, reportedOk: false, skipped: true,
            message: 'not submitted: run stopped after a blocked request'};
          attempts.push(attempt);
          onSettle(attempt);
          onProgress(++done, tasks.length);
        }
        continue;
      }
      const settled = await Promise.all(offerGroups[i].map(async (task) => {
        const attempt = await attemptEnroll(task, retryDelay);
        onSettle(attempt);
        onProgress(++done, tasks.length);
        return attempt;
      }));
      attempts.push(...settled);
      if (settled.some((attempt) => attempt.blocked)) blocked = true;
      else if (i < offerGroups.length - 1) await delay();
    }

    const enrolledByToken = new Map();
    if (!blocked) {
      // Only cards that reported a success need a re-read; failed attempts
      // classify as FAILED regardless of what the added list says.
      const okTokens =
          new Set(attempts.filter((a) => a.reportedOk).map((a) => a.token));
      if (okTokens.size) await settleDelay();
      for (const token of okTokens) {
        const keys = await readEnrolledKeysSafe(token, retryDelay);
        if (keys) enrolledByToken.set(token, keys);
      }
      // Second chance for ghost candidates: re-read once more after another
      // settle, merging (an offer seen in either read counts as enrolled).
      const ghostTokens = new Set(attempts
        .filter((a) => a.reportedOk && enrolledByToken.has(a.token) &&
                !enrolledByToken.get(a.token).has(a.key))
        .map((a) => a.token));
      if (ghostTokens.size) {
        await settleDelay();
        for (const token of ghostTokens) {
          const keys = await readEnrolledKeysSafe(token, retryDelay);
          if (keys) {
            const merged = enrolledByToken.get(token);
            for (const key of keys) merged.add(key);
          }
        }
      }
    }
    return classifyAttempts(attempts, enrolledByToken);
  }

  /**
   * Plans a retry of the failed and never-submitted pairs from a prior run
   * against a fresh offer index. Pure: does no I/O.
   *
   * Per-card offerIds can rotate between reads, so re-sending the token stored
   * in an old result can fail for the wrong reason; each pair is re-resolved
   * to the card's current `offerId` by group key instead. The fresh index also
   * settles two cases without a resend:
   * - `landed`: the card now shows the offer as added — the old "failure"
   *   actually made it (e.g. a timed-out enroll that succeeded server-side).
   *   Returned reclassified as VERIFIED.
   * - `gone`: the card no longer lists the offer at all — the enrollment
   *   window is closed and a resend cannot succeed. Returned with the original
   *   state, a note appended to the message, and `gone: true` so callers stop
   *   offering to retry it.
   *
   * @param {!Array<!EnrollResult>} results A prior run's results.
   * @param {!Array<!OfferGroup>} offers The current offer index.
   * @return {{tasks: !Array<!Task>, landed: !Array<!EnrollResult>,
   *           gone: !Array<!EnrollResult>}} Tasks to resend, plus the pairs
   *     settled without resending.
   */
  function planRetry(results, offers) {
    const tasks = [];
    const landed = [];
    const gone = [];
    for (const result of results) {
      const retryable = (result.state === ResultState.FAILED ||
          result.state === ResultState.SKIPPED) && !result.gone;
      if (!retryable) continue;
      const group = offers.find((g) => g.key === result.key);
      const card = group &&
          group.cards.find((c) => c.token === result.token);
      if (card && card.enrolled) {
        landed.push({...result, state: ResultState.VERIFIED,
          message: 'already on the card (found before retrying)'});
      } else if (!card) {
        const note = 'offer no longer listed for this card';
        gone.push({...result, gone: true,
          message: result.message ? `${result.message} · ${note}` : note});
      } else {
        tasks.push({token: result.token, offerId: card.offerId,
          key: result.key, name: result.name});
      }
    }
    return {tasks, landed, gone};
  }

  /** Functions exposed for reuse and unit testing. */
  const api = {
    offerGroupKey,
    getPath,
    cardName,
    cardShortName,
    cardDisplayDigits,
    buildOfferIndex,
    addableCards,
    classifyAttempts,
    fetchAccounts,
    flattenAccounts,
    fetchEligibleOffers,
    fetchEnrolledOffers,
    fetchEnrolledKeys,
    enrollOffer,
    isEnrollSuccess,
    snapshot,
    executeSelected,
    planRetry,
    fetchAccountBenefits,
    fetchAllBenefits,
    buildBenefitIndex,
    benefitStats,
    annualFeeFor,
    benefitPeriodLabel,
    daysUntil,
    RequestType,
    ResultState,
  };

  const isBrowser =
      typeof window !== 'undefined' && typeof document !== 'undefined';

  if (!isBrowser) {
    // Node / test environment: export and stop (no DOM).
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = api;
    }
    return;
  }

  // ---------------------------------------------------------------------------
  // UI (browser only): a self-contained Shadow DOM panel styled after the "2a"
  // design — Amex-official white header, single bright-blue accent, square
  // corners, underline card tabs. It renders our own data built from the API;
  // it never touches Amex's native tiles.
  // ---------------------------------------------------------------------------

  /**
   * Shared UI state.
   * @type {{cards: !Array<!CardSnapshot>, offers: !Array<!OfferGroup>,
   *         selected: !Map<string, !Set<string>>, query: string,
   *         cardFilter: string, multiOnly: boolean,
   *         lastResults: !Map<string, !EnrollResult>, view: string,
   *         run: ?Object, errorMessage: string}}
   */
  const state = {
    cards: [],
    offers: [],
    selected: new Map(),
    query: '',
    cardFilter: 'all',
    multiOnly: false,
    lastResults: new Map(),
    view: 'list',
    run: null,
    errorMessage: '',
    // Which top-level tab is showing: 'offers' or 'benefits'.
    tab: 'offers',
    // Benefits tab state (loaded lazily on first switch).
    benefits: [],
    benefitStats: null,
    benefitsLoaded: false,
    benefitsError: '',
    benefitsRun: null,
    benefitsReadAt: 0,
    benefitsExpanded: new Set(),
    benefitUnusedOnly: true,
    benefitDoneOpen: false,
  };

  /** Panel host + shadow root, created lazily and reused across opens. */
  let panelHost = null;
  let panelRoot = null;
  /** Launcher button; hidden while the panel is open. */
  let launcherButton = null;
  /** Whether the offer snapshot has been loaded at least once. */
  let loaded = false;

  /**
   * Tiny DOM builder. `props`: `class`/`style`/`text` plus `on*` handlers and
   * any attribute; data goes through `text`/children as text nodes (never
   * innerHTML), so merchant/card strings can't inject markup.
   * @param {string} tag Element tag.
   * @param {!Object=} props Properties/attributes.
   * @param {...(Node|string|null)} children Child nodes or text.
   * @return {!Element} The element.
   */
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value == null) continue;
      if (key === 'class') node.className = value;
      else if (key === 'style') node.style.cssText = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node[key.toLowerCase()] = value;
      else node.setAttribute(key, value);
    }
    for (const child of children) {
      if (child == null) continue;
      node.append(child.nodeType ? child : document.createTextNode(child));
    }
    return node;
  }

  /** @param {string} token Card token. @return {?CardSnapshot} The card. */
  function cardOf(token) {
    return state.cards.find((c) => c.token === token) || null;
  }

  /** @param {string} token Card token. @return {string} Compact card label. */
  function cardLabel(token) {
    const card = cardOf(token);
    return card ? card.shortName : `…${String(token).slice(-4)}`;
  }

  /**
   * First 1-2 letters of a merchant name, for the logo fallback.
   * @param {string} name Merchant name.
   * @return {string} Initials.
   */
  function merchantInitials(name) {
    const words = String(name).replace(/[^\p{L}\p{N} ]/gu, '').trim().split(/\s+/);
    const letters = words.slice(0, 2).map((w) => w[0] || '').join('');
    return (letters || String(name).slice(0, 2)).toUpperCase();
  }

  /** @param {!OfferGroup} g Offer group. @return {string} Short expiry, e.g. */
  /**   "至 7/7". */
  function expiryLabel(g) {
    const match = /(\d{1,2})\/(\d{1,2})/.exec(g.expiry || '');
    return match ? `至 ${match[1]}/${match[2]}` : '';
  }

  /** Soft [background, foreground] pairs for the initials-logo fallback. */
  const LOGO_PALETTE = [
    ['#E7F0FA', '#1B62A8'], ['#FBEDE3', '#B4551E'], ['#EDEDF0', '#3A3D42'],
    ['#E9F3EC', '#1B7A44'], ['#F3EAF6', '#7A3E8E'], ['#FDECEC', '#B4283B'],
    ['#FBF3E0', '#8A6D1C'],
  ];

  /**
   * Stable [bg, fg] colors for a merchant, so the logo squares vary like the
   * design when no real logo image is available.
   * @param {string} name Merchant name.
   * @return {!Array<string>} [background, foreground].
   */
  function logoColors(name) {
    let h = 0;
    for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return LOGO_PALETTE[h % LOGO_PALETTE.length];
  }

  /**
   * A card-colored gradient for the swatch when no card-art image is available.
   * @param {string} token Card token.
   * @return {string} A CSS gradient.
   */
  function swatchStyle(token) {
    const family = (cardOf(token)?.shortName || '').toLowerCase();
    const grad = (a, b) => `linear-gradient(135deg,${a},${b})`;
    if (family.includes('platinum')) return grad('#dfe2e6', '#b3b9c1');
    if (family.includes('gold')) return grad('#e9cd85', '#c29a45');
    if (family.includes('blue') || family.includes('cash')) {
      return grad('#3a86c8', '#154e88');
    }
    if (family.includes('green')) return grad('#5aa06e', '#2f6b45');
    return grad('#c9ccd0', '#9aa0a8');
  }

  const PANEL_STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .p {
      --blue: #006FCF; --navy: #00175A; --green: #0B7A3E; --red: #C8102E;
      --amber: #9A6A00; --ink: #26282A; --sub: #55585D; --mut: #7A7D82;
      --fog: #9A9DA2; --line: #E7E8EA; --line2: #EFF0F1; --card: #F2F3F4;
      font: 13px/1.4 'Helvetica Neue', Helvetica, system-ui, sans-serif;
      color: var(--ink); background: #fff; border: 1px solid #d9dbde;
      border-radius: 6px; width: 400px; max-height: 80vh; display: flex;
      flex-direction: column; overflow: hidden;
      box-shadow: 0 8px 30px rgba(0,23,90,.18);
    }
    .hd {
      display: flex; flex-direction: column; background: #fff;
      border-bottom: 2px solid var(--blue); flex: none;
    }
    .hd.err { border-bottom-color: var(--red); }
    .hd.tabbed { border-bottom: 1px solid var(--line); }
    .hrow { display: flex; align-items: center; gap: 11px; padding: 14px 18px; }
    .hd.tabbed .hrow { padding: 14px 18px 12px; }
    .mtabs { display: flex; gap: 22px; padding: 0 18px; font-size: 12.5px; }
    .mtab { color: var(--sub); padding-bottom: 10px; cursor: pointer;
      border-bottom: 2px solid transparent; margin-bottom: -1px; }
    .mtab.on { font-weight: 700; color: var(--navy);
      border-bottom-color: var(--blue); }
    .ic {
      width: 30px; height: 30px; border-radius: 5px; background: var(--blue);
      color: #fff; display: flex; align-items: center; justify-content: center;
      font-size: 17px; font-weight: 600; line-height: 1; flex: none;
    }
    .hd .tt { flex: 1; min-width: 0; }
    .t1 { font-size: 14.5px; font-weight: 800; color: var(--navy);
      letter-spacing: .1px; }
    .t2 { font-size: 10.5px; color: var(--mut); margin-top: 1px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rf {
      width: 28px; height: 28px; border-radius: 50%; border: 1px solid #E3E5E8;
      background: #fff; color: #53565A; font-size: 15px; cursor: pointer;
      display: flex; align-items: center; justify-content: center; flex: none;
    }
    .cl { font-size: 18px; color: #8B8E93; cursor: pointer; line-height: 1;
      background: none; border: none; padding: 0 2px; flex: none; }
    .body { overflow-y: auto; }
    .sr { padding: 12px 18px 0; }
    .sr input {
      width: 100%; border: 1px solid #D5D7DB; border-radius: 4px;
      padding: 8px 12px; font: inherit; color: var(--ink); outline: none;
    }
    .sr input:focus { border-color: var(--blue); }
    .tabwrap { position: relative; }
    /* Fade the right edge so the overflowing card tabs read as scrollable
       without a scrollbar chrome. */
    .tabwrap::after {
      content: ''; position: absolute; top: 0; right: 0; bottom: 1px;
      width: 28px; pointer-events: none;
      background: linear-gradient(90deg, rgba(255, 255, 255, 0), #fff);
    }
    .tabs {
      display: flex; gap: 18px; padding: 12px 18px 0; overflow-x: auto;
      border-bottom: 1px solid var(--line); font-size: 12px;
      scrollbar-width: none; -ms-overflow-style: none;
    }
    .tabs::-webkit-scrollbar { display: none; }
    .tab { padding-bottom: 9px; color: var(--sub); cursor: pointer;
      white-space: nowrap; border-bottom: 2px solid transparent; }
    .tab.on { font-weight: 700; color: var(--navy); border-bottom-color: var(--blue); }
    .tab .n { color: var(--fog); }
    .tb {
      display: flex; align-items: center; padding: 9px 18px; font-size: 11.5px;
      border-bottom: 1px solid var(--line2);
    }
    .tb label { display: flex; align-items: center; gap: 6px; color: var(--sub);
      cursor: pointer; }
    .tb .sp { flex: 1; }
    .tb .ac { display: flex; gap: 14px; font-weight: 600; }
    .tb .ac a { cursor: pointer; }
    .a-blue { color: var(--blue); }
    .a-mut { color: var(--fog); }
    .list { display: flex; flex-direction: column; }
    .row { display: flex; gap: 11px; padding: 13px 18px; align-items: center;
      border-bottom: 1px solid var(--line2); }
    .grp.done { opacity: .5; }
    .grp.exp { box-shadow: inset 2px 0 0 var(--blue); background: #FBFDFF; }
    .grp.exp > .row { border-bottom: none; padding-bottom: 8px; }
    .logo {
      width: 40px; height: 40px; border-radius: 4px; flex: none; overflow: hidden;
      display: flex; align-items: center; justify-content: center;
      font-size: 12px; font-weight: 700; background: #E7F0FA; color: #1B62A8;
    }
    .logo img { width: 100%; height: 100%; object-fit: contain; background: #fff; }
    .mn { flex: 1; min-width: 0; }
    .nm { font-size: 13px; font-weight: 700; color: var(--ink);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ds { font-size: 12px; color: var(--sub); margin-top: 1px; overflow: hidden;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .rt { text-align: right; flex: none; }
    .bd { font-size: 11px; font-weight: 600; white-space: nowrap; cursor: pointer;
      font-variant-numeric: tabular-nums; color: var(--blue); }
    .bd .dot { color: #C9CCD0; }
    .bd .en { color: var(--green); }
    .bd .car { font-size: 9px; margin-left: 2px; }
    .ex { font-size: 10.5px; color: var(--fog); margin-top: 2px;
      font-variant-numeric: tabular-nums; }
    .done-tag { font-size: 11px; color: var(--green); white-space: nowrap; }
    .cards { margin: 0 18px 13px 67px; display: flex; flex-direction: column; }
    .cards .lb { font-size: 10px; font-weight: 700; color: var(--fog);
      letter-spacing: .6px; padding: 4px 0 7px; }
    .ccard { display: flex; align-items: center; gap: 9px; font-size: 12px;
      color: var(--ink); padding: 4px 0; cursor: pointer; }
    .ccard.off { color: #B4B7BB; cursor: default; }
    .sw { width: 28px; height: 18px; border-radius: 2.5px; flex: none;
      overflow: hidden; background: linear-gradient(135deg,#dfe2e6,#b3b9c1); }
    .sw img { width: 100%; height: 100%; object-fit: cover; }
    .ccard .mk { margin-left: auto; font-size: 10.5px; font-weight: 600; }
    .ccard .mk.en { color: var(--green); }
    .ccard .mk.r-failed { color: var(--red); }
    .ccard .mk.r-ghost { color: var(--amber); }
    .ccard .mk.r-unverified { color: var(--mut); }
    .ccard .mk.r-skipped { color: var(--amber); }
    input[type=checkbox] { width: 16px; height: 16px; accent-color: var(--blue);
      flex: none; }
    .ccard input[type=checkbox] { width: 14px; height: 14px; }
    .ft { border-top: 1px solid var(--line); padding: 12px 18px; display: flex;
      align-items: center; gap: 12px; background: #fff; flex: none; }
    .ft .sm { flex: 1; font-size: 12px; color: var(--sub); }
    .ft .sm b { color: var(--ink); }
    .go { background: var(--blue); color: #fff; font-size: 13px; font-weight: 700;
      border: none; border-radius: 4px; padding: 10px 22px; cursor: pointer;
      white-space: nowrap; }
    .go:disabled { opacity: .55; cursor: default; }
    .cnt { display: flex; background: #fff; border-bottom: 1px solid var(--line); }
    .cnt .c { flex: 1; padding: 14px 0; text-align: center; }
    .cnt .c .n { font-size: 21px; font-weight: 800;
      font-variant-numeric: tabular-nums; }
    .cnt .c .l { font-size: 10.5px; color: var(--sub); margin-top: 2px; }
    .cnt .sep { width: 1px; background: var(--line); margin: 12px 0; }
    .g { color: var(--green); } .r { color: var(--red); }
    .b { color: var(--blue); } .am { color: var(--amber); }
    .bar { height: 4px; border-radius: 2px; background: #EDEEF0; overflow: hidden; }
    .bar > div { height: 100%; background: var(--blue); transition: width .2s; }
    .note { font-size: 11px; color: var(--mut); }
    .info { margin: 12px 18px 0; background: #F7F8F9; border: 1px solid #EDEEF0;
      border-radius: 4px; padding: 9px 12px; font-size: 11px; color: var(--sub);
      line-height: 1.55; }
    .info b { color: var(--amber); }
    .sh { font-size: 10px; font-weight: 700; color: var(--fog);
      letter-spacing: .6px; padding: 10px 0 5px; }
    .si { display: flex; justify-content: space-between; gap: 8px; padding: 6px 0;
      border-bottom: 1px solid var(--line2); font-size: 12px; color: var(--ink); }
    .si:last-child { border-bottom: none; }
    .ri { display: flex; align-items: center; gap: 10px; padding: 8px 0;
      border-bottom: 1px solid var(--line2); font-size: 12px; color: var(--ink); }
    .ri .txt { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis; }
    .ri .st { font-size: 11px; font-weight: 600; }
    .spin { width: 16px; height: 16px; border-radius: 50%; flex: none;
      border: 2px solid #D4E8F8; border-top-color: var(--blue);
      animation: dvspin .9s linear infinite; }
    @keyframes dvspin { to { transform: rotate(360deg); } }
    .msg { padding: 34px 24px; text-align: center; }
    .msg .cir { width: 44px; height: 44px; border-radius: 50%; margin: 0 auto 12px;
      display: flex; align-items: center; justify-content: center; font-size: 20px; }
    .msg .cir.ok { background: #E9F5EE; color: var(--green); }
    .msg .cir.bad { background: #FCEDEF; color: var(--red); font-weight: 700; }
    .msg .h { font-size: 13.5px; font-weight: 700; color: var(--ink); }
    .msg .txt { font-size: 12px; color: var(--mut); margin-top: 5px;
      line-height: 1.55; }
    .msg .btn { display: inline-flex; align-items: center; gap: 6px; margin-top: 16px;
      border: 1px solid #D5D7DB; border-radius: 4px; padding: 8px 16px;
      font-size: 12px; font-weight: 600; color: var(--blue); cursor: pointer; }
    .msg .btn.pri { background: var(--blue); color: #fff; border-color: var(--blue); }
    .lnk { font-size: 12px; font-weight: 600; color: var(--blue); cursor: pointer; }
    .lnk.rerun { border: 1px solid var(--red); color: var(--red); border-radius: 4px;
      padding: 8px 16px; font-weight: 700; }
    /* Benefits tab */
    .bstats { display: flex; background: #fff;
      border-bottom: 1px solid var(--line); }
    .bcol { padding: 13px 0; }
    .bcol.l { flex: 1.2; padding-left: 18px; }
    .bcol.m { flex: 1; text-align: center; }
    .bcol.r { flex: 1.2; padding-right: 18px; text-align: right; }
    .bval { font-size: 19px; font-weight: 800;
      font-variant-numeric: tabular-nums; }
    .bval.navy { color: var(--navy); }
    .bval.green { color: var(--green); }
    .bval.ink { color: var(--ink); }
    .blbl { font-size: 10.5px; color: var(--sub); margin-top: 2px; }
    .bsub2 { font-size: 9.5px; color: var(--fog); margin-top: 1px; }
    .vsep { width: 1px; background: var(--line); margin: 12px 0; }
    .btb { display: flex; align-items: center; padding: 9px 18px; background: #fff;
      border-bottom: 1px solid var(--line2); font-size: 11.5px; }
    .btb .sp { flex: 1; }
    .sortlbl { font-weight: 600; color: var(--ink); cursor: pointer; }
    .caret { font-size: 10px; color: var(--fog); }
    .unused { display: flex; align-items: center; gap: 6px; color: var(--sub);
      cursor: pointer; }
    .unused input[type=checkbox] { width: 13px; height: 13px; }
    .blist { display: flex; flex-direction: column; background: #fff; }
    .brow { display: flex; gap: 11px; padding: 12px 18px; align-items: center;
      border-bottom: 1px solid var(--line2); }
    .blogo { width: 40px; height: 40px; border-radius: 4px; flex: none;
      display: flex; align-items: center; justify-content: center;
      font-size: 12px; font-weight: 700; }
    .bmn { flex: 1; min-width: 0; }
    .btitle { display: flex; align-items: baseline; gap: 6px; }
    .bname { font-size: 13px; font-weight: 700; color: var(--ink);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .bp { font-size: 10px; color: var(--fog); border: 1px solid var(--line);
      border-radius: 2px; padding: 0 4px; flex: none; }
    .bx { font-size: 10px; font-weight: 700; color: #005EB0; background: #EAF4FC;
      border-radius: 2px; padding: 0 5px; flex: none; }
    .bcard { font-size: 11px; color: var(--mut); margin-top: 2px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .bbar { height: 3px; border-radius: 1.5px; background: #EDEEF0;
      margin-top: 6px; overflow: hidden; }
    .bbar > div { height: 100%; background: var(--green); }
    .brt { text-align: right; flex: none; }
    .bamt { font-size: 12.5px; font-weight: 700; color: var(--ink);
      font-variant-numeric: tabular-nums; white-space: nowrap; }
    .bamt .of { font-size: 10.5px; font-weight: 400; color: var(--fog); }
    .bdays { font-size: 10.5px; color: var(--fog); margin-top: 2px; }
    .bdays.urgent { font-weight: 700; color: var(--red); }
    .bcaret { font-size: 10px; color: var(--blue); flex: none; }
    .bgrp { border-bottom: 1px solid var(--line2); }
    .bgrp.exp { box-shadow: inset 2px 0 0 var(--blue); background: #FBFDFF; }
    .bgrp > .brow { border-bottom: none; }
    .bgrp.exp > .brow { padding: 12px 18px 8px 16px; }
    .bsub { margin: 0 18px 12px 69px; display: flex; flex-direction: column;
      gap: 8px; }
    .bsubrow { display: flex; align-items: center; gap: 9px; }
    .bsubcard { font-size: 11.5px; color: var(--ink); width: 56px; flex: none; }
    .bbar.grow { flex: 1; margin-top: 0; background: #E4E6E9; }
    .bsubamt { font-size: 11px; color: var(--sub); width: 74px;
      text-align: right; flex: none; font-variant-numeric: tabular-nums; }
    .bsec { display: flex; align-items: center; gap: 8px; padding: 11px 18px;
      background: #FAFBFC; border-bottom: 1px solid var(--line2); cursor: pointer; }
    .bsec .sp { flex: 1; }
    .bsec-t { font-size: 12px; font-weight: 600; color: var(--sub); }
    .bsec-n { font-size: 11px; color: var(--fog); background: #EDEEF0;
      border-radius: 9px; padding: 1px 8px; font-variant-numeric: tabular-nums; }
    .bfoot { border-top: 1px solid var(--line); padding: 10px 18px;
      background: #fff; flex: none; }
  `;

  /**
   * Expands the current selection into flat enroll tasks, resolving each card's
   * own `offerId` and skipping cards that already have the offer.
   * @return {!Array<!Task>} Tasks to run.
   */
  function buildTasks() {
    const tasks = [];
    for (const [key, tokens] of state.selected) {
      const group = state.offers.find((g) => g.key === key);
      if (!group) continue;
      for (const token of tokens) {
        const card = group.cards.find((c) => c.token === token);
        if (card && !card.enrolled) {
          tasks.push({token, offerId: card.offerId, key, name: group.name});
        }
      }
    }
    return tasks;
  }

  /** @return {!Array<!OfferGroup>} Offers matching filters + query. */
  function visibleOffers() {
    const q = state.query;
    return state.offers.filter((g) => {
      if (q && !g.name.toLowerCase().includes(q)) return false;
      if (state.cardFilter !== 'all' &&
          !g.cards.some((c) => c.token === state.cardFilter)) {
        return false;
      }
      if (state.multiOnly && addableCards(g).length < 2) return false;
      return true;
    });
  }

  /** @return {number} Total selected (offer, card) pairs. */
  function selectedCount() {
    let n = 0;
    for (const set of state.selected.values()) n += set.size;
    return n;
  }

  // ---- rendering -----------------------------------------------------------

  /** @param {!OfferGroup} group Group. @return {!DocumentFragment} Row. */
  function renderOfferRow(group) {
    const frag = document.createDocumentFragment();
    const wrap = el('div', {class: 'grp'});
    const addable = addableCards(group);
    const addedCount = group.cards.length - addable.length;
    const fullyAdded = addable.length === 0;

    const logo = el('div', {class: 'logo'});
    if (group.image) {
      logo.append(el('img', {src: group.image, alt: '', loading: 'lazy'}));
    } else {
      const [bg, fg] = logoColors(group.name);
      logo.style.background = bg;
      logo.style.color = fg;
      logo.textContent = merchantInitials(group.name);
    }

    const pick = el('input', {type: 'checkbox'});
    pick.disabled = fullyAdded;
    pick.checked = (state.selected.get(group.key)?.size || 0) > 0;

    const main = el('div', {class: 'mn'},
      el('div', {class: 'nm', text: group.name}),
      group.description ? el('div', {class: 'ds', text: group.description}) :
        null);

    const box = el('div', {class: 'cards'});
    box.style.display = 'none';

    const rt = el('div', {class: 'rt'});
    if (fullyAdded) {
      rt.append(el('div', {class: 'done-tag',
        text: `${group.cards.length} 张卡都已加`}));
    } else {
      const badge = el('div', {class: 'bd'});
      if (addedCount) {
        badge.append(
          el('span', {text: `可加 ${addable.length} 张`}),
          el('span', {class: 'dot', text: ' · '}),
          el('span', {class: 'en', text: `已加 ${addedCount} 张`}),
          el('span', {class: 'car', text: ' ▾'}));
      } else {
        badge.append(el('span', {text: `可加 ${addable.length} 张`}),
          el('span', {class: 'car', text: ' ▾'}));
      }
      badge.onclick = () => toggleExpand(wrap, box, badge, group);
      rt.append(badge);
    }
    const exp = expiryLabel(group);
    if (exp) rt.append(el('div', {class: 'ex', text: exp}));

    const runStates = group.cards
      .map((c) => state.lastResults.get(`${group.key}|${c.token}`))
      .filter(Boolean).map((res) => res.state);
    if (runStates.length) rt.prepend(renderRunBadge(runStates));

    pick.onchange = () => {
      if (pick.checked) {
        state.selected.set(group.key, new Set(addable.map((c) => c.token)));
      } else {
        state.selected.delete(group.key);
      }
      if (box.style.display !== 'none') renderCardBox(box, group, pick);
      refreshFooter();
    };

    if (fullyAdded) wrap.classList.add('done');
    wrap.append(el('div', {class: 'row'}, pick, logo, main, rt), box);
    frag.append(wrap);
    return frag;
  }

  /**
   * @param {!Array<string>} states Result states for a group.
   * @return {!Element} The per-offer outcome badge.
   */
  function renderRunBadge(states) {
    const n = (s) => states.filter((x) => x === s).length;
    const badge = el('div', {class: 'bd', style: 'cursor:default'});
    badge.append(el('span', {class: 'en', text: `✓${n(ResultState.VERIFIED)}`}),
      el('span', {class: 'dot', text: ' '}),
      el('span', {class: 'am', text: `⚠${n(ResultState.GHOST)}`}),
      el('span', {class: 'dot', text: ' '}),
      el('span', {class: 'r', text: `✗${n(ResultState.FAILED)}`}));
    return badge;
  }

  /**
   * Toggles the per-card list under an offer row.
   * @param {!Element} wrap Group wrapper. @param {!Element} box Card box.
   * @param {!Element} badge Badge (for the caret). @param {!OfferGroup} group
   *     Offer group.
   */
  function toggleExpand(wrap, box, badge, group) {
    const open = box.style.display === 'none';
    box.style.display = open ? 'flex' : 'none';
    wrap.classList.toggle('exp', open);
    const caret = badge.querySelector('.car');
    if (caret) caret.textContent = open ? ' ▴' : ' ▾';
    if (open) renderCardBox(box, group, wrap.querySelector('.row input'));
  }

  /**
   * Renders the per-card checkboxes for an expanded offer.
   * @param {!Element} box Card box. @param {!OfferGroup} group Offer group.
   * @param {!Element} pick The offer-row checkbox (kept in sync).
   */
  function renderCardBox(box, group, pick) {
    box.textContent = '';
    box.append(el('div', {class: 'lb', text: '选择要加到哪些卡'}));
    const chosen = state.selected.get(group.key) || new Set();
    for (const card of group.cards) {
      const result = state.lastResults.get(`${group.key}|${card.token}`);
      const cb = el('input', {type: 'checkbox'});
      cb.checked = chosen.has(card.token);
      cb.disabled = card.enrolled;
      const sw = el('span', {class: 'sw'});
      const cardData = cardOf(card.token);
      if (cardData?.art) sw.append(el('img', {src: cardData.art, alt: ''}));
      else sw.style.background = swatchStyle(card.token);
      const label = el('label', {class: card.enrolled ? 'ccard off' : 'ccard'},
        cb, sw, cardLabel(card.token));
      if (card.enrolled) {
        label.append(el('span', {class: 'mk en', text: '已加 ✓'}));
      } else if (result) {
        const mk = {[ResultState.FAILED]: '✗', [ResultState.GHOST]: '⚠',
          [ResultState.UNVERIFIED]: '?', [ResultState.VERIFIED]: '✓',
          [ResultState.SKIPPED]: '⊘'};
        label.append(el('span', {class: `mk r-${result.state}`,
          text: mk[result.state] || ''}));
      }
      cb.onchange = () => {
        const set = state.selected.get(group.key) || new Set();
        if (cb.checked) set.add(card.token); else set.delete(card.token);
        if (set.size) state.selected.set(group.key, set);
        else state.selected.delete(group.key);
        pick.checked = (state.selected.get(group.key)?.size || 0) > 0;
        refreshFooter();
      };
      box.append(label);
    }
  }

  /**
   * The header refresh control's glyph: a clean stroked "reload" icon that
   * inherits the button's text color via `currentColor`.
   * @const {string}
   */
  const REFRESH_SVG =
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2.4" stroke-linecap="round" ' +
      'stroke-linejoin="round" style="display:block">' +
      '<path d="M21 12a9 9 0 1 1-2.64-6.36"></path>' +
      '<polyline points="21 3 21 9 15 9"></polyline></svg>';

  /**
   * Builds the header row.
   * @param {{glyph: (string|Node), title: string, subtitle: string,
   *          refresh: (boolean|undefined), close: (boolean|undefined),
   *          err: (boolean|undefined), right: (Node|undefined)}} opts Header
   *     options.
   * @return {!Element} The header element.
   */
  function renderHeader(opts) {
    let cls = 'hd';
    if (opts.err) cls += ' err';
    if (opts.tabs) cls += ' tabbed';
    const hd = el('div', {class: cls});
    const row = el('div', {class: 'hrow'});
    row.append(el('div', {class: 'ic'}, opts.glyph));
    row.append(el('div', {class: 'tt'},
      el('div', {class: 't1', text: opts.title}),
      opts.subtitle ? el('div', {class: 't2', text: opts.subtitle}) : null));
    if (opts.right) row.append(opts.right);
    if (opts.refresh) {
      const rf = el('button', {class: 'rf', title: '刷新',
        onclick: opts.onRefresh || (() => refresh())});
      // Static author-controlled markup (no interpolation): safe to inline.
      rf.innerHTML = REFRESH_SVG;
      row.append(rf);
    }
    if (opts.close) {
      row.append(el('button', {class: 'cl', title: '关闭', text: '×',
        onclick: () => hidePanel()}));
    }
    hd.append(row);
    if (opts.tabs) hd.append(renderMainTabs());
    return hd;
  }

  /** @return {!Element} The Offers | Benefits tab row. */
  function renderMainTabs() {
    const mk = (key, label) => {
      const tab = el('div',
        {class: state.tab === key ? 'mtab on' : 'mtab', text: label});
      tab.onclick = () => switchTab(key);
      return tab;
    };
    return el('div', {class: 'mtabs'},
      mk('offers', 'Offers'), mk('benefits', 'Benefits'));
  }

  /**
   * Switches the top-level tab, lazily loading benefits the first time.
   * @param {string} tab `'offers'` or `'benefits'`.
   */
  function switchTab(tab) {
    if (state.tab === tab) return;
    state.tab = tab;
    if (tab === 'benefits' && !state.benefitsLoaded && !state.benefitsError) {
      loadBenefits();
      return;
    }
    render();
  }

  /** Rebuilds the whole panel for the current `state.view`. */
  function render() {
    if (!panelRoot) return;
    const root = panelRoot;
    root.getElementById('shell').textContent = '';
    const shell = root.getElementById('shell');
    if (state.tab === 'benefits') {
      renderBenefitsTab(shell);
      return;
    }
    const views = {list: renderListView, loading: renderLoadingView,
      running: renderRunningView, result: renderResultView,
      empty: renderEmptyView, error: renderErrorView};
    (views[state.view] || renderListView)(shell);
  }

  /**
   * Reads benefits for every card and builds the aggregated view. Cached so
   * re-opening the tab is instant; `force` re-reads from Amex.
   * @param {boolean=} force Re-read even if already loaded.
   * @return {!Promise<void>} Resolves when rendered.
   */
  async function loadBenefits(force = false) {
    if (state.benefitsLoaded && !force) {
      render();
      return;
    }
    state.benefitsError = '';
    state.benefitsLoaded = false;
    const owned = state.cards.filter(
      (c) => (c.relationship || 'BASIC') === 'BASIC');
    state.benefitsRun = {done: 0, total: owned.length};
    render();
    try {
      const benefits = await fetchAllBenefits(state.cards, (done, total) => {
        state.benefitsRun = {done, total};
        if (state.tab === 'benefits' && !state.benefitsLoaded) render();
      });
      state.benefits = buildBenefitIndex(benefits);
      state.benefitStats = benefitStats(state.benefits, state.cards);
      state.benefitsReadAt = Date.now();
      state.benefitsLoaded = true;
    } catch (error) {
      state.benefitsError = error.message || '读取失败';
    }
    render();
  }

  /**
   * A short relative-time label, e.g. `刚刚` / `3 分钟前`.
   * @param {number} ts Epoch ms.
   * @return {string} Relative label.
   */
  function agoLabel(ts) {
    if (!ts) return '';
    const mins = Math.floor((Date.now() - ts) / 60000);
    if (mins < 1) return '刚刚读取';
    if (mins < 60) return `${mins} 分钟前读取`;
    return `${Math.floor(mins / 60)} 小时前读取`;
  }

  /** @param {!Element} shell Panel content root. */
  function renderListView(shell) {
    shell.append(renderHeader({
      glyph: '＋', title: 'Amex 助手',
      subtitle: `${state.offers.length} 个 offer · ${state.cards.length} 张卡`,
      refresh: true, close: true, tabs: true,
    }));

    const body = el('div', {class: 'body'});

    const search = el('input', {type: 'search', value: state.query,
      placeholder: '搜索商家或 offer'});
    search.oninput = (e) => {
      state.query = e.target.value.trim().toLowerCase();
      renderRows(body);
    };
    body.append(el('div', {class: 'sr'}, search));

    const tabs = el('div', {class: 'tabs'});
    const addTab = (key, label, sub) => {
      const cls = state.cardFilter === key ? 'tab on' : 'tab';
      const tab = el('div', {class: cls}, label);
      if (sub) tab.append(el('span', {class: 'n', text: ` ${sub}`}));
      tab.onclick = () => {
        state.cardFilter = key;
        render();
      };
      tabs.append(tab);
    };
    addTab('all', '所有卡');
    for (const card of state.cards) {
      const digits = cardDisplayDigits(cardRaw(card)) ||
          String(card.token).slice(-4);
      addTab(card.token, familyOf(card), `…${digits}`);
    }
    body.append(el('div', {class: 'tabwrap'}, tabs));

    const tb = el('div', {class: 'tb'});
    const multi = el('input', {type: 'checkbox'});
    multi.checked = state.multiOnly;
    multi.onchange = () => {
      state.multiOnly = multi.checked;
      renderRows(body);
    };
    tb.append(el('label', {}, multi, '只看能加多张卡的'),
      el('div', {class: 'sp'}),
      el('div', {class: 'ac'},
        el('a', {class: 'a-blue', text: '全选当前可加',
          onclick: () => selectAllVisible(body)}),
        el('a', {class: 'a-mut', text: '清空选择',
          onclick: () => clearSelection(body)})));
    body.append(tb);

    const list = el('div', {class: 'list', id: 'list'});
    body.append(list);
    shell.append(body);
    renderRows(body);

    shell.append(renderFooter());
  }

  /** @param {!Element} body Panel body (contains #list). */
  function renderRows(body) {
    const list = body.querySelector('#list');
    list.textContent = '';
    const shown = visibleOffers();
    for (const group of shown) list.append(renderOfferRow(group));
    if (shown.length === 0) {
      const empty = el('div', {class: 'note', text: '没有匹配的 offer'});
      list.append(el('div', {class: 'msg', style: 'padding:24px'}, empty));
    }
    refreshFooter();
  }

  /** @return {!Element} The list-view footer. */
  function renderFooter() {
    const sm = el('div', {class: 'sm', id: 'sm'});
    const go = el('button', {class: 'go', id: 'go', text: '加到所选卡',
      onclick: () => runSelected()});
    return el('div', {class: 'ft'}, sm, go);
  }

  /** Updates the footer summary + button enabled state. */
  function refreshFooter() {
    if (!panelRoot) return;
    const sm = panelRoot.getElementById('sm');
    const go = panelRoot.getElementById('go');
    if (!sm || !go) return;
    const offers = state.selected.size;
    const pairs = selectedCount();
    sm.textContent = '';
    sm.append(document.createTextNode('已选 '),
      el('b', {text: String(offers)}),
      document.createTextNode(' 个 offer，将提交 '),
      el('b', {text: String(pairs)}),
      document.createTextNode(' 次 Add to Card'));
    go.disabled = pairs === 0;
  }

  // ---- Benefits tab (3a) ---------------------------------------------------

  /**
   * Formats a currency amount, dropping `.00` on whole dollars.
   * @param {number} n Amount.
   * @param {string=} symbol Currency symbol.
   * @return {string} e.g. `$412` or `$28.56`.
   */
  function fmtMoney(n, symbol = '$') {
    const v = Number(n) || 0;
    return v % 1 === 0 ? `${symbol}${v}` : `${symbol}${v.toFixed(2)}`;
  }

  /** @param {number} d Days left. @return {string} e.g. `还剩 5 天`. */
  function daysLabel(d) {
    if (!Number.isFinite(d)) return '';
    if (d < 0) return '已过期';
    return `还剩 ${d} 天`;
  }

  /** @param {!Object} extra Header overrides. @return {!Object} Header opts. */
  function benefitsHeaderOpts(extra) {
    const owned = state.cards.filter(
      (c) => (c.relationship || 'BASIC') === 'BASIC').length;
    const parts = [`${owned} Cards`];
    const ago = agoLabel(state.benefitsReadAt);
    if (ago) parts.push(ago);
    return {glyph: '＋', title: 'Amex 助手', subtitle: parts.join(' · '),
      close: true, tabs: true, ...extra};
  }

  /** @param {!Element} shell Panel content root. */
  function renderBenefitsTab(shell) {
    if (state.benefitsError) return renderBenefitsError(shell);
    if (!state.benefitsLoaded) return renderBenefitsLoading(shell);
    renderBenefitsList(shell);
  }

  /** @param {!Element} shell Panel content root. */
  function renderBenefitsLoading(shell) {
    shell.append(renderHeader(benefitsHeaderOpts({})));
    const pr = state.benefitsRun || {done: 0, total: 0};
    const known = pr.total > 0;
    const pct = known ? Math.round(pr.done / pr.total * 100) : 8;
    const body = el('div', {class: 'body', style: 'padding:20px 18px'});
    const rowStyle = 'display:flex;justify-content:space-between;' +
        'align-items:baseline;margin-bottom:8px';
    body.append(el('div', {style: rowStyle},
      el('div', {style: 'font-size:13px;font-weight:700',
        text: '正在读取每张卡的 benefits…'}),
      el('div', {class: 'note',
        text: known ? `第 ${pr.done} / ${pr.total} 张卡` :
          '正在读取卡列表…'})));
    body.append(el('div', {class: 'bar', style: 'margin-bottom:6px'},
      el('div', {style: `width:${pct}%`})));
    body.append(el('div', {class: 'note', text: '纯只读，不会改动账户'}));
    shell.append(body);
  }

  /** @param {!Element} shell Panel content root. */
  function renderBenefitsError(shell) {
    shell.append(renderHeader(benefitsHeaderOpts({})));
    const body = el('div', {class: 'body'});
    const msg = el('div', {class: 'msg'});
    msg.append(el('div', {class: 'cir bad', text: '!'}));
    msg.append(el('div', {class: 'h', text: '读取失败'}));
    msg.append(el('div', {class: 'txt',
      text: '登录态可能已过期。请先在本页登录 Amex，再重试。'}));
    msg.append(el('div', {class: 'btn pri', text: '重试',
      onclick: () => loadBenefits(true)}));
    body.append(msg);
    shell.append(body);
  }

  /** @param {!Element} shell Panel content root. */
  function renderBenefitsList(shell) {
    shell.append(renderHeader(benefitsHeaderOpts({
      refresh: true, onRefresh: () => loadBenefits(true)})));
    const body = el('div', {class: 'body'});
    body.append(renderBenefitStats());

    const tb = el('div', {class: 'btb'});
    tb.append(el('div', {class: 'sortlbl'}, '按到期排序 ',
      el('span', {class: 'caret', text: '▾'})));
    tb.append(el('div', {class: 'sp'}));
    const un = el('input', {type: 'checkbox'});
    un.checked = state.benefitUnusedOnly;
    un.onchange = () => {
      state.benefitUnusedOnly = un.checked;
      render();
    };
    tb.append(el('label', {class: 'unused'}, un, '只看未用完'));
    body.append(tb);

    const active = state.benefits.filter((g) => !g.fullyUsed);
    const used = state.benefits.filter((g) => g.fullyUsed);
    const shown = state.benefitUnusedOnly ? active : state.benefits;
    const list = el('div', {class: 'blist'});
    for (const g of shown) list.append(renderBenefitRow(g));
    if (shown.length === 0) {
      list.append(el('div', {class: 'msg', style: 'padding:24px'},
        el('div', {class: 'note', text: '这些卡上没有可追踪的 benefit'})));
    }
    body.append(list);

    if (state.benefitUnusedOnly && used.length) {
      body.append(renderBenefitDoneSection(used));
    }

    shell.append(body);
    shell.append(el('div', {class: 'bfoot'},
      el('div', {class: 'note',
        text: '进度来自 Amex 的额度追踪 · 纯只读，不在本地存任何数据'})));
  }

  /** @return {!Element} The three-stat header bar. */
  function renderBenefitStats() {
    const s = state.benefitStats ||
        {thisMonthUnused: 0, redeemedYtd: 0, annualFee: 0, paybackPct: 0};
    const col = (cls, value, valCls, label, sub) => {
      const c = el('div', {class: `bcol ${cls}`});
      c.append(el('div', {class: `bval ${valCls}`, text: value}));
      c.append(el('div', {class: 'blbl', text: label}));
      if (sub) c.append(el('div', {class: 'bsub2', text: sub}));
      return c;
    };
    const feeCol = s.annualFee > 0 ?
      col('r', `${s.paybackPct}%`, 'ink',
        `年费回本 ${fmtMoney(s.redeemedYtd)}/${fmtMoney(s.annualFee)}`,
        '仅含可自动追踪的项目') :
      col('r', fmtMoney(s.redeemedYtd), 'ink', '今年已用回', '按可追踪项目');
    return el('div', {class: 'bstats'},
      col('l', fmtMoney(s.thisMonthUnused), 'navy', '本月还没用的'),
      el('div', {class: 'vsep'}),
      col('m', fmtMoney(s.redeemedYtd), 'green', '今年已用回'),
      el('div', {class: 'vsep'}),
      feeCol);
  }

  /**
   * @param {!Array<!Object>} used Fully-used benefit groups.
   * @return {!Element} The collapsible "已用完" section.
   */
  function renderBenefitDoneSection(used) {
    const wrap = el('div', {class: 'bdone'});
    const head = el('div', {class: 'bsec'});
    head.append(el('span', {class: 'bsec-t', text: '已用完 · 本周期'}));
    head.append(el('span', {class: 'bsec-n', text: String(used.length)}));
    head.append(el('div', {class: 'sp'}));
    head.append(el('span', {class: 'caret',
      text: state.benefitDoneOpen ? '▴' : '▾'}));
    head.onclick = () => {
      state.benefitDoneOpen = !state.benefitDoneOpen;
      render();
    };
    wrap.append(head);
    if (state.benefitDoneOpen) {
      for (const g of used) wrap.append(renderBenefitRow(g));
    }
    return wrap;
  }

  /**
   * @param {!Object} group A benefit group.
   * @return {!Element} One benefit row (expandable when multi-card).
   */
  function renderBenefitRow(group) {
    const [bg, fg] = logoColors(group.name);
    const logo = el('div', {class: 'blogo',
      style: `background:${bg};color:${fg}`,
      text: merchantInitials(group.name)});
    const title = el('div', {class: 'btitle'},
      el('span', {class: 'bname', text: group.name}));
    if (group.period) {
      title.append(el('span', {class: 'bp', text: group.period}));
    }
    if (group.multiCard) {
      title.append(el('span', {class: 'bx',
        text: `×${group.entries.length} 张卡`}));
    }
    const cardText = group.entries
      .map((e) => `${e.family} …${e.digits}`).join(' · ');
    const mn = el('div', {class: 'bmn'}, title,
      el('div', {class: 'bcard', text: cardText}));

    const pct = group.target > 0 ?
      Math.min(100, Math.round(group.spent / group.target * 100)) : 0;
    if (!group.multiCard) {
      mn.append(el('div', {class: 'bbar'}, el('div', {style: `width:${pct}%`})));
    }

    const urgent = Number.isFinite(group.daysLeft) && group.daysLeft <= 7;
    const rt = el('div', {class: 'brt'},
      el('div', {class: 'bamt'},
        `${fmtMoney(group.spent, group.symbol)} `,
        el('span', {class: 'of',
          text: `/ ${fmtMoney(group.target, group.symbol)}`})),
      el('div', {class: urgent ? 'bdays urgent' : 'bdays',
        text: daysLabel(group.daysLeft)}));

    const row = el('div', {class: 'brow'}, logo, mn, rt);
    const expanded = state.benefitsExpanded.has(group.key);
    if (group.multiCard) {
      row.append(el('span', {class: 'bcaret', text: expanded ? '▴' : '▾'}));
    }

    if (!group.multiCard) return row;

    const wrap = el('div', {class: expanded ? 'bgrp exp' : 'bgrp'});
    row.onclick = () => {
      if (expanded) state.benefitsExpanded.delete(group.key);
      else state.benefitsExpanded.add(group.key);
      render();
    };
    wrap.append(row);
    if (expanded) wrap.append(renderBenefitBreakdown(group));
    return wrap;
  }

  /**
   * @param {!Object} group A multi-card benefit group.
   * @return {!Element} Per-card breakdown rows.
   */
  function renderBenefitBreakdown(group) {
    const box = el('div', {class: 'bsub'});
    for (const e of group.entries) {
      const pct = e.target > 0 ?
        Math.min(100, Math.round(e.spent / e.target * 100)) : 0;
      const sw = el('span', {class: 'sw', style: `background:${swatchStyle(
        e.token)}`});
      box.append(el('div', {class: 'bsubrow'}, sw,
        el('span', {class: 'bsubcard', text: `…${e.digits}`}),
        el('div', {class: 'bbar grow'}, el('div', {style: `width:${pct}%`})),
        el('span', {class: 'bsubamt',
          text: `${fmtMoney(e.spent, e.symbol)} / ` +
            `${fmtMoney(e.target, e.symbol)}`})));
    }
    return box;
  }

  /** @param {!Element} shell Panel content root. */
  function renderLoadingView(shell) {
    shell.append(renderHeader({glyph: '＋', title: 'Amex 助手',
      subtitle: '一个 offer，加到多张卡', close: true}));
    const pr = state.run || {done: 0, total: 0};
    const known = pr.total > 0;
    // Before the account list returns the total is unknown; show a small sliver
    // so the bar reads as "working" rather than empty.
    const pct = known ? Math.round(pr.done / pr.total * 100) : 8;
    const body = el('div', {class: 'body', style: 'padding:20px 18px'});
    const rowStyle = 'display:flex;justify-content:space-between;' +
        'align-items:baseline;margin-bottom:8px';
    body.append(el('div', {style: rowStyle},
      el('div', {style: 'font-size:13px;font-weight:700',
        text: '正在读取每张卡的 offer…'}),
      el('div', {class: 'note',
        text: known ? `第 ${pr.done} / ${pr.total} 张卡` :
          '正在读取卡列表…'})));
    body.append(el('div', {class: 'bar', style: 'margin-bottom:6px'},
      el('div', {style: `width:${pct}%`})));
    body.append(el('div', {class: 'note',
      text: '这里只读取 Offer 列表，不会改动账户'}));
    shell.append(body);
  }

  /** @param {!Element} shell Panel content root. */
  function renderRunningView(shell) {
    const run = state.run;
    const seen = run.results.length;
    const ok = run.results.filter((r) => r.reportedOk).length;
    const skipped = run.results.filter((r) => r.skipped).length;
    const fail = seen - ok - skipped;
    const pending = run.total - seen;
    const pct = run.total ? Math.round(seen / run.total * 100) : 0;
    shell.append(renderHeader({glyph: el('span', {class: 'spin'}),
      title: '正在加到卡上…',
      subtitle: `${run.total} 次 Add to Card 已提交`,
      right: el('div', {class: 'b', style: 'font-size:12px;font-weight:700',
        text: `已处理 ${run.results.length} / ${run.total}`})}));
    const body = el('div', {class: 'body'});
    body.append(el('div', {style: 'padding:16px 18px 0'},
      el('div', {class: 'bar'}, el('div', {style: `width:${pct}%`}))));
    const cols = [
      {n: ok, l: '提交成功', c: 'g'}, {n: fail, l: '提交失败', c: 'r'},
      {n: pending, l: '提交中', c: 'b'}];
    if (skipped) cols.push({n: skipped, l: '未提交', c: 'am'});
    body.append(counters(cols));
    const rl = el('div', {style: 'padding:4px 18px 8px'});
    const settledIds = new Set(run.results.map((r) => `${r.key}|${r.token}`));
    for (const task of run.tasks) {
      const done = run.results.find(
        (r) => r.key === task.key && r.token === task.token);
      const txt = `${task.name} → ${cardLabel(task.token)}`;
      let icon; let stTxt; let stCls;
      if (!done) {
        icon = el('span', {class: 'spin'}); stTxt = '提交中'; stCls = 'st b';
      } else if (done.skipped) {
        icon = el('span', {class: 'am', text: '⊘'}); stTxt = '未提交';
        stCls = 'st am';
      } else if (done.reportedOk) {
        icon = el('span', {class: 'g', text: '✓'}); stTxt = '提交成功';
        stCls = 'st g';
      } else {
        icon = el('span', {class: 'r', text: '✗'}); stTxt = '提交失败';
        stCls = 'st r';
      }
      rl.append(el('div', {class: 'ri'}, icon,
        el('div', {class: 'txt', text: txt}),
        el('div', {class: stCls, text: stTxt})));
    }
    body.append(rl);
    const footStyle = 'border-top:1px solid #E7E8EA;padding:11px 18px';
    body.append(el('div', {style: footStyle},
      el('div', {class: 'note',
        text: '提交完成后，会重新读取已加列表，确认哪些卡真的加上'})));
    shell.append(body);
    void settledIds;
  }

  /** @param {!Element} shell Panel content root. */
  function renderResultView(shell) {
    const results = [...state.lastResults.values()];
    const n = (s) => results.filter((r) => r.state === s).length;
    const throttled = results.some(
      (r) => r.blocked || r.state === ResultState.SKIPPED);
    shell.append(renderHeader({glyph: throttled ? '!' : '✓',
      title: throttled ? '本轮已提前中止' : '完成，已核对',
      subtitle: `${results.length} 次 Add to Card 已处理`, close: true,
      err: throttled}));
    const body = el('div', {class: 'body'});
    const cols = [
      {n: n(ResultState.VERIFIED), l: '确认已加', c: 'g'},
      {n: n(ResultState.FAILED), l: '添加失败', c: 'r'},
      {n: n(ResultState.GHOST) + n(ResultState.UNVERIFIED),
        l: '疑似去重/无法确认', c: 'am'}];
    if (n(ResultState.SKIPPED)) {
      cols.push({n: n(ResultState.SKIPPED), l: '未提交', c: 'am'});
    }
    body.append(counters(cols));
    if (throttled) {
      body.append(el('div', {class: 'info'},
        el('b', {text: '检测到限流或拦截。'}),
        '收到 429/403 或异常响应后，本轮剩余提交已中止，也未做复查核对，' +
          '避免继续触发风控。建议等几分钟再点「重试未完成项」，' +
          '不要立即反复重发。'));
    }
    body.append(el('div', {class: 'info'},
      el('b', {text: '什么是疑似去重？'}),
      'Amex 返回 SUCCESS，但重新读取已加列表后没在这张卡看到这个 ' +
        'offer，就会归到这里。常见原因是同一个 offer 可能只允许加到' +
        '一张卡；「无法确认」表示复查未能完成。'));

    const section = (title, filter, glyph, cls) => {
      const items = results.filter(filter);
      if (!items.length) return;
      body.append(el('div', {style: 'padding:0 18px'},
        el('div', {class: 'sh', text: title})));
      const wrap = el('div', {style: 'padding:0 18px 4px'});
      for (const r of items) {
        const right = r.state === ResultState.FAILED && r.message ?
          el('span', {class: cls, style: 'font-size:11px',
            text: `“${r.message}”`}) :
          el('span', {class: cls, text: glyph});
        wrap.append(el('div', {class: 'si'},
          el('span', {text: `${r.name} → ${cardLabel(r.token)}`}), right));
      }
      body.append(wrap);
    };
    section('确认已加', (r) => r.state === ResultState.VERIFIED, '✓', 'g');
    section('添加失败', (r) => r.state === ResultState.FAILED, '✗', 'r');
    section('未提交 — 检测到限流后中止',
      (r) => r.state === ResultState.SKIPPED, '⊘', 'am');
    section('疑似去重 — SUCCESS 但复查未出现在已加列表',
      (r) => r.state === ResultState.GHOST, '⚠', 'am');
    section('无法确认 — 复查未完成',
      (r) => r.state === ResultState.UNVERIFIED, '?', 'note');

    const retryable = (r) => (r.state === ResultState.FAILED ||
        r.state === ResultState.SKIPPED) && !r.gone;
    const retry = el('div', {class: 'lnk rerun', text: '重试未完成项',
      onclick: () => retryFailed()});
    if (!results.some(retryable)) {
      retry.style.display = 'none';
    }
    shell.append(body);
    shell.append(el('div', {class: 'ft'},
      el('div', {class: 'lnk', text: '导出 CSV', onclick: () => exportCsv()}),
      el('div', {class: 'sp', style: 'flex:1'}), retry,
      el('button', {class: 'go', text: '返回列表',
        onclick: () => backToList()})));
  }

  /**
   * @param {!Array<{n: number, l: string, c: string}>} cols Counter columns.
   * @return {!Element} The 3-up counter strip.
   */
  function counters(cols) {
    const row = el('div', {class: 'cnt'});
    cols.forEach((col, i) => {
      if (i) row.append(el('div', {class: 'sep'}));
      row.append(el('div', {class: 'c'},
        el('div', {class: `n ${col.c}`, text: String(col.n)}),
        el('div', {class: 'l', text: col.l})));
    });
    return row;
  }

  /** @param {!Element} shell Panel content root. */
  function renderEmptyView(shell) {
    shell.append(renderHeader({glyph: '＋', title: 'Amex 助手', close: true,
      refresh: true, tabs: true}));
    shell.append(el('div', {class: 'body'}, el('div', {class: 'msg'},
      el('div', {class: 'cir ok', text: '✓'}),
      el('div', {class: 'h', text: '暂无可加的 offer'}),
      el('div', {class: 'txt',
        text: '当前 offer 都已加到可用的卡上。'}),
      el('div', {class: 'btn', onclick: () => refresh()}, '↻ 重新读取'))));
  }

  /** @param {!Element} shell Panel content root. */
  function renderErrorView(shell) {
    shell.append(renderHeader({glyph: '＋', title: 'Amex 助手', close: true,
      err: true}));
    shell.append(el('div', {class: 'body'}, el('div', {class: 'msg'},
      el('div', {class: 'cir bad', text: '!'}),
      el('div', {class: 'h', text: '读取 Offer 列表失败'}),
      el('div', {class: 'txt', text: state.errorMessage ||
          '登录状态可能已过期。请先在当前页面登录 Amex，再重试。'}),
      el('div', {class: 'btn pri', onclick: () => refresh()}, '重试'))));
  }

  // ---- helpers for card family / raw account -------------------------------

  /**
   * @param {!CardSnapshot} card Card. @return {string} Product family (short).
   */
  function familyOf(card) {
    return (card.shortName || '').replace(/\s*···.*$/, '') ||
        `…${String(card.token).slice(-4)}`;
  }

  /**
   * cardDisplayDigits works on a raw account; snapshot only kept `shortName`,
   * which already embeds the digits, so re-derive from the label.
   * @param {!CardSnapshot} card Card.
   * @return {!Object} A shim account for cardDisplayDigits.
   */
  function cardRaw(card) {
    const m = /···(\d+)/.exec(card.shortName || '');
    return {display_account_number: m ? m[1] : ''};
  }

  // ---- selection helpers ---------------------------------------------------

  /** @param {!Element} body Panel body. */
  function selectAllVisible(body) {
    for (const group of visibleOffers()) {
      const addable = addableCards(group);
      if (addable.length) {
        state.selected.set(group.key, new Set(addable.map((c) => c.token)));
      }
    }
    renderRows(body);
  }

  /** @param {!Element} body Panel body. */
  function clearSelection(body) {
    state.selected.clear();
    renderRows(body);
  }

  // ---- run / retry / export ------------------------------------------------

  /**
   * Runs the current selection (or a given task list), driving the running and
   * result views. Always returns to a usable view.
   * @param {!Array<!Task>=} presetTasks Optional explicit tasks (retry).
   * @return {!Promise<void>} Resolves when the run finishes.
   */
  async function runSelected(presetTasks) {
    const tasks = presetTasks || buildTasks();
    if (tasks.length === 0) return;

    state.view = 'running';
    state.run = {tasks, total: tasks.length, results: []};
    render();
    try {
      const results = await executeSelected(tasks, {
        onSettle: (attempt) => {
          state.run.results.push(attempt);
          render();
        },
      });
      // A retry merges over the previous report so pairs settled earlier
      // (verified, landed, gone) stay visible; a fresh run starts clean.
      const merged = presetTasks ? state.lastResults : new Map();
      for (const r of results) merged.set(`${r.key}|${r.token}`, r);
      state.lastResults = merged;
      state.selected.clear();
      const throttled = results.some(
        (r) => r.blocked || r.state === ResultState.SKIPPED);
      if (!throttled) {
        // Refresh the offer list; skipped when throttled so the tool goes
        // fully quiet instead of firing another full read sweep.
        try {
          state.cards = await snapshot();
          state.offers = buildOfferIndex(state.cards);
        } catch { /* keep previous list; result view still shows outcomes */ }
      }
      state.view = 'result';
    } catch (error) {
      state.errorMessage = `添加过程中断：${error.message}`;
      state.view = 'error';
    }
    render();
  }

  /**
   * Re-runs the failed and never-submitted pairs from the last result.
   * Pairs are re-planned against the current snapshot first (fresh offerIds;
   * see {@link planRetry}); pairs that turn out to be already on the card or
   * no longer available are settled in place without a resend.
   */
  function retryFailed() {
    const {tasks, landed, gone} =
        planRetry([...state.lastResults.values()], state.offers);
    for (const r of [...landed, ...gone]) {
      state.lastResults.set(`${r.key}|${r.token}`, r);
    }
    if (tasks.length) runSelected(tasks);
    else render(); // nothing left to resend; show the settled states
  }

  /** Downloads the last run's results as a CSV file. */
  function exportCsv() {
    const rows = [['offer', 'card', 'state', 'http_status', 'message']];
    for (const r of state.lastResults.values()) {
      rows.push([r.name, cardLabel(r.token), r.state, r.httpStatus || '',
        r.message || '']);
    }
    const csv = rows.map((row) => row
      .map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','),
    ).join('\n');
    const url = URL.createObjectURL(
      new Blob([csv], {type: 'text/csv;charset=utf-8'}));
    const link = el('a', {href: url, download: 'amex-assistant-results.csv'});
    link.click();
    URL.revokeObjectURL(url);
  }

  /** Returns from the result view to the offer list. */
  function backToList() {
    state.view = 'list';
    render();
  }

  // ---- panel shell / lifecycle ---------------------------------------------

  /** @return {!ShadowRoot} Creates the panel host + shadow root. */
  function createPanel() {
    const host = el('div', {style:
      'position:fixed;top:16px;right:16px;z-index:2147483647'});
    document.body.appendChild(host);
    panelHost = host;
    const root = host.attachShadow({mode: 'open'});
    panelRoot = root;
    root.append(el('style', {text: PANEL_STYLE}));
    root.append(el('div', {class: 'p', id: 'shell'}));
    return root;
  }

  /**
   * (Re)loads the snapshot and shows the list (or empty/error). Cached so
   * reopening is instant until the next refresh.
   * @return {!Promise<void>} Resolves when rendered.
   */
  async function refresh() {
    state.lastResults = new Map();
    state.run = {done: 0, total: state.cards.length};
    state.view = 'loading';
    render();
    try {
      state.cards = await snapshot((done, total) => {
        state.run = {done, total};
        if (state.view === 'loading') render();
      });
      state.offers = buildOfferIndex(state.cards);
      loaded = true;
      state.view = state.offers.length ? 'list' : 'empty';
    } catch (error) {
      state.errorMessage = `${error.message}`;
      state.view = 'error';
    }
    render();
  }

  /** Shows the panel, creating and loading it only on first use. */
  function showPanel() {
    if (launcherButton) launcherButton.style.display = 'none';
    if (!panelHost) createPanel();
    panelHost.style.display = '';
    if (!loaded) refresh(); else render();
  }

  /** Hides the panel (keeps cached state) and restores the launcher. */
  function hidePanel() {
    if (panelHost) panelHost.style.display = 'none';
    if (launcherButton) launcherButton.style.display = '';
  }

  /** Installs the launch pill. Nothing hits the account until opened. */
  function installLauncher() {
    const host = el('div', {style:
      'position:fixed;top:96px;right:0;z-index:2147483647'});
    const root = host.attachShadow({mode: 'open'});
    root.append(el('style', {text: `
      .l { display:flex; align-items:center; gap:9px; background:#fff;
        border:1px solid #E3E5E8; border-right:none;
        border-radius:6px 0 0 6px; padding:10px 16px 10px 12px;
        box-shadow:0 3px 12px rgba(0,23,90,.14); cursor:pointer;
        font:12.5px 'Helvetica Neue',Helvetica,system-ui,sans-serif;
        transition:box-shadow .15s ease }
      .l:hover { box-shadow:0 5px 18px rgba(0,23,90,.22) }
      .i { width:24px; height:24px; border-radius:4px; background:#006FCF;
        color:#fff; display:flex; align-items:center; justify-content:center;
        font-size:15px; font-weight:600; line-height:1 }
      .t { font-weight:800; color:#00175A; letter-spacing:.1px }
    `}));
    const pill = el('div', {class: 'l', onclick: () => showPanel()},
      el('div', {class: 'i', text: '＋'}),
      el('div', {},
        el('div', {class: 't', text: 'Amex 助手'})));
    root.append(pill);
    document.body.appendChild(host);
    launcherButton = host;
  }

  window.AmexAssistant = {...api, showPanel, openPanel: showPanel};
  installLauncher();
})();
