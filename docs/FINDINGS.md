# Amex Offers 内部 API 参考

> 本文件记录 Amex offers 页面所用的**内部（未公开）API**——通过在浏览器 DevTools 里观察
> Amex 公开网页发出的请求整理，并在真实登录会话中实测确认。这些接口属于 Amex，任何人打开
> 开发者工具都能观察到。本项目的实现从零编写、MIT、纯本地、零上报。

---

## 0. 一句话原理

登录 amex 后，网页 SPA 用浏览器会话（cookie）直接调 Amex 的内部接口来读/加 offer。
本工具做同样的事：在 `global.americanexpress.com` 页面上下文里用 `fetch(..., {credentials:'include'})`，
**逐张卡（按 `account_token`）直接调 enroll 接口**，完全绕开网页 UI。
「多卡」= 遍历每张卡的 `account_token` 各调一次，不是 multi-tab trick。

---

## 1. 鉴权模型（重要，且已逐层确认）

- 全部走**真 `fetch`**，`credentials: 'include'` → 浏览器自动带上已登录的 Amex cookie。
- 请求头**只有** `Content-Type: application/json` 和 `Accept: application/json`（加调用方可选头）。
- **没有 CSRF token、没有 Authorization bearer、没有 x-* 自定义头。** 等价的请求形态如下：

  ```js
  async function request(method, url, { credentials='include', headers={}, body }) {
    const cfg = {
      method: method.toUpperCase(),
      credentials,                                  // 默认 'include'
      headers: { 'Content-Type':'application/json', 'Accept':'application/json', ...headers },
    };
    return await fetch(url, { ...cfg, body /*, signal */ });   // 普通 fetch 即可
  }
  ```

- 跨子域说明：页面在 `global.americanexpress.com`，offer 接口在 `functions.americanexpress.com`。
  这是**跨子域**请求，靠 Amex 自己配好的 CORS + cookie 的 SameSite 设置成立（SPA 也这么做）。
- 因此我们的脚本 **不需要** `@grant GM.xmlHttpRequest`、不需要任何 `@connect`、不需要 hook fetch。
  → `@grant none` 即可，脚本在技术上没有能力联系任何第三方（这是我们的隐私底线）。
- 注意：**不要手动设置 `Origin` 头**——它是浏览器保留头，页面 fetch 跨域时自动带，手动写会被忽略/拒绝。
- 本工具**不做任何上报、门禁、IP 采集、cookie 读取**——只用页面已登录会话调 Amex 同源/跨子域接口。

---

## 2. 接口链（4 个，均可在 DevTools Network 观察到）

### ① 取所有卡（账户列表）
```
GET https://global.americanexpress.com/api/servicing/v1/member
credentials: 'include'
→ { accounts: [ {
      account_token: "<string>",          // 「哪张卡」的唯一标识，后续都用它
      // product.small_card_art, profile.embossed_name 等用于展示
      supplementary_accounts?: [ { account: { supplementary_index, account_token, ... } } ]
    }, ... ] }
```
- 遍历 `accounts[]`；如需覆盖附属卡，再遍历每个 `supplementary_accounts[].account`。

### ② 读某张卡的可用 offer（eligible）
```
POST https://functions.americanexpress.com/ReadOffersHubPresentation.web.v1
credentials: 'include', headers: {Content-Type, Accept}
body: {
  accountNumberProxy: "<account_token>",
  locale: "en-US",
  requestType: "OFFERSHUB_LANDING",
  offerPage: "page1"                 // page1..page20; 逐页读取
}
→ 取 response.recommendedOffers.offersList.pageN  (数组)
   每个元素含: { offerId, offerType, terms{details}, longDescription, ... }
```
- 客户端再按 `offer.offerType === "MERCHANT"` 过滤（config 里 `offerTypeFilter: "MERCHANT"`）。
- eligible 的 `paginate = true`，`maxPages = 20`：从 `page1` 开始逐页读，body 带
  `offerPage:"pageN"`；某页不存在或返回空数组时停止。
- enrolled 的 `paginate = false`，只读 `page1`，body 不带 `offerPage`。

### ③ 给某张卡加一个 offer（enroll, v2）
```
POST https://functions.americanexpress.com/CreateOffersHubEnrollment.web.v1
credentials: 'include', headers: {Content-Type, Accept}
body: {
  accountNumberProxy: "<account_token>",
  offerId: "<该卡自己的原始 offerId，不透明 token；不是 pznAnalyticsId>",
  locale: "en-US",
  enrollmentTrigger: "OFFERSHUB_TILE",
  requestType: "OFFERSHUB_ENROLLMENT",
  synchronizeOnly: false,
  offerUnencrypted: false
}
→ 成功判定: String(response.status.purpose).toUpperCase() === "SUCCESS"
   失败信息路径: response.status.message
```
- enroll body 结构（等价构造）：
  ```js
  function buildEnrollBody({ accountToken, offerId, locale='en-US' }) {
    return {
      accountNumberProxy: accountToken,
      locale,
      enrollmentTrigger: 'OFFERSHUB_TILE',
      offerUnencrypted: false,
      requestType: 'OFFERSHUB_ENROLLMENT',
      synchronizeOnly: false,
      offerId,                              // v2 的 offerIdField 是 'offerId'
    };
  }
  ```
