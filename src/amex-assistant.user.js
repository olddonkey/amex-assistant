// ==UserScript==
// @name         Amex Assistant
// @namespace    https://github.com/olddonkey/amex-assistant
// @version      1.2.0
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
      launcherRunning: '提交中',
      launcherDone: '已完成',
      refresh: '刷新',
      close: '关闭',
      // Target-language on purpose (pairs with the 'EN' glyph at the call
      // site): whoever needs this control may not read Chinese.
      switchLang: 'Switch to English',
      // Offers list
      listSubtitle: '{offers} 个 offer · {cards} 张卡',
      searchOffers: '搜索商家或 offer',
      allCards: '全部卡',
      multiOnly: '只看多卡',
      selectAllAddable: '全选可加',
      clearSelection: '清空',
      listHeadAddable: '{n} 个可加 OFFER',
      listHeadSelected: '已选 {n} 个 OFFER',
      cardsReadFailed: '{n} 张卡读取失败。',
      cardsReadFailedNote:
          '{names} 的 offer 本次未能读取，列表暂不含这些卡；点右上角 ↻ 重试。',
      noMatchingOffers: '没有匹配的 offer',
      addToSelected: '加到所选卡',
      footerIdle: '勾选 offer 后从这里并行提交',
      footerSelPrefix: '已选 ',
      footerSelMid: ' 个 · 将',
      footerSelReqs: '并行一次发出 {n} 个请求',
      // Wide mode reads with more room, so it spells out offer/添加 (9c mock).
      footerSelMidWide: ' 个 offer · 将',
      footerSelReqsWide: '并行一次发出 {n} 个添加请求',
      addedToAll: '已添加到 {n} 张卡',
      addableN: '可加 {n}',
      addedN: '已加 {n}',
      chooseCards: '加到哪些卡',
      addedMark: '已加 ✓',
      expiresShort: '至 {date}',
      // Last-run strip
      lastRunPrefix: '上次执行：',
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
      confirmTitle: '同时提交 {n} 个添加？',
      confirmSub: '一次性同时提交，提交后不可撤销',
      confirmThrottle: '一次提交超过 30 个添加可能触发限流，建议分批',
      confirmCards: '{n} 张卡',
      confirmMeta: '共 {offers} 个 offer · {adds} 次添加 · 完成后逐卡确认',
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
      runningNoteLead: '请勿关闭本页',
      runningNote: ' · 全部完成后重新读取已加列表逐卡确认',
      readFailBanner: '读取失败，以下结果不含这张卡',
      // First-run trust screen
      trustTitle1: '把一个 offer，',
      trustTitle2: '加到你的每张卡',
      trustDesc: '在 Amex 网页上 Add to Card 之后，其它卡就看不到这个 offer ' +
        '了。Amex 助手把你选的 offer 同时加到多张卡，并逐卡确认结果。',
      trustB1Lead: '纯本地运行',
      trustB1Rest: ' — 零后端、零上报，代码可审计',
      trustB2Lead: '先只读',
      trustB2Rest: ' — 打开只读取 Offer 列表，不改动账户',
      trustB3Lead: '你说了算',
      trustB3Rest: ' — 勾选并确认后才会提交',
      trustStart: '开始读取',
      trustFoot: '技术上无法联系任何第三方（@grant none）',
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
      backToList: '返回列表',
      runInterrupted: '添加过程中断：{msg}',
      // Empty / error
      emptyTitle: '没有可加的 offer',
      emptyBody: '所有 offer 都已加到它们可用的卡上。',
      reload: '重新读取',
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
      noBenefitsMatch: '没有匹配「{q}」的 benefit',
      noBenefits: '这些卡上没有可追踪的 benefit',
      leftThisMonth: '本月还没用的',
      redeemedYtd: '今年已返现',
      feePayback: '年费回本',
      feeOffset: '年费回本 {spent}/{fee}',
      trackedOnly: '仅含可自动追踪项',
      trackedOnly2: '按可追踪项目',
      // Period group headers + three-state row language (13a).
      periodEvery_month: '每月',
      periodEvery_quarter: '每季',
      periodEvery_half: '每半年',
      periodEvery_year: '每年',
      benefitPending: '{n} 项 · {amt} 待用',
      benefitPendingActivate: '{n} 项 · {amt} 待激活',
      notUsed: '未使用',
      usedPct: '已用 {n}%',
      usedUp: '已用完',
      xCardsEach: '{n} 张卡 · 各 {amt}',
      xCardsTotal: '{n} 张卡 · 共 {amt}',
      untrackable: '无法自动追踪',
      notActivated: '未激活',
      activate: '去激活 ↗',
      expired: '已过期',
      daysLeft: '还剩 {n} 天',
      // Added (redeem-tracking) sub-view
      subAddable: '可加',
      subAdded: '已加',
      statRedeemed: '已返现',
      statPending: '待消费',
      statExpiring: '7 天内过期',
      redeemedOfCards: '{x} / {y} 卡已返现',
      groupByExpiry: '按到期',
      groupByCard: '按卡',
      groupByCategory: '按类目',
      nItems: '{n} 个',
      uncategorized: '未分类',
      cardGroupBack: '{amt} 已返现',
      cardGroupPending: '全部待消费',
      singleRedeemed: '✓ {amt} 已返现',
      postedOn: '{date} 入账',
      expandRest: '展开其余 {n} 个 ▾',
      collapseRest: '收起 ▴',
      totalRedeemed: '共返 {amt}',
      noCashbackSeen: '未见返现',
      cashbackPosted: '✓ 已返现',
      pointsAmount: '{n} 点',
      noAddedOffers: '还没有已加的 offer',
      addedLoading: '正在读取返现记录…',
      addedError: '返现记录读取失败。',
      addedFootnote:
          '消费状态按返现入账记录归类，入账通常延迟 1–5 天 · 以 Amex 为准',
      // Wide mode (G4): the second density (≈880px centered overlay).
      expandWide: '展开',
      collapseSidebar: '收窄',
      colMerchantOffer: '商家 / OFFER',
      colExpiry: '到期',
      colCardStatus: '各卡状态',
      colStatus: '状态',
      colChooseCards: '加到哪些卡（点 chip 勾选）',
      colOffer: 'OFFER',
      colCardResult: '各卡结果',
      multiAddableOnly: '只看多卡可加',
      nCards: '{n} 张卡',
      wideResultSub: '{n} 个添加请求并行发出 · 已重新读取各卡确认',
      resultLegend: '✗ 失败 = Amex 返回错误 · ? 疑似重复 = Amex 报成功但复读时' +
          '不在该卡（通常同一 offer 只能加一张卡）',
      retryFailed: '重试失败项',
      period_month: '月',
      period_quarter: '季',
      period_half: '半年',
      period_year: '年',
    },
    en: {
      panelTitle: 'Amex Assistant',
      launcherTitle: 'Amex Assistant',
      launcherRunning: 'Submitting',
      launcherDone: 'Done',
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
      listHeadAddable: '{n} eligible OFFERS',
      listHeadSelected: '{n} OFFERS selected',
      cardsReadFailed: '{n} card(s) could not be read.',
      cardsReadFailedNote: 'Offers on {names} could not be read this time ' +
          'and are not listed; click ↻ (top right) to retry.',
      noMatchingOffers: 'No matching offers',
      addToSelected: 'Add to selected cards',
      footerIdle: 'Check offers, then submit them here in parallel',
      footerSelPrefix: 'Selected ',
      footerSelMid: ' · ',
      footerSelReqs: '{n} requests in parallel, all at once',
      footerSelMidWide: ' · ',
      footerSelReqsWide: '{n} add requests in parallel, all at once',
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
      confirmTitle: 'Submit all {n} additions at once?',
      confirmSub: 'All submitted together at once; this cannot be undone',
      confirmThrottle: 'Submitting over 30 at once may trip rate limits; ' +
          'consider batching',
      confirmCards: '{n} card(s)',
      confirmMeta: '{offers} offer(s) · {adds} addition(s) · ' +
          'each card is verified afterwards',
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
      runningNoteLead: 'Keep this page open',
      runningNote: ' · when done, added lists are re-read to verify each card',
      readFailBanner: 'couldn’t be read; results below exclude it',
      // First-run trust screen
      trustTitle1: 'Add one offer',
      trustTitle2: 'to every card you own',
      trustDesc: 'Once you Add to Card on the Amex site, your other cards ' +
        'can no longer see that offer. Amex Assistant adds your chosen ' +
        'offer to several cards at once, then verifies each card.',
      trustB1Lead: 'Runs locally',
      trustB1Rest: ' — no backend, no telemetry, auditable code',
      trustB2Lead: 'Reads first',
      trustB2Rest: ' — opening only reads your offer list, changes nothing',
      trustB3Lead: 'You decide',
      trustB3Rest: ' — nothing is submitted until you confirm',
      trustStart: 'Start reading',
      trustFoot: 'Technically cannot reach any third party (@grant none)',
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
      backToList: 'Back to list',
      runInterrupted: 'Run interrupted: {msg}',
      // Empty / error
      emptyTitle: 'No offers to add',
      emptyBody: 'Every offer is already on the cards it can go to.',
      reload: 'Reload',
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
      noBenefitsMatch: 'No benefits match "{q}"',
      noBenefits: 'No trackable benefits on these cards',
      leftThisMonth: 'Left this month',
      redeemedYtd: 'Redeemed this year',
      feePayback: 'Fee payback',
      feeOffset: 'Fee offset {spent}/{fee}',
      trackedOnly: 'Auto-tracked credits only',
      trackedOnly2: 'Tracked credits only',
      // Period group headers + three-state row language (13a).
      periodEvery_month: 'Monthly',
      periodEvery_quarter: 'Quarterly',
      periodEvery_half: 'Semi-annual',
      periodEvery_year: 'Annual',
      benefitPending: '{n} items · {amt} left',
      benefitPendingActivate: '{n} items · {amt} to activate',
      notUsed: 'Unused',
      usedPct: '{n}% used',
      usedUp: 'Used up',
      xCardsEach: '{n} cards · {amt} each',
      xCardsTotal: '{n} cards · {amt} total',
      untrackable: "Can't auto-track",
      notActivated: 'Not activated',
      activate: 'Activate ↗',
      expired: 'Expired',
      daysLeft: '{n} days left',
      // Added (redeem-tracking) sub-view
      subAddable: 'Addable',
      subAdded: 'Added',
      statRedeemed: 'Cashback posted',
      statPending: 'To spend',
      statExpiring: 'Expiring in 7 days',
      redeemedOfCards: '{x} / {y} cards posted',
      groupByExpiry: 'By expiry',
      groupByCard: 'By card',
      groupByCategory: 'By category',
      nItems: '{n} offers',
      uncategorized: 'Uncategorized',
      cardGroupBack: '{amt} back',
      cardGroupPending: 'All to spend',
      singleRedeemed: '✓ {amt} back',
      postedOn: 'Posted {date}',
      expandRest: 'Show {n} more ▾',
      collapseRest: 'Collapse ▴',
      totalRedeemed: '{amt} total back',
      noCashbackSeen: 'No cashback yet',
      cashbackPosted: '✓ Posted',
      pointsAmount: '{n} pts',
      noAddedOffers: 'No added offers yet',
      addedLoading: 'Reading cashback records…',
      addedError: 'Could not read cashback records.',
      addedFootnote: 'Spend status comes from posted cashback records, ' +
          'which usually lag 1–5 days · Amex is authoritative',
      // Wide mode (G4): the second density (≈880px centered overlay).
      expandWide: 'Expand',
      collapseSidebar: 'Collapse',
      colMerchantOffer: 'Merchant / offer',
      colExpiry: 'Expires',
      colCardStatus: 'Per-card status',
      colStatus: 'Status',
      colChooseCards: 'Add to which cards (tap a chip)',
      colOffer: 'OFFER',
      colCardResult: 'Per-card result',
      multiAddableOnly: 'Multi-card eligible only',
      nCards: '{n} cards',
      wideResultSub: '{n} add requests sent in parallel · re-read to confirm',
      resultLegend: '✗ Failed = Amex returned an error · ? Possible ' +
          'duplicate = reported success but absent on re-read (an offer ' +
          'usually adds to one card only)',
      retryFailed: 'Retry failed',
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
   * Candidate paths where an offer's category might live. The eligible/added
   * responses aren't confirmed to carry a category (FINDINGS only nails down
   * offerId/offerType/terms/longDescription), so this mirrors the v0.20
   * cashback-amount precedent: probe a list of likely fields and use whichever
   * exists. When the field name is later confirmed in DevTools this list can be
   * narrowed. Order is most- to least-specific.
   * @const {!Array<string>}
   */
  const OFFER_CATEGORY_PATHS = [
    'category', 'offerCategory', 'industry', 'categoryName',
    'merchantCategory', 'category.name', 'offerCategory.name', 'industry.name',
    'merchant.category', 'categorization.category', 'taxonomy.category',
  ];

  /**
   * Best-effort category for a raw offer. Probes {@link OFFER_CATEGORY_PATHS}
   * for a non-empty string (or the first entry of a category array/object) and
   * returns it normalized (trimmed, inner whitespace collapsed), or '' when no
   * candidate carries one. Pure and export-tested; drives the "按类目" grouping
   * option (which is hidden entirely when every offer returns '').
   * @param {?Object} offer Raw offer object.
   * @return {string} Normalized category, or ''.
   */
  function offerCategory(offer) {
    if (!offer || typeof offer !== 'object') return '';
    const norm = (v) =>
      typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
    for (const path of OFFER_CATEGORY_PATHS) {
      const hit = norm(getPath(offer, path));
      if (hit) return hit;
    }
    for (const path of ['categories', 'offerCategories']) {
      const arr = getPath(offer, path);
      if (Array.isArray(arr) && arr.length) {
        const first = arr[0];
        const hit = norm(typeof first === 'string' ? first : first?.name);
        if (hit) return hit;
      }
    }
    return '';
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
   * @param {!Object<string, string>=} headers Extra headers, merged over the
   *     defaults (e.g. a different `Accept` for an endpoint that needs one).
   * @return {!Promise<!Object>} Parsed JSON response.
   */
  function postJson(url, body, headers = {}) {
    return requestJson(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...headers,
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
   * card's product for display — including its art, which Amex omits on
   * supplementary entries. Cards without an `account_token` are skipped.
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
        // A supplementary entry mirrors a top-level account: its enroll token
        // sits on the wrapper (`supp.account_token`), while the card's identity
        // fields (relationship, digits, index) are nested under `supp.account`.
        // Some payloads instead nest the token too, so accept either place.
        // Inherit the parent product for display when the supplementary carries
        // none of its own, and default its relationship to SUPP.
        const token = supp &&
            (supp.account_token || getPath(supp, 'account.account_token'));
        if (!token) continue;
        // Amex omits the card art on supplementary entries, so fall back to the
        // parent card's art — otherwise the supp renders a blank swatch.
        const ownProduct =
            supp.product || getPath(supp, 'account.product') || {};
        cards.push({
          ...supp,
          account_token: token,
          relationship: getPath(supp, 'account.relationship') ||
              supp.relationship || 'SUPP',
          product: {
            ...(account.product || {}),
            ...ownProduct,
            small_card_art: getPath(ownProduct, 'small_card_art') ||
                getPath(account, 'product.small_card_art') || '',
          },
        });
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
    // This endpoint answers to `Accept: */*`; a stricter `application/json`
    // can come back empty, so override just the Accept header here.
    const data = await postJson(READ_BENEFITS_URL,
      [{accountToken: token, locale: LOCALE, limit: BENEFIT_LIMIT}],
      {'Accept': '*/*'});
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
    // Collect the perks we can't put a dollar tracker on (spend-to-unlock,
    // pass-based, or catalog perks issued elsewhere) so the UI can list them
    // honestly. This does not change what `benefits` contains — those items
    // stay dropped from the tracked list; the summary rides along as a
    // property so callers that only iterate the array are unaffected.
    benefits.untrackable = collectUntrackableBenefits(perCard);
    return benefits;
  }

  /**
   * Gathers the benefits we deliberately keep out of the tracked list because
   * no dollar tracker maps to them, so the Benefits view can surface them under
   * a de-emphasized "无法自动追踪" row. Two sources, deduped by name:
   *   1. Trackers dropped by {@link isTrackedCredit} — spend-to-unlock
   *      milestones (`category === 'spend'`) and pass-based perks
   *      (`targetUnit === 'PASSES'`).
   *   2. Enrolled catalog perks whose `sorBenefitId` matches no dollar tracker
   *      (e.g. Uber Cash, issued inside the Uber app). Not-enrolled enrollable
   *      credits are excluded — those already surface as "去激活" rows.
   * @param {!Array<{card: !Object, trackers: !Array<!Object>,
   *     catalog: !Object}>} perCard Raw per-card reads.
   * @return {!Array<{name: string, family: string, digits: string,
   *     token: string}>} Untrackable items in first-seen order.
   */
  function collectUntrackableBenefits(perCard) {
    const trackedSor = new Set();
    for (const {trackers} of perCard) {
      for (const t of trackers || []) {
        if (!isTrackedCredit(t)) continue;
        const sor = t.sorBenefitId || t.benefitId || '';
        if (sor) trackedSor.add(sor);
      }
    }
    const out = [];
    const seen = new Set();
    const push = (name, card) => {
      const key = benefitNameKey(name);
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push({name, family: card.family, digits: card.digits,
        token: card.token});
    };
    for (const {card, trackers} of perCard) {
      for (const t of trackers || []) {
        if (!isTrackedCredit(t)) push(t.benefitName || '', card);
      }
    }
    for (const {card, catalog} of perCard) {
      for (const slug of Object.keys(catalog || {})) {
        const c = catalog[slug];
        if (!c || c.layoutType === 'NOTENROLLED') continue;
        const sor = c.sorBenefitId || '';
        if (sor && trackedSor.has(sor)) continue;
        push(decodeHtml(
          c.benefitTitle || c.benefitShortTitle || c.benefitName || ''), card);
      }
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
   * Computes the benefits header stats from grouped benefits. With `cardFilter`
   * set to a token the three tiles narrow to that one card: only its own
   * entries count toward redeemed / this-month-unused, and only its annual fee
   * feeds the payback percentage (the "single-card" reading behind the card
   * chips filter).
   * @param {!Array<!Object>} groups Grouped benefits.
   * @param {!Array<!Object>} cards Snapshot cards (for annual-fee lookup).
   * @param {number=} now Epoch ms treated as "today".
   * @param {string=} cardFilter `'all'` (every card) or a card token.
   * @return {{thisMonthUnused: number, redeemedYtd: number,
   *           annualFee: number, paybackPct: number}} Stats.
   */
  function benefitStats(groups, cards, now = Date.now(), cardFilter = 'all') {
    const nowDate = new Date(now);
    let thisMonthUnused = 0;
    let redeemedYtd = 0;
    const addUnused = (endStr, amount) => {
      const end = new Date(endStr);
      if (!Number.isNaN(end.getTime()) &&
          end.getFullYear() === nowDate.getFullYear() &&
          end.getMonth() === nowDate.getMonth()) {
        thisMonthUnused += amount;
      }
    };
    for (const g of groups) {
      if (cardFilter === 'all') {
        redeemedYtd += g.spent;
        addUnused(g.periodEnd, g.remaining);
        continue;
      }
      for (const e of g.entries || []) {
        if (e.token !== cardFilter) continue;
        redeemedYtd += e.spent;
        addUnused(e.periodEnd || g.periodEnd, Math.max(0, e.target - e.spent));
      }
    }
    const owned = cards
      .filter((c) => (c.relationship || 'BASIC') === 'BASIC')
      .filter((c) => cardFilter === 'all' || c.token === cardFilter);
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

  /** Nominal length of each reset period in days (for the amber rule). */
  const BENEFIT_PERIOD_DAYS = {month: 31, quarter: 91, half: 182, year: 365};
  /** The order period groups render in (soonest cadence first). */
  const BENEFIT_PERIOD_ORDER = ['month', 'quarter', 'half', 'year'];

  /**
   * The tone for a period group's "还剩 N 天" badge. Amber only once the
   * period is more than three-quarters elapsed (remaining < 25% of the
   * nominal length); grey otherwise. This replaces the old per-row ≤7-day
   * red-days rule inside the Benefits page (the offers page keeps its own
   * red "expiring" rule, which is unrelated).
   * @param {string} period Cadence key (`month`/`quarter`/`half`/`year`).
   * @param {number} daysLeft Whole days until the period resets.
   * @return {string} `'amber'` or `'gray'`.
   */
  function benefitPeriodTone(period, daysLeft) {
    if (!Number.isFinite(daysLeft)) return 'gray';
    const full = BENEFIT_PERIOD_DAYS[period] || BENEFIT_PERIOD_DAYS.year;
    return daysLeft < full * 0.25 ? 'amber' : 'gray';
  }

  /**
   * Buckets finalized benefit groups by reset cadence into ordered period
   * sections (每月/每季/每半年/每年), each carrying the summary the group
   * header renders: the soonest reset (min finite `daysLeft`), the item count,
   * and the pending dollars. When a period holds only not-yet-activated
   * benefits the pending amount is their target sum and `activation` flips true
   * (the header then reads "待激活" instead of "待用"); fully-used groups
   * contribute nothing to the pending amount.
   * @param {!Array<!Object>} groups Finalized benefit groups.
   * @return {!Array<{period: string, daysLeft: number, count: number,
   *     amount: number, activation: boolean, groups: !Array<!Object>}>}
   *     Non-empty period sections in cadence order.
   */
  function buildBenefitPeriodGroups(groups) {
    const byPeriod = new Map();
    for (const g of groups) {
      const p = BENEFIT_PERIOD_ORDER.includes(g.period) ? g.period : 'year';
      if (!byPeriod.has(p)) byPeriod.set(p, []);
      byPeriod.get(p).push(g);
    }
    const out = [];
    for (const period of BENEFIT_PERIOD_ORDER) {
      const list = byPeriod.get(period);
      if (!list || !list.length) continue;
      let amount = 0;
      let activeRemaining = 0;
      let hasInactive = false;
      let daysLeft = Infinity;
      for (const g of list) {
        if (Number.isFinite(g.daysLeft) && g.daysLeft < daysLeft) {
          daysLeft = g.daysLeft;
        }
        if (isInactiveBenefit(g)) {
          hasInactive = true;
          amount += g.target;
        } else if (!g.fullyUsed) {
          amount += g.remaining;
          activeRemaining += g.remaining;
        }
      }
      out.push({period, daysLeft, count: list.length, amount: round2(amount),
        activation: activeRemaining <= 0 && hasInactive, groups: list});
    }
    return out;
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
          category: offerCategory(offer),
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
        if (!g.category) g.category = offerCategory(offer);
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
   * Re-groups the added-offer index by card: one entry per card that has added
   * offers, listing that card's offers with their redemption status. Cards keep
   * their account order; within a card, unredeemed offers sort by soonest
   * expiry and redeemed ones sink.
   * @param {!Array<!Object>} offerGroups Groups from {@link buildAddedIndex}.
   * @param {!Array<string>=} cardOrder Card tokens in the order groups should
   *     sort (defaults to the current account order). Injected by tests so the
   *     function stays pure.
   * @return {!Array<!Object>} One group per card.
   */
  function buildAddedByCard(offerGroups,
    cardOrder = state.cards.map((c) => c.token)) {
    const byToken = new Map();
    for (const g of offerGroups) {
      for (const c of g.cards) {
        let card = byToken.get(c.token);
        if (!card) {
          card = {token: c.token, offers: []};
          byToken.set(c.token, card);
        }
        card.offers.push({key: g.key, name: g.name, image: g.image,
          description: g.description, daysLeft: g.daysLeft, expiry: g.expiry,
          redeemed: c.redeemed});
      }
    }
    const groups = [...byToken.values()];
    for (const card of groups) {
      card.redeemedCount = card.offers.filter((o) => o.redeemed).length;
      const sum = (unit) => round2(card.offers.reduce((total, o) =>
        total + (o.redeemed && o.redeemed.unit === unit ?
          o.redeemed.amount : 0), 0));
      card.totalRedeemedUsd = sum('usd');
      card.totalRedeemedPoints = sum('points');
      card.fullyRedeemed = card.offers.length > 0 &&
          card.redeemedCount === card.offers.length;
      const order = (o) => Number.isFinite(o.daysLeft) ? o.daysLeft : 1e9;
      card.offers.sort((a, b) => {
        if (!!a.redeemed !== !!b.redeemed) return a.redeemed ? 1 : -1;
        return order(a) - order(b);
      });
    }
    // Stable card ordering follows the supplied (account) order.
    const rank = new Map(cardOrder.map((token, i) => [token, i]));
    return groups.sort((a, b) =>
      (rank.get(a.token) ?? 1e9) - (rank.get(b.token) ?? 1e9));
  }

  /**
   * Re-groups the added-offer index by category, using each group's probed
   * {@link offerCategory}. Named categories sort alphabetically; the
   * uncategorized bucket (category '') always sinks last. Pure.
   * @param {!Array<!Object>} offerGroups Groups from {@link buildAddedIndex}.
   * @return {!Array<{category: string, offers: !Array<!Object>}>} Sections.
   */
  function groupAddedByCategory(offerGroups) {
    const byCat = new Map();
    for (const g of offerGroups) {
      const cat = g.category || '';
      let sec = byCat.get(cat);
      if (!sec) {
        sec = {category: cat, offers: []};
        byCat.set(cat, sec);
      }
      sec.offers.push(g);
    }
    return [...byCat.values()].sort((a, b) => {
      if (!a.category !== !b.category) return a.category ? -1 : 1;
      return a.category.localeCompare(b.category);
    });
  }

  /**
   * Dispatches the added-offer index into the shape the requested grouping
   * mode renders from. Pure; the renderer interprets the return by `mode`.
   * @param {!Array<!Object>} offerGroups Groups from {@link buildAddedIndex}.
   * @param {string} mode `'expiry'` (flat, already expiry-sorted), `'card'`
   *     (per-card groups), or `'category'` (per-category sections).
   * @param {!Array<string>=} cardOrder Card order for `'card'` mode.
   * @return {!Array<!Object>} Flat groups, card groups, or category sections.
   */
  function groupAddedBy(offerGroups, mode, cardOrder) {
    if (mode === 'card') return buildAddedByCard(offerGroups, cardOrder);
    if (mode === 'category') return groupAddedByCategory(offerGroups);
    return offerGroups;
  }

  /**
   * Header stats for the added view. `redeemedAmount` is dollars only —
   * points postings are tallied separately and never converted to money.
   * With `cardFilter` set to a token the three tiles narrow to that one card:
   * only its own postings count, and pending/expiring count only its offers
   * that haven't posted (the "single-card" reading behind mock state D).
   * @param {!Array<!Object>} groups Added-offer groups.
   * @param {string=} cardFilter `'all'` (every card) or a card token.
   * @return {{redeemedAmount: number, redeemedPoints: number,
   *           pending: number, expiring: number}} Posted cashback dollars,
   *     posted points, offers not yet redeemed, and how many of those
   *     expire within 7 days.
   */
  function addedStats(groups, cardFilter = 'all') {
    let redeemedAmount = 0;
    let redeemedPoints = 0;
    let pending = 0;
    let expiring = 0;
    const soon = (g) => Number.isFinite(g.daysLeft) && g.daysLeft >= 0 &&
        g.daysLeft <= 7;
    for (const g of groups) {
      if (cardFilter === 'all') {
        redeemedAmount += g.totalRedeemedUsd;
        redeemedPoints += g.totalRedeemedPoints;
        if (!g.fullyRedeemed) {
          pending++;
          if (soon(g)) expiring++;
        }
        continue;
      }
      const c = g.cards.find((x) => x.token === cardFilter);
      if (!c) continue;
      if (c.redeemed) {
        if (c.redeemed.unit === 'points') redeemedPoints += c.redeemed.amount;
        else redeemedAmount += c.redeemed.amount;
      } else {
        pending++;
        if (soon(g)) expiring++;
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

  /**
   * Groups flat enroll results by their offer group key, preserving first-seen
   * order. Used by the wide result / running views, which show one row per
   * offer with each card's outcome as a chip (vs. the sidebar's one-row-per
   * (offer, card) list). Pure; no I/O.
   * @param {!Array<!Object>} results Results carrying `key`, `name`, `token`.
   * @return {!Array<{key: string, name: string, results: !Array<!Object>}>}
   *     One entry per offer, in first-seen order.
   */
  function groupResultsByOffer(results) {
    const byKey = new Map();
    for (const r of results) {
      let g = byKey.get(r.key);
      if (!g) {
        g = {key: r.key, name: r.name, results: []};
        byKey.set(r.key, g);
      }
      g.results.push(r);
    }
    return [...byKey.values()];
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
    groupResultsByOffer,
    fetchRedeemedOffers,
    buildAddedIndex,
    buildAddedByCard,
    groupAddedBy,
    groupAddedByCategory,
    offerCategory,
    addedStats,
    offerExpiryDays,
    fetchAccountBenefits,
    fetchCardCatalog,
    fetchAllBenefits,
    collectUntrackableBenefits,
    buildBenefitIndex,
    benefitStats,
    benefitPeriodTone,
    buildBenefitPeriodGroups,
    isInactiveBenefit,
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
    // How the 'added' redeem-tracking view lays out its rows, chosen from the
    // top-right dropdown: 'expiry' (flat, expiry-ascending — the default),
    // 'card' (per-card groups), or 'category' (per-category sections; the
    // dropdown hides this option when no offer carries a category).
    addedGroupBy: 'expiry',
    // Single-card filter for the 'added' view (its own chips row). Kept apart
    // from the addable view's `cardFilter` so the two tabs never cross-taint.
    addedCardFilter: 'all',
    // Whether the added view's grouping dropdown menu is open.
    addedMenuOpen: false,
    // Expanded groups in the 'added' view (collapsed by default so a card /
    // offer with many rows stays a one-line summary). Keys: 'o:<offerKey>' or
    // 'card:<cardToken>'.
    addedExpanded: new Set(),
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
    // Single-card filter for the Benefits tab (its own chips row), kept apart
    // from the offers views' filters so tabs never cross-taint.
    benefitCardFilter: 'all',
    benefitQuery: '',
    // Perks with no dollar tracker, surfaced under a de-emphasized collapsible
    // "无法自动追踪" row at the bottom of the list.
    benefitsUntrackable: [],
    benefitsUntrackableOpen: false,
    // Wide mode (G4): offer keys whose per-card status chips are expanded past
    // the "+N" overflow in the wide added table.
    wideChipsExpanded: new Set(),
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
    renderLauncherContent();
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

  // ---- density (sidebar ↔ wide) --------------------------------------------
  // The panel has two densities of the SAME skeleton: the 400px sidebar (a
  // companion pane that hugs the Amex page) and a ≈880px centered overlay for
  // browsing/managing. The preference persists (like the language/position);
  // a window too narrow to hold the overlay falls back to the sidebar without
  // losing the preference, and restores it once the window is wide enough.

  /** localStorage key holding the chosen density preference. */
  const DENSITY_STORAGE_KEY = 'amexAssistantDensity';
  /** Below this viewport width the overlay can't fit, so we fall back. */
  const WIDE_MIN_WIDTH = 940;

  /** The user's density preference: `'sidebar'` (default) or `'wide'`. */
  let densityPref = 'sidebar';
  /** The geometry applied to the host, so it isn't reset on every render. */
  let appliedDensity = null;

  /** Loads the saved density preference and watches the viewport. */
  function initDensity() {
    try {
      const saved = localStorage.getItem(DENSITY_STORAGE_KEY);
      if (saved === 'wide' || saved === 'sidebar') densityPref = saved;
    } catch { /* private mode etc.; default sidebar */ }
    let timer = null;
    window.addEventListener('resize', () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        const open = panelHost && panelHost.style.display !== 'none';
        if (open && currentDensity() !== appliedDensity) render();
      }, 150);
    });
  }

  /**
   * The effective density: the preference, unless the window is too narrow to
   * fit the overlay (then the sidebar, keeping the preference for later).
   * @return {string} `'sidebar'` or `'wide'`.
   */
  function currentDensity() {
    return densityPref === 'wide' && window.innerWidth >= WIDE_MIN_WIDTH ?
      'wide' : 'sidebar';
  }

  /** Whether the current window is wide enough to offer the overlay at all. */
  function canGoWide() {
    return window.innerWidth >= WIDE_MIN_WIDTH;
  }

  /** Flips the density preference (from the ⤢/收窄 header button). */
  function toggleDensity() {
    densityPref = densityPref === 'wide' ? 'sidebar' : 'wide';
    try {
      localStorage.setItem(DENSITY_STORAGE_KEY, densityPref);
    } catch { /* private mode etc.; the choice just won't stick */ }
    render();
  }

  /**
   * Positions the host for the current density. The wide overlay is a fixed,
   * centered, non-draggable box (its size comes from the CSS); the sidebar
   * restores its saved/default top-right spot. Only runs when the density
   * actually changes, so an in-session sidebar drag survives re-renders.
   * @param {boolean} wide Whether the wide overlay is active.
   */
  function applyDensityGeometry(wide) {
    const key = wide ? 'wide' : 'sidebar';
    if (appliedDensity === key) return;
    appliedDensity = key;
    if (!panelHost) return;
    const s = panelHost.style;
    if (wide) {
      // A previously dragged spot wins over centering; clamp it to the current
      // viewport using the overlay's own metrics (the .p may still be laid out
      // at sidebar size at this point in the render).
      const saved = savedPosition('panelWide');
      if (saved) {
        const w = Math.min(880, window.innerWidth - 24);
        const h = window.innerHeight - 56;
        const x = Math.max(4, Math.min(saved.x, window.innerWidth - w - 4));
        const y = Math.max(4,
          Math.min(saved.y, Math.max(4, window.innerHeight - h - 4)));
        s.left = `${x}px`;
        s.top = `${y}px`;
        s.right = 'auto';
        s.bottom = 'auto';
        s.transform = 'none';
      } else {
        s.top = '50%';
        s.left = '50%';
        s.right = 'auto';
        s.bottom = 'auto';
        s.transform = 'translate(-50%, -50%)';
      }
    } else {
      s.transform = '';
      const saved = savedPosition('panel');
      if (saved) {
        applyPosition(panelHost, saved);
      } else {
        s.top = '16px';
        s.right = '16px';
        s.left = 'auto';
        s.bottom = 'auto';
      }
    }
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
      /* ===== Design tokens (merged from design/v2/tokens/*.css) ===== */
      /* colors.css — 双蓝规则: 藏青=过滤/视图状态, 亮蓝=动作/提交性选择 */
      --amex-blue: #006FCF; --amex-blue-hover: #0264BE;
      --amex-blue-tint: rgba(0,111,207,.08); --amex-blue-text: #0A6ACB;
      --navy: #0B1F4E; --navy-deep: #00175A; --selected-border: #9EC4E8;
      --green: #0B7A3E; --green-tint: #EAF3EC; --green-border: #D8E9DD;
      --green-row: #F7FAF8; --green-row-border: #E2EDE5;
      --red: #C8102E; --red-tint: #FBEAEA; --red-border: #F0D5D2;
      --amber: #9A6A00; --amber-tint: #FBF3E0; --amber-border: #EFE2BD;
      --ink: #1A1E28; --text-2: #5A5F6A; --text-3: #6A6F7A; --text-4: #8A8F99;
      --text-5: #9CA1AB; --text-disabled: #C9CCD0;
      --surface-page: #F5F6F8; --surface-card: #FFFFFF; --surface-sunken: #FAFBFC;
      --surface-btn: #F2F4F7; --surface-seg: #E9EBEF; --surface-count: #EEF0F3;
      --border-1: #E2E5EA; --border-2: #E7E9EE; --border-3: #E9EAEE;
      --border-card: #ECEEF2; --border-hairline: #EEF0F3; --border-inner: #F0F2F5;
      --border-row: #F4F5F7; --track: #E7EAEF;
      --card-silver: linear-gradient(135deg, #dfe2e6, #b3b9c1);
      --card-gold: linear-gradient(135deg, #e9cd85, #c29a45);
      --archived-text: #5A6B60; --archived-sub: #93A29A;
      --hover-on-white: #F7F8FA; --hover-on-btn: #E7EAEF;
      --border-expanded: #D8DDE5; --spinner-track: #D9E8F8;
      --text-body: var(--ink); --text-muted: var(--text-4);
      --action: var(--amex-blue); --filter-active: var(--navy);
      /* shape.css */
      --r-panel: 18px; --r-row: 14px; --r-item: 12px; --r-seg: 10px;
      --r-btn: 9px; --r-chip: 6px; --r-pill: 18px; --corner: superellipse(1.6);
      --shadow-panel: 0 32px 80px -12px rgba(0,23,90,.2), 0 2px 6px rgba(0,23,90,.05);
      --shadow-card: 0 1px 2px rgba(0,23,90,.04);
      --shadow-seg: 0 1px 3px rgba(0,23,90,.12);
      --shadow-cta: 0 6px 16px -8px rgba(0,111,207,.5);
      --shadow-input: inset 0 1px 2px rgba(0,23,90,.03);
      --gap-row: 8px; --gap-block: 12px; --gap-section: 16px; --panel-pad: 16px;
      /* typography.css — 边栏默认字阶 (宽模式覆盖见 .p[data-density=wide]) */
      --font-ui: 'Public Sans', 'PingFang SC', 'Microsoft YaHei', system-ui,
        sans-serif;
      --fs-title: 13px; --fs-amount: 12.5px; --fs-body: 11.5px; --fs-sub: 11px;
      --fs-caption: 10.5px; --fs-header: 14px; --fs-stat: 16px;
      --row-pad: 12px 15px;
      /* ===== Legacy aliases (existing rules resolve through these unchanged) ===== */
      --blue: var(--amex-blue); --blue2: var(--amex-blue-hover);
      --bluesoft: var(--amex-blue-text); --navy2: var(--navy-deep);
      --sub: var(--text-2); --sub2: var(--text-3); --mut: var(--text-4);
      --fog: var(--text-5); --line: var(--border-card);
      --line2: var(--border-hairline); --bd: var(--border-3);
      --bd2: var(--border-2); --chip: var(--surface-btn); --chip2: var(--track);
      --panel: var(--surface-page); --se: superellipse(1.6);
      /* aliases with no exact token equivalent — kept at their original values */
      --ink2: #3A3F4A; --faint: #B4B9C2; --line3: #F2F3F5;
      --amberbg: #FBF6E8; --amberbd: #F0E3BC; --ambertx: #7A5600;
      font: 13px/1.4 var(--font-ui);
      color: var(--ink); background: var(--panel); border: 1px solid var(--bd);
      border-radius: var(--r-panel); corner-shape: var(--se);
      width: 400px; max-height: 86vh; display: flex;
      flex-direction: column; overflow: hidden; position: relative;
      box-shadow: 0 32px 80px -12px rgba(0,23,90,.2), 0 2px 6px rgba(0,23,90,.05);
      transform-origin: top right;
      transition: opacity .18s ease, transform .18s ease;
    }
    /* Wide-mode density scale — reserved. G4 sets data-density="wide" on .p for
       the wide overlay; sidebar leaves it unset. Values: tokens/typography.css. */
    .p[data-density="wide"] {
      --fs-title: 14.5px; --fs-amount: 14px; --fs-body: 12.5px; --fs-sub: 12px;
      --fs-caption: 11.5px; --fs-header: 15px; --fs-stat: 16px;
      --row-pad: 15px 18px;
    }
    /* Collapsed state used to grow-in on open and shrink-out on close. */
    .p.closing { opacity: 0; transform: scale(.9); }
    /* The superellipse (squircle) corner applies to every rounded surface;
       true circles keep border-radius:50% and are excluded on purpose. */
    .subpills, .subpill, .sr input, .cfil, .grp, .cards, .logo, .cnt .c,
    .go, .lnk.rerun, .info, .banner, .cfdlg, .cf-list, .bactivate, .msg .btn,
    .bgrp, .bstats .c, .buntrack, .buntrack-item, .agrp, .actbtn, .ic.brand,
    .cfsw, .sw,
    .expandbox, .trust-b, .cir { corner-shape: var(--se); }

    /* ---- header ---- */
    .hd { display: flex; flex-direction: column; background: #fff; flex: none; }
    .hrow { display: flex; align-items: center; gap: 12px;
      padding: 16px 20px 14px; border-bottom: 1px solid var(--line2);
      cursor: move; user-select: none; }
    .hd.tabbed .hrow { padding: 16px 20px 12px; border-bottom: none; }
    .hd.err .hrow { border-bottom: 2px solid var(--red); }
    .hd.warn .hrow { border-bottom: 2px solid #D9A62E; }
    .mtabs { display: flex; gap: 22px; padding: 0 20px; font-size: var(--fs-amount);
      background: #fff; border-bottom: 1px solid var(--line2); }
    .mtab { color: var(--sub2); padding: 8px 0 10px; cursor: pointer;
      border-bottom: 2px solid transparent; }
    .mtab.on { font-weight: 700; color: var(--navy);
      border-bottom-color: var(--blue); }
    .ic.brand { width: 34px; height: 34px; flex: none; background: none;
      border-radius: 0; display: block; }
    .ic.brand svg { display: block; }
    .ic { width: 34px; height: 34px; border-radius: 9px; corner-shape: var(--se);
      background: var(--blue); color: #fff; display: flex; align-items: center;
      justify-content: center; font-size: 17px; font-weight: 700; flex: none; }
    .hd .tt { flex: 1; min-width: 0; }
    .t1 { font-size: 15px; font-weight: 800; color: var(--navy);
      letter-spacing: -.2px; }
    .t2 { font-size: var(--fs-caption); color: var(--mut); margin-top: 1px;
      font-variant-numeric: tabular-nums;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rf { width: 30px; height: 30px; border-radius: 50%; border: none;
      background: var(--chip); color: var(--sub); font-size: 15px;
      cursor: pointer; display: flex; align-items: center;
      justify-content: center; flex: none; transition: background .15s ease; }
    .rf:hover { background: var(--hover-on-btn); }
    .rf.lang { font-size: var(--fs-caption); font-weight: 800; letter-spacing: .2px;
      color: var(--sub2); }
    .cl { width: 30px; height: 30px; border-radius: 50%; margin-right: -4px;
      font-size: 15px; color: var(--sub); cursor: pointer; line-height: 1;
      background: var(--chip); border: none; flex: none; display: flex;
      align-items: center; justify-content: center;
      transition: background .15s ease; }
    .cl:hover { background: var(--hover-on-btn); }

    /* ---- body & shared ---- */
    .body { overflow-y: auto; padding-bottom: 6px; }
    /* Full-width status banners that sit directly under the header/tabs. */
    .banner { display: flex; align-items: center; gap: 9px;
      background: var(--amberbg); border-bottom: 1px solid var(--amberbd);
      padding: 9px 20px; font-size: var(--fs-sub); color: var(--ambertx);
      line-height: 1.5; }
    .banner .ico { font-size: 12px; color: var(--amber); line-height: 1; }
    .banner .sp { flex: 1; }
    .banner b { color: var(--ambertx); }
    .banner .act { font-size: var(--fs-sub); font-weight: 700; color: var(--blue);
      cursor: pointer; white-space: nowrap; }
    .lastrun { display: flex; align-items: center; gap: 5px; padding: 8px 20px;
      background: #fff; border-bottom: 1px solid var(--line2);
      font-size: var(--fs-sub); color: var(--mut); font-variant-numeric: tabular-nums; }
    .lastrun .sp { flex: 1; }
    .lastrun b { font-weight: 700; }

    /* ---- sub-tab pills (可加 / 已加) ---- */
    /* Expiry-ascending is the fixed default order, so no sort control lives
       here (the per-row "至 MM/DD" already conveys it). */
    .subbar { display: flex; align-items: center; gap: 10px;
      padding: 14px 16px 0; }
    .subpills { display: flex; background: var(--surface-seg);
      border-radius: var(--r-seg); padding: 2px; }
    .subpill { padding: 5px 14px; font-size: var(--fs-body); font-weight: 600;
      color: var(--sub2); cursor: pointer; border-radius: 8px;
      corner-shape: var(--se); font-variant-numeric: tabular-nums; }
    .subpill.on { background: #fff; font-weight: 700; color: var(--navy);
      box-shadow: 0 1px 3px rgba(0,23,90,.12); }

    /* ---- search ---- */
    .sr { position: relative; padding: 12px 16px 0; }
    .sr::before { content: '⌕'; position: absolute; left: 29px; top: 21px;
      font-size: 14px; color: var(--fog); pointer-events: none; }
    .sr input { width: 100%; border: 1px solid var(--bd2);
      border-radius: var(--r-btn);
      corner-shape: var(--se); padding: 9px 13px 9px 32px; font: inherit;
      font-size: var(--fs-amount); color: var(--ink); outline: none; background: #fff;
      box-shadow: inset 0 1px 2px rgba(0,23,90,.03); }
    .sr input::placeholder { color: var(--fog); }
    .sr input:focus { border-color: var(--blue); }

    /* ---- card filter chips (+ trailing dashed condition filter) ---- */
    .cfrow { display: flex; gap: 6px; padding: 12px 16px 0; overflow-x: auto;
      scrollbar-width: none; -ms-overflow-style: none; }
    .cfrow::-webkit-scrollbar { display: none; }
    .cfil { display: flex; align-items: center; gap: 6px; background: #fff;
      border: 1px solid var(--bd); color: var(--ink2); font-size: var(--fs-body);
      font-weight: 600; border-radius: var(--r-pill); padding: 6px 12px;
      white-space: nowrap; cursor: pointer; flex: none; }
    .cfil.on { background: var(--navy); color: #fff; border-color: var(--navy);
      padding: 6px 13px; }
    /* 1px divider between card filters (which card) and condition filters. */
    .cfdiv { width: 1px; background: var(--border-1); flex: none;
      margin: 4px 1px; }
    /* Condition filter (只看多卡): dashed border marks it apart from the solid
       card chips; active reads navy (a filter/view state, not an action). */
    .cfil.dash { border-style: dashed; border-color: var(--text-disabled);
      color: var(--sub); }
    .cfil.dash.on { color: var(--navy); border-color: var(--navy);
      background: rgba(11,31,78,.06); font-weight: 700; }
    .cfico { display: flex; flex: none; }
    .cfsw { width: 16px; height: 11px; border-radius: 2px; flex: none;
      overflow: hidden; background: linear-gradient(135deg,#dfe2e6,#b3b9c1); }
    .cfsw img { width: 100%; height: 100%; object-fit: cover; }

    /* ---- list header: count + select-all / clear (two states) ---- */
    .lh { display: flex; align-items: center; justify-content: space-between;
      padding: 14px 20px 0; }
    .lh-l { font-size: var(--fs-sub); font-weight: 600; color: var(--text-4);
      letter-spacing: .2px; font-variant-numeric: tabular-nums; }
    .lh-l.sel { font-weight: 700; color: var(--navy); }
    .lh-a { font-size: var(--fs-body); font-weight: 700; color: var(--amex-blue);
      cursor: pointer; white-space: nowrap; }
    .lh-a.mut { font-weight: 600; color: var(--text-4); }

    /* ---- offer list: each group is its own white card ---- */
    .list { display: flex; flex-direction: column; gap: 8px; padding: 12px 16px 0; }
    .grp { background: #fff; border: 1px solid var(--line);
      border-radius: var(--r-row); corner-shape: var(--se);
      box-shadow: 0 1px 2px rgba(0,23,90,.04), 0 16px 32px -24px rgba(0,23,90,.18);
      transition: box-shadow .15s ease, border-color .15s ease; }
    .grp:hover { border-color: #DFE3EA;
      box-shadow: 0 2px 4px rgba(0,23,90,.05), 0 20px 40px -20px rgba(0,23,90,.28); }
    .grp.done { opacity: .55; }
    .grp.exp { background: linear-gradient(180deg,#FEFEFF,#F7FBFF);
      border-color: rgba(0,111,207,.3);
      box-shadow: 0 12px 28px -14px rgba(0,111,207,.35); }
    .grp.exp:hover { border-color: rgba(0,111,207,.4); }
    .row { display: flex; gap: 11px; padding: 13px 14px; align-items: center; }
    /* Expandable rows (not fully-added) are clickable to reveal the card list. */
    .grp:not(.done) > .row { cursor: pointer; }
    .grp:not(.done) > .row input[type=checkbox] { cursor: pointer; }
    .grp.exp > .row { padding: 13px 14px 9px; }
    .logo { width: 40px; height: 40px; border-radius: 9px; corner-shape: var(--se);
      flex: none; overflow: hidden; display: flex; align-items: center;
      justify-content: center; font-size: 12px; font-weight: 700;
      background: #E7F0FA; color: #1B62A8;
      box-shadow: inset 0 0 0 1px rgba(20,60,120,.05); }
    .logo img { width: 100%; height: 100%; object-fit: contain; background: #fff; }
    .mn { flex: 1; min-width: 0; }
    .nm { font-size: var(--fs-title); font-weight: 700; color: var(--ink);
      letter-spacing: -.1px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ds { font-size: var(--fs-body); color: var(--sub2); margin-top: 1px; overflow: hidden;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .rt { text-align: right; flex: none; }
    .bd { display: inline-block; font-size: var(--fs-sub); font-weight: 600;
      color: var(--bluesoft); background: rgba(0,111,207,.07);
      border-radius: 11px; padding: 3px 9px; white-space: nowrap; cursor: pointer;
      font-variant-numeric: tabular-nums; }
    .bd .dot, .bd .en, .bd .car { color: inherit; }
    .ex { font-size: var(--fs-caption); color: var(--fog); margin-top: 4px;
      font-variant-numeric: tabular-nums; }
    .runbadge { display: inline-flex; gap: 6px; font-size: var(--fs-sub); font-weight: 700;
      font-variant-numeric: tabular-nums; margin-bottom: 3px; }
    .done-tag { font-size: var(--fs-caption); font-weight: 700; color: var(--green);
      white-space: nowrap; font-variant-numeric: tabular-nums; }
    /* expanded "加到哪些卡" inset box */
    .cards { margin: 0 14px 12px 65px; display: flex; flex-direction: column;
      gap: 2px; background: #F7F9FC; border: 1px solid #EDF2F9;
      border-radius: 8px; corner-shape: var(--se); padding: 10px 12px; }
    .cards .lb { font-size: 9.5px; font-weight: 800; color: var(--fog);
      letter-spacing: .7px; padding-bottom: 5px; }
    .ccard { display: flex; align-items: center; gap: 9px; font-size: 12px;
      color: var(--ink); padding: 4px 0; cursor: pointer;
      font-variant-numeric: tabular-nums; }
    .ccard.off { color: var(--faint); cursor: default; }
    .sw { width: 28px; height: 18px; border-radius: 4px; flex: none;
      overflow: hidden; background: linear-gradient(135deg,#dfe2e6,#b3b9c1); }
    .sw img { width: 100%; height: 100%; object-fit: cover; }
    .ccard .mk { margin-left: auto; font-size: var(--fs-caption); font-weight: 700; }
    .ccard .mk.en { color: var(--green); }
    .ccard .mk.r-failed { color: var(--red); }
    .ccard .mk.r-ghost { color: var(--amber); }
    .ccard .mk.r-unverified { color: var(--mut); }
    .ccard .mk.r-skipped { color: var(--amber); }
    input[type=checkbox] { width: 16px; height: 16px; accent-color: var(--blue);
      flex: none; }
    .ccard input[type=checkbox] { width: 14px; height: 14px; }

    /* ---- footer action bar (two states): a flat white strip with a hairline
       top border that bookends the white header across the grey list ---- */
    .ft { padding: 12px 16px 14px; display: flex; align-items: center;
      gap: 12px; flex: none; background: var(--surface-card);
      border-top: 1px solid var(--border-hairline); }
    /* Idle (nothing selected): a centered grey hint, no button. */
    .ft.idle { justify-content: center; padding: 11px 16px; }
    .ft.idle .sm { flex: none; text-align: center; color: var(--text-5); }
    .ft .sm { flex: 1; font-size: var(--fs-body); color: var(--sub);
      font-variant-numeric: tabular-nums; line-height: 1.4; }
    .ft .sm b { color: var(--ink); }
    .go { background: var(--blue); color: #fff; font-size: var(--fs-title); font-weight: 700;
      letter-spacing: .2px; border: none; border-radius: var(--r-btn);
      corner-shape: var(--se); padding: 11px 24px; cursor: pointer;
      white-space: nowrap; box-shadow: 0 6px 16px -8px rgba(0,111,207,.5);
      transition: background .15s ease; }
    .go:hover { background: var(--blue2); }
    .go:disabled { opacity: .5; cursor: default; box-shadow: none; }

    /* ---- stat tiles (results / running / added) ---- */
    .cnt { display: flex; gap: 8px; padding: 14px 16px 0; }
    .cnt .c { flex: 1; background: #fff; border: 1px solid var(--line);
      border-radius: var(--r-item); corner-shape: var(--se); padding: 13px 0;
      text-align: center; }
    .cnt .c .n { font-size: 20px; font-weight: 800;
      font-variant-numeric: tabular-nums; }
    .cnt.money .c .n { font-size: 18px; }
    .cnt.lg .c .n { font-size: 22px; }
    .cnt .c .l { font-size: var(--fs-caption); color: var(--sub); margin-top: 2px; }
    .cnt .sep { display: none; }
    .g { color: var(--green); } .r { color: var(--red); }
    .b { color: var(--blue); } .am { color: var(--amber); }
    .navy { color: var(--navy); }
    .bar { height: 4px; border-radius: 2px; background: #E7EAEF; overflow: hidden; }
    .bar > div { height: 100%; border-radius: 2px; background: var(--blue);
      transition: width .2s; }
    .note { font-size: var(--fs-caption); color: var(--fog); line-height: 1.5; }

    /* ---- info / explainer cards ---- */
    .info { margin: 12px 16px 0; background: var(--amberbg);
      border: 1px solid var(--amberbd); border-radius: 8px; corner-shape: var(--se);
      padding: 10px 13px; font-size: var(--fs-sub); color: var(--sub);
      line-height: 1.6; }
    .info b { color: var(--amber); }

    /* ---- grouped result list ---- */
    .reslist { margin: 12px 16px 0; background: #fff; border: 1px solid var(--line);
      border-radius: var(--r-item); corner-shape: var(--se); overflow: hidden; }
    .sh { font-size: 10px; font-weight: 800; color: var(--fog);
      letter-spacing: .7px; padding: 11px 14px 5px; }
    .si { display: flex; justify-content: space-between; gap: 8px;
      padding: 7px 14px; align-items: baseline;
      border-bottom: 1px solid var(--line3); font-size: 12px; color: var(--ink);
      font-variant-numeric: tabular-nums; }
    .reslist > .si:last-child { border-bottom: none; }
    .si.col { flex-direction: column; align-items: stretch; gap: 3px; }
    .si.col .si-msg { font-size: var(--fs-sub); line-height: 1.45; text-align: left; }
    .si .st { font-weight: 700; white-space: nowrap; }

    /* ---- running rows ---- */
    .rl { display: flex; flex-direction: column; gap: 8px; padding: 14px 16px 0; }
    .ri { display: flex; align-items: center; gap: 11px; padding: 11px 14px;
      background: #fff; border: 1px solid var(--line); border-radius: var(--r-item);
      corner-shape: var(--se); font-size: 12px; color: var(--ink); }
    .ri .txt { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis; }
    .ri .st { font-size: var(--fs-sub); font-weight: 600; }
    .spin { width: 16px; height: 16px; border-radius: 50%; flex: none;
      border: 2px solid #D9E8F8; border-top-color: var(--blue);
      animation: dvspin .9s linear infinite; }
    @keyframes dvspin { to { transform: rotate(360deg); } }

    /* ---- empty / error / message views ---- */
    .msg { padding: 32px 24px 34px; text-align: center; }
    .msg .cir { width: 44px; height: 44px; border-radius: 50%; margin: 0 auto 12px;
      display: flex; align-items: center; justify-content: center;
      font-size: 19px; }
    .msg .cir.ok { background: #EAF3EC; color: var(--green); }
    .msg .cir.bad { background: #FCEDEF; color: var(--red); font-weight: 800;
      font-size: 18px; }
    .msg .cir.warn { background: var(--amberbg); color: var(--amber);
      font-weight: 800; font-size: 18px; }
    .msg .h { font-size: 13.5px; font-weight: 700; color: var(--ink); }
    .msg .txt { font-size: 12px; color: var(--mut); margin-top: 5px;
      line-height: 1.6; }
    .msg .btn { display: inline-flex; align-items: center; gap: 6px;
      margin-top: 16px; border: 1px solid #E2E5EA; border-radius: var(--r-btn);
      corner-shape: var(--se); padding: 9px 16px; font-size: 12px;
      font-weight: 700; color: var(--blue); cursor: pointer; background: #fff;
      transition: background .15s ease; }
    .msg .btn:hover { background: var(--hover-on-white); }
    .msg .btn.pri { background: var(--blue); color: #fff; border-color: var(--blue);
      padding: 10px 22px; box-shadow: 0 6px 16px -8px rgba(0,111,207,.5); }
    .msg .btn.pri:hover { background: var(--blue2); }
    .msg .btns { display: flex; gap: 10px; justify-content: center;
      margin-top: 16px; }
    .msg .btns .btn { margin-top: 0; }
    .lnk { font-size: 12px; font-weight: 700; color: var(--blue); cursor: pointer; }
    .lnk.rerun { border: 1px solid #E9C6CC; color: var(--red);
      border-radius: var(--r-btn);
      corner-shape: var(--se); padding: 9px 16px; transition: background .15s ease; }
    .lnk.rerun:hover { background: #FCF5F6; }

    /* ---- first-run trust screen ---- */
    .trust { background: #fff; padding: 22px 24px; }
    .trust-t { font-size: 17px; font-weight: 800; color: var(--navy);
      letter-spacing: -.3px; line-height: 1.4; }
    .trust-d { font-size: 12px; color: var(--sub2); line-height: 1.7;
      margin-top: 8px; }
    .trust-list { display: flex; flex-direction: column; gap: 8px;
      margin-top: 18px; }
    .trust-b { display: flex; gap: 11px; align-items: center; background: #F7F9FC;
      border: 1px solid #EDF2F9; border-radius: 8px; corner-shape: var(--se);
      padding: 10px 13px; font-size: 12px; color: #4A4F5A; line-height: 1.5; }
    .trust-b .ck { width: 26px; height: 26px; border-radius: 6px;
      corner-shape: var(--se); background: #E7F0FA; color: #1B62A8;
      font-size: 12px; font-weight: 800; display: flex; align-items: center;
      justify-content: center; flex: none; }
    .trust-b b { color: var(--ink); }
    .trust .go { display: block; width: 100%; text-align: center;
      margin-top: 20px; padding: 12px 0; }
    .trust-foot { font-size: var(--fs-caption); color: var(--fog); text-align: center;
      margin-top: 10px; }
    .trust-langs { display: flex; gap: 10px; justify-content: center;
      margin-top: 14px; }
    .trust-lang { font-size: 12px; font-weight: 700; color: var(--sub2);
      border: 1px solid #E2E5EA; border-radius: var(--r-btn);
      corner-shape: var(--se);
      padding: 8px 18px; cursor: pointer; min-width: 96px; text-align: center;
      transition: background .15s ease; }
    .trust-lang:hover { background: var(--hover-on-white); }
    .trust-lang.on { background: var(--blue); color: #fff; border-color: var(--blue); }

    /* ---- skeleton (loading rows / confirm backdrop) ---- */
    .skwrap { display: flex; flex-direction: column; gap: 8px;
      padding: 14px 16px 16px; }
    .skrow { display: flex; gap: 11px; align-items: center; padding: 13px 14px;
      background: #fff; border: 1px solid var(--line); border-radius: var(--r-item);
      corner-shape: var(--se); }
    .sklogo { width: 40px; height: 40px; border-radius: 9px; corner-shape: var(--se);
      flex: none; background: #EEF0F3; }
    .skmn { flex: 1; display: flex; flex-direction: column; gap: 7px; }
    .skl { height: 10px; border-radius: 3px; background: #EEF0F3; }
    .skl.a { width: 55%; }
    .skl.b { width: 78%; height: 9px; background: #F4F5F7; }

    /* ---- confirm dialog ---- */
    .cfwrap { display: grid; }
    .cfwrap > * { grid-area: 1 / 1; min-width: 0; }
    .cfdim { opacity: .35; pointer-events: none; }
    .cfov { background: rgba(11,31,78,.32); display: flex; align-items: center;
      justify-content: center; padding: 24px; position: relative; }
    .cfdlg { background: #fff; border-radius: var(--r-item); corner-shape: var(--se);
      width: 100%; box-shadow: 0 24px 64px -12px rgba(0,23,90,.45);
      overflow: hidden; }
    .cf-hd { padding: 18px 20px 0; }
    .cf-t { font-size: 15px; font-weight: 800; color: var(--navy);
      letter-spacing: -.2px; }
    .cf-d { font-size: var(--fs-body); color: var(--mut); line-height: 1.55;
      margin-top: 4px; }
    .cf-list { margin: 14px 20px 0; border: 1px solid var(--line);
      border-radius: 8px; corner-shape: var(--se);
      max-height: 176px; overflow-y: auto; }
    .cf-row { display: flex; align-items: center; gap: 10px;
      padding: 9px 13px; border-bottom: 1px solid var(--line3); font-size: 12px; }
    .cf-row:last-child { border-bottom: none; }
    .cf-row .nm { font-weight: 600; color: var(--ink); flex: 1;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      letter-spacing: 0; }
    .cf-row .ct { color: var(--sub); font-variant-numeric: tabular-nums;
      white-space: nowrap; }
    .cf-meta { padding: 8px 20px 0; font-size: var(--fs-sub); color: var(--fog);
      font-variant-numeric: tabular-nums; }
    .cf-warn { margin: 8px 20px 0; background: var(--amberbg);
      border: 1px solid var(--amberbd); border-radius: 8px; corner-shape: var(--se);
      padding: 7px 11px; font-size: var(--fs-caption); color: var(--ambertx);
      line-height: 1.5; }
    .cf-btns { display: flex; gap: 10px; padding: 14px 20px 18px;
      justify-content: flex-end; }
    .cf-cancel { border: 1px solid #E2E5EA; color: var(--sub); font-size: var(--fs-amount);
      font-weight: 600; border-radius: var(--r-btn); corner-shape: var(--se);
      padding: 9px 18px; cursor: pointer; transition: background .15s ease; }
    .cf-cancel:hover { background: var(--hover-on-white); }
    .cf-ok { background: var(--blue); color: #fff; font-size: var(--fs-amount);
      font-weight: 700; border-radius: var(--r-btn); corner-shape: var(--se);
      padding: 9px 18px; cursor: pointer; transition: background .15s ease; }
    .cf-ok:hover { background: var(--blue2); }

    /* ---- Benefits tab ---- */
    .bstats { display: flex; gap: 8px; padding: 12px 16px 0; }
    .bstats .c { flex: 1; background: #fff; border: 1px solid var(--line);
      border-radius: var(--r-item); corner-shape: var(--se); padding: 11px 0;
      text-align: center; }
    .bval { font-size: var(--fs-stat); font-weight: 800;
      font-variant-numeric: tabular-nums; }
    .bval.navy { color: var(--navy); }
    .bval.green { color: var(--green); }
    .bval.ink { color: var(--ink); }
    .blbl { font-size: var(--fs-caption); color: var(--sub); margin-top: 2px; }
    .bsub2 { font-size: 9px; color: var(--fog); margin-top: 1px; }
    /* Period group header (每月/每季/每半年/每年 · badge · N 项 · $X 待用).
       Cadence lives here, never as per-row chips. */
    .bgh { display: flex; align-items: center; justify-content: space-between;
      gap: 10px; padding: 0 20px; margin-top: 16px; }
    .bgh-l { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .bgh-lbl { font-size: 11px; font-weight: 700; color: var(--sub);
      letter-spacing: .4px; white-space: nowrap; }
    .bgh-badge { font-size: var(--fs-caption); font-weight: 600; color: var(--sub);
      background: var(--surface-count); border-radius: 5px; padding: 2px 7px;
      white-space: nowrap; font-variant-numeric: tabular-nums; }
    .bgh-badge.amber { font-weight: 700; color: var(--amber);
      background: var(--amber-tint); }
    .bgh-sum { font-size: 11px; color: var(--text-5); white-space: nowrap;
      font-variant-numeric: tabular-nums; }
    .blist { display: flex; flex-direction: column; gap: 8px;
      padding: 9px 16px 0; }
    .bgrp { background: #fff; border: 1px solid var(--line);
      border-radius: var(--r-row); corner-shape: var(--se);
      box-shadow: var(--shadow-card); overflow: hidden; }
    .bgrp.exp { border-color: var(--border-expanded); }
    /* Fully-used benefit: the whole card archives to a faint-green, low-noise
       row (the three-state "done" treatment). */
    .bgrp.done { background: var(--green-row); border-color: var(--green-row-border);
      box-shadow: none; }
    .brow { display: flex; gap: 12px; padding: 12px 15px; align-items: center; }
    .bmn { flex: 1; min-width: 0; }
    /* The left icon slot is gone (design judged the initials square as zero
       information), so the name takes the full width. */
    .bname { font-size: var(--fs-title); font-weight: 700; color: var(--ink);
      letter-spacing: -.1px; white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis; }
    .bgrp.done .bname { color: var(--archived-text); }
    .bcard { font-size: var(--fs-body); color: var(--text-4); margin-top: 2px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      font-variant-numeric: tabular-nums; }
    .bgrp.done .bcard { color: var(--archived-sub); }
    .brt { text-align: right; flex: none; }
    .bamt { font-size: var(--fs-amount); font-weight: 700; color: var(--ink);
      font-variant-numeric: tabular-nums; white-space: nowrap; }
    .bamt.done { color: var(--green); }
    .bamt .of { font-size: var(--fs-caption); font-weight: 400; color: var(--fog); }
    .bamt.done .of { color: var(--archived-sub); }
    .bstat { font-size: var(--fs-caption); color: var(--text-4); margin-top: 2px; }
    .bstat.used, .bstat.done { font-weight: 700; color: var(--green); }
    /* Micro progress bar — the ONLY progress bar in the whole list, shown just
       for partial use (0 < pct < 100). */
    .bmicro { height: 3px; border-radius: 1.5px; background: var(--track);
      overflow: hidden; margin: 9px 15px 12px; }
    .bmicro > div { height: 100%; border-radius: 1.5px; background: var(--green); }
    .bgrp.part .brow { padding-bottom: 0; }
    .binact { font-size: var(--fs-sub); font-weight: 700; color: var(--amber);
      flex: none; }
    .bactivate { border: 1px solid var(--border-1); border-radius: var(--r-btn);
      corner-shape: var(--se); padding: 6px 11px; font-size: var(--fs-sub);
      font-weight: 700; color: var(--blue); cursor: pointer; white-space: nowrap;
      flex: none; transition: background .15s ease; }
    .bactivate:hover { background: var(--hover-on-white); }
    /* Per-card breakdown (multi-card expand): full-width sunken strip, no bars. */
    .bsub { border-top: 1px solid var(--border-inner);
      background: var(--surface-sunken); padding: 9px 15px; display: flex;
      flex-direction: column; gap: 7px; }
    .bsubrow { display: flex; align-items: center; gap: 9px; }
    .bsw { width: 26px; height: 17px; border-radius: 3.5px; flex: none;
      overflow: hidden; background: var(--card-silver); }
    .bsw img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .bsubcard { font-size: var(--fs-sub); color: var(--ink); flex: 1; min-width: 0;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      font-variant-numeric: tabular-nums; }
    .bsubamt { font-size: var(--fs-sub); color: var(--text-4); flex: none;
      white-space: nowrap; font-variant-numeric: tabular-nums; }
    .bsubamt.done { font-weight: 700; color: var(--green); }
    /* Collapsible "无法自动追踪" footer — de-emphasized, never competes with
       real benefit rows. */
    .buntrack-wrap { display: flex; flex-direction: column; gap: 8px;
      padding: 14px 16px 0; }
    .buntrack { display: flex; align-items: center; gap: 8px; padding: 10px 14px;
      background: #fff; border: 1px solid var(--line); border-radius: var(--r-item);
      corner-shape: var(--se); cursor: pointer; opacity: .8; }
    .buntrack-t { font-size: var(--fs-body); font-weight: 600; color: var(--sub);
      white-space: nowrap; }
    .buntrack-n { font-size: var(--fs-sub); color: var(--text-5);
      background: var(--surface-count); border-radius: 9px; padding: 1px 8px;
      white-space: nowrap; font-variant-numeric: tabular-nums; }
    .buntrack-h { flex: 1; font-size: var(--fs-caption); color: var(--text-5);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .buntrack-c { flex: none; font-size: 10px; color: var(--text-5); }
    .buntrack-item { display: flex; align-items: center; gap: 9px;
      padding: 9px 14px; background: #fff; border: 1px solid var(--line);
      border-radius: 10px; corner-shape: var(--se); opacity: .8; }
    .buntrack-name { flex: 1; min-width: 0; font-size: var(--fs-body);
      color: var(--sub); white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis; }
    .buntrack-card { flex: none; font-size: var(--fs-caption); color: var(--text-5);
      font-variant-numeric: tabular-nums; white-space: nowrap; }
    .bfoot { padding: 12px 20px 14px; flex: none; background: var(--panel);
      border-top: 1px solid var(--bd); }

    /* ---- added (redeem-tracking) sub-view ---- */
    .agrp { background: #fff; border: 1px solid var(--line);
      border-radius: var(--r-row); corner-shape: var(--se);
      box-shadow: 0 1px 2px rgba(0,23,90,.04), 0 16px 32px -24px rgba(0,23,90,.18); }
    .agrp.dim { opacity: .6; box-shadow: none; }
    .addedlist { display: flex; flex-direction: column; gap: 8px;
      padding: 14px 16px 0; }
    .arow { display: flex; gap: 11px; padding: 13px 14px 7px;
      align-items: center; cursor: pointer; }
    .arow.flat { padding: 13px 14px; }
    .arow.static { cursor: default; }
    .acards { margin: 0 14px 12px 65px; display: flex; flex-direction: column;
      gap: 6px; }
    .acrow { display: flex; align-items: center; gap: 9px; }
    .acdig { font-size: var(--fs-body); color: var(--ink); width: 56px; flex: none;
      font-variant-numeric: tabular-nums; }
    .acst { font-size: var(--fs-sub); color: var(--fog); white-space: nowrap; }
    .acst.ok { font-weight: 600; color: var(--green);
      font-variant-numeric: tabular-nums; }
    .acst.urgent { font-weight: 700; color: var(--red);
      font-variant-numeric: tabular-nums; }
    .aday { font-size: var(--fs-caption); color: var(--fog);
      font-variant-numeric: tabular-nums; }
    .aday.urgent { font-weight: 700; color: var(--red); }
    .aday.ok { font-weight: 700; color: var(--green); }
    .asub { font-size: var(--fs-caption); color: var(--fog); margin-top: 3px;
      font-variant-numeric: tabular-nums; }
    .asub.ok { color: var(--green); font-weight: 600; }

    /* ---- added view: grouping dropdown (the one lightweight dropdown) ---- */
    .adrop { position: relative; margin-left: auto; }
    .adrop.open { z-index: 50; }
    .adropt { display: flex; align-items: center; gap: 5px;
      font-size: var(--fs-body); color: var(--sub); cursor: pointer;
      padding: 4px 2px; }
    .adropt.on { color: var(--navy); font-weight: 700; }
    .adico { display: flex; flex: none; }
    .adcar { font-size: 9px; }
    .adropmenu { position: absolute; top: 26px; right: 0; background: #fff;
      border: 1px solid var(--bd); border-radius: 10px; corner-shape: var(--se);
      box-shadow: 0 12px 32px -8px rgba(0,23,90,.25); padding: 5px; width: 122px; }
    .adropitem { display: flex; align-items: center;
      justify-content: space-between; padding: 7px 11px; font-size: var(--fs-body);
      color: var(--sub); border-radius: 7px; corner-shape: var(--se);
      cursor: pointer; transition: background .15s ease; }
    .adropitem:hover { background: var(--panel); }
    .adropitem.on { font-weight: 700; color: var(--navy); background: #F0F4FA; }
    .adropitem .ck { color: var(--amex-blue); }
    /* Transparent click-catcher; the open .adrop sits above it. */
    .ddscrim { position: absolute; inset: 0; z-index: 40; }

    /* ---- added view: 按类目 section header (mock state E) ---- */
    .acat { display: flex; align-items: center; justify-content: space-between;
      padding: 0 4px; }
    .acat:not(:first-child) { margin-top: 6px; }
    .acat .lbl { font-size: var(--fs-sub); font-weight: 600; color: var(--mut);
      letter-spacing: .2px; }
    .acat .cnt { font-size: var(--fs-sub); color: var(--fog);
      font-variant-numeric: tabular-nums; }

    /* ---- added view: 按卡 card group (mock state C) ---- */
    .acardgrp { background: #fff; border: 1px solid var(--line);
      border-radius: var(--r-row); corner-shape: var(--se);
      box-shadow: var(--shadow-card); overflow: hidden; }
    .acardhd { display: flex; align-items: center; gap: 10px; padding: 11px 14px;
      border-bottom: 1px solid var(--border-inner); }
    .acardhd .thumb { width: 32px; height: 21px; border-radius: 4px;
      corner-shape: var(--se); flex: none; overflow: hidden;
      box-shadow: inset 0 0 0 1px rgba(0,0,0,.06);
      background: linear-gradient(135deg,#dfe2e6,#b3b9c1); }
    .acardhd .thumb img { width: 100%; height: 100%; object-fit: cover; }
    .acardhd .nm { flex: 1; min-width: 0; font-size: var(--fs-amount);
      font-weight: 700; color: var(--ink); white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; }
    .acardhd .nm .dg { font-variant-numeric: tabular-nums; }
    .acardhd .sum { font-size: var(--fs-sub); color: var(--mut); flex: none;
      white-space: nowrap; font-variant-numeric: tabular-nums; }
    .acardhd .sum b { color: var(--green); font-weight: 700; }
    .acardhd .sum b.mut { color: var(--sub); }
    .aorow { display: flex; align-items: center; gap: 10px; padding: 10px 14px;
      border-bottom: 1px solid var(--border-row); }
    .aorow:last-child { border-bottom: none; }
    .aolog { width: 32px; height: 32px; border-radius: 8px;
      corner-shape: var(--se); flex: none; overflow: hidden; display: flex;
      align-items: center; justify-content: center; font-size: 9.5px;
      font-weight: 800; background: #E7F0FA; color: #1B62A8; }
    .aolog img { width: 100%; height: 100%; object-fit: contain; background: #fff; }
    .aomn { flex: 1; min-width: 0; }
    .aonm { font-size: var(--fs-amount); font-weight: 700; color: var(--ink);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .aods { font-size: var(--fs-sub); color: var(--mut); margin-top: 1px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .aort { text-align: right; flex: none; }
    .aostat { font-size: var(--fs-sub); font-weight: 700; color: var(--red); }
    .aostat.gray { font-weight: 400; color: var(--mut); }
    .aostat.ok { color: var(--green); font-variant-numeric: tabular-nums; }
    .aosub { font-size: var(--fs-caption); color: var(--mut); margin-top: 1px;
      font-variant-numeric: tabular-nums; }
    .acardmore { padding: 8px 14px; border-top: 1px solid var(--border-inner);
      font-size: var(--fs-sub); font-weight: 600; color: var(--amex-blue);
      cursor: pointer; text-align: center; transition: background .15s ease; }
    .acardmore:hover { background: var(--hover-on-white); }

    /* ===== Wide mode (G4): the second density, a centered ≈880px overlay =====
       The SAME skeleton at a denser, table-column layout; the +1~1.5px font
       scale comes from the [data-density="wide"] variable block near the top.
       The sidebar never sets that attribute, so every rule below is inert
       there — the wide code path cannot touch the sidebar. */
    .p[data-density="wide"] {
      width: min(880px, calc(100vw - 24px));
      height: calc(100vh - 56px);
      max-height: none;
      transform-origin: center;
    }
    /* Transient/centered views (confirm, trust, error, empty, loading) keep the
       sidebar blocks but centered in the shell instead of stretched to 880px. */
    .p[data-density="wide"] .body { flex: 1; }
    .p[data-density="wide"] .msg,
    .p[data-density="wide"] .trust { max-width: 460px; margin: 0 auto; }
    .p[data-density="wide"] .cfdlg { max-width: 460px; }
    .p[data-density="wide"] .cfwrap { flex: 1; }
    .p[data-density="wide"] .ft { padding: 12px 20px; }
    .p[data-density="wide"] .cfrow { padding: 12px 20px 0; }

    /* Header 收窄 pill (the wide counterpart of the sidebar's ⤢ round button). */
    .densbtn { display: flex; align-items: center; gap: 6px; flex: none;
      border: 1px solid var(--border-1); border-radius: 8px;
      corner-shape: var(--se); padding: 6px 11px; font-size: var(--fs-body);
      font-weight: 700; color: var(--sub); cursor: pointer; background: #fff;
      transition: background .15s ease; }
    .densbtn:hover { background: var(--hover-on-white); }

    /* Pinned top region (pill / search / chips / column header) on the panel bg. */
    .wtop { flex: none; }
    .wctlrow { display: flex; align-items: center; gap: 12px;
      padding: 14px 20px 0; }
    .wsearch { flex: 1; min-width: 0; display: flex; align-items: center;
      gap: 8px; background: #fff; border: 1px solid var(--bd2);
      border-radius: var(--r-btn); corner-shape: var(--se); padding: 8px 13px;
      box-shadow: var(--shadow-input); }
    .wsearch .wsi { color: var(--fog); font-size: 14px; line-height: 1;
      flex: none; }
    .wsearch input { flex: 1; min-width: 0; border: none; outline: none;
      background: none; font: inherit; font-size: var(--fs-amount);
      color: var(--ink); }
    .wsearch input::placeholder { color: var(--fog); }
    .wlink { font-size: var(--fs-body); font-weight: 700;
      color: var(--amex-blue); cursor: pointer; white-space: nowrap;
      flex: none; }
    .wcheckchip { display: flex; align-items: center; gap: 6px;
      font-size: var(--fs-body); color: var(--sub); cursor: pointer;
      flex: none; white-space: nowrap; }
    .wcheckchip .bx { width: 14px; height: 14px; flex: none;
      border: 1.5px solid var(--text-disabled); border-radius: 4px;
      display: inline-flex; align-items: center; justify-content: center; }
    .wcheckchip.on { color: var(--navy); font-weight: 700; }
    .wcheckchip.on .bx { background: var(--navy); border-color: var(--navy);
      color: #fff; }

    /* Column header (pinned) — its width classes are shared with the rows so
       the columns line up. */
    .wcolh { display: flex; align-items: center; gap: 14px; margin: 14px 20px 0;
      padding: 0 16px 8px; border-bottom: 1px solid var(--bd2); }
    .wcolh > div { font-size: var(--fs-sub); font-weight: 600;
      color: var(--text-5); letter-spacing: .3px; }
    .cw-flex { flex: 1; min-width: 0; }
    .cw-exp { width: 80px; flex: none; text-align: right; }
    .cw-exp-s { width: 70px; flex: none; text-align: right; }
    .cw-chips { width: 330px; flex: none; }
    .cw-check { width: 16px; flex: none; }
    .cw-rchips { width: 560px; flex: none; }
    .cw-bstat { width: 190px; flex: none; }
    .cw-bchips { width: 300px; flex: none; }

    /* The one scroll region — nothing else in the overlay scrolls. */
    .wscroll { flex: 1; overflow-y: auto; overflow-x: hidden;
      display: flex; flex-direction: column; gap: 6px; padding: 8px 20px 18px; }

    /* A table row (white card). */
    .wrow { display: flex; align-items: center; gap: 14px; background: #fff;
      border: 1px solid var(--line); border-radius: var(--r-item);
      corner-shape: var(--se); padding: var(--row-pad);
      box-shadow: var(--shadow-card); }
    /* Selected addable row: a soft ring, drawn with inset shadow so the row's
       box size (and column alignment) never shifts. */
    .wrow.sel { border-color: var(--selected-border);
      box-shadow: 0 0 0 1px var(--selected-border) inset, var(--shadow-card); }
    .wrow.done { opacity: .7; }
    .wcell-mn { flex: 1; min-width: 0; display: flex; align-items: center;
      gap: 11px; }
    .wlogo { width: 38px; height: 38px; border-radius: 9px;
      corner-shape: var(--se); flex: none; overflow: hidden; display: flex;
      align-items: center; justify-content: center; font-size: 11px;
      font-weight: 800; color: #fff; }
    .wlogo img { width: 100%; height: 100%; object-fit: contain;
      background: #fff; }
    .wtxt { min-width: 0; }
    .wnm { font-size: var(--fs-title); font-weight: 700; color: var(--ink);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .wds { font-size: var(--fs-body); color: var(--text-4); margin-top: 1px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .wexp { font-size: var(--fs-amount); color: var(--text-4);
      font-variant-numeric: tabular-nums; white-space: nowrap; }
    .wexp.urgent { font-weight: 700; color: var(--red); }

    /* Per-card status chips — the wide core construct (StatusChip). */
    .wchips { display: flex; gap: 5px; flex-wrap: wrap; align-items: center; }
    /* Single-card reading (按卡 sections / single-card filter): a status word
       in the chips column instead of a redundant card chip. */
    .wstat { font-size: var(--fs-body); color: var(--sub);
      font-variant-numeric: tabular-nums; }
    .wstat.ok { color: var(--green); font-weight: 600; }
    .wstat.mut { color: var(--text-4); }
    .wchip { display: inline-flex; align-items: center; gap: 4px;
      font-size: var(--fs-caption); font-weight: 600; color: var(--sub);
      background: var(--panel); border: 1px solid var(--surface-seg);
      border-radius: 7px; corner-shape: var(--se); padding: 4px 9px;
      white-space: nowrap; font-variant-numeric: tabular-nums; }
    .wchip.click { cursor: pointer; }
    .wchip.green { font-weight: 700; color: var(--green);
      background: var(--green-tint); border-color: var(--green-border); }
    .wchip.red { font-weight: 700; color: var(--red);
      background: var(--red-tint); border-color: var(--red-border); }
    .wchip.amber { font-weight: 700; color: var(--amber);
      background: var(--amber-tint); border-color: var(--amber-border); }
    .wchip.sel { font-weight: 700; color: #fff; background: var(--amex-blue);
      border-color: var(--amex-blue); }
    .wsw { width: 18px; height: 12px; border-radius: 2.5px; flex: none;
      overflow: hidden; background: var(--card-silver); }
    .wsw img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .wchip .spin { width: 11px; height: 11px; border-width: 2px; }
    .wmore { font-size: var(--fs-caption); font-weight: 600;
      color: var(--text-4); padding: 3px 4px; cursor: pointer;
      align-self: center; white-space: nowrap; }
    .wretry { font-size: var(--fs-body); font-weight: 700;
      color: var(--amex-blue); cursor: pointer; padding: 3px 6px;
      white-space: nowrap; }

    /* Result / running header (icon + title + inline counts). */
    .wrhd { display: flex; align-items: center; gap: 12px; background: #fff;
      padding: 16px 20px; border-bottom: 1px solid var(--line2); flex: none; }
    .wrhd .cir { width: 34px; height: 34px; border-radius: 50%; flex: none;
      display: flex; align-items: center; justify-content: center;
      font-size: 16px; font-weight: 800; }
    .wrhd .cir.ok { background: var(--green-tint); color: var(--green); }
    .wrhd .cir.bad { background: var(--amberbg); color: var(--amber); }
    .wrhd .cir.run { background: var(--amex-blue-tint); }
    .wrhd .tt { flex: 1; min-width: 0; }
    .wrhd .t1 { font-size: var(--fs-header); font-weight: 800;
      color: var(--navy); letter-spacing: -.2px; }
    .wrhd .t2 { font-size: var(--fs-caption); color: var(--text-4);
      margin-top: 1px; font-variant-numeric: tabular-nums; }
    .wrstats { display: flex; gap: 14px; margin-right: 6px; }
    .wrstat { text-align: center; }
    .wrstat .n { font-size: var(--fs-stat); font-weight: 800;
      font-variant-numeric: tabular-nums; }
    .wrstat .l { font-size: var(--fs-caption); color: var(--text-4); }
    .wprog { flex: none; background: #fff; padding: 0 20px 14px;
      border-bottom: 1px solid var(--line2); }

    /* Result / running pinned footer (legend + back, or the running note). */
    .wfoot { display: flex; align-items: center; gap: 10px; flex: none;
      background: #fff; border-top: 1px solid var(--line2); padding: 12px 20px; }
    .wfoot .txt { flex: 1; font-size: var(--fs-caption); color: var(--text-5);
      line-height: 1.5; }
    .wfoot .txt b { color: var(--amber); font-weight: 700; }
    .wbtn { border: 1px solid var(--border-1); background: #fff;
      border-radius: var(--r-btn); corner-shape: var(--se); padding: 8px 16px;
      font-size: var(--fs-amount); font-weight: 700; color: var(--amex-blue);
      cursor: pointer; white-space: nowrap; flex: none;
      transition: background .15s ease; }
    .wbtn:hover { background: var(--hover-on-white); }

    /* Wide Benefits: compact inline stat tiles + period sections. */
    /* Stat tiles sit in the same control row as the search box on every tab,
       so they stretch to the row's height and keep value + label on ONE line —
       otherwise the Benefits top block is taller than the Offers one and the
       chips row jumps when switching tabs. */
    .wbstats { display: flex; gap: 8px; flex: none; align-self: stretch; }
    .wbtile { background: #fff; border: 1px solid var(--line);
      border-radius: var(--r-btn); corner-shape: var(--se); padding: 0 14px;
      display: flex; align-items: center; gap: 7px; }
    .wbtile .n { font-size: var(--fs-stat); font-weight: 800;
      font-variant-numeric: tabular-nums; }
    .wbtile .n.navy { color: var(--navy); }
    .wbtile .n.green { color: var(--green); }
    .wbtile .n.ink { color: var(--ink); }
    .wbtile .l { font-size: var(--fs-sub); color: var(--sub);
      white-space: nowrap; }
    .wbgh { display: flex; align-items: center; justify-content: space-between;
      gap: 10px; padding: 0 4px; margin-top: 10px; }
    .wbgh.first { margin-top: 2px; }
    .wbgh-l { display: flex; align-items: center; gap: 8px; }
    .wbgh-lbl { font-size: var(--fs-sub); font-weight: 700; color: var(--sub);
      letter-spacing: .4px; }
    .wbgh-badge { font-size: var(--fs-caption); font-weight: 600;
      color: var(--sub); background: var(--surface-count); border-radius: 5px;
      padding: 2px 8px; font-variant-numeric: tabular-nums; }
    .wbgh-badge.amber { font-weight: 700; color: var(--amber);
      background: var(--amber-tint); }
    .wbgh-sum { font-size: var(--fs-sub); color: var(--text-5);
      font-variant-numeric: tabular-nums; white-space: nowrap; }
    /* A benefit row stacks its main line over an optional micro-bar. */
    .wrow.wbenefit { flex-direction: column; align-items: stretch; gap: 0; }
    .wrow.wbenefit.done { background: var(--green-row);
      border-color: var(--green-row-border); box-shadow: none; }
    .wbmain { display: flex; align-items: center; gap: 14px; }
    .wb-name { flex: 1; min-width: 0; font-size: var(--fs-title);
      font-weight: 700; color: var(--ink); }
    .wrow.wbenefit.done .wb-name { color: var(--archived-text); }
    .wb-stat { display: flex; align-items: baseline; justify-content: flex-end;
      gap: 8px; }
    .wb-amt { font-size: var(--fs-amount); font-weight: 700; color: var(--ink);
      font-variant-numeric: tabular-nums; white-space: nowrap; }
    .wb-amt.done { color: var(--green); }
    .wb-amt .of { font-size: var(--fs-caption); font-weight: 400;
      color: var(--text-5); }
    .wb-amt.done .of { color: var(--archived-sub); }
    .wb-word { font-size: var(--fs-caption); color: var(--text-4);
      white-space: nowrap; }
    .wb-word.used { font-weight: 700; color: var(--green); }
    .wbmicro { margin-top: 9px; height: 3px; border-radius: 1.5px;
      background: var(--track); overflow: hidden; }
    .wbmicro > div { height: 100%; border-radius: 1.5px; background: var(--green); }
    .wb-inact { font-size: var(--fs-body); font-weight: 700; color: var(--amber);
      white-space: nowrap; flex: none; }
    /* Wide untrackable / empty helpers reuse the sidebar bfoot-note tone. */
    .wnote { padding: 12px 20px 0; font-size: var(--fs-caption);
      color: var(--fog); line-height: 1.5; }
    .wsec { display: flex; align-items: center; justify-content: space-between;
      gap: 10px; padding: 0 4px; margin-top: 10px; }
    .wsec .lbl { font-size: var(--fs-sub); font-weight: 600; color: var(--mut);
      letter-spacing: .3px; }
    .wsec .cnt { font-size: var(--fs-sub); color: var(--fog);
      font-variant-numeric: tabular-nums; }
    .wcardsec { display: flex; align-items: center; gap: 10px; padding: 4px 4px;
      margin-top: 10px; }
    .wcardsec .thumb { width: 32px; height: 21px; border-radius: 4px;
      corner-shape: var(--se); flex: none; overflow: hidden;
      box-shadow: inset 0 0 0 1px rgba(0,0,0,.06); background: var(--card-silver); }
    .wcardsec .thumb img { width: 100%; height: 100%; object-fit: cover; }
    .wcardsec .nm { flex: 1; min-width: 0; font-size: var(--fs-amount);
      font-weight: 700; color: var(--ink); white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis;
      font-variant-numeric: tabular-nums; }
    .wcardsec .sum { font-size: var(--fs-sub); color: var(--mut); flex: none;
      white-space: nowrap; font-variant-numeric: tabular-nums; }
    .wcardsec .sum b { color: var(--green); font-weight: 700; }
    .wcardsec .sum b.mut { color: var(--sub); }
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
    let badge = null;
    if (fullyAdded) {
      rt.append(el('div', {class: 'done-tag',
        text: t('addedToAll', {n: group.cards.length})}));
    } else {
      badge = el('div', {class: 'bd'});
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
    const rowEl = el('div', {class: 'row'}, pick, logo, main, rt);
    // The whole row toggles the per-card list (except the select checkbox), so
    // users don't have to aim for the small "可加 N" badge on the right.
    if (!fullyAdded) {
      rowEl.onclick = (e) => {
        if (e.target === pick) return;
        toggleExpand(wrap, box, badge, group);
      };
    }
    wrap.append(rowEl, box);
    frag.append(wrap);
    return frag;
  }

  /**
   * @param {!Array<string>} states Result states for a group.
   * @return {!Element} The per-offer outcome badge.
   */
  function renderRunBadge(states) {
    const n = (s) => states.filter((x) => x === s).length;
    const badge = el('div', {class: 'runbadge'});
    badge.append(el('span', {class: 'g', text: `✓${n(ResultState.VERIFIED)}`}),
      el('span', {class: 'am', text: `?${n(ResultState.GHOST)}`}),
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
        const mk = {[ResultState.FAILED]: '✗', [ResultState.GHOST]: '?',
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
   * "Expand to the wide overlay" glyph (arrows to the corners), shown in the
   * sidebar header's first button slot. Inherits color via `currentColor`.
   * @const {string}
   */
  const EXPAND_SVG =
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2.2" stroke-linecap="round" ' +
      'stroke-linejoin="round" style="display:block">' +
      '<polyline points="15 3 21 3 21 9"></polyline>' +
      '<polyline points="9 21 3 21 3 15"></polyline>' +
      '<line x1="21" y1="3" x2="14" y2="10"></line>' +
      '<line x1="3" y1="21" x2="10" y2="14"></line></svg>';

  /**
   * "Collapse to the sidebar" glyph, shown in the wide header's 收窄 pill.
   * The arrowheads sit near the CENTER pointing inward (corners pull in) —
   * the mirror of EXPAND_SVG, whose heads sit at the corners pointing out.
   * Inherits color via `currentColor`.
   * @const {string}
   */
  const COLLAPSE_SVG =
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2.2" stroke-linecap="round" ' +
      'stroke-linejoin="round" style="display:block">' +
      '<polyline points="20 10 14 10 14 4"></polyline>' +
      '<polyline points="4 14 10 14 10 20"></polyline>' +
      '<line x1="14" y1="10" x2="21" y2="3"></line>' +
      '<line x1="10" y1="14" x2="3" y2="21"></line></svg>';

  /** A small check mark for the wide "只看多卡可加" filled checkbox. */
  const CHECK_SVG =
      '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" ' +
      'stroke="#fff" stroke-width="3.5" stroke-linecap="round" ' +
      'stroke-linejoin="round" style="display:block">' +
      '<polyline points="20 6 9 17 4 12"></polyline></svg>';

  /**
   * The "multi-card only" condition-filter glyph: two overlapping rounded
   * rectangles, inheriting the chip's text color via `currentColor`.
   * @const {string}
   */
  const MULTICARD_SVG =
      '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2.2" style="display:block">' +
      '<rect x="3" y="3" width="12" height="9" rx="2"></rect>' +
      '<rect x="9" y="12" width="12" height="9" rx="2"></rect></svg>';

  /**
   * A three-line "list" glyph for the added view's grouping dropdown trigger,
   * inheriting the trigger's text color via `currentColor`.
   * @const {string}
   */
  const GROUP_SVG =
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2.2" stroke-linecap="round" ' +
      'style="display:block"><line x1="4" y1="7" x2="20" y2="7"></line>' +
      '<line x1="4" y1="12" x2="20" y2="12"></line>' +
      '<line x1="4" y1="17" x2="20" y2="17"></line></svg>';

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
      '<path d="M38 0 L90 0 C114 0 128 14 128 38 L128 90 C128 114 114 128 ' +
      '90 128 L38 128 C14 128 0 114 0 90 L0 38 C0 14 14 0 38 0 Z" ' +
      'fill="#006FCF"></path>' +
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
   * The simplified mark for small sizes (the launcher pill): drops the faint
   * chip line so it stays crisp at 24px, matching the design's 5c artwork.
   * @const {string}
   */
  const BRAND_ICON_SM = BRAND_ICON.replace(
    '<rect x="30" y="70" width="26" height="6" rx="3" fill="#C9CCD0"></rect>',
    '');

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
    // Canonical button order (PanelHeader spec): 展开⤢/收窄 · EN · ⟳ · ×.
    // The density toggle only appears on the browse views (opts.expand) and
    // only when the window is wide enough to hold the overlay at all.
    if (opts.expand && canGoWide()) {
      const wide = currentDensity() === 'wide';
      const btn = el('button', {
        class: wide ? 'densbtn' : 'rf dens',
        title: wide ? t('collapseSidebar') : t('expandWide'),
        onclick: () => toggleDensity()});
      btn.innerHTML = wide ? COLLAPSE_SVG : EXPAND_SVG;
      if (wide) btn.append(document.createTextNode(t('collapseSidebar')));
      row.append(btn);
    }
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
    const wide = currentDensity() === 'wide';
    // The overlay's font scale + geometry key off data-density; the sidebar
    // leaves it unset so no wide rule applies (zero sidebar regression).
    if (wide) shell.setAttribute('data-density', 'wide');
    else shell.removeAttribute('data-density');
    applyDensityGeometry(wide);
    // Preserve the scroll position across a same-view rebuild (e.g. expanding a
    // row or toggling a filter). The scroller is `.body` (sidebar) or the wide
    // list region `.wscroll`; the density prefix means a mode switch never
    // restores one layout's scrollTop into the other.
    const viewKey = (wide ? 'w:' : 's:') +
        (state.tab === 'benefits' ? 'benefits' : state.view);
    const oldScroller = shell.querySelector('.body, .wscroll');
    const keepScroll =
        oldScroller && viewKey === lastViewKey ? oldScroller.scrollTop : 0;
    lastViewKey = viewKey;
    shell.textContent = '';
    if (wide) {
      renderWide(shell);
    } else if (state.tab === 'benefits') {
      renderBenefitsTab(shell);
    } else {
      const views = {list: renderListView, loading: renderLoadingView,
        running: renderRunningView, result: renderResultView,
        empty: renderEmptyView, error: renderErrorView,
        confirm: renderConfirmView, language: renderLanguageView};
      (views[state.view] || renderListView)(shell);
    }
    const newScroller = shell.querySelector('.body, .wscroll');
    if (newScroller && keepScroll) newScroller.scrollTop = keepScroll;
    // Keep the collapsed launcher in sync with a background run (e.g. the user
    // closed the panel mid-submit) so its progress / done state stays live.
    renderLauncherContent();
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
      state.benefitsUntrackable = benefits.untrackable || [];
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
      subtitle: [t('listSubtitle',
        {offers: state.offers.length, cards: state.cards.length}),
      agoLabel(state.snapshotAt)].filter(Boolean).join(' · '),
      expand: true, lang: true, refresh: true, close: true, tabs: true,
    }));

    const body = el('div', {class: 'body'});

    // Full-width status banners sit right under the tabs.
    const unreadable = state.cards.filter((c) => c.readFailed);
    if (unreadable.length) {
      body.append(el('div', {class: 'banner'},
        el('span', {class: 'ico', text: '⚠'}),
        el('div', {class: 'sp'},
          el('b', {text: unreadable.map((c) => c.shortName).join(' / ')}),
          ` ${t('readFailBanner')}`),
        el('div', {class: 'act', text: t('retry'),
          onclick: () => refresh()})));
    }
    if (state.lastRun) body.append(renderLastRunStrip());

    body.append(renderOffersSubTabs());

    if (state.offersSub === 'added') {
      renderAddedView(body);
      shell.append(body);
      shell.append(el('div', {class: 'bfoot'},
        el('div', {class: 'note', text: t('addedFootnote')})));
      // Click-outside scrim for the grouping dropdown: a transparent overlay
      // clipped to the panel that closes the menu on any click. The open
      // .adrop lifts above it (z-index), so its trigger/items stay live.
      if (state.addedMenuOpen) {
        shell.append(el('div', {class: 'ddscrim', onclick: () => {
          state.addedMenuOpen = false;
          render();
        }}));
      }
      return;
    }

    const search = el('input', {type: 'search', value: state.query,
      placeholder: t('searchOffers')});
    search.oninput = (e) => {
      state.query = e.target.value.trim().toLowerCase();
      renderRows(body);
    };
    body.append(el('div', {class: 'sr'}, search));

    // Card filter chips: navy "all" pill + one swatch chip per card.
    const cfrow = el('div', {class: 'cfrow'});
    const addChip = (key, label, swToken) => {
      const chip = el('div',
        {class: state.cardFilter === key ? 'cfil on' : 'cfil'});
      if (swToken != null) {
        const sw = el('span', {class: 'cfsw'});
        const cd = cardOf(swToken);
        if (cd?.art) sw.append(el('img', {src: cd.art, alt: ''}));
        else sw.style.background = swatchStyle(swToken);
        chip.append(sw);
      }
      chip.append(document.createTextNode(label));
      chip.onclick = () => {
        state.cardFilter = key;
        render();
      };
      cfrow.append(chip);
    };
    addChip('all', t('allCards'));
    for (const card of state.cards) {
      const digits = cardDisplayDigits(cardRaw(card)) ||
          String(card.token).slice(-4);
      addChip(card.token, `…${digits}`, card.token);
    }
    // Condition filter "只看多卡": a dashed chip after a 1px divider, set apart
    // from the solid card-filter chips (which card vs. a filter condition).
    cfrow.append(el('div', {class: 'cfdiv'}));
    const multiChip = el('div',
      {class: state.multiOnly ? 'cfil dash on' : 'cfil dash'});
    const mico = el('span', {class: 'cfico'});
    mico.innerHTML = MULTICARD_SVG;
    multiChip.append(mico, document.createTextNode(t('multiOnly')));
    multiChip.onclick = () => {
      state.multiOnly = !state.multiOnly;
      render();
    };
    cfrow.append(multiChip);
    body.append(cfrow);

    // List header: addable count + 全选可加 when nothing is selected; flips to
    // 已选 N 个 + 清空 once a selection exists. refreshListHead keeps it live.
    body.append(el('div', {class: 'lh', id: 'lh'}));

    const list = el('div', {class: 'list', id: 'list'});
    body.append(list);
    shell.append(body);
    renderRows(body);

    shell.append(renderFooter());
    // renderRows() ran before the footer/header were in the DOM; sync the
    // summary + list header now so a returning selection is reflected without
    // needing an interaction.
    refreshFooter();
  }

  /**
   * @return {!Element} The 可加 | 已加 segmented pill control. On the 已加
   *     sub-view it also carries the grouping dropdown on the right (the one
   *     lightweight dropdown that replaced the old 按 offer/按卡 segment).
   */
  function renderOffersSubTabs() {
    const addableN =
        state.offers.filter((g) => addableCards(g).length > 0).length;
    const addedGroups = buildAddedIndex(state.cards, state.redeemed.byToken);
    const mk = (key, label, n) => {
      const pill = el('div',
        {class: state.offersSub === key ? 'subpill on' : 'subpill',
          text: `${label} ${n}`});
      pill.onclick = () => {
        if (state.offersSub === key) return;
        state.offersSub = key;
        state.addedMenuOpen = false;
        render();
      };
      return pill;
    };
    const bar = el('div', {class: 'subbar'},
      el('div', {class: 'subpills'},
        mk('addable', t('subAddable'), addableN),
        mk('added', t('subAdded'), addedGroups.length)));
    if (state.offersSub === 'added') {
      const hasCat = addedGroups.some((g) => g.category);
      bar.append(renderAddedGroupDropdown(hasCat, effectiveAddedMode(hasCat)));
    }
    return bar;
  }

  /**
   * The current effective grouping mode, mapping any legacy/invalid value to
   * `'expiry'` and downgrading `'category'` to `'expiry'` when no offer carries
   * a category (so the layout never depends on a hidden option).
   * @param {boolean} hasCat Whether any offer carries a category.
   * @return {string} `'expiry'`, `'card'`, or `'category'`.
   */
  function effectiveAddedMode(hasCat) {
    const m = state.addedGroupBy;
    if (m === 'category') return hasCat ? 'category' : 'expiry';
    if (m === 'card') return 'card';
    return 'expiry';
  }

  /**
   * The one lightweight grouping dropdown at the top-right of the 已加 view.
   * A real menu: the trigger toggles it open, each option ticks the active
   * mode, and picking one re-lays the list. Never a dead control — 按类目 only
   * appears when the data supports it.
   * @param {boolean} hasCat Whether to offer the 按类目 option.
   * @param {string} mode The effective active mode.
   * @return {!Element} The dropdown.
   */
  function renderAddedGroupDropdown(hasCat, mode) {
    const labels = {expiry: t('groupByExpiry'), card: t('groupByCard'),
      category: t('groupByCategory')};
    const open = state.addedMenuOpen;
    const wrap = el('div', {class: open ? 'adrop open' : 'adrop'});
    const ico = el('span', {class: 'adico'});
    ico.innerHTML = GROUP_SVG;
    const trig = el('div', {class: open ? 'adropt on' : 'adropt'});
    trig.append(ico, document.createTextNode(`${labels[mode]} `),
      el('span', {class: 'adcar', text: open ? '▴' : '▾'}));
    trig.onclick = () => {
      state.addedMenuOpen = !open;
      render();
    };
    wrap.append(trig);
    if (open) {
      const menu = el('div', {class: 'adropmenu'});
      const opt = (key, label) => {
        const row = el('div',
          {class: mode === key ? 'adropitem on' : 'adropitem'});
        row.append(el('span', {text: label}));
        if (mode === key) row.append(el('span', {class: 'ck', text: '✓'}));
        row.onclick = () => {
          state.addedGroupBy = key;
          state.addedMenuOpen = false;
          render();
        };
        return row;
      };
      menu.append(opt('expiry', labels.expiry), opt('card', labels.card));
      if (hasCat) menu.append(opt('category', labels.category));
      wrap.append(menu);
    }
    return wrap;
  }

  /**
   * Renders the added (redeem-tracking) sub-view into the list body. Mirrors
   * the addable view's skeleton — search → card chips → stats → list — with
   * grouping moved to the top-right dropdown (rendered by the sub-tab row).
   * Shows a loading / error block while the savings records aren't available.
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
    // Search (reuses state.query so a merchant filter carries between the
    // 可加 and 已加 sub-views); re-draws just the rows to keep input focus.
    const search = el('input', {type: 'search', value: state.query,
      placeholder: t('searchOffers')});
    search.oninput = (e) => {
      state.query = e.target.value.trim().toLowerCase();
      renderAddedRows(body);
    };
    body.append(el('div', {class: 'sr'}, search));

    // Card filter chips — the added view's own filter (state.addedCardFilter),
    // no dashed "只看多卡" chip (that one is addable-only).
    body.append(renderAddedCardChips());

    const groups = buildAddedIndex(state.cards, r.byToken);
    const s = addedStats(groups, state.addedCardFilter);
    body.append(counters([
      {n: fmtMoney(s.redeemedAmount), l: t('statRedeemed'), c: 'g'},
      {n: s.pending, l: t('statPending'), c: 'navy'},
      {n: s.expiring, l: t('statExpiring'), c: 'r'}], 'money'));

    body.append(el('div', {class: 'addedlist', id: 'addedlist'}));
    renderAddedRows(body);
  }

  /**
   * The added view's card-filter chip row: navy "all" pill + one swatch chip
   * per card, bound to state.addedCardFilter. No condition chips — selecting a
   * single card narrows the stats and single-cards the row status.
   * @return {!Element} The chip row.
   */
  function renderAddedCardChips() {
    const row = el('div', {class: 'cfrow'});
    const add = (key, label, swToken) => {
      const chip = el('div',
        {class: state.addedCardFilter === key ? 'cfil on' : 'cfil'});
      if (swToken != null) {
        const sw = el('span', {class: 'cfsw'});
        const cd = cardOf(swToken);
        if (cd?.art) sw.append(el('img', {src: cd.art, alt: ''}));
        else sw.style.background = swatchStyle(swToken);
        chip.append(sw);
      }
      chip.append(document.createTextNode(label));
      chip.onclick = () => {
        state.addedCardFilter = key;
        state.addedMenuOpen = false;
        render();
      };
      row.append(chip);
    };
    add('all', t('allCards'));
    for (const card of state.cards) add(card.token, `…${card.digits}`,
      card.token);
    return row;
  }

  /**
   * (Re)draws just the added-offer rows (so typing in search keeps focus),
   * dispatching on the effective grouping mode and the single-card filter.
   * @param {!Element} body Panel body (contains #addedlist).
   */
  function renderAddedRows(body) {
    const list = body.querySelector('#addedlist');
    if (!list) return;
    list.textContent = '';
    const q = state.query;
    const cf = state.addedCardFilter;
    const single = cf !== 'all';
    const empty = () => list.append(el('div', {class: 'msg',
      style: 'padding:24px'}, el('div', {class: 'note',
      text: q ? t('noMatchingOffers') : t('noAddedOffers')})));

    const all = buildAddedIndex(state.cards, state.redeemed.byToken);
    const mode = effectiveAddedMode(all.some((g) => g.category));
    // Apply the merchant search and the single-card filter to the groups.
    let groups = all.filter((g) =>
      (!q || g.name.toLowerCase().includes(q)) &&
      (!single || g.cards.some((c) => c.token === cf)));
    if (!groups.length) return empty();

    if (mode === 'card') {
      // A single-card 按卡 view collapses to just that card's group.
      if (single) {
        groups = groups.map((g) =>
          ({...g, cards: g.cards.filter((c) => c.token === cf)}));
      }
      for (const cardGroup of groupAddedBy(groups, 'card')) {
        list.append(renderAddedCardGroup(cardGroup));
      }
      return;
    }
    if (mode === 'category') {
      for (const sec of groupAddedBy(groups, 'category')) {
        list.append(renderCategoryHeader(sec));
        for (const g of sec.offers) list.append(renderAddedRow(g, cf));
      }
      return;
    }
    for (const g of groups) list.append(renderAddedRow(g, cf));
  }

  /**
   * A category section header for the 按类目 layout: category name (original,
   * uppercased) on the left, offer count on the right (mock state E).
   * @param {{category: string, offers: !Array<!Object>}} sec A category
   *     section from {@link groupAddedByCategory}.
   * @return {!Element} The header element.
   */
  function renderCategoryHeader(sec) {
    const label = sec.category ?
      sec.category.toUpperCase() : t('uncategorized');
    return el('div', {class: 'acat'},
      el('span', {class: 'lbl', text: label}),
      el('span', {class: 'cnt', text: t('nItems', {n: sec.offers.length})}));
  }

  /**
   * The "✓ $X 已返现" text for a single-card posting, or a bare "✓ 已返现"
   * when the posted amount is unknown.
   * @param {!Object} redeemed A per-card redemption record.
   * @return {string} The status text.
   */
  function singleRedeemedText(redeemed) {
    if (redeemed.amount > 0) {
      const money = redeemed.unit === 'points' ?
        fmtPoints(redeemed.amount) : fmtMoney(redeemed.amount);
      return t('singleRedeemed', {amt: money});
    }
    return t('cashbackPosted');
  }

  /**
   * One added-offer group row. With `cf === 'all'` it reads across cards: the
   * expiry + an x/y "cards posted" ratio, expandable to a per-card breakdown
   * (mock states A / E). With a card token it single-cards to that card's own
   * status — 待消费 or ✓ $X 已返现 · M/D 入账 — and is not expandable (mock
   * state D). Fully-redeemed groups render dimmed in the across-cards reading.
   * @param {!Object} g An added-offer group.
   * @param {string=} cf `'all'` or a single card token.
   * @return {!Element} The group element.
   */
  function renderAddedRow(g, cf = 'all') {
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

    // Single-card reading: this card's own status, no breakdown to expand.
    if (cf !== 'all') {
      const c = g.cards.find((x) => x.token === cf);
      const rt = el('div', {class: 'rt'});
      if (c && c.redeemed) {
        rt.append(el('div',
          {class: 'aday ok', text: singleRedeemedText(c.redeemed)}));
        if (c.redeemed.date) {
          rt.append(el('div',
            {class: 'asub', text: t('postedOn', {date: c.redeemed.date})}));
        }
      } else {
        if (Number.isFinite(g.daysLeft)) {
          rt.append(el('div', {class: g.daysLeft <= 7 ? 'aday urgent' : 'aday',
            text: daysLabel(g.daysLeft)}));
        } else if (g.expiry) {
          rt.append(el('div', {class: 'aday', text: expiryLabel(g)}));
        }
        rt.append(el('div', {class: 'asub', text: t('statPending')}));
      }
      const wrap = el('div', {class: 'agrp'});
      wrap.append(el('div', {class: 'arow flat static'}, logo, main, rt));
      return wrap;
    }

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

    // Collapsed by default (an offer added to many cards would be a long
    // always-open list); the whole row toggles the per-card breakdown.
    const expanded = state.addedExpanded.has(`o:${g.key}`);
    const row = el('div', {class: expanded ? 'arow' : 'arow flat'},
      logo, main, rt,
      el('span', {class: 'bcaret', text: expanded ? '▴' : '▾'}));
    row.onclick = () => {
      if (expanded) state.addedExpanded.delete(`o:${g.key}`);
      else state.addedExpanded.add(`o:${g.key}`);
      render();
    };
    const wrap = el('div', {class: g.fullyRedeemed ? 'agrp dim' : 'agrp'});
    wrap.append(row);
    if (expanded) wrap.append(cardsBox);
    return wrap;
  }

  /**
   * One card group (the 按卡 layout, mock state C): a card header (thumbnail +
   * family ⋯digits + `N 个 · $X 已返现` / `全部待消费`) over its offer rows.
   * The first 3 rows show; the rest hide behind an "展开其余 N 个 ▾" link. Each
   * row single-cards to this card's own status.
   * @param {!Object} cg A by-card group from {@link buildAddedByCard}.
   * @return {!Element} The group element.
   */
  function renderAddedCardGroup(cg) {
    const wrap = el('div', {class: 'acardgrp'});
    const cardData = cardOf(cg.token);
    const thumb = el('div', {class: 'thumb'});
    if (cardData?.art) thumb.append(el('img', {src: cardData.art, alt: ''}));
    else thumb.style.background = swatchStyle(cg.token);
    const family = cardData ? cardData.family : '';
    const digits = cardData ? cardData.digits : String(cg.token).slice(-4);
    const nm = el('div', {class: 'nm'});
    if (family) nm.append(document.createTextNode(`${family} `));
    nm.append(el('span', {class: 'dg', text: `⋯${digits}`}));
    const sum = el('div', {class: 'sum'});
    sum.append(document.createTextNode(`${t('nItems', {n: cg.offers.length})} `));
    if (cg.redeemedCount > 0) {
      const parts = [];
      if (cg.totalRedeemedUsd > 0) parts.push(fmtMoney(cg.totalRedeemedUsd));
      if (cg.totalRedeemedPoints > 0) {
        parts.push(fmtPoints(cg.totalRedeemedPoints));
      }
      sum.append(document.createTextNode('· '),
        el('b', {text: t('cardGroupBack', {amt: parts.join(' + ')})}));
    } else {
      sum.append(document.createTextNode('· '),
        el('b', {class: 'mut', text: t('cardGroupPending')}));
    }
    wrap.append(el('div', {class: 'acardhd'}, thumb, nm, sum));

    // First 3 rows show; the rest sit behind an expand link (state.added
    // Expanded keyed 'card:<token>').
    const expanded = state.addedExpanded.has(`card:${cg.token}`);
    const shown = expanded ? cg.offers : cg.offers.slice(0, 3);
    for (const o of shown) wrap.append(renderCardOfferRow(o));
    const rest = cg.offers.length - 3;
    if (rest > 0) {
      const more = el('div', {class: 'acardmore',
        text: expanded ? t('collapseRest') : t('expandRest', {n: rest})});
      more.onclick = () => {
        if (expanded) state.addedExpanded.delete(`card:${cg.token}`);
        else state.addedExpanded.add(`card:${cg.token}`);
        render();
      };
      wrap.append(more);
    }
    return wrap;
  }

  /**
   * One offer row inside a 按卡 card group: compact logo + name + short
   * description, right-aligned single-card status (待消费 with days-left, or
   * ✓ $X 已返现 · M/D 入账).
   * @param {!Object} o A per-card offer from {@link buildAddedByCard}.
   * @return {!Element} The row element.
   */
  function renderCardOfferRow(o) {
    const log = el('div', {class: 'aolog'});
    if (o.image) {
      log.append(el('img', {src: o.image, alt: '', loading: 'lazy'}));
    } else {
      const [bg, fg] = logoColors(o.name);
      log.style.background = bg;
      log.style.color = fg;
      log.textContent = merchantInitials(o.name);
    }
    const mn = el('div', {class: 'aomn'},
      el('div', {class: 'aonm', text: o.name}),
      o.description ? el('div', {class: 'aods', text: o.description}) : null);
    const rt = el('div', {class: 'aort'});
    if (o.redeemed) {
      rt.append(el('div',
        {class: 'aostat ok', text: singleRedeemedText(o.redeemed)}));
      if (o.redeemed.date) {
        rt.append(el('div',
          {class: 'aosub', text: t('postedOn', {date: o.redeemed.date})}));
      }
    } else {
      if (Number.isFinite(o.daysLeft)) {
        rt.append(el('div', {class: o.daysLeft <= 7 ? 'aostat' : 'aostat gray',
          text: daysLabel(o.daysLeft)}));
      }
      rt.append(el('div', {class: 'aosub', text: t('statPending')}));
    }
    return el('div', {class: 'aorow'}, log, mn, rt);
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
    return el('div', {class: 'ft', id: 'ft'}, sm, go);
  }

  /**
   * Updates the footer's two states: idle (nothing selected) shows a grey
   * hint and hides the button; selected shows the parallel-submit summary +
   * the primary button. Also refreshes the list header (same selection state).
   */
  function refreshFooter() {
    if (!panelRoot) return;
    refreshListHead();
    refreshWideSelectAll();
    const ft = panelRoot.getElementById('ft');
    const sm = panelRoot.getElementById('sm');
    const go = panelRoot.getElementById('go');
    if (!ft || !sm || !go) return;
    const offers = state.selected.size;
    sm.textContent = '';
    if (offers === 0) {
      ft.classList.add('idle');
      go.style.display = 'none';
      sm.textContent = t('footerIdle');
      return;
    }
    ft.classList.remove('idle');
    go.style.display = '';
    // The request count is the flattened, already-enrolled-skipping task set —
    // the same number the confirm dialog and the run will fire in parallel.
    const reqs = buildTasks().length;
    const wide = currentDensity() === 'wide';
    sm.append(document.createTextNode(t('footerSelPrefix')),
      el('b', {text: String(offers)}),
      document.createTextNode(t(wide ? 'footerSelMidWide' : 'footerSelMid')),
      el('b', {text: t(wide ? 'footerSelReqsWide' : 'footerSelReqs',
        {n: reqs})}));
    go.disabled = reqs === 0;
  }

  /**
   * Updates the list header in place: `N 个可加 OFFER ｜ 全选可加` while nothing
   * is selected, flipping to `已选 N 个 OFFER ｜ 清空` once a selection exists.
   * Double-blue: the select-all link is action bright-blue; the selected-count
   * label is view-state navy. No dead control — 全选可加 is hidden when there is
   * nothing addable to select.
   */
  function refreshListHead() {
    if (!panelRoot) return;
    const lh = panelRoot.getElementById('lh');
    if (!lh) return;
    lh.textContent = '';
    const body = panelRoot.querySelector('.body');
    const selCount = state.selected.size;
    const label = el('div', {class: 'lh-l'});
    const action = el('div', {class: 'lh-a'});
    if (selCount > 0) {
      label.classList.add('sel');
      label.textContent = t('listHeadSelected', {n: selCount});
      action.classList.add('mut');
      action.textContent = t('clearSelection');
      action.onclick = () => clearSelection(body);
      lh.append(label, action);
      return;
    }
    const addable =
        visibleOffers().filter((g) => addableCards(g).length > 0).length;
    label.textContent = t('listHeadAddable', {n: addable});
    lh.append(label);
    if (addable > 0) {
      action.textContent = t('selectAllAddable');
      action.onclick = () => selectAllVisible(body);
      lh.append(action);
    }
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
      expand: true, lang: true, close: true, tabs: true, ...extra};
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
    const body = el('div', {class: 'body'});
    body.append(loadingBlock(t('loadingBenefits'),
      known ? t('loadingCardN', {done: pr.done, total: pr.total}) :
        t('loadingCardList'), pct, t('benefitsReadOnly')));
    const sk = el('div', {class: 'skwrap'});
    for (let i = 0; i < 3; i++) sk.append(skeletonRow());
    body.append(sk);
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

    // Card-filter chips (same component as the offers tabs) sit above the
    // stats, per 13a; selecting a single card narrows both the stats and list.
    const chips = renderBenefitCardChips();
    if (chips) body.append(chips);

    body.append(renderBenefitStats());

    body.append(el('div', {id: 'bbody'}));
    shell.append(body);
    renderBenefitBody(body);
  }

  /**
   * The Benefits tab's card-filter chip row: navy "all" pill + one swatch chip
   * per card that actually carries a benefit, bound to state.benefitCardFilter.
   * No dashed "只看多卡" chip (that one is addable-only). Returns null when
   * there is at most one card (a lone "全部卡" chip would be pointless).
   * @return {?Element} The chip row, or null.
   */
  function renderBenefitCardChips() {
    const tokens = new Set();
    for (const g of state.benefits) {
      for (const e of g.entries) tokens.add(e.token);
    }
    const cards = state.cards.filter((c) => tokens.has(c.token));
    if (cards.length <= 1) return null;
    const row = el('div', {class: 'cfrow'});
    const add = (key, label, swToken) => {
      const chip = el('div',
        {class: state.benefitCardFilter === key ? 'cfil on' : 'cfil'});
      if (swToken != null) {
        const sw = el('span', {class: 'cfsw'});
        const cd = cardOf(swToken);
        if (cd?.art) sw.append(el('img', {src: cd.art, alt: ''}));
        else sw.style.background = swatchStyle(swToken);
        chip.append(sw);
      }
      chip.append(document.createTextNode(label));
      chip.onclick = () => {
        state.benefitCardFilter = key;
        render();
      };
      row.append(chip);
    };
    add('all', t('allCards'));
    for (const card of cards) add(card.token, `…${card.digits}`, card.token);
    return row;
  }

  /**
   * Renders the grouped benefit list into `#bbody` (without touching the search
   * box / chips / stats), so typing in search keeps focus. Groups by reset
   * cadence with a header per period, then the de-emphasized "无法自动追踪"
   * footer.
   * @param {!Element} body The benefits body element.
   */
  function renderBenefitBody(body) {
    const bbody = body.querySelector('#bbody');
    if (!bbody) return;
    bbody.textContent = '';
    const q = state.benefitQuery.trim().toLowerCase();
    const cf = state.benefitCardFilter;
    const single = cf !== 'all';
    let groups = state.benefits.filter((g) => matchesBenefitQuery(g, q));
    // A single-card filter narrows each group to just that card's entry and
    // recomputes its totals (so the row reads as that one card).
    if (single) {
      const now = Date.now();
      groups = groups
        .filter((g) => g.entries.some((e) => e.token === cf))
        .map((g) => finalizeBenefitGroup(
          {...g, entries: g.entries.filter((e) => e.token === cf)}, now));
    }
    const sections = buildBenefitPeriodGroups(groups);
    for (const pg of sections) {
      bbody.append(renderBenefitPeriodHeader(pg));
      const list = el('div', {class: 'blist'});
      for (const g of pg.groups) list.append(renderBenefitRow(g));
      bbody.append(list);
    }
    if (!sections.length) {
      const text = q ?
        t('noBenefitsMatch', {q: state.benefitQuery.trim()}) :
        t('noBenefits');
      bbody.append(el('div', {class: 'msg', style: 'padding:24px'},
        el('div', {class: 'note', text})));
    }
    const untrack = state.benefitsUntrackable.filter((u) =>
      (!single || u.token === cf) && (!q || u.name.toLowerCase().includes(q)));
    if (untrack.length) bbody.append(renderBenefitUntrackable(untrack));
  }

  /**
   * @param {!Object} pg A period section from {@link buildBenefitPeriodGroups}.
   * @return {!Element} The period group header (label · badge · summary).
   */
  function renderBenefitPeriodHeader(pg) {
    const left = el('div', {class: 'bgh-l'},
      el('span', {class: 'bgh-lbl', text: t(`periodEvery_${pg.period}`)}));
    if (Number.isFinite(pg.daysLeft)) {
      const amber = benefitPeriodTone(pg.period, pg.daysLeft) === 'amber';
      left.append(el('span', {class: amber ? 'bgh-badge amber' : 'bgh-badge',
        text: daysLabel(pg.daysLeft)}));
    }
    const sumKey = pg.activation ? 'benefitPendingActivate' : 'benefitPending';
    const sum = el('div', {class: 'bgh-sum',
      text: t(sumKey, {n: pg.count, amt: fmtMoney(pg.amount)})});
    return el('div', {class: 'bgh'}, left, sum);
  }

  /** @return {!Element} The three-stat header bar (follows the card filter). */
  function renderBenefitStats() {
    const s = benefitStats(state.benefits, state.cards, Date.now(),
      state.benefitCardFilter);
    const tile = (valCls, value, label, sub) => {
      const c = el('div', {class: 'c'});
      c.append(el('div', {class: `bval ${valCls}`, text: value}));
      c.append(el('div', {class: 'blbl', text: label}));
      if (sub) c.append(el('div', {class: 'bsub2', text: sub}));
      return c;
    };
    // Three tiles: what's unused this month, the year-to-date redeemed total
    // (the headline "how much did I get back this year"), and annual-fee
    // payback. No-fee cards drop the third and fall back to two tiles.
    const tiles = el('div', {class: 'bstats'},
      tile('navy', fmtMoney(s.thisMonthUnused), t('leftThisMonth')),
      tile('green', fmtMoney(s.redeemedYtd), t('redeemedYtd')));
    if (s.annualFee > 0) {
      tiles.append(tile('ink', `${s.paybackPct}%`, t('feePayback'),
        t('trackedOnly')));
    }
    return tiles;
  }

  /**
   * Subtitle line under a benefit name: a single-card row shows "卡名 ⋯尾号";
   * a multi-card row shows the collapsed summary "N 张卡 · 各 $X" (or "共 $X"
   * when the per-card amounts differ).
   * @param {!Object} group A benefit group.
   * @return {string} The subtitle text.
   */
  function benefitRowSubtitle(group) {
    if (group.entries.length <= 1) {
      const e = group.entries[0];
      return e ? `${e.family} …${e.digits}` : '';
    }
    const n = group.entries.length;
    const first = group.entries[0].target;
    const uniform = group.entries.every((e) => e.target === first);
    return uniform ?
      t('xCardsEach', {n, amt: fmtMoney(first, group.symbol)}) :
      t('xCardsTotal', {n, amt: fmtMoney(group.target, group.symbol)});
  }

  /**
   * One benefit row in the three-state language: unused (plain), partial
   * (green % + the list's only micro-bar), or done (faint-green archived row).
   * No left icon slot. Multi-card rows expand to a per-card breakdown.
   * @param {!Object} group A benefit group.
   * @return {!Element} The row.
   */
  function renderBenefitRow(group) {
    const title = el('div', {class: 'bname', text: group.name});

    // Not-yet-activated benefit (e.g. CLEAR Plus): amber "未激活" + 去激活 CTA,
    // with the card name + credit as a subtitle (no per-card breakdown).
    if (isInactiveBenefit(group)) {
      const cardText = group.entries
        .map((e) => `${e.family} …${e.digits}`).join(' · ');
      const sub = `${cardText} · ${fmtMoney(group.target, group.symbol)}/` +
        `${periodText(group.period || 'year')}`;
      const mn = el('div', {class: 'bmn'}, title,
        el('div', {class: 'bcard', text: sub}));
      const btn = el('div', {class: 'bactivate', text: t('activate'),
        onclick: () => window.open(
          'https://global.americanexpress.com/card-benefits/view-all',
          '_blank')});
      return el('div', {class: 'bgrp'},
        el('div', {class: 'brow'}, mn,
          el('span', {class: 'binact', text: t('notActivated')}), btn));
    }

    const done = group.fullyUsed;
    const pct = group.target > 0 ?
      Math.min(100, Math.round(group.spent / group.target * 100)) : 0;
    const partial = !done && group.spent > 0 && group.target > 0;
    const expandable = group.entries.length > 1;
    const expanded = expandable && state.benefitsExpanded.has(group.key);
    const showMicro = partial && !expanded;

    const mn = el('div', {class: 'bmn'}, title,
      el('div', {class: 'bcard', text: benefitRowSubtitle(group)}));

    let statusCls = 'bstat';
    let statusText = t('notUsed');
    if (done) {
      statusCls = 'bstat done';
      statusText = t('usedUp');
    } else if (partial) {
      statusCls = 'bstat used';
      statusText = t('usedPct', {n: pct});
    }
    if (expandable) statusText += expanded ? ' ▴' : ' ▾';

    const amt = el('div', {class: done ? 'bamt done' : 'bamt'});
    amt.append(`${done ? '✓ ' : ''}${fmtMoney(group.spent, group.symbol)} `);
    amt.append(el('span', {class: 'of',
      text: `/ ${fmtMoney(group.target, group.symbol)}`}));
    const rt = el('div', {class: 'brt'}, amt,
      el('div', {class: statusCls, text: statusText}));

    const row = el('div', {class: 'brow'}, mn, rt);
    let cls = 'bgrp';
    if (done) cls += ' done';
    else if (showMicro) cls += ' part';
    if (expanded) cls += ' exp';
    const wrap = el('div', {class: cls});
    if (expandable) {
      row.style.cursor = 'pointer';
      row.onclick = () => {
        if (expanded) state.benefitsExpanded.delete(group.key);
        else state.benefitsExpanded.add(group.key);
        render();
      };
    }
    wrap.append(row);
    if (showMicro) {
      wrap.append(el('div', {class: 'bmicro'},
        el('div', {style: `width:${pct}%`})));
    }
    if (expanded) wrap.append(renderBenefitBreakdown(group));
    return wrap;
  }

  /**
   * @param {!Object} group A benefit group.
   * @return {!Element} Per-card breakdown rows (swatch + card + amount). A card
   *     that has fully used its share shows a green "✓ $y"; no progress bars.
   */
  function renderBenefitBreakdown(group) {
    const box = el('div', {class: 'bsub'});
    for (const e of group.entries) {
      const eDone = e.target > 0 && e.spent >= e.target;
      const sw = el('span', {class: 'bsw'});
      if (e.art) sw.append(el('img', {src: e.art, alt: ''}));
      else sw.style.background = swatchStyle(e.token);
      const amtText = eDone ?
        `✓ ${fmtMoney(e.spent, e.symbol)}` :
        `${fmtMoney(e.spent, e.symbol)} / ${fmtMoney(e.target, e.symbol)}`;
      box.append(el('div', {class: 'bsubrow'}, sw,
        el('span', {class: 'bsubcard', text: `${e.family} …${e.digits}`}),
        el('span', {class: eDone ? 'bsubamt done' : 'bsubamt',
          text: amtText})));
    }
    return box;
  }

  /**
   * The de-emphasized, collapsible "无法自动追踪" footer row. Collapsed it
   * shows a count + a sample name; expanded it lists every untrackable perk.
   * @param {!Array<!Object>} items Untrackable items for the current filter.
   * @return {!Element} The footer.
   */
  function renderBenefitUntrackable(items) {
    const wrap = el('div', {class: 'buntrack-wrap'});
    const open = state.benefitsUntrackableOpen;
    const head = el('div', {class: 'buntrack'},
      el('span', {class: 'buntrack-t', text: t('untrackable')}),
      el('span', {class: 'buntrack-n', text: String(items.length)}),
      el('span', {class: 'buntrack-h', text: items[0] ? items[0].name : ''}),
      el('span', {class: 'buntrack-c', text: open ? '▴' : '▾'}));
    head.onclick = () => {
      state.benefitsUntrackableOpen = !state.benefitsUntrackableOpen;
      render();
    };
    wrap.append(head);
    if (open) {
      for (const it of items) {
        wrap.append(el('div', {class: 'buntrack-item'},
          el('span', {class: 'buntrack-name', text: it.name}),
          el('span', {class: 'buntrack-card',
            text: `${it.family} …${it.digits}`})));
      }
    }
    return wrap;
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
    const body = el('div', {class: 'body'});
    body.append(loadingBlock(t('loadingOffers'),
      known ? t('loadingCardN', {done: pr.done, total: pr.total}) :
        t('loadingCardList'), pct, t('loadingReadOnly')));
    const sk = el('div', {class: 'skwrap'});
    for (let i = 0; i < 3; i++) sk.append(skeletonRow());
    body.append(sk);
    shell.append(body);
  }

  /**
   * Shared "reading…" progress block: a bold title + count on one line, a
   * progress bar, and a read-only reassurance note.
   * @param {string} title Heading. @param {string} count Right-aligned count.
   * @param {number} pct Progress percent. @param {string} note Footnote.
   * @return {!Element} The block.
   */
  function loadingBlock(title, count, pct, note) {
    const rowStyle = 'display:flex;justify-content:space-between;' +
        'align-items:baseline;padding:0 0 9px';
    const countStyle = 'font-size:11.5px;color:#8A8F99;' +
        'font-variant-numeric:tabular-nums';
    const head = el('div', {style: 'padding:18px 20px 0'});
    head.append(el('div', {style: rowStyle},
      el('div', {style: 'font-size:13px;font-weight:700;color:#1A1E28',
        text: title}),
      el('div', {style: countStyle, text: count})));
    head.append(el('div', {class: 'bar'}, el('div', {style: `width:${pct}%`})));
    head.append(el('div', {class: 'note', style: 'margin-top:8px',
      text: note}));
    return head;
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
    shell.append(renderHeader({glyph: '＋',
      title: t('runningTitle'),
      subtitle: t('runningSubtitle', {n: run.total}),
      right: el('div', {class: 'b',
        style: 'font-size:12px;font-weight:700;' +
          'font-variant-numeric:tabular-nums',
        text: t('processedOf',
          {done: run.results.length, total: run.total})})}));
    const body = el('div', {class: 'body'});
    body.append(el('div', {style: 'padding:16px 20px 0'},
      el('div', {class: 'bar'}, el('div', {style: `width:${pct}%`}))));
    const cols = [
      {n: ok, l: t('submitOk'), c: 'g'}, {n: fail, l: t('submitFail'), c: 'r'},
      {n: pending, l: t('submitting'), c: 'b'}];
    if (skipped) cols.push({n: skipped, l: t('notSubmitted'), c: 'am'});
    body.append(counters(cols));
    const rl = el('div', {class: 'rl'});
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
    body.append(el('div', {class: 'bfoot'},
      el('div', {class: 'note'},
        el('b', {class: 'am', style: 'font-weight:700',
          text: t('runningNoteLead')}), t('runningNote'))));
    shell.append(body);
    void settledIds;
  }

  /** @param {!Element} shell Panel content root. */
  function renderResultView(shell) {
    const results = [...state.lastResults.values()];
    const n = (s) => results.filter((r) => r.state === s).length;
    const throttled = results.some(
      (r) => r.blocked || r.state === ResultState.SKIPPED);
    shell.append(renderHeader({glyph: '＋',
      title: throttled ? t('resultTitleStopped') : t('resultTitleOk'),
      subtitle: t('resultSubtitle', {n: results.length}), close: true}));
    const body = el('div', {class: 'body'});
    const cols = [
      {n: n(ResultState.VERIFIED), l: t('confirmedAdded'), c: 'g'},
      {n: n(ResultState.FAILED), l: t('addFailed'), c: 'r'},
      {n: n(ResultState.GHOST) + n(ResultState.UNVERIFIED),
        l: t('dedupeOrUnknown'), c: 'am'}];
    if (n(ResultState.SKIPPED)) {
      cols.push({n: n(ResultState.SKIPPED), l: t('notSubmitted'), c: 'am'});
    }
    body.append(counters(cols, 'lg'));
    if (throttled) {
      body.append(el('div', {class: 'info'},
        el('b', {text: t('throttledTitle')}), t('throttledBody')));
    }
    body.append(el('div', {class: 'info'},
      el('b', {text: t('dedupeHelpTitle')}), t('dedupeHelpBody')));

    // All outcome sections live in one white card, matching the design.
    const reslist = el('div', {class: 'reslist'});
    const section = (title, filter, glyph, cls) => {
      const items = results.filter(filter);
      if (!items.length) return;
      reslist.append(el('div', {class: 'sh', text: title}));
      for (const r of items) {
        const label = `${r.name} → ${cardLabel(r.token)}`;
        if (r.state === ResultState.FAILED && r.message) {
          // Long server message: stack it under the card, left-aligned.
          reslist.append(el('div', {class: 'si col'},
            el('span', {text: label}),
            el('span', {class: `${cls} si-msg`, text: `“${r.message}”`})));
        } else {
          reslist.append(el('div', {class: 'si'},
            el('span', {text: label}),
            el('span', {class: `st ${cls}`, text: glyph})));
        }
      }
    };
    section(t('confirmedAdded'),
      (r) => r.state === ResultState.VERIFIED, '✓', 'g');
    section(t('addFailed'), (r) => r.state === ResultState.FAILED, '✗', 'r');
    section(t('secSkipped'),
      (r) => r.state === ResultState.SKIPPED, '⊘', 'am');
    section(t('secGhost'),
      (r) => r.state === ResultState.GHOST, '?', 'am');
    section(t('secUnverified'),
      (r) => r.state === ResultState.UNVERIFIED, '?', 'note');
    if (reslist.children.length) body.append(reslist);

    const retryable = (r) => (r.state === ResultState.FAILED ||
        r.state === ResultState.SKIPPED) && !r.gone;
    const retry = el('div', {class: 'lnk rerun', text: t('retryUnfinished'),
      onclick: () => retryFailed()});
    if (!results.some(retryable)) {
      retry.style.display = 'none';
    }
    shell.append(body);
    shell.append(el('div', {class: 'ft'},
      el('div', {class: 'sp', style: 'flex:1'}), retry,
      el('button', {class: 'go', text: t('backToList'),
        onclick: () => backToList()})));
  }

  /**
   * @param {!Array<{n: number, l: string, c: string}>} cols Counter columns.
   * @return {!Element} The 3-up counter strip.
   */
  function counters(cols, variant) {
    const row = el('div', {class: variant ? `cnt ${variant}` : 'cnt'});
    cols.forEach((col) => {
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
    const sk = el('div', {class: 'skwrap'});
    for (let i = 0; i < 4; i++) sk.append(skeletonRow());
    dim.append(sk);
    wrap.append(dim);

    const dlg = el('div', {class: 'cfdlg'});
    dlg.append(el('div', {class: 'cf-hd'},
      el('div', {class: 'cf-t', text: t('confirmTitle', {n: tasks.length})}),
      el('div', {class: 'cf-d', text: t('confirmSub')})));
    const list = el('div', {class: 'cf-list'});
    for (const [name, n] of byOffer) {
      list.append(el('div', {class: 'cf-row'},
        el('span', {class: 'nm', text: name}),
        el('span', {class: 'ct', text: t('confirmCards', {n})})));
    }
    dlg.append(list);
    dlg.append(el('div', {class: 'cf-meta',
      text: t('confirmMeta', {offers: byOffer.size, adds: tasks.length})}));
    // Only surfaced past the batch-size threshold, matching the design.
    if (tasks.length > 30) {
      dlg.append(el('div', {class: 'cf-warn'},
        el('span', {text: '⚠ '}), t('confirmThrottle')));
    }
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
      expand: true, close: true, lang: true, refresh: true, tabs: true}));
    const reload = el('div', {class: 'btn', onclick: () => refresh()});
    const ic = el('span', {style: 'display:flex'});
    ic.innerHTML = REFRESH_SVG;
    reload.append(ic, t('reload'));
    shell.append(el('div', {class: 'body'}, el('div', {class: 'msg'},
      el('div', {class: 'cir ok', text: '✓'}),
      el('div', {class: 'h', text: t('emptyTitle')}),
      el('div', {class: 'txt', text: t('emptyBody')}),
      reload)));
  }

  /** @param {!Element} shell Panel content root. */
  function renderErrorView(shell) {
    shell.append(renderHeader({glyph: '＋', title: t('panelTitle'),
      expand: true, close: true, lang: true, err: true}));
    shell.append(el('div', {class: 'body'}, el('div', {class: 'msg'},
      el('div', {class: 'cir bad', text: '!'}),
      el('div', {class: 'h', text: t('errorTitle')}),
      el('div', {class: 'txt',
        text: state.errorMessage || t('errorSessionHint')}),
      el('div', {class: 'btn pri', onclick: () => refresh()}, t('retry')))));
  }

  /**
   * First-run trust screen: explains what the tool does and that it's
   * local-only, with a language toggle. Nothing is read until 开始读取 / Start.
   * @param {!Element} shell Panel content root.
   */
  function renderLanguageView(shell) {
    shell.append(renderHeader(
      {glyph: '＋', title: t('panelTitle'), close: true}));
    const body = el('div', {class: 'body'});
    const trust = el('div', {class: 'trust'});

    const title = el('div', {class: 'trust-t'});
    title.append(document.createTextNode(t('trustTitle1')), el('br'),
      document.createTextNode(t('trustTitle2')));
    trust.append(title);
    trust.append(el('div', {class: 'trust-d', text: t('trustDesc')}));

    const bullet = (lead, rest) => el('div', {class: 'trust-b'},
      el('div', {class: 'ck', text: '✓'}),
      el('div', {}, el('b', {text: lead}), rest));
    trust.append(el('div', {class: 'trust-list'},
      bullet(t('trustB1Lead'), t('trustB1Rest')),
      bullet(t('trustB2Lead'), t('trustB2Rest')),
      bullet(t('trustB3Lead'), t('trustB3Rest'))));

    trust.append(el('div', {class: 'go', text: t('trustStart'),
      onclick: () => chooseLanguage(getLanguage())}));
    trust.append(el('div', {class: 'trust-foot', text: t('trustFoot')}));

    // Non-persisting language toggle; the choice is saved on 开始读取 / Start.
    const langBtn = (lang, label) => el('div', {
      class: getLanguage() === lang ? 'trust-lang on' : 'trust-lang',
      text: label,
      onclick: () => {
        setLanguage(lang);
        render();
      }});
    trust.append(el('div', {class: 'trust-langs'},
      langBtn('zh', '中文'), langBtn('en', 'English')));

    body.append(trust);
    shell.append(body);
  }

  // ---- helpers for card family / raw account -------------------------------

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

  /** Returns from the result view to the offer list. */
  function backToList() {
    state.view = 'list';
    render();
  }

  // ---- wide mode (G4): the second density ----------------------------------
  // Same skeleton, denser table layout. These renderers reuse every pure
  // function and every piece of `state` the sidebar uses (buildOfferIndex /
  // buildAddedIndex / addedStats / buildBenefitPeriodGroups / benefitStats /
  // planRetry / groupResultsByOffer …); no business logic is duplicated, only
  // the presentation differs. Entered only from render() when the density is
  // wide, so nothing here runs in the sidebar.

  /** @param {string} token Card token. @return {!Element} An 18×12 swatch. */
  function wideSwatch(token) {
    const sw = el('span', {class: 'wsw'});
    const cd = cardOf(token);
    if (cd?.art) sw.append(el('img', {src: cd.art, alt: ''}));
    else sw.style.background = swatchStyle(token);
    return sw;
  }

  /** @param {string} token Card token. @return {string} `⋯1234` label. */
  function wideDigits(token) {
    const cd = cardOf(token);
    return `⋯${cd ? cd.digits : String(token).slice(-4)}`;
  }

  /**
   * A per-card status chip (the wide core construct). Tone encodes the state:
   * gray (default), green, red, amber, or `sel` (bright-blue submit-selection).
   * @param {{token: string, tone: (string|undefined), suffix: (string|
   *          undefined), onClick: (function()|undefined)}} opts Chip options.
   * @return {!Element} The chip.
   */
  function wideChip(opts) {
    let cls = 'wchip';
    if (opts.tone && opts.tone !== 'gray') cls += ` ${opts.tone}`;
    if (opts.onClick) cls += ' click';
    const chip = el('span', {class: cls});
    chip.append(wideSwatch(opts.token));
    chip.append(document.createTextNode(
      opts.suffix ? `${wideDigits(opts.token)} ${opts.suffix}` :
        wideDigits(opts.token)));
    if (opts.onClick) chip.onclick = opts.onClick;
    return chip;
  }

  /** @param {string} name @param {string} image @return {!Element} Logo. */
  function wideLogo(name, image) {
    const logo = el('div', {class: 'wlogo'});
    if (image) {
      logo.append(el('img', {src: image, alt: '', loading: 'lazy'}));
    } else {
      const [bg, fg] = logoColors(name);
      logo.style.background = bg;
      logo.style.color = fg;
      logo.textContent = merchantInitials(name);
    }
    return logo;
  }

  /**
   * The "商家 / OFFER" cell shared by the wide offer tables: a logo over a
   * stacked name + (optional) description, taking the flex column.
   * @param {string} name @param {string} desc @param {string} image
   * @param {string=} sub Explicit subtitle (overrides `desc` when set).
   * @return {!Element} The cell.
   */
  function wideMnCell(name, desc, image, sub) {
    const txt = el('div', {class: 'wtxt'},
      el('div', {class: 'wnm', text: name}),
      (sub || desc) ? el('div', {class: 'wds', text: sub || desc}) : null);
    return el('div', {class: 'wcell-mn cw-flex'}, wideLogo(name, image), txt);
  }

  /** @param {string} exp Raw expiry text. @return {string} `MM/DD` or ''. */
  function shortExpiry(exp) {
    const m = /(\d{1,2})\/(\d{1,2})/.exec(exp || '');
    return m ? `${m[1]}/${m[2]}` : '';
  }

  /** Dispatches the wide overlay to the right view. @param {!Element} shell */
  function renderWide(shell) {
    if (state.tab === 'benefits') {
      if (state.benefitsError) return renderBenefitsError(shell);
      if (!state.benefitsLoaded) return renderBenefitsLoading(shell);
      return renderWideBenefits(shell);
    }
    switch (state.view) {
      case 'running': return renderWideRunning(shell);
      case 'result': return renderWideResult(shell);
      case 'confirm': return renderConfirmView(shell);
      case 'language': return renderLanguageView(shell);
      case 'empty': return renderEmptyView(shell);
      case 'error': return renderErrorView(shell);
      case 'loading': return renderLoadingView(shell);
      default: return renderWideOffers(shell);
    }
  }

  /** @return {!Element} The 可加 | 已加 pill for the wide control row. */
  function wideSubPills() {
    const addableN =
        state.offers.filter((g) => addableCards(g).length > 0).length;
    const addedN = buildAddedIndex(state.cards, state.redeemed.byToken).length;
    const mk = (key, label, n) => {
      const pill = el('div',
        {class: state.offersSub === key ? 'subpill on' : 'subpill',
          text: `${label} ${n}`});
      pill.onclick = () => {
        if (state.offersSub === key) return;
        state.offersSub = key;
        state.addedMenuOpen = false;
        render();
      };
      return pill;
    };
    return el('div', {class: 'subpills'},
      mk('addable', t('subAddable'), addableN),
      mk('added', t('subAdded'), addedN));
  }

  /** @param {!Element} shell Panel content root. */
  function renderWideOffers(shell) {
    shell.append(renderHeader({
      glyph: '＋', title: t('panelTitle'),
      subtitle: [t('listSubtitle',
        {offers: state.offers.length, cards: state.cards.length}),
      agoLabel(state.snapshotAt)].filter(Boolean).join(' · '),
      expand: true, lang: true, refresh: true, close: true, tabs: true,
    }));
    if (state.offersSub === 'added') renderWideAdded(shell);
    else renderWideAddable(shell);
  }

  /** @return {!Array<!OfferGroup>} Wide-addable offers (query + 只看多卡). */
  function visibleAddableWide() {
    const q = state.query;
    return state.offers.filter((g) => {
      if (addableCards(g).length === 0) return false;
      if (q && !g.name.toLowerCase().includes(q)) return false;
      if (state.multiOnly && addableCards(g).length < 2) return false;
      return true;
    });
  }

  /** @param {!Element} shell Panel content root (9c). */
  function renderWideAddable(shell) {
    const top = el('div', {class: 'wtop'});
    const search = el('input', {type: 'search', value: state.query,
      placeholder: t('searchOffers')});
    search.oninput = (e) => {
      state.query = e.target.value.trim().toLowerCase();
      fillWideAddableRows(shell);
      refreshFooter();
    };
    const box = el('div', {class: 'wsearch'},
      el('span', {class: 'wsi', text: '⌕'}), search);
    const multi = el('div',
      {class: state.multiOnly ? 'wcheckchip on' : 'wcheckchip'});
    const bx = el('span', {class: 'bx'});
    if (state.multiOnly) bx.innerHTML = CHECK_SVG;
    multi.append(bx, document.createTextNode(t('multiAddableOnly')));
    multi.onclick = () => {
      state.multiOnly = !state.multiOnly;
      render();
    };
    const selall = el('div', {class: 'wlink', id: 'wselall'});
    top.append(el('div', {class: 'wctlrow'},
      wideSubPills(), box, multi, selall));
    top.append(el('div', {class: 'wcolh'},
      el('div', {class: 'cw-check'}),
      el('div', {class: 'cw-flex', text: t('colMerchantOffer')}),
      el('div', {class: 'cw-exp-s', text: t('colExpiry')}),
      el('div', {class: 'cw-chips', text: t('colChooseCards')})));
    shell.append(top);
    shell.append(el('div', {class: 'wscroll', id: 'wscroll'}));
    fillWideAddableRows(shell);
    shell.append(renderFooter());
    refreshFooter();
  }

  /** @param {!Element} shell Panel content root. */
  function fillWideAddableRows(shell) {
    const scroll = shell.querySelector('#wscroll');
    if (!scroll) return;
    scroll.textContent = '';
    const groups = visibleAddableWide();
    if (!groups.length) {
      scroll.append(el('div', {class: 'msg', style: 'padding:32px'},
        el('div', {class: 'note',
          text: state.query ? t('noMatchingOffers') : t('emptyTitle')})));
      return;
    }
    for (const g of groups) scroll.append(renderWideAddableRow(g));
  }

  /**
   * One wide-addable row: the offer-level select-all checkbox, the merchant
   * cell, the expiry, and one selectable chip per addable card (bright-blue =
   * selected, the submit-type selection). Chip / checkbox toggles update in
   * place (no full re-render), preserving scroll and focus.
   * @param {!OfferGroup} g Offer group.
   * @return {!Element} The row.
   */
  function renderWideAddableRow(g) {
    const addable = addableCards(g);
    const chosen = () => state.selected.get(g.key) || new Set();
    const row = el('div', {class: 'wrow'});
    const check = el('input', {type: 'checkbox', class: 'cw-check'});
    const chipEls = new Map();

    const syncRow = () => {
      const set = chosen();
      check.checked = set.size > 0;
      check.indeterminate = set.size > 0 && set.size < addable.length;
      row.classList.toggle('sel', set.size > 0);
      for (const c of addable) {
        chipEls.get(c.token).classList.toggle('sel', set.has(c.token));
      }
    };
    check.onclick = (e) => {
      e.stopPropagation();
      if (check.checked) {
        state.selected.set(g.key, new Set(addable.map((c) => c.token)));
      } else {
        state.selected.delete(g.key);
      }
      syncRow();
      refreshFooter();
    };

    const chips = el('div', {class: 'wchips cw-chips'});
    for (const c of addable) {
      const chip = wideChip({token: c.token, tone: 'gray', onClick: () => {
        const set = new Set(chosen());
        if (set.has(c.token)) set.delete(c.token);
        else set.add(c.token);
        if (set.size) state.selected.set(g.key, set);
        else state.selected.delete(g.key);
        syncRow();
        refreshFooter();
      }});
      chip.classList.add('click');
      chipEls.set(c.token, chip);
      chips.append(chip);
    }

    const exp = el('div',
      {class: 'wexp cw-exp-s', text: shortExpiry(g.expiry)});
    row.append(check, wideMnCell(g.name, g.description, g.image), exp, chips);
    syncRow();
    return row;
  }

  /** Updates the wide 全选可加 / 清空 link in place (called by refreshFooter). */
  function refreshWideSelectAll() {
    const link = panelRoot.getElementById('wselall');
    if (!link) return;
    if (state.selected.size > 0) {
      link.textContent = t('clearSelection');
      link.onclick = () => {
        state.selected.clear();
        render();
      };
    } else {
      link.textContent = t('selectAllAddable');
      link.onclick = () => {
        for (const g of visibleAddableWide()) {
          const a = addableCards(g);
          if (a.length) {
            state.selected.set(g.key, new Set(a.map((c) => c.token)));
          }
        }
        render();
      };
    }
  }

  /** @param {!Element} shell Panel content root (9a). */
  function renderWideAdded(shell) {
    const top = el('div', {class: 'wtop'});
    const search = el('input', {type: 'search', value: state.query,
      placeholder: t('searchOffers')});
    search.oninput = (e) => {
      state.query = e.target.value.trim().toLowerCase();
      fillWideAddedRows(shell);
    };
    const box = el('div', {class: 'wsearch'},
      el('span', {class: 'wsi', text: '⌕'}), search);
    const ctl = el('div', {class: 'wctlrow'}, wideSubPills(), box);
    const groups0 = buildAddedIndex(state.cards, state.redeemed.byToken);
    const hasCat = groups0.some((g) => g.category);
    const mode = effectiveAddedMode(hasCat);
    ctl.append(renderAddedGroupDropdown(hasCat, mode));
    top.append(ctl);
    top.append(renderAddedCardChips());
    // 按卡 sections and single-card filtering render status words, not chips,
    // so the third column header follows suit.
    const singleRead = mode === 'card' || state.addedCardFilter !== 'all';
    top.append(el('div', {class: 'wcolh'},
      el('div', {class: 'cw-flex', text: t('colMerchantOffer')}),
      el('div', {class: 'cw-exp', text: t('colExpiry')}),
      el('div', {class: 'cw-chips',
        text: t(singleRead ? 'colStatus' : 'colCardStatus')})));
    shell.append(top);
    shell.append(el('div', {class: 'wscroll', id: 'wscroll'}));
    fillWideAddedRows(shell);
    shell.append(el('div', {class: 'bfoot'},
      el('div', {class: 'note', text: t('addedFootnote')})));
    // Click-outside scrim for the grouping dropdown — same relationship as the
    // sidebar (.wtop is a static child of the relative .p, so .adrop.open's
    // z-index still lifts it above the scrim; the .wtop isn't a scroll clip).
    if (state.addedMenuOpen) {
      shell.append(el('div', {class: 'ddscrim', onclick: () => {
        state.addedMenuOpen = false;
        render();
      }}));
    }
  }

  /** @param {!Element} shell Panel content root. */
  function fillWideAddedRows(shell) {
    const scroll = shell.querySelector('#wscroll');
    if (!scroll) return;
    scroll.textContent = '';
    const r = state.redeemed;
    if (r.error) {
      scroll.append(el('div', {class: 'msg', style: 'padding:28px'},
        el('div', {class: 'note'}, el('b', {text: t('addedError')}), ' ',
          el('a', {class: 'lnk', text: t('retry'),
            onclick: () => loadRedeemed(true)}))));
      return;
    }
    if (!r.loaded) {
      if (!r.loading) loadRedeemed();
      scroll.append(el('div', {class: 'msg', style: 'padding:32px'},
        el('div', {style: 'display:flex;gap:10px;justify-content:center;' +
            'align-items:center'},
        el('span', {class: 'spin'}),
        el('span', {class: 'note', text: t('addedLoading')}))));
      return;
    }
    const q = state.query;
    const cf = state.addedCardFilter;
    const single = cf !== 'all';
    const all = buildAddedIndex(state.cards, r.byToken);
    const mode = effectiveAddedMode(all.some((g) => g.category));
    let groups = all.filter((g) =>
      (!q || g.name.toLowerCase().includes(q)) &&
      (!single || g.cards.some((c) => c.token === cf)));
    if (!groups.length) {
      scroll.append(el('div', {class: 'msg', style: 'padding:32px'},
        el('div', {class: 'note',
          text: q ? t('noMatchingOffers') : t('noAddedOffers')})));
      return;
    }
    if (mode === 'card') {
      if (single) {
        groups = groups.map((g) =>
          ({...g, cards: g.cards.filter((c) => c.token === cf)}));
      }
      for (const cg of groupAddedBy(groups, 'card')) {
        scroll.append(renderWideCardSection(cg));
      }
      return;
    }
    if (mode === 'category') {
      for (const sec of groupAddedBy(groups, 'category')) {
        scroll.append(el('div', {class: 'wsec'},
          el('span', {class: 'lbl',
            text: sec.category ? sec.category.toUpperCase() :
              t('uncategorized')}),
          el('span', {class: 'cnt', text: t('nItems',
            {n: sec.offers.length})})));
        for (const g of sec.offers) scroll.append(renderWideAddedRow(g, cf));
      }
      return;
    }
    for (const g of groups) scroll.append(renderWideAddedRow(g, cf));
  }

  /**
   * One wide 已加 row: merchant cell, expiry / days-left, and one status chip
   * per card — gray = added, awaiting spend; green `⋯尾号 ✓ $X` = cashback
   * posted — with the overflow collapsed to an interactive `+N`.
   * @param {!Object} g An added-offer group.
   * @param {string} cf `'all'` or a single card token.
   * @return {!Element} The row.
   */
  function renderWideAddedRow(g, cf) {
    // A single-card filter reads like a 按卡 row: status word, no chip (the
    // chip would just repeat the digits already selected in the filter).
    if (cf !== 'all') {
      const c = g.cards.find((x) => x.token === cf);
      return el('div', {class: 'wrow'},
        wideMnCell(g.name, g.description, g.image),
        ...wideSingleCells(c && c.redeemed, g.daysLeft, g.expiry));
    }
    const exp = el('div', {class: 'wexp cw-exp'});
    if (Number.isFinite(g.daysLeft)) {
      if (g.daysLeft <= 7) exp.classList.add('urgent');
      exp.textContent = daysLabel(g.daysLeft);
    } else {
      exp.textContent = shortExpiry(g.expiry);
    }
    const chips = el('div', {class: 'wchips cw-chips'});
    fillWideAddedChips(chips, g, cf);
    return el('div', {class: 'wrow'},
      wideMnCell(g.name, g.description, g.image), exp, chips);
  }

  /**
   * Fills an added row's status chips, capping at four with an interactive
   * `+N` that reveals the rest (state.wideChipsExpanded) without a re-render.
   * @param {!Element} container Chip container. @param {!Object} g Group.
   * @param {string} cf `'all'` or a card token.
   */
  function fillWideAddedChips(container, g, cf) {
    container.textContent = '';
    const cards = cf === 'all' ? g.cards :
      g.cards.filter((c) => c.token === cf);
    const expanded = state.wideChipsExpanded.has(g.key);
    const LIMIT = 4;
    const show = expanded ? cards : cards.slice(0, LIMIT);
    for (const c of show) {
      let tone = 'gray';
      let suffix = '';
      if (c.redeemed) {
        tone = 'green';
        suffix = '✓';
        if (c.redeemed.amount > 0) {
          suffix += ` ${c.redeemed.unit === 'points' ?
            fmtPoints(c.redeemed.amount) : fmtMoney(c.redeemed.amount)}`;
        }
      }
      container.append(wideChip({token: c.token, tone, suffix}));
    }
    const hidden = cards.length - show.length;
    if (hidden > 0) {
      const more = el('div', {class: 'wmore', text: `+${hidden}`});
      more.onclick = () => {
        state.wideChipsExpanded.add(g.key);
        fillWideAddedChips(container, g, cf);
      };
      container.append(more);
    }
  }

  /**
   * One 按卡 section (wide): a card header (thumbnail + family ⋯digits + summary)
   * over that card's offers as single-card rows.
   * @param {!Object} cg A by-card group from {@link buildAddedByCard}.
   * @return {!DocumentFragment} The section.
   */
  function renderWideCardSection(cg) {
    const frag = document.createDocumentFragment();
    const cd = cardOf(cg.token);
    const thumb = el('div', {class: 'thumb'});
    if (cd?.art) thumb.append(el('img', {src: cd.art, alt: ''}));
    else thumb.style.background = swatchStyle(cg.token);
    const family = cd ? cd.family : '';
    const digits = cd ? cd.digits : String(cg.token).slice(-4);
    const nm = el('div', {class: 'nm'});
    if (family) nm.append(document.createTextNode(`${family} `));
    nm.append(el('span', {text: `⋯${digits}`}));
    const sum = el('div', {class: 'sum'});
    sum.append(document.createTextNode(
      `${t('nItems', {n: cg.offers.length})} `));
    if (cg.redeemedCount > 0) {
      const parts = [];
      if (cg.totalRedeemedUsd > 0) parts.push(fmtMoney(cg.totalRedeemedUsd));
      if (cg.totalRedeemedPoints > 0) {
        parts.push(fmtPoints(cg.totalRedeemedPoints));
      }
      sum.append(document.createTextNode('· '),
        el('b', {text: t('cardGroupBack', {amt: parts.join(' + ')})}));
    } else {
      sum.append(document.createTextNode('· '),
        el('b', {class: 'mut', text: t('cardGroupPending')}));
    }
    frag.append(el('div', {class: 'wcardsec'}, thumb, nm, sum));
    for (const o of cg.offers) frag.append(renderWideCardOfferRow(o));
    return frag;
  }

  /**
   * The expiry + status cells for a row that reads as ONE card (a 按卡 section
   * row, or any row under a single-card filter). Mirrors the sidebar's
   * single-card language (8final C/D): redeemed = green `✓ $X 已返现` with the
   * posted date in the expiry slot; pending = days-left + grey `待消费`. No
   * card chip — it would repeat what the section header / filter already says
   * and leave the rest of the column as whitespace.
   * @param {?Object} redeemed The card's redemption record, if any.
   * @param {number} daysLeft Days to expiry. @param {string} expiry Raw label.
   * @return {!Array<!Element>} `[expCell, statusCell]`.
   */
  function wideSingleCells(redeemed, daysLeft, expiry) {
    const exp = el('div', {class: 'wexp cw-exp'});
    const stat = el('div', {class: 'wstat cw-chips'});
    if (redeemed) {
      stat.classList.add('ok');
      stat.textContent = singleRedeemedText(redeemed);
      if (redeemed.date) {
        exp.textContent = t('postedOn', {date: redeemed.date});
      }
    } else {
      if (Number.isFinite(daysLeft)) {
        if (daysLeft <= 7) exp.classList.add('urgent');
        exp.textContent = daysLabel(daysLeft);
      } else {
        exp.textContent = shortExpiry(expiry);
      }
      stat.classList.add('mut');
      stat.textContent = t('statPending');
    }
    return [exp, stat];
  }

  /**
   * One offer row inside a 按卡 wide section: merchant cell plus the
   * single-card expiry/status cells ({@link wideSingleCells}).
   * @param {!Object} o A per-card offer from {@link buildAddedByCard}.
   * @return {!Element} The row.
   */
  function renderWideCardOfferRow(o) {
    return el('div', {class: 'wrow'},
      wideMnCell(o.name, o.description, o.image),
      ...wideSingleCells(o.redeemed, o.daysLeft, o.expiry));
  }

  /** @param {!Element} shell Panel content root (9d). */
  function renderWideResult(shell) {
    const results = [...state.lastResults.values()];
    const n = (s) => results.filter((r) => r.state === s).length;
    const throttled = results.some(
      (r) => r.blocked || r.state === ResultState.SKIPPED);
    const hd = el('div', {class: 'wrhd'});
    hd.append(el('div', {class: throttled ? 'cir bad' : 'cir ok',
      text: throttled ? '!' : '✓'}));
    hd.append(el('div', {class: 'tt'},
      el('div', {class: 't1',
        text: throttled ? t('resultTitleStopped') : t('resultTitleOk')}),
      el('div', {class: 't2', text: t('wideResultSub', {n: results.length})})));
    const stat = (val, label, cls) => el('div', {class: 'wrstat'},
      el('div', {class: `n ${cls}`, text: String(val)}),
      el('div', {class: 'l', text: label}));
    hd.append(el('div', {class: 'wrstats'},
      stat(n(ResultState.VERIFIED), t('confirmedAdded'), 'g'),
      stat(n(ResultState.FAILED), t('addFailed'), 'r'),
      stat(n(ResultState.GHOST) + n(ResultState.UNVERIFIED),
        t('dedupeOrUnknown'), 'am')));
    hd.append(el('button', {class: 'cl', title: t('close'), text: '×',
      onclick: () => hidePanel()}));
    shell.append(hd);
    shell.append(el('div', {class: 'wcolh'},
      el('div', {class: 'cw-flex', text: t('colOffer')}),
      el('div', {class: 'cw-rchips', text: t('colCardResult')})));
    const scroll = el('div', {class: 'wscroll'});
    for (const g of groupResultsByOffer(results)) {
      scroll.append(renderWideResultRow(g));
    }
    shell.append(scroll);
    shell.append(el('div', {class: 'wfoot'},
      el('div', {class: 'txt', text: t('resultLegend')}),
      el('div', {class: 'wbtn', text: t('backToList'),
        onclick: () => backToList()})));
  }

  /**
   * One wide result row: merchant cell (with an "N 张卡" subtitle) and one chip
   * per card encoding the outcome (✓ green / ✗ red / ? amber / ⊘ amber), plus
   * an inline "重试失败项" link when the offer has a retryable card.
   * @param {{key: string, name: string, results: !Array<!Object>}} g Offer.
   * @return {!Element} The row.
   */
  function renderWideResultRow(g) {
    const grp = state.offers.find((o) => o.key === g.key);
    const chips = el('div', {class: 'wchips cw-rchips'});
    let retryable = false;
    for (const r of g.results) {
      let tone = 'amber';
      let s = '?';
      if (r.state === ResultState.VERIFIED) {
        tone = 'green';
        s = '✓';
      } else if (r.state === ResultState.FAILED) {
        tone = 'red';
        s = '✗';
      } else if (r.state === ResultState.SKIPPED) {
        s = '⊘';
      }
      chips.append(wideChip({token: r.token, tone, suffix: s}));
      if ((r.state === ResultState.FAILED ||
           r.state === ResultState.SKIPPED) && !r.gone) retryable = true;
    }
    if (retryable) {
      chips.append(el('span', {class: 'wretry', text: t('retryFailed'),
        onclick: () => retryOfferFailed(g.key)}));
    }
    return el('div', {class: 'wrow'},
      wideMnCell(g.name, '', grp ? grp.image : '',
        t('nCards', {n: g.results.length})), chips);
  }

  /**
   * Re-runs just one offer's failed / never-submitted cards, re-planned against
   * the current snapshot (reuses {@link planRetry}). Pairs that already landed
   * or are gone settle in place without a resend.
   * @param {string} key The offer group key.
   */
  function retryOfferFailed(key) {
    const subset =
        [...state.lastResults.values()].filter((r) => r.key === key);
    const {tasks, landed, gone} = planRetry(subset, state.offers);
    for (const r of [...landed, ...gone]) {
      state.lastResults.set(`${r.key}|${r.token}`, r);
    }
    if (tasks.length) runSelected(tasks);
    else render();
  }

  /** @param {!Element} shell Panel content root (derived: 9d × running). */
  function renderWideRunning(shell) {
    const run = state.run;
    const seen = run.results.length;
    const ok = run.results.filter((r) => r.reportedOk).length;
    const skipped = run.results.filter((r) => r.skipped).length;
    const fail = seen - ok - skipped;
    const pending = run.total - seen;
    const pct = run.total ? Math.round(seen / run.total * 100) : 0;
    const hd = el('div', {class: 'wrhd'});
    const cir = el('div', {class: 'cir run'});
    cir.append(el('span', {class: 'spin'}));
    hd.append(cir);
    hd.append(el('div', {class: 'tt'},
      el('div', {class: 't1', text: t('runningTitle')}),
      el('div', {class: 't2', text: t('runningSubtitle', {n: run.total})})));
    const stat = (val, label, cls) => el('div', {class: 'wrstat'},
      el('div', {class: `n ${cls}`, text: String(val)}),
      el('div', {class: 'l', text: label}));
    const stats = el('div', {class: 'wrstats'},
      stat(ok, t('submitOk'), 'g'),
      stat(fail, t('submitFail'), 'r'),
      stat(pending, t('submitting'), 'b'));
    if (skipped) stats.append(stat(skipped, t('notSubmitted'), 'am'));
    hd.append(stats);
    shell.append(hd);
    shell.append(el('div', {class: 'wprog', style: 'padding-top:12px'},
      el('div', {class: 'bar'}, el('div', {style: `width:${pct}%`}))));
    shell.append(el('div', {class: 'wcolh'},
      el('div', {class: 'cw-flex', text: t('colOffer')}),
      el('div', {class: 'cw-rchips', text: t('colCardResult')})));
    const scroll = el('div', {class: 'wscroll'});
    for (const offerTasks of groupTasksByOffer(run.tasks)) {
      scroll.append(renderWideRunningRow(offerTasks));
    }
    shell.append(scroll);
    shell.append(el('div', {class: 'wfoot'},
      el('div', {class: 'txt'},
        el('b', {text: t('runningNoteLead')}), t('runningNote'))));
  }

  /**
   * One wide running row: an offer with a live chip per card that shows a
   * spinner while pending, then flips to ✓ / ✗ / ⊘ as each settles (the same
   * onSettle-driven data source as the sidebar running view).
   * @param {!Array<!Task>} offerTasks Tasks for one offer.
   * @return {!Element} The row.
   */
  function renderWideRunningRow(offerTasks) {
    const run = state.run;
    const first = offerTasks[0];
    const grp = state.offers.find((o) => o.key === first.key);
    const chips = el('div', {class: 'wchips cw-rchips'});
    for (const task of offerTasks) {
      const done = run.results.find(
        (r) => r.key === task.key && r.token === task.token);
      if (!done) {
        const chip = el('span', {class: 'wchip'});
        chip.append(wideSwatch(task.token),
          document.createTextNode(wideDigits(task.token)),
          el('span', {class: 'spin'}));
        chips.append(chip);
      } else if (done.skipped) {
        chips.append(wideChip({token: task.token, tone: 'amber', suffix: '⊘'}));
      } else if (done.reportedOk) {
        chips.append(wideChip({token: task.token, tone: 'green', suffix: '✓'}));
      } else {
        chips.append(wideChip({token: task.token, tone: 'red', suffix: '✗'}));
      }
    }
    return el('div', {class: 'wrow'},
      wideMnCell(first.name, '', grp ? grp.image : '',
        t('nCards', {n: offerTasks.length})), chips);
  }

  /** @param {!Element} shell Panel content root (12a). */
  function renderWideBenefits(shell) {
    shell.append(renderHeader(benefitsHeaderOpts({
      refresh: true, onRefresh: () => loadBenefits(true)})));
    const top = el('div', {class: 'wtop'});
    const search = el('input', {type: 'search', value: state.benefitQuery,
      placeholder: t('searchBenefits')});
    search.oninput = (e) => {
      state.benefitQuery = e.target.value;
      fillWideBenefitRows(shell);
    };
    const box = el('div', {class: 'wsearch'},
      el('span', {class: 'wsi', text: '⌕'}), search);
    const s = benefitStats(state.benefits, state.cards, Date.now(),
      state.benefitCardFilter);
    const tile = (cls, val, label) => el('div', {class: 'wbtile'},
      el('div', {class: `n ${cls}`, text: val}),
      el('div', {class: 'l', text: label}));
    const tiles = el('div', {class: 'wbstats'},
      tile('navy', fmtMoney(s.thisMonthUnused), t('leftThisMonth')),
      tile('green', fmtMoney(s.redeemedYtd), t('redeemedYtd')));
    if (s.annualFee > 0) {
      tiles.append(tile('navy', `${s.paybackPct}%`, t('feePayback')));
    }
    top.append(el('div', {class: 'wctlrow'}, box, tiles));
    const chips = renderBenefitCardChips();
    if (chips) top.append(chips);
    shell.append(top);
    shell.append(el('div', {class: 'wscroll', id: 'wscroll'}));
    fillWideBenefitRows(shell);
  }

  /** @param {!Element} shell Panel content root. */
  function fillWideBenefitRows(shell) {
    const scroll = shell.querySelector('#wscroll');
    if (!scroll) return;
    scroll.textContent = '';
    const q = state.benefitQuery.trim().toLowerCase();
    const cf = state.benefitCardFilter;
    const single = cf !== 'all';
    let groups = state.benefits.filter((g) => matchesBenefitQuery(g, q));
    if (single) {
      const now = Date.now();
      groups = groups
        .filter((g) => g.entries.some((e) => e.token === cf))
        .map((g) => finalizeBenefitGroup(
          {...g, entries: g.entries.filter((e) => e.token === cf)}, now));
    }
    const sections = buildBenefitPeriodGroups(groups);
    sections.forEach((pg, i) => {
      scroll.append(renderWideBenefitHeader(pg, i === 0));
      for (const g of pg.groups) scroll.append(renderWideBenefitRow(g));
    });
    if (!sections.length) {
      scroll.append(el('div', {class: 'msg', style: 'padding:32px'},
        el('div', {class: 'note',
          text: q ? t('noBenefitsMatch', {q: state.benefitQuery.trim()}) :
            t('noBenefits')})));
    }
    const untrack = state.benefitsUntrackable.filter((u) =>
      (!single || u.token === cf) &&
      (!q || u.name.toLowerCase().includes(q)));
    if (untrack.length) scroll.append(renderBenefitUntrackable(untrack));
  }

  /**
   * @param {!Object} pg A period section from {@link buildBenefitPeriodGroups}.
   * @param {boolean} first Whether it is the first section (tighter top gap).
   * @return {!Element} The wide period group header.
   */
  function renderWideBenefitHeader(pg, first) {
    const left = el('div', {class: 'wbgh-l'},
      el('span', {class: 'wbgh-lbl', text: t(`periodEvery_${pg.period}`)}));
    if (Number.isFinite(pg.daysLeft)) {
      const amber = benefitPeriodTone(pg.period, pg.daysLeft) === 'amber';
      left.append(el('span', {class: amber ? 'wbgh-badge amber' : 'wbgh-badge',
        text: daysLabel(pg.daysLeft)}));
    }
    const sumKey = pg.activation ? 'benefitPendingActivate' : 'benefitPending';
    return el('div', {class: first ? 'wbgh first' : 'wbgh'}, left,
      el('div', {class: 'wbgh-sum',
        text: t(sumKey, {n: pg.count, amt: fmtMoney(pg.amount)})}));
  }

  /**
   * One wide benefit row (12a): name (full width) | status (amount + word +
   * optional micro-bar) | per-card chips (✓ = that card fully used, $x =
   * partial, gray = unused). Same three-state language as the sidebar (G3),
   * driven by the same finalized group.
   * @param {!Object} group A finalized benefit group.
   * @return {!Element} The row.
   */
  function renderWideBenefitRow(group) {
    if (isInactiveBenefit(group)) {
      const chips = el('div', {class: 'wchips cw-bchips'});
      for (const e of group.entries) {
        chips.append(wideChip({token: e.token, tone: 'gray'}));
      }
      chips.append(el('div', {class: 'bactivate', text: t('activate'),
        onclick: () => window.open(
          'https://global.americanexpress.com/card-benefits/view-all',
          '_blank')}));
      return el('div', {class: 'wrow wbenefit'},
        el('div', {class: 'wbmain'},
          el('div', {class: 'wb-name', text: group.name}),
          el('div', {class: 'wb-stat cw-bstat'},
            el('span', {class: 'wb-inact', text: t('notActivated')})),
          chips));
    }

    const done = group.fullyUsed;
    const pct = group.target > 0 ?
      Math.min(100, Math.round(group.spent / group.target * 100)) : 0;
    const partial = !done && group.spent > 0 && group.target > 0;

    const amt = el('div', {class: done ? 'wb-amt done' : 'wb-amt'});
    amt.append(`${done ? '✓ ' : ''}${fmtMoney(group.spent, group.symbol)} `);
    amt.append(el('span', {class: 'of',
      text: `/ ${fmtMoney(group.target, group.symbol)}`}));
    let word = t('notUsed');
    let wordCls = 'wb-word';
    if (done) {
      word = t('usedUp');
      wordCls = 'wb-word used';
    } else if (partial) {
      word = t('usedPct', {n: pct});
      wordCls = 'wb-word used';
    }

    const chips = el('div', {class: 'wchips cw-bchips'});
    for (const e of group.entries) {
      const eDone = e.target > 0 && e.spent >= e.target;
      let tone = 'gray';
      let suffix = '';
      if (eDone) {
        tone = 'green';
        suffix = '✓';
      } else if (e.spent > 0) {
        tone = 'green';
        suffix = fmtMoney(e.spent, e.symbol);
      }
      chips.append(wideChip({token: e.token, tone, suffix}));
    }

    const main = el('div', {class: 'wbmain'},
      el('div', {class: 'wb-name', text: group.name}),
      el('div', {class: 'wb-stat cw-bstat'}, amt,
        el('span', {class: wordCls, text: word})),
      chips);
    const row = el('div',
      {class: done ? 'wrow wbenefit done' : 'wrow wbenefit'}, main);
    if (partial) {
      row.append(el('div', {class: 'wbmicro'},
        el('div', {style: `width:${pct}%`})));
    }
    return row;
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
      if (opts.skip && opts.skip()) return;
      if (opts.only && !e.target.closest(opts.only)) return;
      if (opts.ignore && e.target.closest(opts.ignore)) return;
      const rect = host.getBoundingClientRect();
      // The wide overlay centers via translate(-50%,-50%); freeze the current
      // visual spot as plain left/top before dragging so the math below (which
      // writes untransformed left/top) doesn't make the panel jump.
      if (host.style.transform && host.style.transform !== 'none') {
        host.style.left = `${rect.left}px`;
        host.style.top = `${rect.top}px`;
        host.style.right = 'auto';
        host.style.bottom = 'auto';
        host.style.transform = 'none';
      }
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
          const storeKey = typeof opts.storeKey === 'function' ?
            opts.storeKey() : opts.storeKey;
          if (storeKey) {
            savePosition(storeKey,
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

  /** @return {string} Which launcher appearance the current state calls for. */
  function launcherState() {
    if (state.run && state.view === 'running') return 'running';
    if (state.view === 'result' && state.lastResults.size) {
      const results = [...state.lastResults.values()];
      return results.every((r) => r.state === ResultState.VERIFIED) ?
        'allok' : 'done';
    }
    return 'default';
  }

  /**
   * Rebuilds the collapsed launcher pill to reflect a background run: a spinner
   * with X/Y while submitting; a ✓ with the confirmed · failed · other tally
   * once done (click it to open the report); otherwise the plain brand pill,
   * with a small green dot when everything landed cleanly.
   */
  function renderLauncherContent() {
    if (!launcherButton) return;
    const pill = launcherButton.shadowRoot.querySelector('.l');
    if (!pill) return;
    pill.classList.remove('prog');
    pill.textContent = '';
    const brand = () => {
      const i = el('div', {class: 'i'});
      i.innerHTML = BRAND_ICON_SM;
      return i;
    };
    const st = launcherState();
    if (st === 'running') {
      pill.classList.add('prog');
      pill.append(el('div', {class: 'lspin'}),
        el('div', {},
          el('div', {class: 't', text: t('launcherRunning')}),
          el('div', {class: 'lsub blue',
            text: `${state.run.results.length} / ${state.run.total}`})));
    } else if (st === 'done') {
      pill.classList.add('prog');
      const results = [...state.lastResults.values()];
      const c = (s) => results.filter((r) => r.state === s).length;
      const other = c(ResultState.GHOST) + c(ResultState.UNVERIFIED) +
          c(ResultState.SKIPPED);
      pill.append(el('div', {class: 'lok', text: '✓'}),
        el('div', {},
          el('div', {class: 't', text: t('launcherDone')}),
          el('div', {class: 'lsub'},
            el('span', {class: 'g', text: String(c(ResultState.VERIFIED))}),
            el('span', {class: 'sep', text: ' · '}),
            el('span', {class: 'r', text: String(c(ResultState.FAILED))}),
            el('span', {class: 'sep', text: ' · '}),
            el('span', {class: 'am', text: String(other)}))));
    } else {
      pill.append(brand(),
        el('div', {}, el('div', {class: 't', text: t('launcherTitle')})));
      if (st === 'allok') pill.append(el('span', {class: 'ldot'}));
    }
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
      renderLauncherContent();
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
    // Both densities drag by the header; each remembers its own spot so the
    // wide overlay's placement never fights the sidebar's.
    makeDraggable(host, root, {only: '.hrow',
      ignore: 'button, .rf, .cl, .densbtn',
      storeKey: () => currentDensity() === 'wide' ? 'panelWide' : 'panel'});
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
    // Only in the sidebar — the wide overlay owns its (centered) geometry via
    // applyDensityGeometry and must not be nudged to a saved sidebar spot.
    if (firstCreate && currentDensity() !== 'wide') {
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
      .l { position:relative; display:flex; align-items:center; gap:9px;
        background:#fff; border:1px solid #E9EAEE; border-right:none;
        border-radius:12px 0 0 12px; corner-shape:superellipse(1.6);
        padding:11px 18px 11px 13px;
        box-shadow:0 8px 24px -8px rgba(0,23,90,.25); cursor:pointer;
        font:13px 'Public Sans','PingFang SC','Microsoft YaHei',system-ui,sans-serif;
        user-select:none;
        transition:box-shadow .15s ease, opacity .14s ease, transform .14s ease }
      .l:hover { box-shadow:0 10px 28px -8px rgba(0,23,90,.32) }
      .l.closed { opacity:0; transform:scale(.85) translateX(10px);
        pointer-events:none }
      /* Once dragged off the edge it becomes a normal free-floating pill. */
      .l.float { border-right:1px solid #E9EAEE; border-radius:12px;
        corner-shape:superellipse(1.6) }
      .i { width:24px; height:24px; flex-shrink:0 }
      .t { font-weight:800; color:#0B1F4E; letter-spacing:-.1px;
        line-height:1.1; font-size:13px }
      /* Running / done states run a two-line block, so shrink the title a touch. */
      .l.prog .t { font-size:12px }
      .lspin { width:18px; height:18px; border-radius:50%;
        border:2.5px solid #D9E8F8; border-top-color:#006FCF;
        animation:lspin .9s linear infinite; flex-shrink:0 }
      @keyframes lspin { to { transform:rotate(360deg) } }
      .lok { width:18px; height:18px; border-radius:50%; background:#EAF3EC;
        color:#0B7A3E; font-size:11px; font-weight:800; display:flex;
        align-items:center; justify-content:center; flex-shrink:0 }
      .lsub { font-size:10px; font-weight:700; margin-top:2px; line-height:1;
        font-variant-numeric:tabular-nums }
      .lsub.blue { color:#006FCF }
      .lsub .g { color:#0B7A3E } .lsub .r { color:#C8102E }
      .lsub .am { color:#9A6A00 } .lsub .sep { color:#C9CCD0 }
      .ldot { position:absolute; top:7px; right:9px; width:8px; height:8px;
        border-radius:50%; background:#0B7A3E; box-shadow:0 0 0 2px #fff }
    `}));
    const pill = el('div', {class: 'l'});
    root.append(pill);
    document.body.appendChild(host);
    launcherButton = host;
    renderLauncherContent();
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
  initDensity();
  installLauncher();
})();
