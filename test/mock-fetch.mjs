/**
 * @fileoverview A scenario-driven stand-in for `fetch` used by the tests so
 * they can exercise the userscript's network layer without a real American
 * Express session. It mirrors the response shapes documented in
 * docs/FINDINGS.md.
 */

/**
 * Wraps data in a minimal `Response`-like object.
 * @param {!Object} data Parsed JSON body to return.
 * @param {boolean=} ok Whether the response is a success.
 * @param {number=} status HTTP status code.
 * @return {!Object} A `fetch`-compatible response.
 */
export function jsonResponse(data, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => data,
  };
}

/**
 * Builds a raw offers-hub offer object.
 * @param {string} offerId The `offerId` field.
 * @param {{pzn: (string|undefined), type: (string|undefined),
 *          title: (string|undefined)}=} opts Optional overrides.
 * @return {!Object} A raw offer.
 */
export function makeOffer(offerId, opts = {}) {
  const offer = {
    offerId,
    offerType: opts.type || 'MERCHANT',
    title: opts.title || `Offer ${offerId}`,
  };
  if (opts.pzn) offer.pznAnalyticsId = opts.pzn;
  return offer;
}

/**
 * Builds a raw benefit tracker object (shape of the benefits endpoint).
 * @param {string} name The `benefitName`.
 * @param {{sor: (string|undefined), category: (string|undefined),
 *          status: (string|undefined), start: (string|undefined),
 *          end: (string|undefined), duration: (string|undefined),
 *          target: (number|undefined), spent: (number|undefined),
 *          remaining: (number|undefined),
 *          benefitId: (string|undefined)}=} opts Optional overrides.
 * @return {!Object} A raw tracker.
 */
export function makeTracker(name, opts = {}) {
  const tracker = {
    targetAmount: String(opts.target != null ? opts.target : 20),
    spentAmount: String(opts.spent != null ? opts.spent : 0),
    targetCurrency: 'USD',
    targetCurrencySymbol: '$',
  };
  if (opts.remaining != null) tracker.remainingAmount = String(opts.remaining);
  return {
    benefitName: name,
    benefitId: opts.benefitId || `B-${name}`,
    sorBenefitId: opts.sor,
    category: opts.category || 'CREDIT',
    status: opts.status || 'ACTIVE',
    periodStartDate: opts.start || '2026-07-01',
    periodEndDate: opts.end || '2026-07-31',
    trackerDuration: opts.duration,
    tracker,
    progress: {},
  };
}

/**
 * Builds a raw catalog benefit (shape of ReadLoyaltyBenefits.v2's dict values).
 * @param {string} title The `benefitTitle` (may contain entities/tags).
 * @param {{sor: (string|undefined), layoutType: (string|undefined),
 *          enrollable: (boolean|undefined),
 *          shortTitle: (string|undefined)}=} opts Optional overrides.
 * @return {!Object} A raw catalog benefit.
 */
export function makeCatalogEntry(title, opts = {}) {
  return {
    benefitTitle: title,
    benefitShortTitle: opts.shortTitle || title,
    sorBenefitId: opts.sor || '',
    layoutType: opts.layoutType || 'ENROLLED',
    isEnrollable: opts.enrollable != null ? opts.enrollable : true,
    imageName: 'x.webp',
  };
}

/**
 * Creates a `fetch` mock driven by a scenario.
 *
 * Scenario fields:
 * - `accounts`: raw account objects (each with `account_token`).
 * - `catalog`: `{[token]: {slug: catalogEntry}}` — ReadLoyaltyBenefits.v2.
 * - `eligiblePages`: `{[token]: Array<Array<offer>>}` — one inner array per
 *   hub page.
 * - `enrolledState`: `{[token]: Array<offer>}` — mutable; the current
 *   added-to-card list per card.
 * - `onEnroll`: `(token, offerId, scenario) => enrollResponse` — returns the
 *   raw enroll response and may mutate `enrolledState` to model the server.
 *
 * @param {!Object} scenario Scenario definition.
 * @return {function(string, !Object=): !Promise<!Object>} A `fetch` mock; its
 *     `.calls` array records every request.
 */
