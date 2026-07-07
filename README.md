<div align="center">

# Amex Assistant

**把 Amex Offer 批量加到多张卡，并顺手看清每张卡的 Benefit 进度。**<br>
**Add Amex Offers to multiple cards from one panel, and track Benefits across cards.**

<br>

[![Greasy Fork](https://img.shields.io/greasyfork/v/585884?style=flat-square&labelColor=00175A&color=006FCF&label=Greasy%20Fork)](https://greasyfork.org/en/scripts/585884-amex-assistant)
[![Installs](https://img.shields.io/greasyfork/dt/585884?style=flat-square&labelColor=00175A&color=006FCF&label=installs)](https://greasyfork.org/en/scripts/585884-amex-assistant)
[![Stars](https://img.shields.io/github/stars/olddonkey/amex-assistant?style=flat-square&labelColor=00175A&color=006FCF)](https://github.com/olddonkey/amex-assistant/stargazers)
[![License: MIT](https://img.shields.io/badge/license-MIT-006FCF?style=flat-square&labelColor=00175A)](LICENSE)
[![Telemetry: none](https://img.shields.io/badge/telemetry-none-006FCF?style=flat-square&labelColor=00175A)](#privacy)
[![@grant none](https://img.shields.io/badge/%40grant-none-006FCF?style=flat-square&labelColor=00175A)](src/amex-assistant.user.js)

[![Install on Greasy Fork](https://img.shields.io/badge/Install%20on%20Greasy%20Fork-006FCF?style=for-the-badge&labelColor=00175A&logo=tampermonkey&logoColor=white)](https://greasyfork.org/en/scripts/585884-amex-assistant)

</div>

---

## 中文

Amex 官网通常只能一张卡一张卡地点 **Add to Card**。更麻烦的是，一个 offer
加到某张卡后，其他卡上可能很快就看不到了。Amex Assistant 会先把每张卡的 Offers
读进同一个面板；你选好卡以后，它会一起提交，最后重新读取 added list，告诉你哪些卡是真的加上了。

**Benefits** tab 是只读的 statement credit 仪表盘：本月还剩多少、今年已经抵扣多少、哪些 benefit
快到期，以及每张卡分别用了多少，都可以在一个面板里看完。

### 截图

<table>
<tr valign="top">
<td width="33%"><img src="docs/panel.png" alt="Offers list"><br><sub><b>Offers</b><br>跨卡搜索、筛选、选择要添加的 offer。</sub></td>
<td width="33%"><img src="docs/running.png" alt="Running add requests"><br><sub><b>提交中</b><br>同一个 offer 的多张卡会一起提交。</sub></td>
<td width="33%"><img src="docs/result.png" alt="Verified result"><br><sub><b>结果核对</b><br>重新读取 added list，区分确认已加、失败和疑似去重。</sub></td>
</tr>
<tr valign="top">
<td width="66%" colspan="2"><img src="docs/benefits.png" alt="Benefits overview"><br><sub><b>Benefits</b><br>按到期时间看 statement credits 的剩余额度和已抵扣金额。</sub></td>
<td width="33%"><img src="docs/benefits-detail.png" alt="Benefit per-card detail"><br><sub><b>逐卡明细</b><br>展开多卡 benefit，看每张卡自己的进度。</sub></td>
</tr>
</table>

### 功能

- **一个 offer，一次选多张卡。** 勾选 offer 会默认选中所有可加的卡；展开后也可以只选部分卡。
- **同一 offer 并发提交。** Amex 可能在第一张卡加上后让其他卡失去资格，所以同一个 offer
  下的多张卡会一起提交。不同 offer 之间会稍微错开，避免太密集。
- **提交后会复查。** 面板不会只相信接口返回的 success。它会等服务端更新后重新读取每张卡的
  added list，再把结果分成确认已加、添加失败、疑似去重、无法确认和未提交。
- **失败可以重试，但不会硬闯限流。** 网络错误和 5xx 会快速重试；遇到 429、403 或疑似拦截时，
  本轮剩余请求会停止，稍后再重试未完成项。
- **Benefits 只读查看。** 第二个 tab 会汇总每张主卡的 benefit / statement credit 进度：
  本月剩余额度、今年已抵扣金额、年费抵扣比例，以及每个 benefit 的逐卡明细。
- **没有后端，也没有 telemetry。** 脚本只在 Amex 页面里运行，只用当前浏览器登录态请求
  `americanexpress.com`。`@grant none` 表示它没有 Tampermonkey 的跨站特权 API。

> 这些是 Amex 网页内部接口，不是公开 API。Amex 随时可能改字段、改 endpoint、改行为或风控策略。
> 详细风险见 [`DISCLAIMER.md`](DISCLAIMER.md)。

### 安装

1. 安装 userscript 管理器，例如 [Tampermonkey](https://www.tampermonkey.net/)
   或 [Violentmonkey](https://violentmonkey.github.io/)。
2. 推荐从 [Greasy Fork](https://greasyfork.org/en/scripts/585884-amex-assistant)
   安装；也可以直接安装
   [GitHub raw 脚本](https://raw.githubusercontent.com/olddonkey/amex-assistant/main/src/amex-assistant.user.js)。
3. 打开 `https://global.americanexpress.com/` 并登录，页面右侧会出现 **Amex 助手** 按钮。

### 使用

1. 点击 **Amex 助手**，面板会读取所有卡的 Offers。
2. 在 **Offers** tab 里搜索或筛选 offer。勾选一行会选中所有可加的卡；展开后可以只选部分卡。
3. 点击 **加到所选卡** 并确认。提交完成后，面板会自动复查每张卡。
4. **疑似去重** 的意思是：Amex 接口说添加成功，但复查 added list 时这张卡上没有看到该 offer。
   这通常是 Amex 对同一个 offer 做了按人去重，不一定是脚本 bug。
5. 切到 **Benefits** tab 可以只读查看 statement credits；这里不会执行 enroll，也不会改动账户。

<a id="privacy"></a>

### 隐私

Amex Assistant 没有服务器，不收集 IP，不上传数据，也不读取 cookie 内容。所有请求都发生在
`global.americanexpress.com` 页面上下文里，使用浏览器已经登录的 Amex session。

你可以直接检查 [`src/amex-assistant.user.js`](src/amex-assistant.user.js)：脚本头部是
`@grant none`，没有 `GM.xmlHttpRequest`、没有 `@connect`，也没有第三方 endpoint。

### 开发

这个项目没有 build step；`src/amex-assistant.user.js` 就是可安装的 userscript。
测试用本地 mock，不需要 Amex 登录态。

```sh
npm install
npm test
npm run lint
```

真实账户第一次使用前，建议按 [`docs/FINDINGS.md`](docs/FINDINGS.md) 里的 DevTools checklist
确认当前 Amex 接口还没有变化，然后先选一个 offer、一张卡做小范围 smoke test。

### 文档

| Doc | 内容 |
| --- | --- |
| [`docs/FINDINGS.md`](docs/FINDINGS.md) | 当前整理出的 Amex 内部 Offers API。 |
| [`docs/PLAN.md`](docs/PLAN.md) | 设计思路、里程碑和行为约束。 |
| [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) | 给 coding agent 的实现计划和验收点。 |

### 免责声明

本项目与 American Express 无关联。自动化操作自己的账户可能违反或处在 Amex 服务条款的灰色地带；
请自行承担风险。本工具不能保证同一个 offer 一定能加到多张卡。详见
[`DISCLAIMER.md`](DISCLAIMER.md) 和 [`LICENSE`](LICENSE)。

---

## English

Amex normally makes you click **Add to Card** one card at a time. Worse, once an
offer is added to one card, it may disappear from the rest. Amex Assistant reads
every card's Offers into one panel, submits the cards you choose together, then
re-reads the added list so you can see what actually landed.

The **Benefits** tab is a read-only statement credit dashboard. It aggregates
credits across your primary cards so you can see what is left this month, what
you have used this year, what expires soon, and how each card is doing.

### Features

- **One offer, many cards.** Select an offer once to queue every eligible card,
  or expand the row and choose specific cards.
- **Concurrent where it matters.** Cards for the same offer are submitted
  together, because Amex may make the offer unavailable on other cards once one
  card gets it. Different offers are paced apart.
- **Verified results, not just success responses.** After submitting, the panel
  waits for the server to settle and re-reads each card's added list. Results
  are grouped as confirmed, failed, suspected dedupe, unconfirmed, or skipped.
- **Retry without pushing through throttles.** Network errors and 5xx responses
  get quick retries. If the session hits 429, 403, or an interception-looking
  response, the run stops instead of hammering the account.
- **Read-only Benefits dashboard.** The second tab reads benefit / statement
  credit progress across primary cards: remaining balance, redeemed value,
  annual-fee payback, and per-card breakdowns.
- **No backend, no telemetry.** The script runs only on Amex pages and uses your
  logged-in browser session to talk to `americanexpress.com`. `@grant none`
  means it has no Tampermonkey cross-site privileged APIs.

> These are undocumented Amex web endpoints, not public APIs. Amex can change
> fields, endpoints, behavior, or throttling at any time. See
> [`DISCLAIMER.md`](DISCLAIMER.md).

### Install

1. Install a userscript manager, such as
   [Tampermonkey](https://www.tampermonkey.net/) or
   [Violentmonkey](https://violentmonkey.github.io/).
2. Install Amex Assistant from
   [Greasy Fork](https://greasyfork.org/en/scripts/585884-amex-assistant), or
   install the
   [raw GitHub userscript](https://raw.githubusercontent.com/olddonkey/amex-assistant/main/src/amex-assistant.user.js).
3. Open `https://global.americanexpress.com/`, sign in, and click the
   **Amex 助手** button on the page.

### Use

1. Open **Amex 助手**. The panel reads Offers from every card.
2. In the **Offers** tab, search or filter offers. Selecting a row queues all
   eligible cards; expanding the row lets you choose specific cards.
3. Click **加到所选卡** and confirm. The panel submits the selected cards, then
   re-reads each card to verify the result.
4. **Suspected dedupe** means Amex reported success, but the offer did not show
   up on that card after re-reading the added list. This is commonly Amex
   limiting the same offer to one card, not necessarily a tool bug.
5. Switch to **Benefits** for read-only statement credit tracking. It does not
   enroll benefits or change your account.

### Privacy

Amex Assistant has no server, no telemetry, no IP collection, and no cookie
reading. Requests happen in the `global.americanexpress.com` page context using
your already-signed-in Amex session.

You can audit [`src/amex-assistant.user.js`](src/amex-assistant.user.js)
directly: the header uses `@grant none`, with no `GM.xmlHttpRequest`, no
`@connect`, and no third-party endpoints.

### Development

There is no build step. `src/amex-assistant.user.js` is the installable
userscript. Tests use local mocks and do not need an Amex login.

```sh
npm install
npm test
npm run lint
```

Before trusting a real run, use the DevTools checklist in
[`docs/FINDINGS.md`](docs/FINDINGS.md) to confirm Amex has not changed the
internal endpoints, then do a small smoke test with one offer on one card.

### Docs

| Doc | Contents |
| --- | --- |
| [`docs/FINDINGS.md`](docs/FINDINGS.md) | Current notes on the internal Amex Offers API. |
| [`docs/PLAN.md`](docs/PLAN.md) | Design, milestones, and behavior constraints. |
| [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) | Implementation plan and validation notes for coding agents. |

### Disclaimer

This project is not affiliated with American Express. Automating your own
account may violate or sit in a gray area of the Amex Terms of Service; use it
at your own risk. The tool cannot guarantee that an offer will be added to more
than one card. See [`DISCLAIMER.md`](DISCLAIMER.md) and [`LICENSE`](LICENSE).
