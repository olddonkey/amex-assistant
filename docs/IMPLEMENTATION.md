# IMPLEMENTATION — 交给编码 agent（Codex）的执行计划

> 面向执行者（Codex 等 agent）。先读 [FINDINGS.md](./FINDINGS.md)（API 依据）和 [PLAN.md](./PLAN.md)（设计 + 里程碑 + 参考骨架），本文件定义**按什么顺序做、每步产出什么、怎么离线验收、哪些必须停下来交给用户**。
>
> 交接方式：**一个里程碑一个 PR**（M1→M4）。M0 是**用户 gate**，不是 agent 任务。每个 PR 合并前必须满足对应「Definition of Done（DoD）」。

---

## 0. 红线约束（不可协商，违反即打回）

- `@grant none`；**不加任何 `@connect`**；不用 `GM.*`。
- **零上报**：不发任何第三方请求，不采集 IP，不读 cookie，不做用户门禁/信任校验。只同源/跨子域打 `americanexpress.com`。
- **不自动改账户**：脚本加载时只放一个启动按钮；拉快照要用户点开面板；enroll 只在用户点「加入所选」时发生。
- **单文件** `src/amex-assistant.user.js`，原生 DOM + Shadow DOM，不引框架、无打包步骤。
- **同一 offer 的多卡必须并发**（`Promise.all`）——串行只会让第一张成功；**不同 offer 之间**用随机延迟 1.5–4s 隔开。
- 按 FINDINGS 的规格**从零实现**（不引入任何第三方代码）。
- 许可 MIT。

---

## 1. 能力边界：Codex 能验的 vs 必须交给用户

**Codex 拿不到用户的 Amex 登录态**，接口是通过观察 Amex 网页整理的、尚未在真实会话逐一验证。因此：

| 能离线做 + 能自测（Codex 负责） | 必须用户的登录态（USER GATE，Codex 停在此） |
|---|---|
| 全部代码结构、常量集中 | **M0**：DevTools 确认端点/body/字段未变、cookie 即足够 |
| 纯函数：`offerGroupKey` / `getPath` / `buildOfferIndex` / `flattenAccounts` | 首次真实 enroll 冒烟（选 1 个 offer 加到 1 张卡并校验出现） |
| `executeSelected` 的并发与四态分类逻辑（用 mock fetch） | `snapshot()` 对真实账户跑通、聚合数量核对 |
| Shadow DOM 面板渲染、勾选/展开/搜索交互 | 真实分页边界、真实「假成功」返回形态 |
| `node --check`、fixture 单测、`git diff --check` | |

**硬规则**：Codex **不得**声称做过任何「线上验证」。凡依赖线上行为的验收点，PR 描述里必须显式标 `USER GATE: 待用户验证`，并保证该路径默认不会自动触发。

---

## 2. 工程约定

- 目录：
  ```
  src/amex-assistant.user.js        # 唯一交付物
  test/fixtures/*.json           # 假 API 响应
  test/mock-fetch.js             # 按 URL+requestType 返回 fixture
  test/*.test.mjs                # node 原生跑的单测（无需 Amex）
  docs/                          # FINDINGS / PLAN / IMPLEMENTATION
  LICENSE  DISCLAIMER.md  README.md
  ```
- 无构建：userscript 直接可装。核心纯函数从 IIFE 里 `export` 到一个可被测试 import 的形态（例如同时挂到 `globalThis`/`window.AmexAssistant` 便于 Node 测试注入），但**运行时行为不变**。
- 测试用 Node 原生（`node --test` 或极简断言），mock `fetch`/最小 DOM；不引重型测试框架。
- 分支：`feat/m1-...`、`feat/m2-...`…，**一里程碑一 PR**，base 为 `main`（前一里程碑合并后再开下一 PR，避免堆叠）。
- 每个 PR 必须：`node --check src/amex-assistant.user.js` 通过、`test/` 通过、`git diff --check` 干净；PR 描述列出该里程碑 DoD 勾选项 + 明确标注哪些是 `USER GATE` 未验证。
- 提交信息尾部加 `Co-Authored-By:`（Codex 用自己的署名）。

---

## 3. 任务分解（里程碑 → PR）

### M0（USER GATE，非 Codex 任务）
用户按 FINDINGS §4「2 分钟自证步骤」在 DevTools 确认端点/body/字段未变、cookie 即足够。**未过 M0 之前，M3 的真实 enroll 不允许启用**（M1/M2 及 M3 的分类逻辑可先用 mock fetch 离线开发）。

