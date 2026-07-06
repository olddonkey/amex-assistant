# PLAN — 个人自用版 Amex Offers 多卡批量工具

> 目标读者：实现者（人类或 Codex 等 agent）。实现前请先读 [FINDINGS.md](./FINDINGS.md)。
> 实现依据全部在 FINDINGS.md；本文件定义**做什么、怎么分步、验收标准**。

---

## 1. 目标与定位

一个 **Tampermonkey userscript**，在 Amex 网站上提供一个**注入式面板**，让用户**以 offer 为中心、选择性地把某个 offer 加到多张卡**：
1. 枚举所有卡，并快照每张卡的可用/已加 offer；
2. 按 offer 去重聚合成一张列表，每个 offer 显示「在哪几张卡可加 / 已加」；
3. 用户**勾选想加的 offer**（默认加到它所有可加的卡，可展开细选具体卡）；
4. 只对**选中的 offer×卡对**执行 enroll（同一 offer 的卡并发、offer 间随机延迟）；
5. 加完**重新拉已加列表做真实校验**，给出每张卡的结果（成功 / 失败 / 假成功 / 无法校验）。

核心价值：解决「同一 offer 想加到多张卡、但网页上加一张其它就消失」的痛点——用户挑 offer，工具把它扇出到选定的多张卡，并如实报告每张卡到底加没加上。**不是无脑全加**：加哪个 offer、加到哪几张卡，由用户在面板里决定。

## 2. 硬性原则（Non-Goals）

- ❌ **无后端、无上报、无采集 IP、无门禁、不读 cookie**。
- ✅ **代码可读、可审计**，无隐藏逻辑。
- ❌ 不做绕过登录、不碰凭证。
- ✅ `@grant none`：脚本在技术上无法联系任何第三方，只同源/跨子域打 `americanexpress.com`。
- ✅ **从零编写**；本项目 MIT。
- ✅ 合规声明：自动化操作自己账户属 Amex ToS 灰色地带，使用自负；同 offer 多卡受 Amex 服务端按人去重限制，工具只如实报告结果。

## 3. 技术选型

- **形态**：单文件 `.user.js`（先不引入 TypeScript/打包，改完刷新即生效，迭代最快）。逻辑稳定后再考虑 esbuild+TS。
- **UserScript header**：
  ```
  // @name        Amex Assistant
  // @namespace   local
  // @version     0.1.0
  // @match       https://global.americanexpress.com/*
  // @grant       none
  // @run-at      document-idle
  // ==/UserScript==
  ```
- **网络**：见 FINDINGS.md §1 —— 真 `fetch` + `credentials:'include'`，headers 仅 `{Content-Type, Accept}`，**不设 Origin**。
- **UI**：**自建注入式面板，不改 Amex 原生 tile**。原生 tile 是虚拟列表（滚动即回收、随时重渲染），往上挂 UI 会重新引入我们特意用 API 直调躲开的 DOM 脆性。面板用**原生 DOM + Shadow DOM**（样式与 Amex 页面互相隔离），挂在 `document.body` 上一个稳定挂载点，渲染的是**我们自己从 API 聚合出来的 offer 列表**，与 Amex DOM 解耦。不引入框架（逻辑变复杂再考虑 Preact）。

## 4. 行为规范（务必遵守）

1. **先快照，后聚合**：先把每张卡的可用 offer 分页全部读完 + 已加列表读完并存下；**分组 key = `pznAnalyticsId || offerId`（跨卡共享，用于去重显示）**，但每张卡要保留它自己的**原始 `offerId`**（不透明 token，enroll 用它）。见 FINDINGS §③。
2. **选择驱动，不全加**：只对用户在面板里**勾选的 offer×卡对**执行 enroll。默认勾一个 offer = 加到它所有可加卡；可展开细选具体卡。已加的卡不再重复 enroll。
3. **同一 offer 的多卡必须并发**：一个 offer 的所有目标卡用 `Promise.all` **同时发**——因为 Amex 一旦某张卡加上该 offer，其余卡就会变不可加，串行只会让第一张成功（这正是「多卡」的关键）。**不同 offer 之间**才加随机延迟 `1.5–4s` 隔开。（这一点推翻了早期「串行 + 禁止 Promise.all」的规范，是实测教训。）
4. **单个失败不中断**：某个 offer×卡 enroll 失败 → 记录并继续。并发时每个任务各自 try/catch，一个失败不影响同批其他卡。
5. **事后校验**：涉及的卡加完后重新调 `ADDEDTOCARD_LANDING` 读已加列表，用**分组 key** 对比目标是否真的在里面。
6. **结果报告**：每个 offer×卡对归类为「已校验成功 / 请求失败或异常 / 请求成功但校验未出现（假成功）/ 校验读取失败（无法判定）」，分开列出。
7. **低频使用**：README 提示一天跑一两次即可。

## 5. 里程碑与验收标准

