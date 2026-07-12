# UI-REDESIGN-V2 — 设计稿 t8–t13 落地计划（交给编码 agent）

> 面向执行者（Opus 等编码 agent）。当前面板 UI 是设计稿 **7a** 定稿的实现（v1.0.0 落地，现版本 1.1.1）。
> 本轮要落地的是 claude.ai/design 上继续迭代出的 **t8–t13 定稿**：已加页重构（8final）、可加页修缺（10a）、Benefits 全面改造（11b→13a）、全新宽模式（9a/9c/9d/12a/13b）。
>
> **设计资料全部在本仓库 `design/v2/` 下**（完整 design system，已从 claude.ai/design 同步；另有本地 skill `amex-assistant-design` 可随时调用）：
> - `design/v2/DESIGN-SYSTEM.md` — 设计系统总则（双蓝规则、三态状态语言、控件语法、文案基调）。**先读这个。**
> - `design/v2/tokens/*.css` — 颜色 / 字阶 / 圆角阴影 token（含宽模式 `[data-density="wide"]` 字阶）
> - `design/v2/components/*/*.prompt.md` — **14 个组件的逐组件规格**（Button / Checkbox / SearchBox / TextDropdown / SegmentedPill / CardChip / StatusChip / StatCard / GroupHeader / MicroBar / BenefitRow / OfferRow / PanelHeader / ActionBar）
> - `design/v2/{8final,9a,9c,9d,10a,11b,12a,13a,13b}.html` — 各定稿 mock，浏览器直接打开；**mock 是像素级规格来源**，样式全部内联在 HTML 里可直接查
> - `design/v2/ui_kits/sidebar/index.html` — 边栏组装示例：组件如何拼成「可加」屏与 Benefits 屏（含列表头随选择切换、chips 行分隔线 + 虚线「只看多卡」）。注意它是 React demo，运行时依赖（.jsx 组件、ds-loader.js）**故意未同步**——当组装规格读，别试图本地运行；**prod 是原生 DOM，严禁把 React 代码搬进 userscript**
> - `design/v2/7a.html` — 已实现基线（对照用，不需要动）
> - 未同步、留在 claude.ai/design 项目里的：`components/**` 的 `.jsx/.d.ts/*.card.html`（React 参考代码）、`guidelines/*.html`（token specimen，信息不超出 tokens/）——实现用不到，需要时再取
>
> 规格冲突时的优先级：**定稿 mock（像素）＞ components/*.prompt.md（组件行为）＞ DESIGN-SYSTEM.md（总则）**；tokens 是唯一取值来源。
>
> 工程约束沿用 `docs/IMPLEMENTATION.md` §0/§2（红线 + 工程约定），测试策略沿用 §4。**一个 Goal 一个 PR。**

---

## 0. 红线（不可协商，违反即打回）

沿用 IMPLEMENTATION.md §0 全部条目，本轮特别强调：

1. **不改网络层与执行时序**。本轮是纯 UI/展示层改造：`snapshot / buildOfferIndex / executeSelected / planRetry / fetchAllBenefits / fetchRedeemedOffers` 等数据与执行函数的行为、并发策略、重试与熔断逻辑一律不动（新增纯函数可以）。同一 offer 多卡并发、offer 间隔离等策略保持现状。
2. **不加任何第三方请求**。设计稿字体是 Public Sans，但 **prod 严禁引入 Google Fonts `@import`/`<link>`**（零上报红线）。字体栈更新为 `'Public Sans','PingFang SC','Microsoft YaHei',system-ui,sans-serif`——用户装了 Public Sans 就用，没装回退系统字体。
3. **执行文案硬约束**（设计系统规定）：所有执行相关文案必须体现「**并行一次发出**」，严禁出现「串行」「随机延迟」「排队等待」字样。注意：这是**文案层**约束，不等于改网络时序（时序见红线 1）。
4. **禁止死控件**：可点的必有响应。mock 里出现的每个控件都要么可交互、要么不实现，不允许摆一个点了没反应的（现状的静态「按到期 ▾」标签就是本轮要删的死控件）。
5. **i18n 完整性**：所有新增用户可见字符串进 `MESSAGES.zh/en`，key 双语对齐（`test/i18n.test.mjs` 强制）。
6. **单文件 + Shadow DOM + 无框架** 不变；`node --check` + `npm test` 每个 PR 必须全绿。
7. UI 渲染函数不强制单测（仓库惯例），但**新增的纯逻辑函数必须导出并配单测**。

---

## 1. 现状 ↔ 设计差距总览

现状代码定位（`src/amex-assistant.user.js`，行号为 v1.1.1 参考，动手前先重新确认）：
CSS 单模板串 `PANEL_STYLE` 2382–2901（token 变量 2386–2393）；面板固定 400px（2397）；header `renderHeader` 3150；Offers 子视图 pill `renderOffersSubTabs` 3388–3410；可加视图 `renderListView` 3291；已加视图 `renderAddedView` 3418；Benefits `renderBenefitsList` 3865、行 `renderBenefitRow` 3970；结果页 `renderResultView` 4167；执行中 `renderRunningView` 4107；状态对象 `state` 2094–2138；词表 `MESSAGES` 181–512。

| # | 设计稿 | 内容 | 现状 | 差距量级 |
|---|---|---|---|---|
| 1 | 10a | 可加页修缺 | 有卡 chips / 搜索 / 多卡过滤 / 全选，但布局不同 | 小改 |
| 2 | 8final | 已加页重构 | PR #23 只有「按 offer/按卡」pill 切换，无卡 chips、无按类目 | 中改 |
| 3 | 11b + 13a | Benefits 改造 | 字母缩略图 + 周期 chip + 到期红字,与设计完全不同 | 大改 |
| 4 | 9a/9c/9d/12a/13b | 宽模式 | **完全没有**（面板固定 400px） | 全新功能 |
| 5 | 全局 | 双蓝规则 / 琥珀阈值 / 字体栈 / tabular-nums | 部分符合(token 变量已有 navy/blue/amber) | 审计 + 补齐 |

---

## 2. Goals（按依赖排序，一个 Goal 一个 PR）

### G0 — 设计基座：token 对齐 + 密度脚手架

**目标**：`PANEL_STYLE` 的设计变量与 `design/v2/tokens/` 对齐，并为宽模式准备好密度切换机制（本 Goal 不做任何宽模式布局）。

- 把 `tokens/colors.css` / `shape.css` / `typography.css` 的变量并入 `PANEL_STYLE` 的 `.p` 变量区（现有 `--blue/--navy/--green/--red/--amber/--se` 等保留兼容或平滑重命名，全局 replace 需谨慎）。
- 字阶改为变量驱动（`--fs-title/--fs-amount/--fs-body/--fs-sub/--fs-caption/--fs-header/--fs-stat/--row-pad`），边栏取默认值;预留 `[data-density="wide"]` 覆盖块（值见 `tokens/typography.css`，即 13b 规则）。
- 字体栈按红线 2 更新；审计所有金额/尾号/计数已加 `tabular-nums`。
- **双蓝规则审计**：藏青 `--navy` = 过滤器/视图状态（卡过滤 chip 选中、pill 选中）；亮蓝 `--amex-blue` = 动作与提交性选择（勾选、主按钮、链接、tab 下划线）。逐处核对现状用色，修正用反的地方。
- **DoD**：视觉与现状基本无回归（这是重构性 PR）；`npm test` 全绿；无新增网络请求。

### G1 — 可加页修缺（10a）

**目标**：可加页控件区从 5 排收到 4 排，选择状态可见性提升。对照 `design/v2/10a.html`。

- 删掉子 tab 行右侧的静态死控件「按到期 ▾」（3409 附近）；到期升序为固定默认排序，不给控件。
- 「只看多卡」从独立 toolbar 行（`.tb` 3360–3374）并入卡 chips 行末尾，**虚线边框**样式区分“条件过滤”与“卡过滤”（mock 有精确样式）。
- 「全选可加 / 清空」挪进**列表头**：未选时显示 `143 个可加 OFFER ｜ 全选可加`；已选时变 `已选 N 个 OFFER ｜ 清空`。原 toolbar 行删除。
- 底栏两态：未选 = 灰字提示「勾选 offer 后从这里并行提交」；已选 = 亮起 `已选 N 个 · 将并行一次发出 M 个请求 ＋ [加到所选卡]`（文案红线 3）。
- 头部规范对齐 10a mock：标题 + 副标题（N 个 offer · M 张卡 · 刚刚更新）+ EN + 刷新 + ×。按钮顺序定稿（PanelHeader.prompt.md）：`展开⤢/收窄 · EN · ⟳ · ×`——「展开 ⤢」本 Goal 不做（G4 加），但预留第一的位置。
- **DoD**：交互全部可用（全选/清空/多卡过滤/卡过滤/搜索/勾选）；新增词条 zh/en 对齐；`npm test` 全绿。

### G2 — 已加页重构（8final）

**目标**：已加页獲得与可加页对称的骨架：pill → 搜索 → 卡 chips → stats → 列表头 → 列表；分组收进右上角唯一下拉。对照 `design/v2/8final.html`（A–E 五个状态图）。

- **类目数据（已拍板 2026-07-12）**：eligible 响应的类目字段未确认存在（FINDINGS 只确认 offerId/offerType/terms/longDescription）。采用**运行时探测 + 无则隐藏**：按候选字段路径解析（仿 v0.20 返现金额字段的候选解析先例，候选如 `category`/`offerCategory`/`industry` 等，解析函数导出可测）；运行时任一 offer 带类目 → 下拉显示「按类目」，全部缺失 → 该选项不渲染（无死控件、不造假）。字段名待用户日后在 DevTools 确认后可收窄候选表。
- 右上角**唯一轻量下拉**「按到期（默认）/ 按卡 / 按类目」，替换 PR #23 的「按 offer/按卡」segmented 切换（3443–3455）。`state.addedGroupBy` 语义迁移。
- **卡 chips 行**（与可加页同组件同样式）：选中单卡后 stats 与列表只看该卡；单卡模式下行内状态**单卡化**——`待消费` / `✓ $X 已返现 · M/D 入账`，不再显示「0/N 卡」（mock 状态 D）。
- 确保 pill 行下有**搜索框**（与可加一致；t8 修订注明确要求）。
- 按卡分组的组头：卡面缩略 + 卡名 + 尾号 + `N 个 · $X 已返现`；组内默认露前 3 行 + `展开其余 N 个 ▾`（mock 状态 C）。
- 按类目分组组头：`购物 SHOPPING ｜ N 个`（mock 状态 E）。
- stats 三格保留现状口径（已返现 $ / 待消费 / 7 天内过期），但要跟随卡过滤。
- 新增/改动的分组、过滤、单卡化统计逻辑抽成**纯函数并配单测**（如 `groupAddedBy(index, mode)`、stats 的 cardFilter 参数化）。
- **DoD**：五个 mock 状态（A 默认/B 菜单开/C 按卡/D 单卡/E 按类目）全部可达；诚实口径脚注保留；词表对齐；`npm test` 全绿。

### G3 — Benefits 全面改造（11b → 13a 完整定稿）

**目标**：Benefits 页换成 13a 的完整形态。对照 `design/v2/13a.html`（完整版）与 `design/v2/11b.html`（状态语言规则）。这是边栏改动最大的一页。

- **删左槽**：字母缩略图 `.blogo` 整个删掉，标题拿全宽（设计判定字母缩略图是零信息）。
- **周期分组**：列表按周期分组，组头 = `每月/每季/每半年/每年 ＋ 还剩 N 天 ＋ N 项 · $X 待用`；周期 chip 从行内移除。`benefitPeriodLabel` 已返回 month/quarter/half/year 枚举，分组逻辑新写纯函数（如 `buildBenefitPeriodGroups`）并配单测。
- **状态三态**（11b 规则，全局唯一进度条出处）：
  - 未使用 = 黑字金额 + 灰词「未使用」；
  - 部分 = 绿「已用 N%」+ 行卡**底部 3px 微条**（全列表唯一进度条）；
  - 已用完 = 整行淡绿底「归档」+ ✓ 绿金额。
  - 现状的「只看未用」开关与「已用完」折叠区（`state.benefitUnusedOnly`/`benefitDoneOpen`）删除——已用完行就地淡绿归档，不再抽走。
- **琥珀阈值新规**：组头「还剩 N 天」在**周期剩余 <25% 时变琥珀**，否则灰（每月 19/31 = 灰；每半年 38/182 = 琥珀）。写成纯函数（输入周期与剩余天数 → gray/amber）配单测。行级红色 urgent（≤7 天）规则由此替代，注意与 offers 页的红色「7 天内过期」区分开——那是 offers 的规则，不动。
- **卡 chips 过滤**：与 Offers 页同组件；选中单卡后 stats 与列表只看该卡。
- **多卡行展开态**：副标题「N 张卡 · 各 $X」为收起摘要；点击展开 per-card 明细（每行：卡名 + 尾号 + `$x / $y` 或 `✓ $y`，✓ 绿 = 该卡已用）。现状 breakdown 的常驻绿色进度条删除。
- **三种特殊行**（13a 底部）：
  - 未激活：琥珀词「未激活」+「去激活 ↗」链接（现状已有 `isInactiveBenefit`，重新排版即可）；组头统计口径注意 mock 里写「N 项 · $X 待激活」；
  - 无法自动追踪（**已拍板 2026-07-12：做**）：折叠低透明度行，数据源 = 现状被 `trackableBenefit` 过滤掉的追踪器（`category === 'spend'` 的 spend-to-unlock 与 `PASSES` 类）+ 无追踪器的 catalog 条目。注意：数据层的过滤行为不动，只是把被丢弃的条目**另行收集**供 UI 展示（新增纯函数）。
  - 未归类返现（**已拍板 2026-07-12：本轮不做**）：需要逐笔入账记录对账，现有接口（trackers/catalog/SAVINGS_LANDING）无此数据源，加新接口超出本轮纯 UI 范围。该行不渲染，设计稿保留依据待将来补。
- stats 三格（本月还没用的 / 今年已返现 / 年费回本）现状已有，保留并跟随卡过滤。
- **DoD**：13a mock 的所有行为可达（分组/三态/展开/chips 过滤/特殊行按数据可用性）；新纯函数单测；词表对齐；`npm test` 全绿。

### G4 — 宽模式（9a / 9c / 9d / 12a / 13b + 派生执行中态）

**目标**：全新的第二密度。同一骨架两种密度，**不是两套设计**。对照 `design/v2/9a.html`（已加宽）、`9c.html`（可加宽）、`9d.html`（结果宽）、`12a.html`（Benefits 宽）、`13b.html`（字阶规则）。

- **模式切换**：边栏头部加「展开 ⤢」按钮，宽模式头部为「收窄」；选择持久化（localStorage 新 key，如 `amexAssistantDensity`，沿用 `POS_STORAGE_PREFIX` 的存取风格）；**窗口太窄自动回落边栏**（阈值 ≈ 940px，即 880 + 边距），窗口变宽恢复用户偏好。
- **容器规格**（9d mock 附注）：居中覆盖层 ≈880px、内容区 max-width 1040px；高度 = 视口 − 上下 24–32px；**滚动只发生在列表区**，头部/搜索/stats/tab 钉住；行高紧凑 56–64px；行式列表，不用卡片网格。宽模式不可拖拽（边栏保持可拖拽）。
- **字阶**：容器挂 `data-density="wide"`，G0 预留的变量覆盖自动生效（13b：标题 14.5 / 正文 12 / 金额 14 / chips 11.5 / 组头 12.5 / 行距 15，卡面 18×12）。
- **9a 已加宽**：三列 = 商家/OFFER ｜ 到期 ｜ 各卡状态。卡状态 chips 直接铺行内：灰 chip = 已加待消费，绿 chip = `✓ $X` 已返现；溢出收成 `+N`（**必须可交互**——点击展开完整 chips，禁止死控件）。搜索框提到第一排；分组下拉沿用 G2。
- **9c 可加宽**：各卡列变成**可勾选的卡 chips**（亮蓝 = 选中，双蓝规则）；行首勾选框 = 全选该 offer 可加卡；底栏常驻：`已选 N 个 offer · 将并行一次发出 M 个添加请求 ＋ [加到所选卡]`；「只看多卡可加」「全选可加」在控件行。
- **9d 结果宽**：一行一个 offer，各卡结果编码在 chips 上（✓ 绿 / ✗ 红 / ? 琥珀）；头部把 确认/失败/疑似重复 三个数并进标题行（不占一排 stat 卡）；失败行行内「重试失败项」按钮——用现有 `planRetry` 管线按 offer 过滤子集重试，若需新的纯函数（如按 offer 过滤重试任务）则导出配单测；底部图例 `✗ 失败 = Amex 返回错误 · ? 疑似重复 = …` + 「返回列表」。
- **12a Benefits 宽**：三列 = 名称（全宽不截断）｜ 状态（金额 + 状态词 + 按需微条）｜ 各卡 chips（`✓`= 该卡已用、`$x` = 部分）。状态语言与 G3 完全同一套。
- **执行中态（设计稿未画，需派生）**：设计稿明确「宽模式执行中 = 边栏执行中的进度语义 × 9d 的表格结构」——一行一个 offer，各卡 chips 实时从 spinner → ✓/✗，顶部进度条与计数沿用现状 running 视图的数据源。布局跟 9d 对齐即可，不要自由发挥新视觉。
- 宽模式下五个视图（可加/已加/Benefits/执行中/结果）都必须可用；confirm 对话框、语言首选屏、错误/空态可沿用边栏布局居中呈现（设计稿未另画）。
- **DoD**：⤢/收窄往返切换 + 持久化 + 窄窗自动回落；五视图宽布局对齐 mock；chips 溢出 `+N` 可交互；词表对齐；`npm test` 全绿；边栏模式零回归。

### G5 — 全局审计 + 收尾

**目标**：按设计系统对全局做一致性审计，处理零碎项。

- **执行文案审计**：全量过一遍 `MESSAGES` 与 confirm/running/result 文案，确保符合红线 3（并行一次发出；无串行/延迟/排队字样）。特别检查 confirm 对话框的节流警告文案（现状 tasks>30 触发的那条）。
- hover 规则统一：白卡 hover `#F7F8FA`、按钮 hover 深一档；transition .15s ease。
- 圆角阶梯审计：面板 18 / 边栏行卡 14 / 宽行卡与统计卡 12 / pill 容器 10 / 按钮与搜索 9 / 状态 chip 6（宽 7）/ 卡过滤胶囊 18，全部 `corner-shape: superellipse(1.6)`。
- 图标审计：全部内联 SVG 描边（stroke-width 2–2.4, round cap/join）；功能符号用 unicode ✓ ✗ ? ▾ ▴ ⌕ ×；无 emoji。
- launcher 药丸如需配色微调跟 token 走，交互不动。
- README / 商店截图（`docs/store/`）标记为**发布前用户手动更新**，agent 不代劳。
- 版本号：G1–G5 全部合并后 bump minor（1.1.x → 1.2.0），CHANGELOG/发版走 `npm run release` 现有流程（发布本身由用户触发）。
- **DoD**：全局无双蓝用反、无死控件、无违规文案；`npm test` 全绿。

---

## 3. 明确不做 / 保持不变

- 网络层、执行引擎、重试/熔断、数据聚合纯函数的**行为**（新增纯函数除外）。
- launcher 交互、拖拽、位置持久化机制（宽模式不可拖为新增规则，不影响边栏）。
- 语言首选屏（trust screen)、错误页、空态的**流程**（视觉跟随 G0 token 即可）。
- 测试口径：现有测试一个不许删；`MESSAGES` key 只增不删时同步双语。
- 不引入构建步骤、框架、外部依赖。

## 4. 拍板事项（均已有结论，agent 按此执行，不再询问）

1. **按类目分组**：✅ 已拍板（2026-07-12）——运行时探测候选字段，无类目数据则从下拉隐藏该选项。详见 G2。
2. **Benefits 特殊行**：✅ 已拍板（2026-07-12）——「无法自动追踪」做（用被丢弃追踪器 + 无追踪器 catalog 条目）；「未归类返现」本轮不做。详见 G3。
3. 宽模式**默认值**：按默认执行——新用户首次打开为边栏，用户手动 ⤢ 后记住选择。
