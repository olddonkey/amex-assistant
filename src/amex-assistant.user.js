// ==UserScript==
// @name         Amex Assistant
// @namespace    https://github.com/olddonkey/amex-assistant
// @version      0.22.0
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
   *            family: string, digits: string, relationship: string,
   *            art: string, eligible: !Array<!Object>,
   *            enrolled: !Array<!Object>, enrolledKeys: !Set<string>,
   *            readFailed: boolean}}
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

  /**
   * Endpoint that reads a card's full benefit catalog (every perk, keyed by
   * slug, with enrollment status). Joined to the trackers by `sorBenefitId`
   * to add not-yet-enrolled benefits and cleaner titles.
   */
  const READ_CATALOG_URL = `${FUNCTIONS_ORIGIN}/ReadLoyaltyBenefits.v2`;

  /** `limit` value that asks the benefits endpoint for every tracker. */
  const BENEFIT_LIMIT = 'ALL';

  /** Locale sent with every offers request. */
  const LOCALE = 'en-US';

  /** Max cards read from Amex at once, to stay gentle on big accounts. */
  const MAX_CONCURRENT_READS = 4;

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
   * Age (ms) beyond which the snapshot behind a submit is considered stale:
   * per-card offerIds may have rotated since it was read, so the involved
   * cards are re-read and the tasks re-resolved just before sending.
   */
  const SNAPSHOT_MAX_AGE_MS = 10 * 60 * 1000;

  /**
   * `requestType` values understood by the offers hub. `OFFERSHUB_LANDING`
   * returns eligible offers; `ADDEDTOCARD_LANDING` returns already-added ones.
   * @enum {string}
   */
  const RequestType = {
    ELIGIBLE: 'OFFERSHUB_LANDING',
    ENROLLED: 'ADDEDTOCARD_LANDING',
    /** Offers with posted savings (the hub's "redeemed" list). */
    REDEEMED: 'SAVINGS_LANDING',
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
  // I18N: every user-facing panel string lives here, in both languages. The
  // catalogs must carry exactly the same keys (unit-tested). Diagnostic
  // strings that end up in results / CSV exports (server messages, HTTP
  // statuses) are NOT translated — they are data and stay stable for
  // analysis across languages.
  // ---------------------------------------------------------------------------

  /** @const {!Object<string, !Object<string, string>>} */
  const MESSAGES = {
    zh: {
      panelTitle: 'Amex 助手',
      launcherTitle: 'Amex 助手',
      refresh: '刷新',
      close: '关闭',
      // Target-language on purpose (pairs with the 'EN' glyph at the call
      // site): whoever needs this control may not read Chinese.
      switchLang: 'Switch to English',
      // Offers list
      listSubtitle: '{offers} 个 offer · {cards} 张卡',
      searchOffers: '搜索商家或 offer',
      allCards: '所有卡',
      multiOnly: '只看多卡可加',
      selectAllAddable: '全选当前可加',
      clearSelection: '清空',
      cardsReadFailed: '{n} 张卡读取失败。',
      cardsReadFailedNote:
          '{names} 的 offer 本次未能读取，列表暂不含这些卡；点右上角 ↻ 重试。',
      noMatchingOffers: '没有匹配的 offer',
      addToSelected: '加到所选卡',
      footerSelPrefix: '已选 ',
      footerSelMid: ' 个 offer，将尝试添加到 ',
      footerSelSuffix: ' 张卡',
      addedToAll: '已添加到 {n} 张卡',
      addableN: '可加 {n}',
      addedN: '已加 {n}',
      chooseCards: '选择要加到哪些卡',
      addedMark: '已加 ✓',
      expiresShort: '至 {date}',
      // Last-run strip
      lastRunPrefix: '上次添加：',
      lastRunConfirmed: '{n} 确认已加',
      lastRunFailed: '{n} 失败',
      lastRunDedupe: '{n} 疑似去重',
      view: '查看',
      today: '今天 {time}',
      yesterday: '昨天 {time}',
      // Loading
      loadingSubtitle: '一个 offer，加到多张卡',
      loadingOffers: '正在读取每张卡的 offer…',
      loadingCardN: '第 {done} / {total} 张卡',
      loadingCardList: '正在读取卡列表…',
      loadingReadOnly: '这里只读取 offer 列表，不会改动账户',
      // Confirm dialog
      confirmTitle: '确认添加到 {n} 张卡？',
      confirmBody1: '已选 {offers} 个 offer，共 {cards} 张卡。系统会',
      confirmBodyBold: '一次性提交这些请求',
      confirmBody2: '；提交后不能撤销。完成后会重新读取已添加列表，逐张卡核对。',
      confirmRowCards: '{name} → {n} 张卡',
      cancel: '取消',
      confirmSubmit: '确认提交',
      // Running
      runningTitle: '正在添加到卡上…',
      runningSubtitle: '已提交 {n} 个添加请求',
      processedOf: '已处理 {done} / {total}',
      submitOk: '提交成功',
      submitFail: '提交失败',
      submitting: '提交中',
      notSubmitted: '未提交',
      runningNote: '提交完成后会重新读取已添加列表，逐张卡核对结果',
      // Result
      resultTitleOk: '添加完成，已核对',
      resultTitleStopped: '已停止本轮添加',
      resultSubtitle: '已处理 {n} 个添加请求',
      confirmedAdded: '确认已加',
      addFailed: '添加失败',
      dedupeOrUnknown: '疑似去重/无法确认',
      throttledTitle: '检测到限流或拦截。',
      throttledBody: '收到 429/403 或异常响应后，剩余请求已经停止，' +
          '也没有继续复查。建议等几分钟再点「重试未完成项」，不要马上反复提交。',
      dedupeHelpTitle: '什么是疑似去重？',
      dedupeHelpBody: 'Amex 接口返回添加成功，但重新读取已添加列表时，' +
          '这张卡上没有看到该 offer，就会归到这里。常见原因是同一个 offer ' +
          '可能只能加到一张卡；「无法确认」表示复查未完成。',
      secSkipped: '未提交 — 检测到限流后中止',
      secGhost: '疑似去重 — 接口成功，但复查没看到',
      secUnverified: '无法确认 — 复查未完成',
      retryUnfinished: '重试未完成项',
      exportCsv: '导出 CSV',
      backToList: '返回列表',
      runInterrupted: '添加过程中断：{msg}',
      // Empty / error
      emptyTitle: '暂无可加的 offer',
      emptyBody: '当前 offer 都已添加到可用的卡上。',
      reload: '↻ 重新读取',
      errorTitle: '读取 offer 列表失败',
      errorSessionHint: '登录状态可能已过期。请先在当前页面登录 Amex，再重试。',
      retry: '重试',
      cardsReadAllFailed: '卡片 offer 读取失败，请稍后重试。',
      // Benefits
      primaryCardsN: '{n} 张主卡',
      updatedJustNow: '刚刚更新',
      updatedMinsAgo: '{n} 分钟前更新',
      updatedHoursAgo: '{n} 小时前更新',
      loadingBenefits: '正在读取每张卡的 benefit 信息…',
      benefitsReadOnly: '只读查看，不会改动账户',
      benefitsReadFailed: '读取失败',
      searchBenefits: '搜索 benefit 或卡',
      sortByExpiry: '按到期时间排序 ',
      unusedOnly: '只看还有余额的',
      benefitsFootnote: '金额来自 Amex 的 benefit 进度 · 只读查看，不在本地保存数据',
      noBenefitsMatch: '没有匹配「{q}」的 benefit',
      noBenefits: '这些卡上没有可追踪的 benefit',
      leftThisMonth: '本月剩余额度',
      redeemedYtd: '今年已抵扣',
      feeOffset: '已抵年费 {spent}/{fee}',
      trackedOnly: '仅含可自动追踪的项目',
      trackedOnly2: '按可追踪项目',
      usedUpSection: '本周期已用完',
      xCards: '×{n} 张卡',
      notActivated: '待开启',
      activate: '去开启 ↗',
      expired: '已过期',
      daysLeft: '还剩 {n} 天',
      // Added (redeem-tracking) sub-view
      subAddable: '可加',
      subAdded: '已加',
      sortShortExpiry: '按到期',
      statRedeemed: '已返现',
      statPending: '待消费',
      statExpiring: '7 天内过期',
      redeemedOfCards: '{x} / {y} 卡已返现',
      totalRedeemed: '共返 {amt}',
      noCashbackSeen: '未见返现',
      cashbackPosted: '✓ 已返现',
      pointsAmount: '{n} 点',
      noAddedOffers: '还没有已加的 offer',
      addedLoading: '正在读取返现记录…',
      addedError: '返现记录读取失败。',
      addedFootnote:
          '消费状态按返现入账记录归类，入账通常延迟 1–5 天 · 以 Amex 为准',
      period_month: '月',
      period_quarter: '季',
      period_half: '半年',
      period_year: '年',
    },
    en: {
      panelTitle: 'Amex Assistant',
      launcherTitle: 'Amex Assistant',
      refresh: 'Refresh',
      close: 'Close',
      // Target-language on purpose; see zh.switchLang.
      switchLang: '切换到中文',
      // Offers list
      listSubtitle: '{offers} offers · {cards} cards',
      searchOffers: 'Search merchants or offers',
      allCards: 'All cards',
      multiOnly: 'Multi-card only',
      selectAllAddable: 'Select all eligible',
      clearSelection: 'Clear',
      cardsReadFailed: '{n} card(s) could not be read.',
      cardsReadFailedNote: 'Offers on {names} could not be read this time ' +
          'and are not listed; click ↻ (top right) to retry.',
      noMatchingOffers: 'No matching offers',
      addToSelected: 'Add to selected cards',
      footerSelPrefix: 'Selected ',
      footerSelMid: ' offer(s) · will try adding to ',
      footerSelSuffix: ' card(s)',
      addedToAll: 'Added to all {n} cards',
      addableN: '{n} eligible',
      addedN: '{n} added',
      chooseCards: 'Choose which cards to add to',
      addedMark: 'Added ✓',
      expiresShort: 'Expires {date}',
      // Last-run strip
      lastRunPrefix: 'Last run: ',
      lastRunConfirmed: '{n} confirmed',
      lastRunFailed: '{n} failed',
      lastRunDedupe: '{n} possible duplicate(s)',
      view: 'View',
      today: 'Today {time}',
      yesterday: 'Yesterday {time}',
      // Loading
      loadingSubtitle: 'One offer, multiple cards',
      loadingOffers: 'Reading offers on each card…',
      loadingCardN: 'Card {done} / {total}',
      loadingCardList: 'Reading your card list…',
      loadingReadOnly: 'Read-only at this step — nothing on the account ' +
          'changes',
      // Confirm dialog
      confirmTitle: 'Add to {n} cards?',
      confirmBody1: '{offers} offer(s) selected across {cards} card(s). ' +
          'This will ',
      confirmBodyBold: 'submit all requests at once',
      confirmBody2: ' and cannot be undone. Afterwards the added list is ' +
          're-read to verify each card.',
      confirmRowCards: '{name} → {n} card(s)',
      cancel: 'Cancel',
      confirmSubmit: 'Confirm & submit',
      // Running
      runningTitle: 'Adding to cards…',
      runningSubtitle: '{n} add requests submitted',
      processedOf: '{done} / {total} processed',
      submitOk: 'Submitted',
      submitFail: 'Failed',
      submitting: 'Submitting',
      notSubmitted: 'Not submitted',
      runningNote: 'When done, added lists are re-read to verify each card',
      // Result
      resultTitleOk: 'Done — verified',
      resultTitleStopped: 'Run stopped early',
      resultSubtitle: '{n} add requests processed',
      confirmedAdded: 'Confirmed',
      addFailed: 'Failed',
      dedupeOrUnknown: 'Possible duplicate / unconfirmed',
      throttledTitle: 'Throttling or interception detected.',
      throttledBody: 'After a 429/403 or an abnormal response, the ' +
          'remaining requests were stopped and verification was skipped. ' +
          'Wait a few minutes before pressing "Retry unfinished" — do not ' +
          'resubmit right away.',
      dedupeHelpTitle: 'What is "possible duplicate"?',
      dedupeHelpBody: 'Amex reported success, but on re-reading the ' +
          'added list the offer was not on this card. Usually the same ' +
          'offer can only be added to one card. "Unconfirmed" means ' +
          'verification could not finish.',
      secSkipped: 'Not submitted — stopped after a throttle signal',
      secGhost: 'Possible duplicate — success reported, absent on re-read',
      secUnverified: 'Unconfirmed — verification incomplete',
      retryUnfinished: 'Retry unfinished',
      exportCsv: 'Export CSV',
      backToList: 'Back to list',
      runInterrupted: 'Run interrupted: {msg}',
      // Empty / error
      emptyTitle: 'No offers to add',
      emptyBody: 'Every offer is already on the cards it can go to.',
      reload: '↻ Reload',
      errorTitle: 'Could not read the offers list',
      errorSessionHint: 'Your session may have expired. Sign in to Amex on ' +
          'this page, then retry.',
      retry: 'Retry',
      cardsReadAllFailed: 'Could not read card offers. Please try again ' +
          'later.',
      // Benefits
      primaryCardsN: '{n} primary card(s)',
      updatedJustNow: 'Updated just now',
      updatedMinsAgo: 'Updated {n} min ago',
      updatedHoursAgo: 'Updated {n} h ago',
      loadingBenefits: 'Reading benefits on each card…',
      benefitsReadOnly: 'Read-only — nothing on the account changes',
      benefitsReadFailed: 'Read failed',
      searchBenefits: 'Search benefits or cards',
      sortByExpiry: 'Sorted by expiry ',
      unusedOnly: 'Unused balance only',
      benefitsFootnote: 'Amounts come from Amex benefit trackers · ' +
          'read-only, nothing stored locally',
      noBenefitsMatch: 'No benefits match "{q}"',
      noBenefits: 'No trackable benefits on these cards',
      leftThisMonth: 'Left this month',
      redeemedYtd: 'Redeemed this year',
      feeOffset: 'Fee offset {spent}/{fee}',
      trackedOnly: 'Auto-tracked credits only',
      trackedOnly2: 'Tracked credits only',
      usedUpSection: 'Used up this period',
      xCards: '×{n} cards',
      notActivated: 'Not activated',
      activate: 'Activate ↗',
      expired: 'Expired',
      daysLeft: '{n} days left',
      // Added (redeem-tracking) sub-view
      subAddable: 'Addable',
      subAdded: 'Added',
      sortShortExpiry: 'By expiry',
      statRedeemed: 'Cashback posted',
      statPending: 'To spend',
      statExpiring: 'Expiring in 7 days',
      redeemedOfCards: '{x} / {y} cards posted',
      totalRedeemed: '{amt} total back',
      noCashbackSeen: 'No cashback yet',
      cashbackPosted: '✓ Posted',
      pointsAmount: '{n} pts',
      noAddedOffers: 'No added offers yet',
      addedLoading: 'Reading cashback records…',
      addedError: 'Could not read cashback records.',
      addedFootnote: 'Spend status comes from posted cashback records, ' +
          'which usually lag 1–5 days · Amex is authoritative',
      period_month: 'mo',
      period_quarter: 'qtr',
      period_half: '6 mo',
      period_year: 'yr',
    },
  };

  /** The active panel language ('zh' | 'en'). */
  let currentLang = 'zh';

  /**
   * Sets the active language; unknown codes fall back to English.
   * @param {string} lang Language code.
   */
  function setLanguage(lang) {
    currentLang = MESSAGES[lang] ? lang : 'en';
  }

  /** @return {string} The active language code. */
  function getLanguage() {
    return currentLang;
  }

  /**
   * Looks up a UI string in the active language, interpolating `{name}`
   * placeholders from `params`. Unknown keys return the key itself so a
   * missing translation degrades visibly instead of crashing.
   * @param {string} key Catalog key.
   * @param {!Object<string, *>=} params Placeholder values.
   * @return {string} The localized string.
   */
  function t(key, params) {
    const table = MESSAGES[currentLang] || MESSAGES.zh;
    let text = table[key] != null ? table[key] :
      (MESSAGES.zh[key] != null ? MESSAGES.zh[key] : key);
    if (params) {
      for (const [name, value] of Object.entries(params)) {
        text = text.split(`{${name}}`).join(String(value));
      }
    }
    return text;
  }

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
   * Runs a request, re-sending it quickly when it fails with a transient
   * error (network hiccup or 5xx). Definitive answers — other 4xx, blocked
   * signals, non-JSON — are thrown through untouched. For idempotent reads
   * only; enroll has its own window-sensitive retry policy in
   * {@link attemptEnroll}.
   *
   * @param {function(): !Promise<T>} fn The request to run.
   * @param {function(): !Promise<void>=} retryDelay Pause between tries.
   * @param {number=} retries Extra attempts after the first.
   * @return {!Promise<T>} `fn`'s result.
   * @template T
   */
  async function retryTransient(fn, retryDelay = randomRetryDelay,
    retries = 1) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (!error.transient || attempt >= retries) throw error;
        await retryDelay();
      }
    }
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
   * @param {function(): !Promise<void>=} retryDelay Pause between read tries.
   * @return {!Promise<!Array<!Object>>} Raw account objects.
   */
  async function fetchAccounts(retryDelay = randomRetryDelay) {
    const data = await retryTransient(() => getJson(MEMBER_URL), retryDelay);
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
   * empty page is returned. Each page read retries once on a transient error.
   *
   * @param {string} token The card's `account_token`.
   * @param {function(): !Promise<void>=} retryDelay Pause between read tries.
   * @return {!Promise<!Array<!Object>>} Raw eligible offers.
   */
  async function fetchEligibleOffers(token, retryDelay = randomRetryDelay) {
    const offers = [];
    for (let i = 1; i <= MAX_PAGES; i++) {
      const page = `page${i}`;
      const data = await retryTransient(
        () => readOffersHub(token, RequestType.ELIGIBLE, page), retryDelay);
      const items = getPath(data, `recommendedOffers.offersList.${page}`);
      if (!Array.isArray(items) || items.length === 0) break;
      for (const offer of items) {
        if (offer.offerType === OFFER_TYPE) offers.push(offer);
      }
    }
    return offers;
  }

  /**
   * Fetches the offers already added to a card (single page). Retries once on
   * a transient error.
   *
   * @param {string} token The card's `account_token`.
   * @param {function(): !Promise<void>=} retryDelay Pause between read tries.
   * @return {!Promise<!Array<!Object>>} Raw added-to-card offers.
   */
  async function fetchEnrolledOffers(token, retryDelay = randomRetryDelay) {
    const data = await retryTransient(
      () => readOffersHub(token, RequestType.ENROLLED), retryDelay);
    const items = getPath(data, 'addedToCardViewAll.offersList.page1');
    return Array.isArray(items) ? items : [];
  }

  /**
   * Reads a card's added offers and returns their group keys as a set.
   * @param {string} token The card's `account_token`.
   * @param {function(): !Promise<void>=} retryDelay Pause between read tries.
   * @return {!Promise<!Set<string>>} Added-offer group keys.
   */
  async function fetchEnrolledKeys(token, retryDelay = randomRetryDelay) {
    const offers = await fetchEnrolledOffers(token, retryDelay);
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
   * Maps `fn` over `items` with at most `limit` running concurrently,
   * preserving input order. Caps how many cards we read from Amex at once.
   * @param {!Array<T>} items Items to map.
   * @param {number} limit Max concurrent invocations.
   * @param {function(T, number): !Promise<R>} fn Async mapper.
   * @return {!Promise<!Array<R>>} Results in input order.
   * @template T, R
   */
  async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    };
    const count = Math.max(1, Math.min(limit, items.length));
    await Promise.all(Array.from({length: count}, () => worker()));
    return results;
  }

  /**
   * Reads all cards and their eligible offers plus already-added group keys.
   *
   * The account list is fetched first so the real card count is known before
   * any card is read; `onProgress` then fires once per card (starting at 0)
   * with the running total, letting the loading UI show honest progress.
   *
   * Reads retry once on transient errors. A card whose reads still fail comes
   * back with empty lists and `readFailed: true` instead of sinking the whole
   * load — except on a blocked signal (throttle / interception), which aborts
   * the snapshot so we stop reading into a wall.
   *
   * @param {function(number, number)=} onProgress Called `(done, total)` as
   *     each card finishes reading. Defaults to a no-op.
   * @param {{retryDelay: (function(): !Promise<void>|undefined)}=} options
   *     Behavior overrides (tests inject a no-op delay).
   * @return {!Promise<!Array<!CardSnapshot>>} Per-card snapshot.
   */
  async function snapshot(onProgress = () => {}, options = {}) {
    const {retryDelay = randomRetryDelay} = options;
    const accounts = flattenAccounts(await fetchAccounts(retryDelay))
      .filter((account) => account.account_token);
    const total = accounts.length;
    onProgress(0, total);
    // Read cards concurrently but capped (was fully serial, i.e. slow on an
    // 8-card account). Reads within a card stay sequential, so at most
    // MAX_CONCURRENT_READS requests are in flight.
    let done = 0;
    return mapLimit(accounts, MAX_CONCURRENT_READS, async (account) => {
      const token = account.account_token;
      let eligible = [];
      let enrolled = [];
      let readFailed = false;
      try {
        eligible = await fetchEligibleOffers(token, retryDelay);
        enrolled = await fetchEnrolledOffers(token, retryDelay);
      } catch (error) {
        // A blocked signal means every further read would hit the same wall
        // — abort the whole load. Anything else skips just this card.
        if (error.blocked) throw error;
        readFailed = true;
      }
      onProgress(++done, total);
      return {
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
        enrolledKeys: new Set(enrolled.map(offerGroupKey).filter(Boolean)),
        readFailed,
      };
    });
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
   * Returns a language-neutral cadence key; the UI localizes it via the
   * `period_*` catalog entries.
   * @param {!Object} tracker Raw tracker object.
   * @return {string} One of `month` / `quarter` / `half` / `year`, or `''`.
   */
  function benefitPeriodLabel(tracker) {
    const start = Date.parse(tracker.periodStartDate);
    const end = Date.parse(tracker.periodEndDate);
    if (!Number.isNaN(start) && !Number.isNaN(end)) {
      const days = Math.round((end - start) / 86400000);
      if (days <= 45) return 'month';
      if (days <= 135) return 'quarter';
      if (days <= 250) return 'half';
      return 'year';
    }
    const dur = String(tracker.trackerDuration || '').toUpperCase();
    if (dur.includes('MONTH')) return 'month';
    if (dur.includes('QUARTER')) return 'quarter';
    if (dur.includes('SEMI') || dur.includes('HALF')) return 'half';
    if (dur.includes('YEAR') || dur.includes('ANNUAL')) return 'year';
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
   * A stable grouping key for a benefit, derived from its display name. The
   * same benefit has a different `sorBenefitId` on each card product, so
   * grouping by (normalized) name is what merges e.g. the ChatGPT credit across
   * a Platinum and a Business Gold into one row.
   * @param {string} name Benefit display name.
   * @return {string} Normalized key.
   */
  function benefitNameKey(name) {
    return String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /**
   * Whether a tracker is a dollar credit we should show (and count in stats).
   * Excludes `category === "spend"` (spend-to-unlock milestones like Centurion
   * / Delta Sky Club, whose target is a huge spend goal, not a credit) and
   * pass-based perks (`targetUnit === "PASSES"`, e.g. lounge visits) that are
   * not dollar amounts.
   * @param {!Object} tracker Raw tracker object.
   * @return {boolean} True for a spendable dollar credit.
   */
  function isTrackedCredit(tracker) {
    const cat = String(tracker.category || '').toLowerCase();
    const unit = String((tracker.tracker || {}).targetUnit || '').toUpperCase();
    return cat !== 'spend' && unit !== 'PASSES';
  }

  /**
   * Reads a card's benefit catalog (every perk keyed by slug). The body is a
   * plain object (the array form is rejected). Returns {} on any failure so the
   * tracker view still works without it.
   * @param {string} token The card's `account_token`.
   * @return {!Promise<!Object>} The `benefits` dict, or {} on failure.
   */
  async function fetchCardCatalog(token) {
    try {
      const data = await postJson(READ_CATALOG_URL,
        {accountToken: token, locale: LOCALE});
      return data && data.benefits ? data.benefits : {};
    } catch {
      return {};
    }
  }

  /**
   * Strips tags and decodes HTML entities from an API title for plain-text
   * display (rendered via textContent, so this is for readability, not safety).
   * @param {string} s Raw title.
   * @return {string} Decoded plain text.
   */
  function decodeHtml(s) {
    return String(s || '')
      .replace(/<[^>]+>/g, '')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .trim();
  }

  /**
   * Extracts the dollar amount from a benefit title (e.g. "$209 CLEAR+ Credit"
   * → 209), so a not-yet-enrolled benefit can show its credit value.
   * @param {string} title Benefit title.
   * @return {number} Parsed amount, or 0.
   */
  function parseCreditAmount(title) {
    const m = /\$([0-9][0-9,]*)/.exec(String(title));
    return m ? parseFloat(m[1].replace(/,/g, '')) : 0;
  }

  /**
   * Builds a benefit entry for a not-yet-enrolled catalog benefit.
   * @param {!Object} entry Raw catalog benefit.
   * @param {!Object} card A snapshot card.
   * @return {!Object} Normalized (not-enrolled) benefit.
   */
  function catalogBenefit(entry, card) {
    const name = decodeHtml(
      entry.benefitShortTitle || entry.benefitTitle || entry.benefitName || '');
    const target = parseCreditAmount(name);
    return {
      sorBenefitId: entry.sorBenefitId || '',
      benefitId: entry.sorBenefitId || '',
      name,
      category: '',
      status: 'NOTENROLLED',
      period: 'year',
      periodEnd: '',
      symbol: '$',
      target,
      spent: 0,
      remaining: target,
      token: card.token,
      family: card.family,
      digits: card.digits,
      art: card.art,
    };
  }

  /**
   * Reads benefits for every BASIC (owned) card: the spend trackers plus the
   * catalog. The catalog supplies cleaner titles (joined by `sorBenefitId`) and
   * the not-yet-enrolled benefits (`layoutType === 'NOTENROLLED'`) that never
   * appear as trackers. `onProgress(done, total)` fires per card.
   * @param {!Array<!Object>} cards Snapshot cards.
   * @param {function(number, number)=} onProgress Progress callback.
   * @return {!Promise<!Array<!Object>>} Card-tagged benefits.
   */
  async function fetchAllBenefits(cards, onProgress = () => {}) {
    const owned = cards.filter((c) => (c.relationship || 'BASIC') === 'BASIC');
    const total = owned.length;
    onProgress(0, total);
    // Read cards concurrently but capped; reads within a card stay sequential,
    // so at most MAX_CONCURRENT_READS requests are in flight at once.
    let done = 0;
    const perCard = await mapLimit(owned, MAX_CONCURRENT_READS,
      async (card) => {
        const trackers = await retryTransient(
          () => fetchAccountBenefits(card.token));
        const catalog = await retryTransient(
          () => fetchCardCatalog(card.token));
        onProgress(++done, total);
        return {card, trackers, catalog};
      });
    const catalogs = perCard.map(({card, catalog}) => ({card, catalog}));
    const benefits = [];
    for (const {card, trackers} of perCard) {
      for (const t of trackers) {
        if (isTrackedCredit(t)) benefits.push(normalizeBenefit(t, card));
      }
    }

    // Prefer the catalog's clean title where it maps to a tracker (fixes names
    // like "Congratulations!" that the tracker returns for achieved benefits).
    const titleBySor = new Map();
    for (const {catalog} of catalogs) {
      for (const slug of Object.keys(catalog)) {
        const c = catalog[slug];
        if (c.sorBenefitId && c.benefitTitle) {
          titleBySor.set(c.sorBenefitId, decodeHtml(c.benefitTitle));
        }
      }
    }
    for (const b of benefits) {
      const title = titleBySor.get(b.sorBenefitId);
      if (title) b.name = title;
    }

    // Add not-yet-enrolled benefits (no tracker on any card) as "去激活" rows,
    // deduped by name so a benefit enrollable on several cards shows once.
    const tracked = new Set(benefits.map((b) => benefitNameKey(b.name)));
    const added = new Set();
    for (const {card, catalog} of catalogs) {
      for (const slug of Object.keys(catalog)) {
        const c = catalog[slug];
        if (c.layoutType !== 'NOTENROLLED' || !c.isEnrollable) continue;
        if (!c.sorBenefitId) continue;
        const b = catalogBenefit(c, card);
        // Only surface dollar-credit perks (e.g. CLEAR $189), not status/link
        // benefits like "Link Your Resy Profile" that have no amount.
        if (b.target <= 0) continue;
        const nameKey = benefitNameKey(b.name);
        if (tracked.has(nameKey) || added.has(nameKey)) continue;
        added.add(nameKey);
        benefits.push(b);
      }
    }
    return benefits;
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
   * Groups card-tagged benefits across cards by normalized name (so the same
   * benefit on different card products merges) and sorts soonest-expiry first.
   * @param {!Array<!Object>} benefits Card-tagged benefits.
   * @param {number=} now Epoch ms treated as "today".
   * @return {!Array<!Object>} Grouped benefits, soonest-to-expire first.
   */
  function buildBenefitIndex(benefits, now = Date.now()) {
    const byKey = new Map();
    for (const b of benefits) {
      const key = benefitNameKey(b.name) ||
          b.sorBenefitId || `${b.token}:${b.benefitId}`;
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

  // ---------------------------------------------------------------------------
  // Redeem tracking (the "added" sub-view): group the added offers across
  // cards and mark each (offer, card) pair by whether a cashback posting
  // exists for it. Honest framing throughout: we only see posting records —
  // a pair is "no cashback seen", never "not spent" (postings lag spend by
  // days, and some offers credit in other ways).
  // ---------------------------------------------------------------------------

  /**
   * Fetches the offers with posted savings for a card. Retries once on a
   * transient error. Tolerates both the paginated (`page1`) and flat-array
   * shapes of the savings list.
   * @param {string} token The card's `account_token`.
   * @param {function(): !Promise<void>=} retryDelay Pause between read tries.
   * @return {!Promise<!Array<!Object>>} Raw redeemed offers.
   */
  async function fetchRedeemedOffers(token, retryDelay = randomRetryDelay) {
    const data = await retryTransient(
      () => readOffersHub(token, RequestType.REDEEMED), retryDelay);
    const node =
        getPath(data, 'offersSavingsViewAll.savingsOffers.offersList');
    if (Array.isArray(node)) return node;
    const page = getPath(node, 'page1');
    return Array.isArray(page) ? page : [];
  }

  /** Candidate paths that may hold a redemption's credited amount. */
  const REDEEM_AMOUNT_PATHS = ['savingsAmount', 'creditAmount', 'savedAmount',
    'statementCreditAmount', 'amount', 'savings.amount'];

  /** Candidate paths that may hold a redemption's posting date. */
  const REDEEM_DATE_PATHS = ['redemptionDate', 'creditDate', 'postedDate',
    'transactionDate', 'savings.date', 'date'];

  /** Candidate paths whose presence marks a points-based posting. */
  const REDEEM_POINTS_PATHS = ['points', 'pointsEarned', 'rewardPoints',
    'membershipRewardsPoints', 'totalPoints'];

  /**
   * Whether a raw redeemed offer credits points/miles rather than dollars
   * (e.g. "Earn +1 Membership Rewards point per eligible dollar"). Points
   * values must never be summed as money. Checks points-ish fields first,
   * then the offer's own wording.
   * @param {!Object} offer Raw redeemed offer.
   * @return {boolean} True for a points/miles posting.
   */
  function isPointsRedemption(offer) {
    for (const path of REDEEM_POINTS_PATHS) {
      const value = getPath(offer, path);
      if (value == null || value === '') continue;
      const n = parseFloat(String(value).replace(/[^0-9.]/g, ''));
      if (Number.isFinite(n) && n > 0) return true;
    }
    const text = [offer.title, offer.name, offer.shortDescription,
      getPath(offer, 'rewardType'), getPath(offer, 'offerRewardType'),
      getPath(offer, 'rewardsType')].filter(Boolean).join(' ');
    return /point|membership rewards|\bmiles\b/i.test(text);
  }

  /**
   * Extracts the credited amount from a raw redeemed offer, tolerating both
   * numeric and `"$12.50"`-style fields across the candidate paths.
   * @param {!Object} offer Raw redeemed offer.
   * @return {number} Credited amount, or 0 when unknown.
   */
  function redemptionAmount(offer) {
    for (const path of REDEEM_AMOUNT_PATHS) {
      const value = getPath(offer, path);
      if (value == null || value === '') continue;
      const n = typeof value === 'number' ? value :
        parseFloat(String(value).replace(/[^0-9.]/g, ''));
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 0;
  }

  /**
   * Extracts a redemption's posting date as `M/D`. Parses ISO and `M/D`
   * shapes with regexes (never `Date.parse`, whose UTC midnight shifts the
   * day in western timezones).
   * @param {!Object} offer Raw redeemed offer.
   * @return {string} `M/D`, or '' when unknown.
   */
  function redemptionDate(offer) {
    for (const path of REDEEM_DATE_PATHS) {
      const value = getPath(offer, path);
      if (!value) continue;
      const s = String(value);
      let m = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
      if (m) return `${Number(m[2])}/${Number(m[3])}`;
      m = /(\d{1,2})\/(\d{1,2})/.exec(s);
      if (m) return `${Number(m[1])}/${Number(m[2])}`;
    }
    return '';
  }

  /**
   * Days until an added offer expires, from whichever expiration field is
   * present. Text like `7/9` without a year is assumed to be the upcoming
   * occurrence (offers expire in the future).
   * @param {!Object} offer Raw offer object.
   * @param {number=} now Epoch ms treated as "today".
   * @return {number} Whole days left (negative when past), or Infinity when
   *     unparsable — unknown expiries sort last, they don't shout "urgent".
   */
  function offerExpiryDays(offer, now = Date.now()) {
    // Calendar-day difference (expiring the day after tomorrow = 2), the
    // colloquial reading of "N days left".
    const nowDate = new Date(now);
    const today = new Date(nowDate.getFullYear(), nowDate.getMonth(),
      nowDate.getDate()).getTime();
    const dayDiff = (end) => Math.round((end.getTime() - today) / 86400000);
    const iso = String(getPath(offer, 'expiration.date') ||
        offer.expirationDate || '');
    let m = /(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    if (m) return dayDiff(new Date(+m[1], +m[2] - 1, +m[3]));
    m = /(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/
      .exec(getPath(offer, 'expiration.text') || '');
    if (!m) return Infinity;
    let year = m[3] ? Number(m[3]) : nowDate.getFullYear();
    if (year < 100) year += 2000;
    let end = new Date(year, Number(m[1]) - 1, Number(m[2]));
    if (!m[3] && dayDiff(end) < 0) {
      end = new Date(year + 1, Number(m[1]) - 1, Number(m[2]));
    }
    return dayDiff(end);
  }

  /**
   * Builds the "added" view's index: every offer present on any card's added
   * list OR savings list, grouped across cards by {@link offerGroupKey}.
   * Redeemed-only offers are included so a fully-redeemed offer still shows
   * after Amex drops it from the added list. Each group's `cards[i]` carries
   * that card's redemption record (null when no posting was seen). Groups
   * sort by expiry urgency; fully-redeemed groups sink to the bottom.
   *
   * @param {!Array<!CardSnapshot>} cards Per-card snapshot (uses `enrolled`).
   * @param {!Map<string, !Array<!Object>>=} redeemedByToken Raw redeemed
   *     offers per card token; empty → everything shows as no-posting-seen.
   * @param {number=} now Epoch ms treated as "today".
   * @return {!Array<!Object>} Added-offer groups.
   */
  function buildAddedIndex(cards, redeemedByToken = new Map(),
    now = Date.now()) {
    const byKey = new Map();
    const groupFor = (offer) => {
      const key = offerGroupKey(offer);
      if (!key) return null;
      let g = byKey.get(key);
      if (!g) {
        g = {key, name: offer.title || offer.name || key,
          description: offer.shortDescription || '',
          image: offer.image || '',
          expiry: getPath(offer, 'expiration.text') || '',
          daysLeft: offerExpiryDays(offer, now),
          cards: [], cardIndex: new Map()};
        byKey.set(key, g);
      } else {
        // Later sightings (e.g. the savings copy) may carry fields the first
        // one lacked.
        if (!g.description && offer.shortDescription) {
          g.description = offer.shortDescription;
        }
        if (!Number.isFinite(g.daysLeft)) {
          g.daysLeft = offerExpiryDays(offer, now);
        }
      }
      return g;
    };
    const entryFor = (g, token) => {
      let e = g.cardIndex.get(token);
      if (!e) {
        e = {token, redeemed: null};
        g.cardIndex.set(token, e);
        g.cards.push(e);
      }
      return e;
    };
    for (const card of cards) {
      const seen = new Set();
      for (const offer of card.enrolled || []) {
        const g = groupFor(offer);
        if (!g || seen.has(g.key)) continue;
        seen.add(g.key);
        entryFor(g, card.token);
      }
      for (const offer of redeemedByToken.get(card.token) || []) {
        const g = groupFor(offer);
        if (!g) continue;
        const e = entryFor(g, card.token);
        if (!e.redeemed) {
          e.redeemed = {amount: redemptionAmount(offer),
            unit: isPointsRedemption(offer) ? 'points' : 'usd',
            date: redemptionDate(offer)};
        }
      }
    }
    const groups = [...byKey.values()];
    for (const g of groups) {
      delete g.cardIndex;
      g.redeemedCount = g.cards.filter((c) => c.redeemed).length;
      const sum = (unit) => round2(g.cards.reduce((total, c) =>
        total + (c.redeemed && c.redeemed.unit === unit ?
          c.redeemed.amount : 0), 0));
      // Dollars and points are separate ledgers — never added together.
      g.totalRedeemedUsd = sum('usd');
      g.totalRedeemedPoints = sum('points');
      g.fullyRedeemed =
          g.cards.length > 0 && g.redeemedCount === g.cards.length;
    }
    const order = (g) => Number.isFinite(g.daysLeft) ? g.daysLeft : 1e9;
    return groups.sort((a, b) => {
      if (a.fullyRedeemed !== b.fullyRedeemed) return a.fullyRedeemed ? 1 : -1;
      return order(a) - order(b);
    });
  }

  /**
   * Header stats for the added view. `redeemedAmount` is dollars only —
   * points postings are tallied separately and never converted to money.
   * @param {!Array<!Object>} groups Added-offer groups.
   * @return {{redeemedAmount: number, redeemedPoints: number,
   *           pending: number, expiring: number}} Posted cashback dollars,
   *     posted points, groups not yet fully redeemed, and how many of those
   *     expire within 7 days.
   */
  function addedStats(groups) {
    let redeemedAmount = 0;
    let redeemedPoints = 0;
    let pending = 0;
    let expiring = 0;
    for (const g of groups) {
      redeemedAmount += g.totalRedeemedUsd;
      redeemedPoints += g.totalRedeemedPoints;
      if (!g.fullyRedeemed) {
        pending++;
        if (Number.isFinite(g.daysLeft) && g.daysLeft >= 0 &&
            g.daysLeft <= 7) {
          expiring++;
        }
      }
    }
    return {redeemedAmount: round2(redeemedAmount),
      redeemedPoints: Math.round(redeemedPoints), pending, expiring};
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
   * Reads a card's added-offer keys, tolerating failure. Transient errors
   * already retry inside {@link fetchEnrolledKeys}; anything that still fails
   * returns null so the card's attempts classify UNVERIFIED instead of the
   * whole run throwing.
   *
   * @param {string} token The card's `account_token`.
   * @param {function(): !Promise<void>} retryDelay Pause between read tries.
   * @return {!Promise<?Set<string>>} Added-offer keys, or null if unreadable.
   */
  async function readEnrolledKeysSafe(token, retryDelay) {
    try {
      return await fetchEnrolledKeys(token, retryDelay);
    } catch {
      return null;
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
    const retryable = results.filter((result) =>
      (result.state === ResultState.FAILED ||
       result.state === ResultState.SKIPPED) && !result.gone);
    const {tasks, landed, gone} = resolveTasks(retryable, offers);
    const note = 'offer no longer listed for this card';
    return {
      tasks,
      landed: landed.map((r) => ({...r, state: ResultState.VERIFIED,
        message: 'already on the card (found before retrying)'})),
      gone: gone.map((r) => ({...r, gone: true,
        message: r.message ? `${r.message} · ${note}` : note})),
    };
  }

  /**
   * Re-resolves task-like items against a fresh offer index. Pure: no I/O.
   *
   * Per-card offerIds can rotate between reads, so an item built from an older
   * snapshot may carry a stale token; each one is re-resolved to the card's
   * current `offerId` by group key. Items whose card now shows the offer as
   * added come back in `landed`; items whose card no longer lists the offer
   * come back in `gone` (the enrollment window is closed). Both are returned
   * as given, untouched.
   *
   * @param {!Array<!Object>} items Items with `token`, `key`, `name`.
   * @param {!Array<!OfferGroup>} offers The current offer index.
   * @return {{tasks: !Array<!Task>, landed: !Array<!Object>,
   *           gone: !Array<!Object>}} Re-resolved tasks plus the items that
   *     need no send.
   */
  function resolveTasks(items, offers) {
    const tasks = [];
    const landed = [];
    const gone = [];
    for (const item of items) {
      const group = offers.find((g) => g.key === item.key);
      const card = group && group.cards.find((c) => c.token === item.token);
      if (card && card.enrolled) {
        landed.push(item);
      } else if (!card) {
        gone.push(item);
      } else {
        tasks.push({token: item.token, offerId: card.offerId,
          key: item.key, name: item.name});
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
    mapLimit,
    retryTransient,
    snapshot,
    executeSelected,
    planRetry,
    resolveTasks,
    fetchRedeemedOffers,
    buildAddedIndex,
    addedStats,
    offerExpiryDays,
    fetchAccountBenefits,
    fetchCardCatalog,
    fetchAllBenefits,
    buildBenefitIndex,
    benefitStats,
    annualFeeFor,
    benefitPeriodLabel,
    daysUntil,
    decodeHtml,
    parseCreditAmount,
    MESSAGES,
    t,
    setLanguage,
    getLanguage,
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
    // When the offers snapshot was last read (epoch ms); a submit against a
    // stale snapshot re-reads the involved cards first (offerIds rotate).
    snapshotAt: 0,
    // Tasks awaiting the confirm dialog, and the last run's summary strip.
    pendingTasks: null,
    lastRun: null,
    // Which top-level tab is showing: 'offers' or 'benefits'.
    tab: 'offers',
    // Offers sub-view: 'addable' (the enroll list) or 'added' (redeem
    // tracking).
    offersSub: 'addable',
    // Redeemed (savings) records per card token, loaded lazily the first
    // time the added sub-view opens; cleared on refresh.
    redeemed: {byToken: new Map(), loaded: false, loading: false, error: '',
      readAt: 0},
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
    benefitQuery: '',
  };

  /** Panel host + shadow root, created lazily and reused across opens. */
  let panelHost = null;
  let panelRoot = null;
  /** Launcher button; hidden while the panel is open. */
  let launcherButton = null;
  /** Whether the offer snapshot has been loaded at least once. */
  let loaded = false;
  /** The view key of the last render, to preserve scroll across rebuilds. */
  let lastViewKey = '';

  // ---- language persistence -------------------------------------------------
  // `@grant none` means no GM storage, but the script only ever runs on the
  // Amex origin, so the page's localStorage is a natural per-user store.

  /** localStorage key holding the chosen panel language. */
  const LANG_STORAGE_KEY = 'amexAssistantLang';

  /** Whether the user has explicitly picked a language (vs. auto-detected). */
  let langChosen = false;

  /** @return {?string} The saved language choice, or null. */
  function savedLanguage() {
    try {
      const value = localStorage.getItem(LANG_STORAGE_KEY);
      return MESSAGES[value] ? value : null;
    } catch {
      return null;
    }
  }

  /** @return {string} Best-guess language from the browser locale. */
  function detectLanguage() {
    const locale = typeof navigator !== 'undefined' ?
      navigator.language || '' : '';
    return String(locale).toLowerCase().startsWith('zh') ? 'zh' : 'en';
  }

  /** Loads the saved language (or the browser guess) at startup. */
  function initLanguage() {
    const saved = savedLanguage();
    langChosen = saved != null;
    setLanguage(saved || detectLanguage());
  }

  /**
   * Activates and persists a language, updating the launcher label.
   * @param {string} lang Language code.
   */
  function applyLanguage(lang) {
    setLanguage(lang);
    try {
      localStorage.setItem(LANG_STORAGE_KEY, lang);
    } catch { /* private mode etc.; the choice just won't stick */ }
    langChosen = true;
    updateLauncherText();
  }

  /**
   * First-run choice from the language view: persist, then load the panel.
   * @param {string} lang Language code.
   */
  function chooseLanguage(lang) {
    applyLanguage(lang);
    if (!loaded) refresh(); else render();
  }

  /** Flips zh ↔ en from the header toggle. */
  function toggleLanguage() {
    applyLanguage(getLanguage() === 'zh' ? 'en' : 'zh');
    render();
  }

  /** Re-labels the launcher pill after a language change. */
  function updateLauncherText() {
    if (!launcherButton) return;
    const label = launcherButton.shadowRoot.querySelector('.t');
    if (label) label.textContent = t('launcherTitle');
  }

  // ---- position persistence -------------------------------------------------
  // Same store as the language choice: dragged positions of the launcher and
  // the panel are kept in the Amex origin's localStorage so they survive a
  // reload (the script otherwise rebuilds both at their hardcoded defaults).

  /** localStorage key prefix for remembered drag positions. */
  const POS_STORAGE_PREFIX = 'amexAssistantPos:';

  /**
   * Reads a saved drag position.
   * @param {string} key Sub-key, e.g. `'launcher'` or `'panel'`.
   * @return {?{x: number, y: number, float: boolean}} Position, or null.
   */
  function savedPosition(key) {
    try {
      const raw = localStorage.getItem(POS_STORAGE_PREFIX + key);
      if (!raw) return null;
      const pos = JSON.parse(raw);
      if (typeof pos.x !== 'number' || typeof pos.y !== 'number') return null;
      return {x: pos.x, y: pos.y, float: !!pos.float};
    } catch {
      return null;
    }
  }

  /**
   * Persists a drag position.
   * @param {string} key Sub-key, e.g. `'launcher'` or `'panel'`.
   * @param {{x: number, y: number, float: boolean}} pos Position to save.
   */
  function savePosition(key, pos) {
    try {
      localStorage.setItem(POS_STORAGE_PREFIX + key, JSON.stringify(pos));
    } catch { /* private mode etc.; the position just won't stick */ }
  }

  /**
   * Applies a saved position to a fixed host, re-clamped to the current
   * viewport (the window may have been resized since it was saved). The host
   * must already be laid out so its size can be measured.
   * @param {!Element} host The fixed element to place.
   * @param {{x: number, y: number}} pos Saved position.
   */
  function applyPosition(host, pos) {
    const maxX = window.innerWidth - host.offsetWidth - 4;
    const maxY = window.innerHeight - host.offsetHeight - 4;
    const x = Math.max(4, Math.min(pos.x, maxX));
    const y = Math.max(4, Math.min(pos.y, maxY));
    host.style.left = `${x}px`;
    host.style.top = `${y}px`;
    host.style.right = 'auto';
  }

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

  /**
   * Initials for a benefit square, ignoring a leading "$300" so the letters
   * come from the name ("$300 Digital Entertainment" → "DE", not "3D").
   * @param {string} name Benefit name.
   * @return {string} Letter initials.
   */
  function benefitInitials(name) {
    return merchantInitials(String(name).replace(/^\s*\$[\d,]+\s*/, ''));
  }

  /** @param {!OfferGroup} g Offer group. @return {string} Short expiry, e.g. */
  /**   "至 7/7". */
  function expiryLabel(g) {
    const match = /(\d{1,2})\/(\d{1,2})/.exec(g.expiry || '');
    return match ?
      t('expiresShort', {date: `${match[1]}/${match[2]}`}) : '';
  }

  /**
   * Localized short label for a benefit cadence key from
   * {@link benefitPeriodLabel} (e.g. `month` → `月` / `mo`).
   * @param {string} period Cadence key, possibly ''.
   * @return {string} Localized label, or ''.
   */
  function periodText(period) {
    return period ? t(`period_${period}`) : '';
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
      transform-origin: top right;
      transition: opacity .18s ease, transform .18s ease;
    }
    /* Collapsed state used to grow-in on open and shrink-out on close. */
    .p.closing { opacity: 0; transform: scale(.9); }
    .hd {
      display: flex; flex-direction: column; background: #fff;
      border-bottom: 2px solid var(--blue); flex: none;
    }
    .hd.err { border-bottom-color: var(--red); }
    .hd.tabbed { border-bottom: 1px solid var(--line); }
    /* Drag handle: the title row moves the panel; its buttons keep pointer. */
    .hrow { display: flex; align-items: center; gap: 11px; padding: 14px 18px;
      cursor: move; user-select: none; }
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
    /* Brand icon carries its own artwork/background. */
    .ic.brand { background: none; border-radius: 0; }
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
    .rf.lang { font-size: 10.5px; font-weight: 700; letter-spacing: .3px; }
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
      align-items: baseline;
      border-bottom: 1px solid var(--line2); font-size: 12px; color: var(--ink); }
    .si:last-child { border-bottom: none; }
    /* Failed rows carry a long message — stack it under the card, left-aligned,
       instead of wrapping ragged beside it. */
    .si.col { flex-direction: column; align-items: stretch;
      justify-content: flex-start; gap: 3px; }
    .si.col .si-msg { font-size: 11px; line-height: 1.45; text-align: left; }
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
    .binact { font-size: 11px; font-weight: 700; color: var(--amber); }
    .bwhen { font-size: 10.5px; color: var(--fog); margin-top: 2px;
      font-variant-numeric: tabular-nums; }
    .bactivate { border: 1px solid #D5D7DB; border-radius: 4px;
      padding: 5px 10px; font-size: 11px; font-weight: 600; color: var(--blue);
      cursor: pointer; white-space: nowrap; flex: none; }
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
    /* Added (redeem-tracking) sub-view */
    .sortmini { color: var(--sub); font-size: 11.5px; padding-bottom: 9px;
      white-space: nowrap; }
    .navy { color: var(--navy); }
    .agrp { border-bottom: 1px solid var(--line2); background: #fff; }
    .agrp.dim .arow, .agrp.dim .acards { opacity: .65; }
    .arow { display: flex; gap: 11px; padding: 12px 18px 6px;
      align-items: center; }
    .acards { margin: 0 18px 12px 69px; display: flex;
      flex-direction: column; gap: 7px; }
    .acrow { display: flex; align-items: center; gap: 9px; }
    .acdig { font-size: 11.5px; color: var(--ink); width: 56px; flex: none; }
    .acst { font-size: 11px; color: var(--fog); white-space: nowrap; }
    .acst.ok { font-weight: 600; color: var(--green);
      font-variant-numeric: tabular-nums; }
    .aday { font-size: 10.5px; color: var(--fog);
      font-variant-numeric: tabular-nums; }
    .aday.urgent { font-weight: 700; color: var(--red); }
    .aday.ok { font-weight: 600; color: var(--green); }
    .asub { font-size: 10.5px; color: var(--fog); margin-top: 2px;
      font-variant-numeric: tabular-nums; }
    .asub.ok { color: var(--green); }
    /* Last-run strip */
    .lastrun { display: flex; align-items: center; gap: 5px; padding: 7px 18px;
      background: #FAFBFC; border-bottom: 1px solid var(--line2);
      font-size: 11px; color: var(--mut); font-variant-numeric: tabular-nums; }
    .lastrun .sp { flex: 1; }
    .lastrun .when { color: var(--mut); }
    /* Confirm dialog */
    .cfwrap { position: relative; }
    .cfdim { opacity: .4; pointer-events: none; }
    .cfsk { padding: 14px 18px; display: flex; flex-direction: column;
      gap: 12px; background: #fff; }
    .skrow { display: flex; gap: 11px; align-items: center; }
    .sklogo { width: 40px; height: 40px; border-radius: 4px; flex: none;
      background: var(--card); }
    .skmn { flex: 1; display: flex; flex-direction: column; gap: 7px; }
    .skl { height: 10px; border-radius: 2px; background: var(--card); }
    .skl.a { width: 52%; }
    .skl.b { width: 74%; height: 9px; background: #F7F8F9; }
    .cfov { position: absolute; inset: 0; background: rgba(0, 23, 90, .30);
      display: flex; align-items: center; justify-content: center;
      padding: 26px; }
    .cfdlg { background: #fff; border-radius: 6px; width: 100%; padding: 20px;
      box-shadow: 0 12px 32px rgba(0, 23, 90, .35); }
    .cf-t { font-size: 14px; font-weight: 800; color: var(--navy); }
    .cf-d { font-size: 12px; color: var(--sub); line-height: 1.6;
      margin-top: 7px; }
    .cf-d b { color: var(--ink); }
    .cf-sum { margin-top: 10px; background: #F7F8F9; border: 1px solid #EDEEF0;
      border-radius: 4px; padding: 9px 12px; font-size: 11.5px;
      color: var(--sub); line-height: 1.7; font-variant-numeric: tabular-nums; }
    .cf-btns { display: flex; gap: 10px; margin-top: 16px;
      justify-content: flex-end; }
    .cf-cancel { border: 1px solid #D5D7DB; color: var(--sub); font-size: 12.5px;
      font-weight: 600; border-radius: 4px; padding: 9px 18px; cursor: pointer; }
    .cf-ok { background: var(--blue); color: #fff; font-size: 12.5px;
      font-weight: 700; border-radius: 4px; padding: 9px 18px; cursor: pointer; }
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
        text: t('addedToAll', {n: group.cards.length})}));
    } else {
      const badge = el('div', {class: 'bd'});
      if (addedCount) {
        badge.append(
          el('span', {text: t('addableN', {n: addable.length})}),
          el('span', {class: 'dot', text: ' · '}),
          el('span', {class: 'en', text: t('addedN', {n: addedCount})}),
          el('span', {class: 'car', text: ' ▾'}));
      } else {
        badge.append(el('span', {text: t('addableN', {n: addable.length})}),
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
    box.append(el('div', {class: 'lb', text: t('chooseCards')}));
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
        label.append(el('span', {class: 'mk en', text: t('addedMark')}));
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
   * The brand icon: a two-card stack with a "+" badge on the Amex blue. Used by
   * both the launcher pill and the panel header (sized by its container), and
   * rendered to PNGs for the Chrome extension (extension/icons/). Kept as an
   * inline SVG so neither spot needs an image asset.
   * @const {string}
   */
  const BRAND_ICON =
      '<svg width="100%" height="100%" viewBox="0 0 128 128" ' +
      'style="display:block">' +
      '<rect width="128" height="128" rx="26" fill="#006FCF"></rect>' +
      '<rect x="34" y="26" width="66" height="44" rx="7" ' +
      'fill="#7FB5E5"></rect>' +
      '<rect x="22" y="42" width="66" height="44" rx="7" fill="#fff"></rect>' +
      '<rect x="22" y="52" width="66" height="9" fill="#B3D4F0"></rect>' +
      '<rect x="30" y="70" width="26" height="6" rx="3" ' +
      'fill="#C9CCD0"></rect>' +
      '<circle cx="92" cy="90" r="21" fill="#00175A"></circle>' +
      '<rect x="84" y="87" width="16" height="6" rx="2" fill="#fff"></rect>' +
      '<rect x="89" y="82" width="6" height="16" rx="2" fill="#fff"></rect>' +
      '</svg>';

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
    // The default '＋' glyph is the brand icon; status glyphs ('!', '✓',
    // spinner) keep the plain blue chip.
    if (opts.glyph === '＋') {
      const ic = el('div', {class: 'ic brand'});
      ic.innerHTML = BRAND_ICON;
      row.append(ic);
    } else {
      row.append(el('div', {class: 'ic'}, opts.glyph));
    }
    row.append(el('div', {class: 'tt'},
      el('div', {class: 't1', text: opts.title}),
      opts.subtitle ? el('div', {class: 't2', text: opts.subtitle}) : null));
    if (opts.right) row.append(opts.right);
    if (opts.lang) {
      // Shows the language it switches TO (the classic i18n toggle pattern).
      row.append(el('button', {class: 'rf lang', title: t('switchLang'),
        text: getLanguage() === 'zh' ? 'EN' : '中',
        onclick: () => toggleLanguage()}));
    }
    if (opts.refresh) {
      const rf = el('button', {class: 'rf', title: t('refresh'),
        onclick: opts.onRefresh || (() => refresh())});
      // Static author-controlled markup (no interpolation): safe to inline.
      rf.innerHTML = REFRESH_SVG;
      row.append(rf);
    }
    if (opts.close) {
      row.append(el('button', {class: 'cl', title: t('close'), text: '×',
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
    const shell = panelRoot.getElementById('shell');
    // Preserve the scroll position across a same-view rebuild (e.g. expanding a
    // row or toggling a filter), so the list doesn't jump back to the top.
    const viewKey = state.tab === 'benefits' ? 'benefits' : state.view;
    const oldBody = shell.querySelector('.body');
    const keepScroll =
        oldBody && viewKey === lastViewKey ? oldBody.scrollTop : 0;
    lastViewKey = viewKey;
    shell.textContent = '';
    if (state.tab === 'benefits') {
      renderBenefitsTab(shell);
    } else {
      const views = {list: renderListView, loading: renderLoadingView,
        running: renderRunningView, result: renderResultView,
        empty: renderEmptyView, error: renderErrorView,
        confirm: renderConfirmView, language: renderLanguageView};
      (views[state.view] || renderListView)(shell);
    }
    const newBody = shell.querySelector('.body');
    if (newBody && keepScroll) newBody.scrollTop = keepScroll;
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
      state.benefitsError = error.message || t('benefitsReadFailed');
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
    if (mins < 1) return t('updatedJustNow');
    if (mins < 60) return t('updatedMinsAgo', {n: mins});
    return t('updatedHoursAgo', {n: Math.floor(mins / 60)});
  }

  /** @param {!Element} shell Panel content root. */
  function renderListView(shell) {
    shell.append(renderHeader({
      glyph: '＋', title: t('panelTitle'),
      subtitle: t('listSubtitle',
        {offers: state.offers.length, cards: state.cards.length}),
      lang: true, refresh: true, close: true, tabs: true,
    }));

    const body = el('div', {class: 'body'});

    const search = el('input', {type: 'search', value: state.query,
      placeholder: t('searchOffers')});
    search.oninput = (e) => {
      state.query = e.target.value.trim().toLowerCase();
      if (state.offersSub === 'added') renderAddedRows(body);
      else renderRows(body);
    };
    body.append(el('div', {class: 'sr'}, search));
    body.append(renderOffersSubTabs());

    if (state.offersSub === 'added') {
      renderAddedView(body);
      shell.append(body);
      shell.append(el('div', {class: 'bfoot'},
        el('div', {class: 'note', text: t('addedFootnote')})));
      return;
    }

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
    addTab('all', t('allCards'));
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
    tb.append(el('label', {}, multi, t('multiOnly')),
      el('div', {class: 'sp'}),
      el('div', {class: 'ac'},
        el('a', {class: 'a-blue', text: t('selectAllAddable'),
          onclick: () => selectAllVisible(body)}),
        el('a', {class: 'a-mut', text: t('clearSelection'),
          onclick: () => clearSelection(body)})));
    body.append(tb);

    const unreadable = state.cards.filter((c) => c.readFailed);
    if (unreadable.length) {
      body.append(el('div', {class: 'info'},
        el('b', {text: t('cardsReadFailed', {n: unreadable.length})}),
        ' ',
        t('cardsReadFailedNote',
          {names: unreadable.map((c) => c.shortName).join(' / ')})));
    }

    if (state.lastRun) body.append(renderLastRunStrip());

    const list = el('div', {class: 'list', id: 'list'});
    body.append(list);
    shell.append(body);
    renderRows(body);

    shell.append(renderFooter());
  }

  /** @return {!Element} The 可加 | 已加 sub-tab row under the search box. */
  function renderOffersSubTabs() {
    const addableN =
        state.offers.filter((g) => addableCards(g).length > 0).length;
    const addedN =
        buildAddedIndex(state.cards, state.redeemed.byToken).length;
    const mk = (key, label, n) => {
      const tab = el('div',
        {class: state.offersSub === key ? 'tab on' : 'tab'}, label);
      tab.append(el('span', {class: 'n', text: ` ${n}`}));
      tab.onclick = () => {
        if (state.offersSub === key) return;
        state.offersSub = key;
        render();
      };
      return tab;
    };
    const row = el('div', {class: 'tabs'});
    row.append(mk('addable', t('subAddable'), addableN));
    row.append(mk('added', t('subAdded'), addedN));
    row.append(el('div', {style: 'flex:1'}));
    if (state.offersSub === 'added') {
      row.append(el('div', {class: 'sortmini',
        text: `${t('sortShortExpiry')} ▾`}));
    }
    return row;
  }

  /**
   * Renders the added (redeem-tracking) sub-view into the list body: stats
   * strip + always-expanded per-card rows, or a loading / error block while
   * the savings records aren't available.
   * @param {!Element} body Panel body.
   */
  function renderAddedView(body) {
    const r = state.redeemed;
    if (r.error) {
      body.append(el('div', {class: 'info'},
        el('b', {text: t('addedError')}), ' ',
        el('a', {class: 'lnk', text: t('retry'),
          onclick: () => loadRedeemed(true)})));
      return;
    }
    if (!r.loaded) {
      if (!r.loading) loadRedeemed();
      body.append(el('div', {class: 'msg', style: 'padding:28px 24px'},
        el('div', {style: 'display:flex;gap:10px;justify-content:center;' +
            'align-items:center'},
        el('span', {class: 'spin'}),
        el('span', {class: 'note', text: t('addedLoading')}))));
      return;
    }
    const groups = buildAddedIndex(state.cards, r.byToken);
    const s = addedStats(groups);
    body.append(counters([
      {n: fmtMoney(s.redeemedAmount), l: t('statRedeemed'), c: 'g'},
      {n: s.pending, l: t('statPending'), c: 'navy'},
      {n: s.expiring, l: t('statExpiring'), c: 'r'}]));
    body.append(el('div', {id: 'addedlist'}));
    renderAddedRows(body);
  }

  /**
   * (Re)draws just the added-offer rows (so typing in search keeps focus).
   * @param {!Element} body Panel body (contains #addedlist).
   */
  function renderAddedRows(body) {
    const list = body.querySelector('#addedlist');
    if (!list) return;
    list.textContent = '';
    const q = state.query;
    const groups = buildAddedIndex(state.cards, state.redeemed.byToken)
      .filter((g) => !q || g.name.toLowerCase().includes(q));
    if (groups.length === 0) {
      list.append(el('div', {class: 'msg', style: 'padding:24px'},
        el('div', {class: 'note',
          text: q ? t('noMatchingOffers') : t('noAddedOffers')})));
      return;
    }
    for (const g of groups) list.append(renderAddedRow(g));
  }

  /**
   * One added-offer group: merchant row + always-open per-card redemption
   * lines (a posting shows ✓ + amount + date; otherwise "no cashback seen").
   * Fully-redeemed groups render dimmed.
   * @param {!Object} g An added-offer group.
   * @return {!Element} The group element.
   */
  function renderAddedRow(g) {
    const logo = el('div', {class: 'logo'});
    if (g.image) {
      logo.append(el('img', {src: g.image, alt: '', loading: 'lazy'}));
    } else {
      const [bg, fg] = logoColors(g.name);
      logo.style.background = bg;
      logo.style.color = fg;
      logo.textContent = merchantInitials(g.name);
    }
    const main = el('div', {class: 'mn'},
      el('div', {class: 'nm', text: g.name}),
      g.description ? el('div', {class: 'ds', text: g.description}) : null);

    const rt = el('div', {class: 'rt'});
    const ratio = t('redeemedOfCards',
      {x: g.redeemedCount, y: g.cards.length});
    if (g.fullyRedeemed) {
      rt.append(el('div', {class: 'aday ok', text: `✓ ${ratio}`}));
      const parts = [];
      if (g.totalRedeemedUsd > 0) parts.push(fmtMoney(g.totalRedeemedUsd));
      if (g.totalRedeemedPoints > 0) {
        parts.push(fmtPoints(g.totalRedeemedPoints));
      }
      if (parts.length) {
        rt.append(el('div', {class: 'asub',
          text: t('totalRedeemed', {amt: parts.join(' + ')})}));
      }
    } else {
      if (Number.isFinite(g.daysLeft)) {
        rt.append(el('div', {
          class: g.daysLeft <= 7 ? 'aday urgent' : 'aday',
          text: daysLabel(g.daysLeft)}));
      } else if (g.expiry) {
        rt.append(el('div', {class: 'aday', text: expiryLabel(g)}));
      }
      rt.append(el('div',
        {class: g.redeemedCount > 0 ? 'asub ok' : 'asub', text: ratio}));
    }

    const cardsBox = el('div', {class: 'acards'});
    for (const c of g.cards) {
      const sw = el('span', {class: 'sw'});
      const cardData = cardOf(c.token);
      if (cardData?.art) sw.append(el('img', {src: cardData.art, alt: ''}));
      else sw.style.background = swatchStyle(c.token);
      const digits = cardData ?
        `…${cardData.digits}` : `…${String(c.token).slice(-4)}`;
      let status;
      if (c.redeemed) {
        let text = t('cashbackPosted');
        if (c.redeemed.amount > 0) {
          text += ` ${c.redeemed.unit === 'points' ?
            fmtPoints(c.redeemed.amount) : fmtMoney(c.redeemed.amount)}`;
        }
        if (c.redeemed.date) text += ` · ${c.redeemed.date}`;
        status = el('span', {class: 'acst ok', text});
      } else {
        status = el('span', {class: 'acst', text: t('noCashbackSeen')});
      }
      cardsBox.append(el('div', {class: 'acrow'}, sw,
        el('span', {class: 'acdig', text: digits}),
        el('div', {style: 'flex:1'}), status));
    }

    return el('div', {class: g.fullyRedeemed ? 'agrp dim' : 'agrp'},
      el('div', {class: 'arow'}, logo, main, rt), cardsBox);
  }

  /**
   * Reads each card's redeemed (savings) list for the added sub-view.
   * Cached until the next panel refresh; `force` re-reads.
   * @param {boolean=} force Re-read even if already loaded.
   * @return {!Promise<void>} Resolves when rendered.
   */
  async function loadRedeemed(force = false) {
    const r = state.redeemed;
    if (r.loading || (r.loaded && !force)) return;
    state.redeemed = {...r, loading: true, error: ''};
    try {
      const byToken = new Map();
      await mapLimit(state.cards, MAX_CONCURRENT_READS, async (card) => {
        byToken.set(card.token, await fetchRedeemedOffers(card.token));
      });
      state.redeemed = {byToken, loaded: true, loading: false, error: '',
        readAt: Date.now()};
    } catch (error) {
      state.redeemed = {...state.redeemed, loading: false,
        error: error.message || t('addedError')};
    }
    render();
  }

  /** @return {!Element} The "上次执行" summary strip. */
  function renderLastRunStrip() {
    const r = state.lastRun;
    const strip = el('div', {class: 'lastrun'});
    strip.append(document.createTextNode(t('lastRunPrefix')));
    strip.append(el('b',
      {class: 'g', text: t('lastRunConfirmed', {n: r.confirmed})}));
    strip.append(document.createTextNode(' · '));
    strip.append(el('b',
      {class: 'r', text: t('lastRunFailed', {n: r.failed})}));
    strip.append(document.createTextNode(' · '));
    strip.append(el('b',
      {class: 'am', text: t('lastRunDedupe', {n: r.dedupe})}));
    strip.append(el('span', {class: 'when', text: ` · ${whenLabel(r.at)}`}));
    strip.append(el('div', {class: 'sp'}));
    strip.append(el('span', {class: 'lnk', text: t('view'), onclick: () => {
      state.view = 'result';
      render();
    }}));
    return strip;
  }

  /**
   * A short clock label: `今天 14:32` / `昨天 14:32` / `7/4 14:32`.
   * @param {number} ts Epoch ms.
   * @return {string} Label.
   */
  function whenLabel(ts) {
    const d = new Date(ts);
    const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
    const today = new Date();
    const sameDay = (a, b) => a.toDateString() === b.toDateString();
    const yest = new Date(today.getTime() - 86400000);
    if (sameDay(d, today)) return t('today', {time: hm});
    if (sameDay(d, yest)) return t('yesterday', {time: hm});
    return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  }

  /** @param {!Element} body Panel body (contains #list). */
  function renderRows(body) {
    const list = body.querySelector('#list');
    list.textContent = '';
    const shown = visibleOffers();
    for (const group of shown) list.append(renderOfferRow(group));
    if (shown.length === 0) {
      const empty = el('div', {class: 'note', text: t('noMatchingOffers')});
      list.append(el('div', {class: 'msg', style: 'padding:24px'}, empty));
    }
    refreshFooter();
  }

  /** @return {!Element} The list-view footer. */
  function renderFooter() {
    const sm = el('div', {class: 'sm', id: 'sm'});
    const go = el('button', {class: 'go', id: 'go', text: t('addToSelected'),
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
    sm.append(document.createTextNode(t('footerSelPrefix')),
      el('b', {text: String(offers)}),
      document.createTextNode(t('footerSelMid')),
      el('b', {text: String(pairs)}),
      document.createTextNode(t('footerSelSuffix')));
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

  /**
   * Formats a points amount, e.g. `5,000 pts` / `5,000 点`. Points are a
   * separate ledger from dollars and never go through {@link fmtMoney}.
   * @param {number} n Points.
   * @return {string} Localized points label.
   */
  function fmtPoints(n) {
    return t('pointsAmount',
      {n: Math.round(Number(n) || 0).toLocaleString('en-US')});
  }

  /** @param {number} d Days left. @return {string} e.g. `还剩 5 天`. */
  function daysLabel(d) {
    if (!Number.isFinite(d)) return '';
    if (d < 0) return t('expired');
    return t('daysLeft', {n: d});
  }

  /**
   * Whether a benefit is available but not yet activated (e.g. CLEAR Plus),
   * so it shows a "去激活" prompt instead of a progress bar. Best-effort on the
   * tracker `status`; unknown/active statuses fall through to a normal row.
   * @param {!Object} group A benefit group.
   * @return {boolean} True when the benefit needs activation.
   */
  function isInactiveBenefit(group) {
    return /AVAILABLE|INACTIVE|NOT[_ ]?ENROLLED|ELIGIBLE[_ ]?TO/i
      .test(group.status || '');
  }

  /** @param {!Object} extra Header overrides. @return {!Object} Header opts. */
  function benefitsHeaderOpts(extra) {
    const owned = state.cards.filter(
      (c) => (c.relationship || 'BASIC') === 'BASIC').length;
    const parts = [t('primaryCardsN', {n: owned})];
    const ago = agoLabel(state.benefitsReadAt);
    if (ago) parts.push(ago);
    return {glyph: '＋', title: t('panelTitle'), subtitle: parts.join(' · '),
      lang: true, close: true, tabs: true, ...extra};
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
        text: t('loadingBenefits')}),
      el('div', {class: 'note',
        text: known ? t('loadingCardN', {done: pr.done, total: pr.total}) :
          t('loadingCardList')})));
    body.append(el('div', {class: 'bar', style: 'margin-bottom:6px'},
      el('div', {style: `width:${pct}%`})));
    body.append(el('div', {class: 'note', text: t('benefitsReadOnly')}));
    shell.append(body);
  }

  /** @param {!Element} shell Panel content root. */
  function renderBenefitsError(shell) {
    shell.append(renderHeader(benefitsHeaderOpts({})));
    const body = el('div', {class: 'body'});
    const msg = el('div', {class: 'msg'});
    msg.append(el('div', {class: 'cir bad', text: '!'}));
    msg.append(el('div', {class: 'h', text: t('benefitsReadFailed')}));
    msg.append(el('div', {class: 'txt', text: t('errorSessionHint')}));
    msg.append(el('div', {class: 'btn pri', text: t('retry'),
      onclick: () => loadBenefits(true)}));
    body.append(msg);
    shell.append(body);
  }

  /**
   * @param {!Object} group A benefit group.
   * @param {string} q Lowercased search query.
   * @return {boolean} Whether the benefit matches by name or card.
   */
  function matchesBenefitQuery(group, q) {
    if (!q) return true;
    if (group.name.toLowerCase().includes(q)) return true;
    return group.entries.some(
      (e) => `${e.family} …${e.digits}`.toLowerCase().includes(q));
  }

  /** @param {!Element} shell Panel content root. */
  function renderBenefitsList(shell) {
    shell.append(renderHeader(benefitsHeaderOpts({
      refresh: true, onRefresh: () => loadBenefits(true)})));
    const body = el('div', {class: 'body'});

    const search = el('input', {type: 'search', value: state.benefitQuery,
      placeholder: t('searchBenefits')});
    search.oninput = (e) => {
      state.benefitQuery = e.target.value;
      renderBenefitBody(body);
    };
    body.append(el('div', {class: 'sr'}, search));

    body.append(renderBenefitStats());

    const tb = el('div', {class: 'btb'});
    tb.append(el('div', {class: 'sortlbl'}, t('sortByExpiry'),
      el('span', {class: 'caret', text: '▾'})));
    tb.append(el('div', {class: 'sp'}));
    const un = el('input', {type: 'checkbox'});
    un.checked = state.benefitUnusedOnly;
    un.onchange = () => {
      state.benefitUnusedOnly = un.checked;
      renderBenefitBody(body);
    };
    tb.append(el('label', {class: 'unused'}, un, t('unusedOnly')));
    body.append(tb);

    body.append(el('div', {id: 'bbody'}));
    shell.append(body);
    renderBenefitBody(body);

    shell.append(el('div', {class: 'bfoot'},
      el('div', {class: 'note', text: t('benefitsFootnote')})));
  }

  /**
   * Renders the filtered benefit list into `#bbody` (without touching the
   * search box / stats / toolbar), so typing in search keeps focus.
   * @param {!Element} body The benefits body element.
   */
  function renderBenefitBody(body) {
    const bbody = body.querySelector('#bbody');
    if (!bbody) return;
    bbody.textContent = '';
    const q = state.benefitQuery.trim().toLowerCase();
    const match = (g) => matchesBenefitQuery(g, q);
    const active = state.benefits.filter((g) => !g.fullyUsed && match(g));
    const used = state.benefits.filter((g) => g.fullyUsed && match(g));
    const shown = state.benefitUnusedOnly ? active :
      state.benefits.filter(match);
    const list = el('div', {class: 'blist'});
    for (const g of shown) list.append(renderBenefitRow(g));
    if (shown.length === 0) {
      const text = q ?
        t('noBenefitsMatch', {q: state.benefitQuery.trim()}) :
        t('noBenefits');
      list.append(el('div', {class: 'msg', style: 'padding:24px'},
        el('div', {class: 'note', text})));
    }
    bbody.append(list);

    if (state.benefitUnusedOnly && used.length) {
      bbody.append(renderBenefitDoneSection(used));
    }
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
        t('feeOffset', {spent: fmtMoney(s.redeemedYtd),
          fee: fmtMoney(s.annualFee)}),
        t('trackedOnly')) :
      col('r', fmtMoney(s.redeemedYtd), 'ink', t('redeemedYtd'),
        t('trackedOnly2'));
    return el('div', {class: 'bstats'},
      col('l', fmtMoney(s.thisMonthUnused), 'navy', t('leftThisMonth')),
      el('div', {class: 'vsep'}),
      col('m', fmtMoney(s.redeemedYtd), 'green', t('redeemedYtd')),
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
    head.append(el('span', {class: 'bsec-t', text: t('usedUpSection')}));
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
      text: benefitInitials(group.name)});
    const title = el('div', {class: 'btitle'},
      el('span', {class: 'bname', text: group.name}));
    if (group.period) {
      title.append(el('span', {class: 'bp', text: periodText(group.period)}));
    }
    if (group.multiCard) {
      title.append(el('span', {class: 'bx',
        text: t('xCards', {n: group.entries.length})}));
    }
    const cardText = group.entries
      .map((e) => `${e.family} …${e.digits}`).join(' · ');
    const mn = el('div', {class: 'bmn'}, title,
      el('div', {class: 'bcard', text: cardText}));

    // Not-yet-activated benefit (e.g. CLEAR Plus): no progress, a "去激活" CTA.
    if (isInactiveBenefit(group)) {
      const rt = el('div', {class: 'brt'},
        el('div', {class: 'binact', text: t('notActivated')}),
        el('div', {class: 'bwhen',
          text: `${fmtMoney(group.target, group.symbol)} / ` +
            `${periodText(group.period || 'year')}`}));
      const btn = el('div', {class: 'bactivate', text: t('activate'),
        onclick: () => window.open(
          'https://global.americanexpress.com/card-benefits/view-all',
          '_blank')});
      return el('div', {class: 'brow'}, logo, mn, rt, btn);
    }

    // Inline aggregate progress bar on every credit row (single and multi).
    const pct = group.target > 0 ?
      Math.min(100, Math.round(group.spent / group.target * 100)) : 0;
    mn.append(el('div', {class: 'bbar'}, el('div', {style: `width:${pct}%`})));

    const urgent = Number.isFinite(group.daysLeft) && group.daysLeft <= 7;
    const rt = el('div', {class: 'brt'},
      el('div', {class: 'bamt'},
        `${fmtMoney(group.spent, group.symbol)} `,
        el('span', {class: 'of',
          text: `/ ${fmtMoney(group.target, group.symbol)}`})),
      el('div', {class: urgent ? 'bdays urgent' : 'bdays',
        text: daysLabel(group.daysLeft)}));

    // Every credit row is expandable (consistency) — reveals the per-card
    // breakdown with card-art thumbnails.
    const expanded = state.benefitsExpanded.has(group.key);
    const row = el('div', {class: 'brow'}, logo, mn, rt,
      el('span', {class: 'bcaret', text: expanded ? '▴' : '▾'}));
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
   * @param {!Object} group A benefit group.
   * @return {!Element} Per-card breakdown rows (card-art thumbnail + progress).
   */
  function renderBenefitBreakdown(group) {
    const box = el('div', {class: 'bsub'});
    for (const e of group.entries) {
      const pct = e.target > 0 ?
        Math.min(100, Math.round(e.spent / e.target * 100)) : 0;
      const sw = el('span', {class: 'sw'});
      if (e.art) sw.append(el('img', {src: e.art, alt: ''}));
      else sw.style.background = swatchStyle(e.token);
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
    shell.append(renderHeader({glyph: '＋', title: t('panelTitle'),
      subtitle: t('loadingSubtitle'), close: true}));
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
        text: t('loadingOffers')}),
      el('div', {class: 'note',
        text: known ? t('loadingCardN', {done: pr.done, total: pr.total}) :
          t('loadingCardList')})));
    body.append(el('div', {class: 'bar', style: 'margin-bottom:6px'},
      el('div', {style: `width:${pct}%`})));
    body.append(el('div', {class: 'note', text: t('loadingReadOnly')}));
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
      title: t('runningTitle'),
      subtitle: t('runningSubtitle', {n: run.total}),
      right: el('div', {class: 'b', style: 'font-size:12px;font-weight:700',
        text: t('processedOf',
          {done: run.results.length, total: run.total})})}));
    const body = el('div', {class: 'body'});
    body.append(el('div', {style: 'padding:16px 18px 0'},
      el('div', {class: 'bar'}, el('div', {style: `width:${pct}%`}))));
    const cols = [
      {n: ok, l: t('submitOk'), c: 'g'}, {n: fail, l: t('submitFail'), c: 'r'},
      {n: pending, l: t('submitting'), c: 'b'}];
    if (skipped) cols.push({n: skipped, l: t('notSubmitted'), c: 'am'});
    body.append(counters(cols));
    const rl = el('div', {style: 'padding:4px 18px 8px'});
    const settledIds = new Set(run.results.map((r) => `${r.key}|${r.token}`));
    for (const task of run.tasks) {
      const done = run.results.find(
        (r) => r.key === task.key && r.token === task.token);
      const txt = `${task.name} → ${cardLabel(task.token)}`;
      let icon; let stTxt; let stCls;
      if (!done) {
        icon = el('span', {class: 'spin'});
        stTxt = t('submitting');
        stCls = 'st b';
      } else if (done.skipped) {
        icon = el('span', {class: 'am', text: '⊘'});
        stTxt = t('notSubmitted');
        stCls = 'st am';
      } else if (done.reportedOk) {
        icon = el('span', {class: 'g', text: '✓'});
        stTxt = t('submitOk');
        stCls = 'st g';
      } else {
        icon = el('span', {class: 'r', text: '✗'});
        stTxt = t('submitFail');
        stCls = 'st r';
      }
      rl.append(el('div', {class: 'ri'}, icon,
        el('div', {class: 'txt', text: txt}),
        el('div', {class: stCls, text: stTxt})));
    }
    body.append(rl);
    const footStyle = 'border-top:1px solid #E7E8EA;padding:11px 18px';
    body.append(el('div', {style: footStyle},
      el('div', {class: 'note', text: t('runningNote')})));
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
      title: throttled ? t('resultTitleStopped') : t('resultTitleOk'),
      subtitle: t('resultSubtitle', {n: results.length}), close: true,
      err: throttled}));
    const body = el('div', {class: 'body'});
    const cols = [
      {n: n(ResultState.VERIFIED), l: t('confirmedAdded'), c: 'g'},
      {n: n(ResultState.FAILED), l: t('addFailed'), c: 'r'},
      {n: n(ResultState.GHOST) + n(ResultState.UNVERIFIED),
        l: t('dedupeOrUnknown'), c: 'am'}];
    if (n(ResultState.SKIPPED)) {
      cols.push({n: n(ResultState.SKIPPED), l: t('notSubmitted'), c: 'am'});
    }
    body.append(counters(cols));
    if (throttled) {
      body.append(el('div', {class: 'info'},
        el('b', {text: t('throttledTitle')}), t('throttledBody')));
    }
    body.append(el('div', {class: 'info'},
      el('b', {text: t('dedupeHelpTitle')}), t('dedupeHelpBody')));

    const section = (title, filter, glyph, cls) => {
      const items = results.filter(filter);
      if (!items.length) return;
      body.append(el('div', {style: 'padding:0 18px'},
        el('div', {class: 'sh', text: title})));
      const wrap = el('div', {style: 'padding:0 18px 4px'});
      for (const r of items) {
        const label = `${r.name} → ${cardLabel(r.token)}`;
        if (r.state === ResultState.FAILED && r.message) {
          // Long server message: stack it under the card, left-aligned.
          wrap.append(el('div', {class: 'si col'},
            el('span', {text: label}),
            el('span', {class: `${cls} si-msg`, text: `“${r.message}”`})));
        } else {
          wrap.append(el('div', {class: 'si'},
            el('span', {text: label}),
            el('span', {class: cls, text: glyph})));
        }
      }
      body.append(wrap);
    };
    section(t('confirmedAdded'),
      (r) => r.state === ResultState.VERIFIED, '✓', 'g');
    section(t('addFailed'), (r) => r.state === ResultState.FAILED, '✗', 'r');
    section(t('secSkipped'),
      (r) => r.state === ResultState.SKIPPED, '⊘', 'am');
    section(t('secGhost'),
      (r) => r.state === ResultState.GHOST, '⚠', 'am');
    section(t('secUnverified'),
      (r) => r.state === ResultState.UNVERIFIED, '?', 'note');

    const retryable = (r) => (r.state === ResultState.FAILED ||
        r.state === ResultState.SKIPPED) && !r.gone;
    const retry = el('div', {class: 'lnk rerun', text: t('retryUnfinished'),
      onclick: () => retryFailed()});
    if (!results.some(retryable)) {
      retry.style.display = 'none';
    }
    shell.append(body);
    shell.append(el('div', {class: 'ft'},
      el('div', {class: 'lnk', text: t('exportCsv'),
        onclick: () => exportCsv()}),
      el('div', {class: 'sp', style: 'flex:1'}), retry,
      el('button', {class: 'go', text: t('backToList'),
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

  /** @return {!Element} A gray placeholder row (loading / dimmed backdrop). */
  function skeletonRow() {
    return el('div', {class: 'skrow'},
      el('div', {class: 'sklogo'}),
      el('div', {class: 'skmn'},
        el('div', {class: 'skl a'}), el('div', {class: 'skl b'})));
  }

  /** @param {!Element} shell Panel content root (pre-submit confirm dialog). */
  function renderConfirmView(shell) {
    const tasks = state.pendingTasks || [];
    const byOffer = new Map();
    for (const t of tasks) byOffer.set(t.name, (byOffer.get(t.name) || 0) + 1);

    const wrap = el('div', {class: 'cfwrap'});
    const dim = el('div', {class: 'cfdim'});
    dim.append(renderHeader({glyph: '＋', title: t('panelTitle')}));
    const sk = el('div', {class: 'cfsk'});
    for (let i = 0; i < 4; i++) sk.append(skeletonRow());
    dim.append(sk);
    wrap.append(dim);

    const dlg = el('div', {class: 'cfdlg'});
    dlg.append(el('div', {class: 'cf-t',
      text: t('confirmTitle', {n: tasks.length})}));
    dlg.append(el('div', {class: 'cf-d'},
      t('confirmBody1', {offers: byOffer.size, cards: tasks.length}),
      el('b', {text: t('confirmBodyBold')}),
      t('confirmBody2')));
    const sum = el('div', {class: 'cf-sum'});
    for (const [name, n] of byOffer) {
      sum.append(el('div', {text: t('confirmRowCards', {name, n})}));
    }
    dlg.append(sum);
    dlg.append(el('div', {class: 'cf-btns'},
      el('div', {class: 'cf-cancel', text: t('cancel'),
        onclick: () => cancelConfirm()}),
      el('div', {class: 'cf-ok', text: t('confirmSubmit'),
        onclick: () => confirmRun()})));
    wrap.append(el('div', {class: 'cfov'}, dlg));
    shell.append(wrap);
  }

  /** @param {!Element} shell Panel content root. */
  function renderEmptyView(shell) {
    shell.append(renderHeader({glyph: '＋', title: t('panelTitle'),
      close: true, lang: true, refresh: true, tabs: true}));
    shell.append(el('div', {class: 'body'}, el('div', {class: 'msg'},
      el('div', {class: 'cir ok', text: '✓'}),
      el('div', {class: 'h', text: t('emptyTitle')}),
      el('div', {class: 'txt', text: t('emptyBody')}),
      el('div', {class: 'btn', onclick: () => refresh()}, t('reload')))));
  }

  /** @param {!Element} shell Panel content root. */
  function renderErrorView(shell) {
    shell.append(renderHeader({glyph: '＋', title: t('panelTitle'),
      close: true, lang: true, err: true}));
    shell.append(el('div', {class: 'body'}, el('div', {class: 'msg'},
      el('div', {class: 'cir bad', text: '!'}),
      el('div', {class: 'h', text: t('errorTitle')}),
      el('div', {class: 'txt',
        text: state.errorMessage || t('errorSessionHint')}),
      el('div', {class: 'btn pri', onclick: () => refresh()}, t('retry')))));
  }

  /** @param {!Element} shell Panel content root (first-run language pick). */
  function renderLanguageView(shell) {
    // Deliberately bilingual: no language has been chosen yet, so both must
    // be readable. The detected language is pre-highlighted as the default.
    const detected = detectLanguage();
    shell.append(renderHeader(
      {glyph: '＋', title: 'Amex 助手 · Amex Assistant', close: true}));
    const pick = (lang, label) => el('div', {
      class: detected === lang ? 'btn pri' : 'btn',
      text: label,
      style: 'min-width:112px;justify-content:center',
      onclick: () => chooseLanguage(lang),
    });
    shell.append(el('div', {class: 'body'}, el('div', {class: 'msg'},
      el('div', {class: 'cir ok', text: '文',
        style: 'font-size:16px;font-weight:700'}),
      el('div', {class: 'h', text: '选择语言 · Choose your language'}),
      el('div', {class: 'txt',
        text: '之后可以在面板右上角随时切换 · ' +
          'You can switch anytime from the panel header.'}),
      el('div', {style: 'display:flex;gap:10px;justify-content:center'},
        pick('zh', '中文'), pick('en', 'English')))));
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
    if (presetTasks) return doRun(tasks, true);
    // A fresh submit goes through the confirm dialog first.
    state.pendingTasks = tasks;
    state.view = 'confirm';
    render();
  }

  /** Confirms the pending submit and runs it. */
  function confirmRun() {
    const tasks = state.pendingTasks;
    state.pendingTasks = null;
    if (tasks && tasks.length) doRun(tasks, false);
  }

  /** Cancels the confirm dialog and returns to the list. */
  function cancelConfirm() {
    state.pendingTasks = null;
    state.view = 'list';
    render();
  }

  /**
   * Runs a task list, driving the running → result views.
   * @param {!Array<!Task>} tasks Tasks to submit.
   * @param {boolean} isRetry Whether these are re-sent failed pairs.
   * @return {!Promise<void>} Resolves when the result view is shown.
   */
  async function doRun(tasks, isRetry) {
    state.view = 'running';
    state.run = {tasks, total: tasks.length, results: []};
    render();
    try {
      // A snapshot that has sat around long enough may carry rotated
      // offerIds; re-read the involved cards and re-resolve before sending.
      if (state.snapshotAt &&
          Date.now() - state.snapshotAt > SNAPSHOT_MAX_AGE_MS) {
        tasks = await freshenTasks(tasks);
        if (tasks.length === 0) {
          // Everything already landed or is no longer available; the list
          // (rebuilt from the fresh reads) tells that story.
          state.selected.clear();
          state.view = 'list';
          render();
          return;
        }
        state.run = {tasks, total: tasks.length, results: []};
        render();
      }
      const results = await executeSelected(tasks, {
        onSettle: (attempt) => {
          state.run.results.push(attempt);
          render();
        },
      });
      // A retry merges over the previous report so pairs settled earlier
      // (verified, landed, gone) stay visible; a fresh run starts clean.
      const merged = isRetry ? state.lastResults : new Map();
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
          state.snapshotAt = Date.now();
        } catch { /* keep previous list; result view still shows outcomes */ }
      }
      setLastRunSummary();
      state.view = 'result';
    } catch (error) {
      state.errorMessage = t('runInterrupted', {msg: error.message});
      state.view = 'error';
    }
    render();
  }

  /**
   * Re-reads the cards involved in `tasks` and re-resolves each task against
   * the fresh data (see {@link resolveTasks}). Used when the snapshot backing
   * the selection is old enough that offerIds may have rotated. If the
   * re-read fails, the original tasks are returned unchanged — better to
   * attempt with what we have than to block the run.
   * @param {!Array<!Task>} tasks Tasks about to run.
   * @return {!Promise<!Array<!Task>>} Tasks carrying fresh offerIds; may be
   *     smaller when pairs turn out to be already added or gone.
   */
  async function freshenTasks(tasks) {
    const tokens = [...new Set(tasks.map((t) => t.token))];
    try {
      await mapLimit(tokens, MAX_CONCURRENT_READS, async (token) => {
        const card = cardOf(token);
        if (!card) return;
        const eligible = await fetchEligibleOffers(token);
        const enrolled = await fetchEnrolledOffers(token);
        card.eligible = eligible;
        card.enrolled = enrolled;
        card.enrolledKeys =
            new Set(enrolled.map(offerGroupKey).filter(Boolean));
        card.readFailed = false;
      });
      state.offers = buildOfferIndex(state.cards);
    } catch {
      return tasks;
    }
    return resolveTasks(tasks, state.offers).tasks;
  }

  /** Records a compact summary of the last run for the list-view strip. */
  function setLastRunSummary() {
    const vals = [...state.lastResults.values()];
    const count = (s) => vals.filter((r) => r.state === s).length;
    state.lastRun = {
      confirmed: count(ResultState.VERIFIED),
      failed: count(ResultState.FAILED),
      dedupe: count(ResultState.GHOST),
      at: Date.now(),
    };
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

  /**
   * Makes a fixed-positioned host draggable. Clamps to the viewport; the host's
   * own inline style remembers where it was left, and (with `storeKey`) the
   * position is persisted so it survives a reload. A press that doesn't move
   * counts as a click (for the launcher).
   * @param {!Element} host The fixed element to move.
   * @param {!EventTarget} listenOn Where to listen (element or shadow root).
   * @param {{only: (string|undefined), ignore: (string|undefined),
   *          onClick: (function(!Event)|undefined),
   *          onMove: (function()|undefined), storeKey: (string|undefined),
   *          float: (boolean|undefined)}=} opts Behavior.
   */
  function makeDraggable(host, listenOn, opts = {}) {
    listenOn.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (opts.only && !e.target.closest(opts.only)) return;
      if (opts.ignore && e.target.closest(opts.ignore)) return;
      const rect = host.getBoundingClientRect();
      const offX = e.clientX - rect.left;
      const offY = e.clientY - rect.top;
      const startX = e.clientX;
      const startY = e.clientY;
      let moved = false;
      let lastX = rect.left;
      let lastY = rect.top;
      const move = (ev) => {
        if (Math.abs(ev.clientX - startX) +
            Math.abs(ev.clientY - startY) > 4) {
          moved = true;
          if (opts.onMove) opts.onMove();
        }
        const maxX = window.innerWidth - host.offsetWidth - 4;
        const maxY = window.innerHeight - host.offsetHeight - 4;
        lastX = Math.max(4, Math.min(ev.clientX - offX, maxX));
        lastY = Math.max(4, Math.min(ev.clientY - offY, maxY));
        host.style.left = `${lastX}px`;
        host.style.top = `${lastY}px`;
        host.style.right = 'auto';
      };
      const up = (ev) => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        if (moved) {
          if (opts.storeKey) {
            savePosition(opts.storeKey,
              {x: lastX, y: lastY, float: !!opts.float});
          }
        } else if (opts.onClick) {
          opts.onClick(ev);
        }
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
      e.preventDefault();
    });
  }

  /** @return {?Element} The panel shell (`.p`), if created. */
  function panelShell() {
    return panelRoot ? panelRoot.getElementById('shell') : null;
  }

  /** Grows the panel in from its collapsed state. */
  function animatePanelIn() {
    const p = panelShell();
    if (!p) return;
    p.classList.add('closing');
    void p.offsetWidth; // reflow so removing the class transitions
    p.classList.remove('closing');
  }

  /**
   * Shrinks the panel out, then runs `done` once.
   * @param {function()} done Called after the shrink finishes.
   */
  function animatePanelOut(done) {
    const p = panelShell();
    if (!p) {
      done();
      return;
    }
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      done();
    };
    p.addEventListener('transitionend', finish, {once: true});
    setTimeout(finish, 260);
    requestAnimationFrame(() => p.classList.add('closing'));
  }

  /**
   * Fades the launcher pill in or out.
   * @param {boolean} show Fade in (true) or out then hide (false).
   */
  function fadeLauncher(show) {
    if (!launcherButton) return;
    const pill = launcherButton.shadowRoot.querySelector('.l');
    if (!pill) return;
    if (show) {
      launcherButton.style.display = '';
      pill.classList.add('closed');
      void pill.offsetWidth;
      pill.classList.remove('closed');
    } else {
      pill.classList.add('closed');
      setTimeout(() => {
        if (launcherButton) launcherButton.style.display = 'none';
      }, 150);
    }
  }

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
    // Drag the panel by its title row; buttons/tabs keep their own clicks.
    makeDraggable(host, root,
      {only: '.hrow', ignore: 'button, .rf, .cl', storeKey: 'panel'});
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
    // Redeemed records are re-read lazily after a refresh.
    state.redeemed = {byToken: new Map(), loaded: false, loading: false,
      error: '', readAt: 0};
    state.view = 'loading';
    render();
    try {
      state.cards = await snapshot((done, total) => {
        state.run = {done, total};
        if (state.view === 'loading') render();
      });
      state.offers = buildOfferIndex(state.cards);
      state.snapshotAt = Date.now();
      loaded = true;
      if (!state.offers.length && state.cards.some((c) => c.readFailed)) {
        // Nothing usable came back — surface the failure rather than an
        // (untrue) "no offers" empty state.
        state.errorMessage = t('cardsReadAllFailed');
        state.view = 'error';
      } else {
        state.view = state.offers.length ? 'list' : 'empty';
      }
    } catch (error) {
      state.errorMessage = `${error.message}`;
      state.view = 'error';
    }
    render();
  }

  /** Shows the panel, creating and loading it only on first use. */
  function showPanel() {
    const firstCreate = !panelHost;
    if (firstCreate) createPanel();
    fadeLauncher(false);
    panelHost.style.display = '';
    if (!langChosen) {
      // First run: ask for a language before anything loads. Nothing hits
      // the account until the user picks (or reopens with a saved choice).
      state.view = 'language';
      render();
    } else if (!loaded) {
      refresh();
    } else {
      render();
    }
    // Restore the saved spot once, after the first render so the panel has a
    // real height to clamp against (later opens keep the in-session position).
    if (firstCreate) {
      const saved = savedPosition('panel');
      if (saved) applyPosition(panelHost, saved);
    }
    animatePanelIn();
  }

  /** Hides the panel (keeps cached state) and restores the launcher. */
  function hidePanel() {
    animatePanelOut(() => {
      if (panelHost) panelHost.style.display = 'none';
      fadeLauncher(true);
    });
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
        user-select:none;
        transition:box-shadow .15s ease, opacity .14s ease, transform .14s ease }
      .l:hover { box-shadow:0 5px 18px rgba(0,23,90,.22) }
      .l.closed { opacity:0; transform:scale(.85) translateX(10px);
        pointer-events:none }
      /* Once dragged off the edge it becomes a normal free-floating pill. */
      .l.float { border-right:1px solid #E3E5E8; border-radius:6px }
      .i { width:24px; height:24px }
      .t { font-weight:800; color:#00175A; letter-spacing:.1px }
    `}));
    const iconChip = el('div', {class: 'i'});
    iconChip.innerHTML = BRAND_ICON;
    const pill = el('div', {class: 'l'},
      iconChip,
      el('div', {},
        el('div', {class: 't', text: t('launcherTitle')})));
    root.append(pill);
    document.body.appendChild(host);
    launcherButton = host;
    // Restore a previously dragged spot (it becomes a free-floating pill then).
    const saved = savedPosition('launcher');
    if (saved) {
      applyPosition(host, saved);
      if (saved.float) pill.classList.add('float');
    }
    // Draggable; a press that doesn't move opens the panel.
    makeDraggable(host, pill, {
      storeKey: 'launcher',
      float: true,
      onClick: () => showPanel(),
      onMove: () => pill.classList.add('float'),
    });
  }

  window.AmexAssistant = {...api, showPanel, openPanel: showPanel};
  initLanguage();
  installLauncher();
})();