### PR-M1 — 网络层 + 快照 + 聚合（纯逻辑，不含 UI，不真改账户）
- 文件：`src/amex-assistant.user.js`（header + 常量 + 网络层 + `snapshot` + `buildOfferIndex`）、`test/fixtures/*`、`test/mock-fetch.js`、`test/offer-index.test.mjs`、`LICENSE`、`DISCLAIMER.md`。
- 实现：`get/post/readHub/fetchAccounts/flattenAccounts/fetchEligibleOffers(分页)/fetchEnrolledKeys/enrollOffer/offerGroupKey/snapshot/buildOfferIndex`（对齐 `src/` 与 FINDINGS）。
- **DoD**：
  - `buildOfferIndex` 用 fixture（跨卡同 offer、pznAnalyticsId 与仅 offerId 两种、含已加）产出正确去重，且每张卡保留自己的 `offerId`——单测通过。
  - `fetchEligible` 分页在 mock 下能跨页拼接、空页停止——单测通过。
  - `node --check` 通过；脚本加载不发起任何账户变更请求。
  - `USER GATE`：用户登录后在 Console 跑 `AmexAssistant.snapshot()` 核对聚合数量（PR 里标注，不阻塞合并）。

### PR-M2 — Shadow DOM 面板渲染（只读）
- 文件：`src/amex-assistant.user.js`（面板 + 启动按钮 + `renderList`）、`test/panel.test.mjs`（可选，用最小 DOM 或 jsdom）。
- 实现：启动按钮 → `openPanel` → 用 M1 聚合结果渲染 offer 列表（名称、可加X/已加Y 徽标、勾选框、展开逐卡）、卡范围过滤、搜索。「加入所选」此阶段只**打印**选中的 offer×卡对，不真正 enroll。
- **DoD**：
  - 给定注入的 `STATE`（来自 fixture），面板正确渲染去重 offer 与逐卡分布；勾选/展开/搜索/过滤交互正常（离线可测或截图说明）。
  - 已加卡的复选框禁用；勾 offer 默认选中其所有「可加且未加」的卡。
  - `node --check` 通过；无真实 enroll 发生。

### PR-M3 — 执行选中 + 校验 + 三态
- 文件：`src/amex-assistant.user.js`（`executeSelected` + `onGo` 接线 + 进度/结果）、`test/execute.test.mjs`。
- 实现：把选中 offer×卡展开成任务；**同一 offer 的卡并发**、offer 间随机延迟 enroll（跳过已加）；结束后对涉及卡重拉已加列表，用**分组 key** 分类 `verified / failed / ghost / unverified`；面板进度与四态计数。
- **DoD**：
  - 用 mock fetch：`executeSelected(sel)` 四态分类正确（命中→verified；enroll 非 SUCCESS→failed；SUCCESS 但列表无→ghost；校验读取失败→unverified）——单测通过。
  - 同一 offer 并发、offer 间延迟；单个失败不中断。
  - `node --check` 通过。
  - `USER GATE`：**用户过 M0 后**，选 1 个 offer 加到 1 张卡冒烟，确认校验为 verified（PR 里标注为发布前必做）。

### PR-M4（可选）— 打磨
- CSV 导出、失败项一键重试、「只看多卡可加」过滤、延迟可调、样式细化。按需取舍。

---

## 4. 无 Amex 的测试策略

- `test/fixtures/`：`member.json`（多卡，含 supplementary）、`eligible-page1.json`/`eligible-page2.json`/`eligible-empty.json`、`enrolled.json`、`enroll-success.json`、`enroll-fail.json`。
- `test/mock-fetch.js`：按 `url` + body 里的 `requestType`/`offerPage` 分发返回对应 fixture；`enroll` 端点按传入 identifier 返回 success/fail。
- 覆盖：`buildOfferIndex` 聚合、`fetchEligibleOffers` 分页、`executeSelected` 的并发/四态分类、`flattenAccounts` 供应卡展平。
- 每个 PR 附 `node --check` 与测试运行结果。

---

## 5. 用户 gate 清单（用户执行，agent 不代劳）

1. **M0**（M3 真实启用前必过）：DevTools 确认端点/body/字段、Copy-as-fetch 复现一次成功 enroll。
2. **PR-M1 合并后**：登录跑 `AmexAssistant.snapshot()`，核对卡数与聚合 offer 数合理。
3. **PR-M3 发布前**：选 1 offer 加到 1 卡冒烟，确认 3 步后校验为 verified。

---

## 6. 整体完成定义

M1–M3 全部合并；用户已过 M0 与首次真实 enroll 冒烟；面板能在用户账户上按 PLAN §5 的验收标准工作（选 offer→选卡→加→结果校验）。M4 视需要。

---

## 7. v0.11.0 — 提高成功率与限流保护