### M0 — 实测确认接口（唯一需要用户登录态的一步）
- 按 FINDINGS.md §4 的「2 分钟自证步骤」在 DevTools 里确认 enroll/read 接口与 body 未变、cookie 即足够。
- 以下几点已确认（见 FINDINGS §4），M0 只需 Copy-as-fetch 复核当前线上仍如此：eligible 分页（`offerPage:"pageN"`）、enroll 用每张卡自己的原始 `offerId`、已加列表按分组 key 匹配。
- 验收：Console 里 Copy-as-fetch 能复现一次成功 enroll。

### M1 — 只读快照 + offer 聚合（不改动账户）
- 实现 `fetchAccounts()`、`fetchEligible(token)`（`page1..page20` 循环，空页停）、`fetchEnrolled(token)`。
- 实现 `buildOfferIndex(snapshot)`：按分组 key `pznAnalyticsId || offerId` 去重，**每张卡保留自己的原始 `offerId`**，产出
  `[{ key, name, cards:[{token, offerId, enrolled}] }]`。
- 先在 Console 打印聚合结果（每个 offer 在几张卡可加/已加）验证数据正确。
- 验收：offer 去重正确；每张卡的 `offerId`/已加状态与逐卡原始数据一致，无报错。

### M2 — 面板渲染聚合视图（只读，不改账户）
- Shadow DOM 面板：顶部卡范围过滤 + 搜索；主体是 offer 列表（名称、可加X卡/已加Y卡徽标、复选框、展开按钮）；展开显示该 offer 的逐卡复选框。
- 一个悬浮开关按钮打开/关闭面板；面板数据来自 M1 的聚合结果。
- 验收：面板正确列出去重后的 offer 与每个 offer 的卡分布；勾选/展开/搜索/卡过滤交互正常；此阶段「加入所选」可先只打印选中的 offer×卡对，不真正 enroll。

### M3 — 执行选中项 + 校验 + 三态报告
- 「加入所选」把选中的 offer×卡对展开成任务；**同一 offer 的卡并发发出**，offer 间随机延迟（跳过已加卡）。
- 面板进度区实时显示 `已完成/总数` 与 成功/失败/假成功/无法校验计数；结束后按 offer×卡列出结果明细。
- 验收：真跑后「已校验成功」均能在已加列表按分组 key 找到；「请求失败」保留服务端消息或异常；「假成功」只含返回 SUCCESS 但校验缺失项；校验读取失败的记为「无法校验」；单个失败不中断整体。

### M4（可选）— 打磨
- 结果导出 CSV、延迟可调、「只看多卡可加」过滤、失败项一键重试、面板样式细化。
- 纯自用可按需取舍。

## 6. 参考实现

**实现已完成——`src/amex-assistant.user.js` 就是参考实现**（单文件 userscript，纯函数已导出供测试）。下面只记核心要点，细节以源码为准：

- **enroll 用每张卡自己的原始 `offerId`**（不透明 token，跨卡不同）；`pznAnalyticsId || offerId` 只作分组去重 key。两者不能混用（见 FINDINGS §③）。
- **同一 offer 的多张卡必须并发**（`Promise.all`）：一旦某卡加上，其余卡会变不可加，串行只会让第一张成功。不同 offer 之间才用随机延迟隔开。
- **四态结果**：`verified`（校验到）/ `failed`（请求失败）/ `ghost`（返回成功但校验没有＝服务端去重）/ `unverified`（校验读取本身失败，无法判定）。
- **快照聚合**：读每张卡的 eligible + 已加，按分组 key 去重成 offer 列表；每张卡保留自己的 `offerId`。
- **执行健壮性**：「加入所选」外层 try/finally，失败也不卡死、不丢结果；供应/附属卡展平后一并纳入。
- **UI**：Shadow DOM 面板，选 offer→选卡→加；已加 offer 可见、每卡标注结果；面板缓存、可手动刷新。
- **测试**：`test/` 用 fixtures + fetch mock，覆盖去重、分页、并发、四态分类、供应卡展平等（`npm test`）。


## 7. 建议的仓库结构（发 GitHub 时）

```
amex-assistant/
├── README.md              # 中英；定位、装法、免责声明、隐私承诺（@grant none 即证据）
├── LICENSE                # MIT
├── DISCLAIMER.md          # ToS 灰色地带、服务端去重限制、使用自负
├── src/
│   └── amex-assistant.user.js
├── test/                  # 无需 Amex 的离线单测：fixtures + mock fetch
│   ├── fixtures/
│   ├── mock-fetch.js
│   └── *.test.mjs
└── docs/
    ├── FINDINGS.md        # 内部 API 参考（实现依据）
    ├── PLAN.md            # 本文件（设计 + 里程碑 + 骨架）
    └── IMPLEMENTATION.md  # 交给 agent 的执行计划
```

## 8. 风险与注意

- **接口会变**：Amex 改字段/端点时需按 FINDINGS.md §4 重新抓一次并更新常量。把端点/字段集中在文件顶部常量区，改一处即可。
- **检测特征**：API 直调比点击更「像机器人」→ 同一 offer 的卡必须并发（否则只有第一张成功）、offer 间随机延迟、低频。
- **服务端去重**：同 offer 多卡，Amex 可能只认第一张，其余进入「假成功」列表——非 bug，如实报告。
- **合规**：见 §2。发布时 README 顶部要有免责声明。
