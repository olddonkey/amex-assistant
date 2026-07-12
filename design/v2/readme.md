# Amex 助手 · Design System

浏览器插件「Amex 助手」的设计系统 —— 把 Amex Offer **并行**加到多张卡、追踪 offer 消费与 benefit 使用情况。两种密度:**边栏模式**(400px,贴 Amex 页面,密度优先)与**宽模式**(≈880px 居中覆盖层,内容区 max-width 1040px,可读性优先)。

来源:本项目设计稿 `Amex Offers 面板设计.dc.html`(t7–t13 定稿),无外部 Figma/代码库。

## 内容基调 (CONTENT FUNDAMENTALS)

- 中文为主、英文混排(商家名/offer 文案保留英文原文);头部有 EN 语言切换
- 短句、名词优先、不打招呼不客套:「已选 2 个 · 将并行一次发出 16 个请求」
- 状态词固定三态:「未使用 / 已用 N% / 已用完」;结果三态:「确认 / 失败 / 疑似重复」
- **硬性约束:所有执行文案必须体现「并行一次发出」,严禁出现「串行」「随机延迟」「排队等待」**(Amex 服务端按人去重,先到先得)
- 不用 emoji;✓ ✗ ? ▾ ▴ ⌕ 等 unicode 符号作为功能符号使用
- 信任文案直白具体:「纯本地运行 — 零后端、零上报」「先只读 — 不改动账户」

## 视觉基础 (VISUAL FOUNDATIONS)

- **字体**:Public Sans(400–800),中文回退 PingFang SC / Microsoft YaHei;金额、卡尾号、计数一律 `font-variant-numeric: tabular-nums`
- **双蓝规则**(核心):藏青 `--navy` = 过滤器/视图状态(全部卡 chip、pill 选中);亮蓝 `--amex-blue` = 动作与提交性选择(勾选、选中的卡 chip、主按钮、链接)。同为"选中"但语义不同,颜色刻意分开
- **语义色**:绿 = 已用/成功;红 = 紧急/失败;琥珀 = 警示/疑似重复/未激活。琥珀警示阈值 = 周期剩余 <25%
- **布局**:灰底 `--surface-page` + 白卡;行式列表(不用卡片网格)—— 同构数据靠列对齐竖向扫描;flex/grid + gap
- **圆角**:阶梯 18/14/12/10/9/6,全部 `corner-shape: superellipse(1.6)`(squircle)
- **阴影**:面板一层大投影 + 行卡 1px 微影;无内发光、无渐变底(卡面渐变除外)
- **进度可视化**:只在「部分使用」时出现(3px 微条);不用环形量表(连续量表不适合二元状态);已用完的行淡绿底"归档"
- **状态三态**:未使用 = 黑字金额 + 灰词;部分 = 绿「已用 N%」+ 微条;已用完 = 淡绿底 + ✓ 绿金额
- **交互**:hover = 底色变深一档(如 #F2F4F7 → #E7EAEF);主按钮 hover 深一档蓝;无动画偏好,transition .15s ease
- **卡面**:银渐变(Platinum 系)/ 金渐变(Gold 系)小圆角矩形,不画卡号艺术
- **控件语法**:分段 pill 只管数据集切换(一屏一次);卡过滤 = 胶囊 chips;状态 = 小方 chips;分组/排序 = 右上角唯一轻量下拉;禁止死控件(可点必有响应)

## ICONOGRAPHY

- 无图标字体;全部内联 SVG 描边图标(stroke-width 2–2.4, round cap/join):刷新、展开⤢、收窄、列表、卡片、勾
- 商家 logo:prod 用真实商家图片;mock 用色块 + 缩写占位。**Benefit 行没有左槽图标**(字母缩写是零信息,已删)
- 产品 logo:`assets/logo.svg`(蓝 squircle + 卡片 + 加号,本项目自创)
- 功能符号用 unicode:✓ ✗ ? ▾ ▴ ⌕ ×

## 索引

- `styles.css` → tokens/(colors / typography / shape / fonts)
- `components/core/` — Button, Checkbox, SearchBox, TextDropdown
- `components/chips/` — SegmentedPill, CardChip, StatusChip
- `components/data/` — StatCard, GroupHeader, MicroBar, BenefitRow, OfferRow
- `components/shell/` — PanelHeader, ActionBar
- `ui_kits/sidebar/` — 边栏 Offers·可加 交互示例
- `guidelines/` — 基础 specimen 卡片
- `SKILL.md` — Claude Code 可用的 skill 定义

## 非 token 的合法颜色

- 商家格子占位色(#B02A1E 等)—— prod 用真实商家 logo,mock 随机深色占位,不进 token
- `assets/logo.svg` 内部色(#7FB5E5/#B3D4F0)—— logo 资产自身
- 设计稿画布 chrome(#F0EEE9 底、#1A1A1A 标签等)—— 非产品 UI

## Intentional additions

- 无 —— 组件清单完全来自设计稿定稿(t8/t10/t11/t12/t13)。