- **瞬时失败快速重试**：enroll 遇网络错误 / 5xx 时快速重发（300–600ms，至多 2 次）。服务端明确拒绝（2xx 业务失败）与 429/401/403/非 JSON 拦截**不**重发。同一 offer 的多卡仍完全同时齐发；重试之所以快，是为了留在"首卡成功后其余卡仍可加"的时间窗内。
- **全局熔断**：任一请求返回 429/401/403 或非 JSON 响应（疑似拦截 / 登录失效）→ 立即中止剩余 offer 组（结果标 `skipped`），跳过复查，也不自动刷新快照，避免把软限流推成账户级风控；面板提示等几分钟后用「重试未完成项」。
- **复查更准**：enroll 全部结束后先等 ~2.5s 再读已加列表（只读有 SUCCESS 的卡）；读取失败快速重试一次；「SUCCESS 但列表未见」的卡再等一轮做第二次复查，两次读取取并集——把服务端传播延迟造成的假 ghost 洗掉，只留真去重。
- **可观测**：结果对象与 CSV 导出新增 `http_status` 原始状态码（配合原始 message），用于事后区分失败类型（瞬时错误 / 业务拒绝 / 限流）。
- 新终态 `skipped`（未提交）贯穿分类、面板计数、结果分区与重试按钮；`executeSelected` 新增可注入的 `retryDelay` / `settleDelay`（测试注入 no-op 保持秒级跑完）。
- **重试更聪明**（`planRetry`，纯函数可测）：「重试未完成项」重发前先对照当前快照——每卡 `offerId` 按分组 key 重新解析（旧 token 可能已轮换）；快照显示已在卡上的直接改判 `verified`（假失败实为成功，不重发）；已不在该卡 offer 列表的标注"窗口已关"并停止再次重试。重试结果**合并**进上一轮报告（普通 run 仍从头开始），已核实的条目不会从结果页消失。

---

## 8. v0.18.0 — 读取路径健壮性 + 快照过期防护

- **读请求瞬时重试**（`retryTransient`）：member / offers hub / benefits 的读请求遇网络错误或 5xx 快速重试一次；其余 4xx、拦截信号、非 JSON 直接抛出。enroll 不走这个 helper——它有自己的窗口敏感重试策略（见 §7）。
- **单卡失败不再拖垮整个面板**：snapshot 中某张卡重试后仍读取失败 → 该卡标 `readFailed`、offer 列表为空，其余卡照常展示，列表页顶部有提示条指出哪些卡缺失；全部读取失败（无任何 offer）则进错误页而不是误导性的"暂无 offer"。读取途中收到 429/401/403 等拦截信号仍整体中止（不往墙上继续撞）。
- **快照过期防护**（`SNAPSHOT_MAX_AGE_MS` = 10 分钟）：提交（含确认对话框后的正式 run 与重试）时若快照已老化，先并发（capped）重读涉及卡的 eligible / 已加列表，用 `resolveTasks`（从 `planRetry` 抽出的纯函数）按分组 key 换成新 `offerId`；期间发现已加上或已下架的对子不再提交。重读失败则按原 token 照发——宁可试也不阻塞。
- `refresh` 与跑完后的自动刷新记录 `snapshotAt` 时间戳；`snapshot` 新增可注入 `retryDelay`（测试注入 no-op）。mock 新增 `onReadOffers` 钩子模拟单卡读取失败 / 限流。

---

## 9. v0.19.0 — 中英双语

- **词表 + `t()`**（core 层，导出可测）：面板所有用户可见字符串收进 `MESSAGES.zh` / `MESSAGES.en`，`t(key, params)` 按当前语言取词并做 `{name}` 插值；未知 key 原样返回（可见降级）。单测强制两种语言 **key 完全对齐**、无空串——漏翻会直接挂测试。
- **不翻的边界**：结果里的诊断 message（服务端原文、`HTTP 429` 等）与 CSV 表头保持英文——它们是跨语言应稳定的数据；商家名 / 卡产品名来自 Amex 接口原文。`benefitPeriodLabel` 改为返回中性枚举（`month/quarter/half/year`），由 UI 的 `period_*` 词条本地化。
- **首次引导**：无 localStorage 记录时（key `amexAssistantLang`，`@grant none` 下用 Amex 域的页面 localStorage），打开面板先进双语的语言选择视图，按 `navigator.language` 预高亮推荐项；选择后才开始读取。老用户有存档则无感。
- **随时切换**：列表 / Benefits / 空态 / 错误页的 header 带「中/EN」圆钮（显示目标语言），点击即切换 + 持久化 + 全量重渲染；launcher 药丸文案同步更新。
- 版本 0.18.0 → 0.19.0；新增 `test/i18n.test.mjs`（53 个测试全绿）。