- **legacy 备用端点**（v2 失败时的兜底，可选实现）：
  ```
  POST https://functions.americanexpress.com/CreateCardAccountOfferEnrollment.v1
  body: { accountNumberProxy, locale, identifier: "<enrollIdentifier>",
          requestDateTimeWithOffset: "<带偏移的时间戳>", userOffset: "-06:00" }
  → 成功判定: response.isEnrolled 为真
     失败信息路径: response.explanationMessage 或 response.message
  ```
- **identifier 到底填什么（⚠️ 已由真实会话实测更正，2026-07-06）**：body 的 `offerId` 必须是
  **每张卡各自的原始 `offerId`**——它是一串不透明 token（如 `"ZJEu]7FbB="`），**同一个 offer 在不同卡上各不相同**。
  - `pznAnalyticsId`（如 `"1000257277"`）是**跨卡共享的稳定分析 id**，只用于「把同一 offer 在多张卡上归组去重」显示，**不能拿来 enroll**。
  - 实测：用某卡的原始 `offerId` enroll → `status.purpose = SUCCESS`；用 `pznAnalyticsId` → 失败。
  - 正确做法：**分组/去重的 key = `pznAnalyticsId || offerId`；enroll 和校验用的值 = 该卡自己的原始 `offerId`。** 两者必须分开，不能混用同一个 identifier。
  - 这一点以真实会话实测为准；多卡添加时务必保留每张卡自己的 `offerId`，不要用共享的 `pznAnalyticsId`。

### ④ 校验已加（enrolled）—— 关键，不可省
```
POST https://functions.americanexpress.com/ReadOffersHubPresentation.web.v1
body: { accountNumberProxy: "<account_token>", locale: "en-US", requestType: "ADDEDTOCARD_LANDING" }
→ 取 response.addedToCardViewAll.offersList.page1  (数组)
   看目标 offerId 是否在其中 → true 才算真正加上
```
- （另有 redeemed：`requestType: "SAVINGS_LANDING"`，listPath `offersSavingsViewAll.savingsOffers.offersList`，本工具用不到。）

---

## 3. 读取 / body 构造（实现参考）

```js
// getPath("a.b.c", obj) → obj.a.b.c（安全取值）
function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

// body 构造：eligible 传 page1..page20；enrolled 不传 page
function buildReadBody(accountToken, requestType, locale='en-US', page /*可选*/) {
  const body = { accountNumberProxy: accountToken, locale, requestType };
  if (page) body.offerPage = page;
  return body;
}
```

---

## 4. 已证实 vs. 需实测确认

**已确认（DevTools 观察 + 真实会话实测，高置信度）：**
- 上述 4 个端点、method、body 字段名与取值、成功判定、多卡靠遍历 `account_token`。
- 鉴权仅 cookie + Content-Type/Accept，无额外 token；普通 fetch。
- **eligible `paginate=true`**（`maxPages=20`，逐页 `offerPage:"pageN"`，空页停）；
  **enrolled `paginate=false`**（仅 `page1`）。
  ——DevTools 里可见：offer 多时 eligible 会继续请求 `page2`/`page3`…，enrolled 只回 `page1`。
- **enroll 用每卡自己的原始 `offerId`（不透明 token）；`pznAnalyticsId` 只用于跨卡分组去重**（见 §③；实测：用 offerId enroll 返回 SUCCESS）。

**已由真实会话验证（2026-07-06）：**
- 读（member / eligible 分页 / enrolled）在真实登录态下工作正常（面板正确列出 143 offer / 8 卡）。
- enroll 用**该卡原始 `offerId`** → `status.purpose = SUCCESS`；用 `pznAnalyticsId` → 失败。

**仍需实测确认：**
1. Amex 是否又改了接口/字段（随时可能变）。
2. 服务端「按人去重」时「假成功（ghost）」的返回长什么样，以及同一 offer 到底能加到几张卡（正是 ④ 步 + 三态报告存在的意义）。

**2 分钟自证步骤（DevTools）：**
1. 登录 Amex dashboard → F12 → Network。
2. 手动点一次任意 offer 的「Add to Card」，找到发往 `CreateOffersHubEnrollment.web.v1`（或 legacy）的请求。
3. 核对 Request Payload 是否为上文结构；核对 Request Headers 除 cookie 外有无多余的 `x-*`/token。
4. 右键该请求 → Copy as fetch → 粘到 Console 跑一次：能复现成功即证明「cookie 就够」。
   若去掉某个头就失败，说明该头是必需的 → 把它补进实现即可。

---

## 5. 端点速查表

| 用途 | Method | URL | 关键 body / 判定 |
|---|---|---|---|
| 卡列表 | GET | `global.americanexpress.com/api/servicing/v1/member` | → `accounts[].account_token` |
| 读可用 | POST | `functions.americanexpress.com/ReadOffersHubPresentation.web.v1` | `requestType:"OFFERSHUB_LANDING"` + `offerPage:"pageN"` → `recommendedOffers.offersList.pageN[]` |
| 读已加 | POST | 同上 | `requestType:"ADDEDTOCARD_LANDING"` → `addedToCardViewAll.offersList.page1[]` |
| 加 offer(v2) | POST | `functions.americanexpress.com/CreateOffersHubEnrollment.web.v1` | 见 ③；成功 `status.purpose==="SUCCESS"` |
| 加 offer(legacy) | POST | `functions.americanexpress.com/CreateCardAccountOfferEnrollment.v1` | 见 ③；成功 `isEnrolled` 为真 |

所有请求：`credentials:'include'`，headers `{Content-Type, Accept}: application/json`，无额外鉴权头。
