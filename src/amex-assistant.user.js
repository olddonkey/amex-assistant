// ==UserScript==
// @name         Amex Assistant
// @namespace    https://github.com/olddonkey/amex-assistant
// @version      0.8.0
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
   * @typedef {{token: string, tag: string, name: string,
   *            eligible: !Array<!Object>, enrolled: !Array<!Object>,
   *            enrolledKeys: !Set<string>}} CardSnapshot
   */

  /**
   * A merchant offer grouped across the cards that can add it. `cards[i]`
   * carries that card's own `offerId` (the token to enroll with).
   * @typedef {{key: string, name: string, description: string,
   *            cards: !Array<{token: string, offerId: string,
   *                           enrolled: boolean}>}} OfferGroup
   */

  /**
   * @typedef {{token: string, offerId: string, key: string,
   *            name: string}} Task
   */

  /**
   * @typedef {{key: string, name: string, token: string, offerId: string,
   *            state: string, message: string}} EnrollResult
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
    /** Dry run: nothing was sent. */
    DRY_RUN: 'dry-run',
    /** The enroll request errored or did not report success. */
    FAILED: 'failed',
    /** Enroll reported success and the offer was found on re-read. */
    VERIFIED: 'verified',
    /** Enroll reported success but the offer was absent on re-read. */
    GHOST: 'ghost',
    /** Enroll reported success but the re-read could not be performed. */
    UNVERIFIED: 'unverified',
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
    return [...byKey.values()].sort(
      (a, b) => b.cards.length - a.cards.length);
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
      if (!attempt.reportedOk) {
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
        message: attempt.message || '',
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Network layer (uses the logged-in session; talks only to Amex)
  // ---------------------------------------------------------------------------

  /**
   * Performs a JSON request with the logged-in session and returns the parsed
   * body. Throws on a non-2xx response.
   *
   * @param {string} url Request URL.
   * @param {!Object} options `fetch` options (method/headers/body).
   * @return {!Promise<!Object>} Parsed JSON response.
   */
  async function requestJson(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) {
      throw new Error(`Request to ${url} failed with ${response.status}`);
    }
    return response.json();
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
   * Reads all cards and their eligible offers plus already-added group keys.
   * @return {!Promise<!Array<!CardSnapshot>>} Per-card snapshot.
   */
  async function snapshot() {
    const cards = [];
    for (const account of flattenAccounts(await fetchAccounts())) {
      const token = account.account_token;
      if (!token) continue;
      const eligible = await fetchEligibleOffers(token);
      const enrolled = await fetchEnrolledOffers(token);
      const enrolledKeys =
          new Set(enrolled.map(offerGroupKey).filter(Boolean));
      cards.push({
        token,
        tag: String(token).slice(-4),
        name: cardName(account, token),
        eligible,
        enrolled,
        enrolledKeys,
      });
    }
    return cards;
  }

  /**
   * Sleeps for a random duration within the configured delay window. Kept as a
   * default so callers (tests) can inject a no-op.
   * @return {!Promise<void>} Resolves after the delay.
   */
  function randomDelay() {
    const ms = MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Enrolls one task, never throwing; returns a tagged attempt.
   * @param {!Task} task The (offer, card) work item.
   * @return {!Promise<!Object>} Attempt tagged with `reportedOk` and `message`.
   */
  async function attemptEnroll(task) {
    try {
      const response = await enrollOffer(task.token, task.offerId);
      return {
        ...task,
        reportedOk: isEnrollSuccess(response),
        message: getPath(response, 'status.message') || '',
      };
    } catch (error) {
      return {...task, reportedOk: false,
        message: error.message || 'request failed'};
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
   * Enrolls the given (offer, card) tasks, then re-reads the affected cards and
   * classifies each attempt.
   *
   * Each task enrolls with the card's own `offerId`. All cards for the SAME
   * offer are fired concurrently: once one card enrolls an offer, Amex can make
   * it ineligible on the others, so a sequential pass would let only the first
   * card win. Different offers are paced apart by `delay`. A single failure is
   * recorded and does not abort the run.
   *
   * @param {!Array<!Task>} tasks Flattened (offer, card) work items.
   * @param {{dryRun: (boolean|undefined),
   *          onProgress: (function(number, number)|undefined),
   *          delay: (function(): !Promise<void>|undefined)}=} options Behavior
   *     overrides. `delay` (between offers) defaults to {@link randomDelay}.
   * @return {!Promise<!Array<!EnrollResult>>} One result per task.
   */
  async function executeSelected(tasks, options = {}) {
    const {
      dryRun = false,
      onProgress = () => {},
      delay = randomDelay,
    } = options;

    if (dryRun) {
      tasks.forEach((task, index) => onProgress(index + 1, tasks.length));
      return tasks.map((task) => ({
        key: task.key,
        name: task.name,
        token: task.token,
        offerId: task.offerId,
        state: ResultState.DRY_RUN,
        message: '',
      }));
    }

    const offerGroups = groupTasksByOffer(tasks);
    const attempts = [];
    let done = 0;
    for (let i = 0; i < offerGroups.length; i++) {
      const settled = await Promise.all(offerGroups[i].map(async (task) => {
        const attempt = await attemptEnroll(task);
        onProgress(++done, tasks.length);
        return attempt;
      }));
      attempts.push(...settled);
      if (i < offerGroups.length - 1) await delay();
    }

    const enrolledByToken = new Map();
    for (const token of new Set(tasks.map((task) => task.token))) {
      try {
        enrolledByToken.set(token, await fetchEnrolledKeys(token));
      } catch {
        // Leave this token unset so its (already-sent) attempts classify as
        // UNVERIFIED instead of the whole run throwing and losing results.
      }
    }
    return classifyAttempts(attempts, enrolledByToken);
  }

  /** Functions exposed for reuse and unit testing. */
  const api = {
    offerGroupKey,
    getPath,
    cardName,
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
  // UI (browser only): a self-contained Shadow DOM panel. It renders our own
  // offer list built from the API — it never touches Amex's native tiles.
  // ---------------------------------------------------------------------------

  /**
   * Shared UI state. `selected` maps an offer group key to the set of chosen
   * card tokens.
   * `lastResults` maps `"<offerKey>|<token>"` to the last run's result for that
   * (offer, card), so the panel can show which cards succeeded/failed and why.
   * @type {{cards: !Array<!CardSnapshot>, offers: !Array<!OfferGroup>,
   *         selected: !Map<string, !Set<string>>, query: string,
   *         lastResults: !Map<string, !EnrollResult>}}
   */
  const state = {
    cards: [], offers: [], selected: new Map(), query: '',
    lastResults: new Map(),
  };

  /** Panel host + shadow root, created lazily and reused across opens. */
  let panelHost = null;
  let panelRoot = null;
  /** Launcher button; hidden while the panel is open. */
  let launcherButton = null;
  /** Whether the offer snapshot has been loaded at least once. */
  let loaded = false;

  /**
   * Returns a card's display label.
   * @param {string} token Card token.
   * @return {string} Display label.
   */
  function cardLabel(token) {
    const card = state.cards.find((c) => c.token === token);
    return card ? card.name : `…${String(token).slice(-4)}`;
  }

  /**
   * Expands the current selection into flat enroll tasks, resolving each
   * card's own `offerId` and skipping cards that already have the offer.
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

  const AMEX_BLUE = '#006fcf';
  const PANEL_STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .panel {
      font: 13px -apple-system, system-ui, sans-serif; color: #1a1a1a;
      background: #fff; border: 1px solid #d8dee4; border-radius: 12px;
      width: 460px; max-height: 78vh; display: flex; flex-direction: column;
      box-shadow: 0 12px 32px rgba(0, 0, 0, .22); overflow: hidden;
    }
    header {
      padding: 12px 14px; display: flex; align-items: center;
      justify-content: space-between; background: ${AMEX_BLUE}; color: #fff;
    }
    header .title { font-weight: 600; font-size: 14px; }
    header .sub { font-size: 11px; opacity: .85; margin-left: 8px; }
    header button {
      all: unset; cursor: pointer; font-size: 18px; line-height: 1;
      padding: 0 4px; opacity: .9;
    }
    .search { padding: 10px 14px 6px; }
    .search input {
      width: 100%; padding: 7px 10px; font: inherit; border: 1px solid #d8dee4;
      border-radius: 8px; outline: none;
    }
    .search input:focus { border-color: ${AMEX_BLUE}; }
    .body { overflow-y: auto; padding: 4px 6px 8px; }
    .row {
      display: flex; align-items: center; gap: 10px; padding: 8px 8px;
      border-radius: 8px;
    }
    .row:hover { background: #f5f8fb; }
    .row .main { flex: 1; min-width: 0; }
    .row .name {
      font-weight: 600; white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis;
    }
    .row .desc {
      font-size: 11px; color: #6b7280; white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis;
    }
    .pill {
      font-size: 11px; color: ${AMEX_BLUE}; background: #eaf3fb;
      border-radius: 999px; padding: 2px 8px; white-space: nowrap;
    }
    .pill.done { color: #4b5563; background: #eef0f2; }
    .expand {
      all: unset; cursor: pointer; color: ${AMEX_BLUE}; font-size: 12px;
      padding: 2px 4px;
    }
    .cards {
      display: flex; flex-wrap: wrap; gap: 6px; padding: 2px 8px 10px 34px;
    }
    .chip {
      display: inline-flex; align-items: center; gap: 5px; font-size: 12px;
      border: 1px solid #d8dee4; border-radius: 999px; padding: 3px 9px;
      cursor: pointer;
    }
    .chip.off { opacity: .5; cursor: default; }
    .chip.r-verified { border-color: #1a8f3c; color: #1a8f3c; opacity: 1; }
    .chip.r-ghost { border-color: #e08600; color: #e08600; }
    .chip.r-failed { border-color: #d33; color: #d33; }
    .chip.r-unverified { border-color: #6b7280; color: #6b7280; }
    .result { font-size: 11px; white-space: nowrap; }
    .result .v, .runhead .v { color: #1a8f3c; }
    .result .g, .runhead .g { color: #e08600; }
    .result .f, .runhead .f { color: #d33; }
    .result .u, .runhead .u { color: #6b7280; }
    .runbanner {
      background: #f7f9fb; border: 1px solid #dbe7f2; border-radius: 8px;
      padding: 8px 10px; margin: 4px 2px 8px; font-size: 12px;
    }
    .runhead {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 4px;
    }
    .runline { color: #444; padding: 2px 0; }
    .empty { padding: 8px; color: #6b7280; }
    footer {
      padding: 10px 14px; display: flex; align-items: center; gap: 12px;
      border-top: 1px solid #eef0f2; background: #fafbfc;
    }
    footer label { display: flex; align-items: center; gap: 5px; }
    .prog { flex: 1; color: #4b5563; font-size: 12px; }
    .go {
      all: unset; cursor: pointer; background: ${AMEX_BLUE}; color: #fff;
      font-weight: 600; padding: 7px 14px; border-radius: 8px;
    }
    .go[disabled] { opacity: .5; cursor: default; }
    input[type=checkbox] { accent-color: ${AMEX_BLUE}; }
  `;

  /**
   * Creates the panel host, attaches a shadow root, and wires up controls.
   * @return {!ShadowRoot} The panel's shadow root.
   */
  function createPanel() {
    const host = document.createElement('div');
    host.style.cssText =
        'position:fixed;top:16px;right:16px;z-index:2147483647';
    document.body.appendChild(host);
    panelHost = host;
    const root = host.attachShadow({mode: 'open'});
    panelRoot = root;
    root.innerHTML = `
      <style>${PANEL_STYLE}</style>
      <div class="panel">
        <header>
          <span><span class="title">Amex Assistant</span
            ><span class="sub" id="sub"></span></span>
          <span>
            <button id="refresh" title="Refresh">↻</button>
            <button id="close" title="Close">×</button>
          </span>
        </header>
        <div class="search">
          <input id="q" type="search" placeholder="Search offers…">
        </div>
        <div class="body" id="list">Loading…</div>
        <footer>
          <label><input type="checkbox" id="dry" checked> Dry-run</label>
          <span class="prog" id="prog"></span>
          <button class="go" id="go">Add selected</button>
        </footer>
      </div>`;
    root.getElementById('close').onclick = () => hidePanel();
    root.getElementById('refresh').onclick = () => refresh(root);
    root.getElementById('go').onclick = () => runSelected(root);
    root.getElementById('q').oninput = (e) => {
      state.query = e.target.value.trim().toLowerCase();
      renderOfferList(root);
    };
    return root;
  }

  /**
   * Renders one offer row plus its (hidden until expanded) per-card chips.
   * @param {!OfferGroup} group Offer group to render.
   * @return {!DocumentFragment} Row and its card box.
   */
  function renderOfferRow(group) {
    const fragment = document.createDocumentFragment();
    const addable = addableCards(group);
    const addedCount = group.cards.length - addable.length;

    const row = document.createElement('div');
    row.className = 'row';
    const pick = document.createElement('input');
    pick.type = 'checkbox';
    pick.disabled = addable.length === 0;

    const main = document.createElement('div');
    main.className = 'main';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = group.name;
    main.appendChild(name);
    if (group.description) {
      const desc = document.createElement('div');
      desc.className = 'desc';
      desc.textContent = group.description;
      main.appendChild(desc);
    }

    const pill = document.createElement('span');
    pill.className = addable.length ? 'pill' : 'pill done';
    pill.textContent = addedCount ?
      `${addable.length} to add · ${addedCount} on card` :
      `${addable.length} cards`;
    const expand = document.createElement('button');
    expand.className = 'expand';
    expand.textContent = 'cards ▾';

    // If this offer was part of the last run, show a per-offer outcome badge
    // (in place of the pill) so successes/failures are visible without
    // expanding.
    const runStates = group.cards
      .map((c) => state.lastResults.get(`${group.key}|${c.token}`))
      .filter(Boolean)
      .map((r) => r.state);
    let resultBadge = null;
    if (runStates.length > 0) {
      const n = (s) => runStates.filter((x) => x === s).length;
      resultBadge = document.createElement('span');
      resultBadge.className = 'result';
      const unv = n(ResultState.UNVERIFIED);
      resultBadge.innerHTML =
          `<span class="v">✓${n(ResultState.VERIFIED)}</span> ` +
          `<span class="g">⚠${n(ResultState.GHOST)}</span> ` +
          `<span class="f">✗${n(ResultState.FAILED)}</span>` +
          (unv ? ` <span class="u">?${unv}</span>` : '');
    }

    const box = document.createElement('div');
    box.className = 'cards';
    box.style.display = 'none';

    const syncPick = () => {
      pick.checked = (state.selected.get(group.key)?.size || 0) > 0;
    };
    const renderChips = () => {
      box.textContent = '';
      const chosen = state.selected.get(group.key) || new Set();
      for (const card of group.cards) {
        const result = state.lastResults.get(`${group.key}|${card.token}`);
        const st = result && result.state;
        const chip = document.createElement('label');
        let chipClass = 'chip';
        if (card.enrolled) chipClass += ' off';
        if (st) chipClass += ` r-${st}`;
        chip.className = chipClass;
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = chosen.has(card.token);
        cb.disabled = card.enrolled;
        cb.onchange = () => {
          const set = state.selected.get(group.key) || new Set();
          if (cb.checked) {
            set.add(card.token);
          } else {
            set.delete(card.token);
          }
          if (set.size) {
            state.selected.set(group.key, set);
          } else {
            state.selected.delete(group.key);
          }
          syncPick();
        };
        let mark = '';
        if (card.enrolled) mark = ' ✓';
        else if (st) mark = ` ${stateMark(st)}`;
        chip.append(cb, document.createTextNode(cardLabel(card.token) + mark));
        box.appendChild(chip);
      }
    };

    pick.onchange = () => {
      if (pick.checked) {
        state.selected.set(group.key, new Set(addable.map((c) => c.token)));
      } else {
        state.selected.delete(group.key);
      }
      if (box.style.display !== 'none') renderChips();
    };
    expand.onclick = () => {
      box.style.display = box.style.display === 'none' ? 'flex' : 'none';
      renderChips();
    };

    row.append(pick, main, resultBadge || pill, expand);
    fragment.append(row, box);
    return fragment;
  }

  /**
   * Builds the "last run" banner: overall counts plus a line per non-verified
   * (offer, card) with its error/ghost message, so failures are visible even if
   * the card dropped out of the offer's list on the post-run refresh.
   * @return {?Element} The banner, or null if there was no run.
   */
  function renderRunSummary() {
    if (state.lastResults.size === 0) return null;
    const results = [...state.lastResults.values()];
    const n = (s) => results.filter((r) => r.state === s).length;

    const box = document.createElement('div');
    box.className = 'runbanner';
    const head = document.createElement('div');
    head.className = 'runhead';
    const counts = document.createElement('span');
    counts.innerHTML =
        `Last run: <span class="v">✓${n(ResultState.VERIFIED)}</span> ` +
        `<span class="g">⚠${n(ResultState.GHOST)}</span> ` +
        `<span class="f">✗${n(ResultState.FAILED)}</span> ` +
        `<span class="u">?${n(ResultState.UNVERIFIED)}</span>`;
    const dismiss = document.createElement('button');
    dismiss.className = 'expand';
    dismiss.textContent = 'dismiss';
    dismiss.onclick = () => {
      state.lastResults = new Map();
      renderOfferList(panelRoot);
    };
    head.append(counts, dismiss);
    box.appendChild(head);

    for (const r of results.filter((x) => x.state !== ResultState.VERIFIED)) {
      const line = document.createElement('div');
      line.className = 'runline';
      const mark = stateMark(r.state);
      line.textContent = `${mark} ${r.name} · ${cardLabel(r.token)}` +
          (r.message ? ` — ${r.message}` : '');
      box.appendChild(line);
    }
    return box;
  }

  /**
   * A short glyph for a result state.
   * @param {string} resultState One of {@link ResultState}.
   * @return {string} The glyph.
   */
  function stateMark(resultState) {
    if (resultState === ResultState.FAILED) return '✗';
    if (resultState === ResultState.GHOST) return '⚠';
    if (resultState === ResultState.UNVERIFIED) return '?';
    return '✓';
  }

  /**
   * Renders the offer list into the panel, honoring the search query.
   * @param {!ShadowRoot} root Panel shadow root.
   */
  function renderOfferList(root) {
    const list = root.getElementById('list');
    list.textContent = '';
    const summary = renderRunSummary();
    if (summary) list.appendChild(summary);
    const query = state.query;
    const shown = query ?
      state.offers.filter((g) => g.name.toLowerCase().includes(query)) :
      state.offers;
    for (const group of shown) {
      list.appendChild(renderOfferRow(group));
    }
    if (shown.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No offers match.';
      list.appendChild(empty);
    }
  }

  /**
   * Runs the selection when the user clicks "Add selected", updating the footer
   * with progress and the run summary. Always re-enables the button, and keeps
   * the run's results even if the post-run refresh fails.
   * @param {!ShadowRoot} root Panel shadow root.
   * @return {!Promise<void>} Resolves when the run finishes.
   */
  async function runSelected(root) {
    const dry = root.getElementById('dry').checked;
    const prog = root.getElementById('prog');
    const go = root.getElementById('go');
    const tasks = buildTasks();
    if (tasks.length === 0) {
      prog.textContent = 'Nothing selected';
      return;
    }

    go.disabled = true;
    try {
      const results = await executeSelected(tasks, {
        dryRun: dry,
        onProgress: (done, total) => {
          prog.textContent = `${done}/${total}…`;
        },
      });

      if (!dry) {
        // Remember per-card outcomes so the list can annotate them.
        state.lastResults = new Map(
          results.map((r) => [`${r.key}|${r.token}`, r]));
        state.selected.clear();
        try {
          // Re-read so added offers now show as on-card.
          state.cards = await snapshot();
          state.offers = buildOfferIndex(state.cards);
        } catch {
          // Keep the previous list; the run banner still shows the outcome.
        }
        renderOfferList(root);
        root.getElementById('sub').textContent =
            `${state.offers.length} offers · ${state.cards.length} cards`;
      }

      const count = (s) => results.filter((r) => r.state === s).length;
      prog.textContent = dry ?
        `dry-run: ${results.length} offer×card (nothing sent)` :
        `verified ${count(ResultState.VERIFIED)} · ` +
              `failed ${count(ResultState.FAILED)} · ` +
              `ghost ${count(ResultState.GHOST)} · ` +
              `unverified ${count(ResultState.UNVERIFIED)}`;
      console.table(results.map((r) => ({
        offer: r.name,
        card: cardLabel(r.token),
        state: r.state,
        message: r.message,
      })));
    } catch (error) {
      prog.textContent = `Run failed: ${error.message}`;
    } finally {
      go.disabled = false;
    }
  }

  /**
   * (Re)loads the snapshot and renders the offer list. Called on first open and
   * whenever the user clicks refresh; the result is cached so reopening is
   * instant until the next refresh.
   * @param {!ShadowRoot} root Panel shadow root.
   * @return {!Promise<void>} Resolves when rendered.
   */
  async function refresh(root) {
    const list = root.getElementById('list');
    list.textContent = 'Loading…';
    root.getElementById('sub').textContent = '';
    state.lastResults = new Map();
    try {
      state.cards = await snapshot();
      state.offers = buildOfferIndex(state.cards);
      loaded = true;
      renderOfferList(root);
      root.getElementById('sub').textContent =
          `${state.offers.length} offers · ${state.cards.length} cards`;
    } catch (error) {
      list.textContent = `Failed to load: ${error.message}`;
    }
  }

  /** Shows the panel, creating it and loading data only on first use. */
  function showPanel() {
    if (launcherButton) launcherButton.style.display = 'none';
    if (!panelHost) createPanel();
    panelHost.style.display = '';
    if (!loaded) refresh(panelRoot); // cached afterwards; ↻ to reload
  }

  /** Hides the panel (keeps its cached state) and restores the launcher. */
  function hidePanel() {
    if (panelHost) panelHost.style.display = 'none';
    if (launcherButton) launcherButton.style.display = '';
  }

  /**
   * Installs a small launch button. Nothing hits the account until the user
   * opens the panel and clicks "Add selected".
   */
  function installLauncher() {
    const button = document.createElement('button');
    button.textContent = 'Offers';
    button.style.cssText =
        'position:fixed;top:16px;right:16px;z-index:2147483647;' +
        `padding:7px 14px;cursor:pointer;background:${AMEX_BLUE};color:#fff;` +
        'border:none;border-radius:8px;font:600 13px system-ui';
    button.onclick = () => showPanel();
    document.body.appendChild(button);
    launcherButton = button;
  }

  window.AmexAssistant = {...api, showPanel, openPanel: showPanel};
  installLauncher();
})();