export function createMockFetch(scenario) {
  const calls = [];

  /**
   * @param {string} url Request URL.
   * @param {!Object=} options `fetch` options.
   * @return {!Promise<!Object>} Response.
   */
  async function mockFetch(url, options = {}) {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({url, method: options.method || 'GET', body});

    if (url.endsWith('/api/servicing/v1/member')) {
      return jsonResponse({accounts: scenario.accounts || []});
    }

    if (url.includes('ReadOffersHubPresentation')) {
      const token = body.accountNumberProxy;
      if (body.requestType === 'OFFERSHUB_LANDING') {
        const pages = (scenario.eligiblePages || {})[token] || [];
        const index = body.offerPage ?
          Number(body.offerPage.replace('page', '')) - 1 : 0;
        const key = body.offerPage || 'page1';
        return jsonResponse(
          {recommendedOffers: {offersList: {[key]: pages[index] || []}}});
      }
      if (body.requestType === 'ADDEDTOCARD_LANDING') {
        if (scenario.failVerify) throw new Error('verify read failed');
        if (scenario.failVerifyTimes > 0) {
          scenario.failVerifyTimes--;
          throw new Error('verify read failed');
        }
        const items = (scenario.enrolledState || {})[token] || [];
        return jsonResponse({addedToCardViewAll: {offersList: {page1: items}}});
      }
    }

    if (url.includes('CreateOffersHubEnrollment')) {
      // Optional barrier so a test can hold every enroll open at once and
      // observe that concurrent fires all reach here before any completes.
      if (scenario.enrollGate) await scenario.enrollGate;
      const response =
          scenario.onEnroll(body.accountNumberProxy, body.offerId, scenario);
      // A handler may return a ready-made Response-like object (e.g. an HTTP
      // error built with jsonResponse) instead of a raw enroll body.
      if (response && typeof response.json === 'function') return response;
      return jsonResponse(response);
    }

    if (url.includes('ReadBestLoyaltyBenefitsTrackers')) {
      // Body is an array with one request object.
      const token = body[0].accountToken;
      const trackers = (scenario.benefits || {})[token] || [];
      return jsonResponse([{trackers}]);
    }

    if (url.includes('ReadLoyaltyBenefits.v2')) {
      // Body is a plain object; response is {cardProduct, benefits} where
      // benefits is a dict keyed by slug.
      const token = body.accountToken;
      const benefits = (scenario.catalog || {})[token] || {};
      return jsonResponse({cardProduct: {}, benefits});
    }

    throw new Error(`mock-fetch: unhandled ${options.method || 'GET'} ${url}`);
  }

  mockFetch.calls = calls;
  return mockFetch;
}

/**
 * Common `onEnroll` handlers.
 * @const
 */
export const enrollHandlers = {
  /**
   * Reports success and adds the matching eligible offer to the card's enrolled
   * list (so a re-read verifies it). Models the server: the added offer is the
   * same object — carrying the same `pznAnalyticsId` group key — as the
   * eligible one for that card.
   * @param {string} token Card token.
   * @param {string} offerId The card's own opaque offerId.
   * @param {!Object} scenario Scenario (mutated).
   * @return {!Object} Enroll response.
   */
  succeedAndAdd(token, offerId, scenario) {
    const pages = (scenario.eligiblePages || {})[token] || [];
    const offer = pages.flat().find((o) => o.offerId === offerId);
    (scenario.enrolledState[token] ||= []).push(offer || {offerId});
    return {status: {purpose: 'SUCCESS', message: 'Offer added.'}};
  },

  /**
   * Reports success but does NOT add the offer (models Amex's per-person
   * de-duplication — a "ghost" success).
   * @return {!Object} Enroll response.
   */
  succeedButGhost() {
    return {status: {purpose: 'SUCCESS', message: 'Offer added.'}};
  },

  /**
   * Reports a hard failure.
   * @return {!Object} Enroll response.
   */
  fail() {
    return {status: {purpose: 'ERROR', message: 'Not eligible.'}};
  },

  /**
   * Simulates edge throttling: an HTTP 429 with an empty body.
   * @return {!Object} A Response-like HTTP error (passed through as-is).
   */
  throttled() {
    return jsonResponse({}, false, 429);
  },
};
