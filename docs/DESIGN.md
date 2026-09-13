# 本地工具箱 · 设计文档

> **本文档是本项目的设计基准（Single Source of Truth）。**
> 后续任何功能调整都必须先比对本文档；若确需改变既定设计，**必须先更新本文档并写明变更理由**，再改动代码。
> 提交信息的正文中请引用相关章节（例如 `refs docs/DESIGN.md §10.3`）。

- 文档版本：1.1.0
- 最近更新：2026-09-13
- 对应代码版本：v0.1.0

---

## 0. 变更纪律（先读这一节）

### 0.1 变更分类

| 分类 | 定义 | 处理方式 |
| --- | --- | --- |
| **A. 实现级变更** | 不改变外部行为、视觉与契约，仅为内部优化（重命名变量、抽函数、改注释） | 直接改代码，无需改文档 |
| **B. 行为级变更** | 改变用户可感知的行为、界面、参数取值、默认值 | **先改本文档**（§10 等对应章节），再改代码 |
| **C. 契约级变更** | 改变工具扩展契约（§9）、设计系统令牌（§3）、数据存储键（§8） | 先改本文档 → 评估对**所有**既有工具的影响 → 同步迁移代码 |
| **D. 红线级变更** | 触碰 §1.2 的不可协商红线 | 必须先与项目所有者确认，取得明确同意后才可实施，并在文档中记录决策 |

### 0.2 每次改动前的自检清单

- [ ] 改动是否触碰 §1.2 红线？若触碰，是否已取得明确同意？
- [ ] 改动是否改变了用户可感知的行为或默认值？若是，文档是否已先行更新？
- [ ] 改动是否引入了新的网络请求 / 第三方资源 / 构建步骤？
- [ ] 改动是否破坏了「一工具一目录一模块」的解耦结构？
- [ ] 改动是否新增了共享样式或共享脚本？是否确认它**确实**会被第二个工具复用（而非 YAGNI）？
- [ ] 改动是否新增了 `localStorage` 键？是否遵循 §8.1 命名规范并已记入文档？
- [ ] 新增的界面元素是否可在**明暗两套主题**下正常显示？
- [ ] 是否满足 §7 无障碍要求（标签、键盘可达、`role="status"`）？

---

## 1. 项目定位与设计原则

### 1.1 定位

一个**全部计算在浏览器客户端完成**的静态工具集。左列表右内容的工作台形态，可持续添加互不干扰的小工具。面向「需要处理文本/数据、但不信任把数据贴到在线服务」的场景。

### 1.2 不可协商的红线（Hard Constraints）

> 这七条是项目的存在理由。任何改动都不得违反；违反即视为设计背离。

| 编号 | 红线 | 说明 |
| --- | --- | --- |
| **R1** | 零后端 | 不含任何服务端逻辑、接口调用或环境变量；部署只需静态托管 |
| **R2** | 零网络请求 | 运行期不发起任何 `fetch` / `XMLHttpRequest` / WebSocket / 埋点 |
| **R3** | 零第三方资源 | 不引 CDN、不外链字体、不引图标库文件、不引 UI 框架、不引统计脚本 |
| **R4** | 零构建 | 无打包、无编译、无转译；浏览器直接执行源码 |
| **R5** | 输入数据不离开设备且不被持久化 | 用户粘贴的内容只存在于内存与当前 DOM，不写入任何存储 |
| **R6** | 工具解耦 | 每个工具拥有独立页面与独立模块，互不共享状态、互不干扰 |
| **R7** | 参数化优先 | 任何功能行为都必须先成为**用户可配置的选项**；预设只能是一组参数取值，不得存在「预设专属逻辑分支」 |

### 1.3 核心设计原则

- **单点扩展**：新增工具只需修改 `assets/js/registry.js` 一处共享文件。
- **契约稳定**：工具模块只通过 `init(ctx)` 与外壳交互，外壳不感知任何工具的业务细节。
- **能力下沉**：通用能力（剪贴板、文本处理、DOM 辅助、图标、设计令牌）集中在共享层，工具**必须复用而非重复实现**。
- **样式隔离**：共享样式只放真正通用的层；工具专属样式放工具目录内。
- **可推理性**：业务算法写成无副作用纯函数并导出，使其可脱离 DOM 在 Node 中直接验证。
- **渐进增强**：JS 未启用或模块加载失败时，页面仍有可读内容与可读错误提示，不出现空白页。

---

## 2. 技术架构

### 2.1 技术栈（已冻结）

| 层面 | 选型 | 备注 |
| --- | --- | --- |
| 页面 | 原生 HTML5 多页面 | 一工具一 HTML |
| 样式 | 原生 CSS3 + CSS 自定义属性 | 不使用预处理器、不使用原子类框架 |
| 脚本 | 原生 ES Module（ES2022+） | `<script type="module">` |
| 图标 | 内联 SVG | 由 `assets/js/icons.js` 统一提供，禁止 emoji |
| 字体 | 仅系统本地字体栈 | 不加载任何 Web Font |
| 持久化 | `localStorage` | 仅存配置，不存用户输入 |
| 文件读写 | `Blob` / `URL.createObjectURL` / `FileReader` | 全部本地 API |
| 版本管理 | Git | 见 §12 |

### 2.2 分层

```
展示层     工具页 HTML + 共享 CSS（tokens/base/shell/tool）+ 工具私有 CSS
   ↓
外壳层     shell.js（渲染左列表与顶栏、收起态、动态挂载工具模块）
   ↓
能力层     theme.js / theme-boot.js / icons.js / utils/{dom,clipboard,text}
   ↓
工具层     各工具独立模块，仅导出 init(ctx)；内部再分 纯函数核心 / 存储适配 / UI 编排
   ↓
存储层     localStorage（仅配置，键名见 §8.1）
```

### 2.3 目录结构约定

```
/
├── index.html                          入口页（工具总览）
├── tools/<tool-id>/
│   ├── index.html                      工具独立页面
│   ├── <tool-id>.js                    工具独立模块（仅导出 init）
│   └── <tool-id>.css                   工具私有样式（可选，仅本工具使用）
│   ▸ 现有工具：text-line-merge（《文本行合并》§10）、sql-format（《SQL 格式化》§13）
├── assets/
│   ├── css/  tokens.css base.css shell.css tool.css
│   ├── js/   registry.js shell.js theme.js theme-boot.js icons.js
│   │         utils/{dom,clipboard,text}.js
│   └── noscript.html
├── docs/DESIGN.md                      本文档
├── .gitignore  .nojekyll  package.json  README.md
```

### 2.4 路径解析（关键，不得违反）

- `registry.js` 中的 `path` / `entry` 一律写**站点根相对路径**（不带前导 `/`），如 `tools/x/index.html`。
- 运行期由 `shell.js` 通过 `import.meta.url` 反推站点根并解析为绝对 URL：

  ```js
  export const SITE_ROOT = new URL("../../", import.meta.url); // 本文件位于 assets/js/
  export const toSiteUrl = (p) => new URL(p, SITE_ROOT).href;
  ```

- **禁止**在代码中硬编码 `/assets/...` 这类根路径。此约定同时兼容根路径部署与子路径部署（如 GitHub Pages 的 `/仓库名/`）。
- 工具页位于二级目录，因此其自身的 `<link>` / `<script src>` 使用 `../../` 前缀；新增工具时必须按其目录深度调整。

### 2.5 页面加载时序

1. `<head>` 中**同步**加载 `theme-boot.js` → 在首屏绘制前写入 `data-theme` / `data-sidebar`，消除明暗闪烁。
2. 浏览器解析到 `#shell-root` 与 `main#workspace`。
3. `shell.js`（module，延迟执行）：
   注入外壳（跳过链接 + 侧边栏 + 顶栏）→ 把 `main#workspace` 移入外壳 → 渲染列表/面包屑/首页卡片/页脚 → 绑定收起与主题按钮 → 若 `body[data-tool]` 存在则动态 `import()` 对应工具模块并调用 `init(ctx)`。
4. 工具模块渲染自身界面到 `#tool-body`，并返回可选清理函数。

---

## 3. 设计系统（视觉基准）

> 所有取值定义在 `assets/css/tokens.css`。**不得在工具样式中硬编码色值/字号**，必须引用令牌。

### 3.1 美学方向

**工业实用主义**：暖灰纸感底面、发丝级 1px 描边、精确的间距节奏、等宽数字与标签化元信息；焦橙作为**唯一**强调色。

### 3.2 色板

**原始色板（浅色）**

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--paper-0 / 1 / 2 / 3` | `#ffffff` `#f4f1ea` `#ede9e0` `#e4dfd3` | 纸感底色梯度 |
| `--ink-900 / 700 / 500 / 300` | `#17150f` `#5c5648` `#6e6757` `#a8a196` | 墨色文字梯度 |
| `--brand-700 / 600 / 100` | `#9a3412` `#c2410c` `#fdece3` | 强调色 |
| `--green-600 / --amber-600 / --red-600 / --blue-600` | `#2e7d5b` `#b45309` `#b42318` `#2563a8` | 状态色 |

**语义令牌（浅色 / 深色）**

| 令牌 | 浅色 | 深色 | 用途 |
| --- | --- | --- | --- |
| `--bg-base` | `#f4f1ea` | `#121110` | 页面底色（含栅格纹理） |
| `--bg-surface` | `#ffffff` | `#1b1917` | 面板/卡片表面 |
| `--bg-inset` | `#ede9e0` | `#262320` | 内嵌区、面板头尾 |
| `--bg-sunken` | `#e4dfd3` | `#0d0c0b` | 下沉区域 |
| `--bg-hover` | `rgba(23,21,15,.045)` | `rgba(245,242,234,.06)` | 悬停底色 |
| `--bg-active` | `#fdece3` | `rgba(232,112,31,.16)` | 当前项底色 |
| `--text-strong / body / muted / faint` | `#17150f` `#5c5648` `#6e6757` `#a8a196` | `#f5f2ea` `#d3ccbf` `#a8a196` `#6f6960` | 四级文字层级 |
| `--hairline / --hairline-strong` | `#dcd6c9` `#c7c0b0` | `#2e2a26` `#3d3833` | 发丝描边 |
| `--accent / --accent-hover` | `#c2410c` `#9a3412` | `#e8701f` `#f7903f` | 强调色 |
| `--accent-soft` | `#fdece3` | `rgba(232,112,31,.14)` | 强调色浅底 |
| `--accent-contrast` | `#ffffff` | `#17150f` | 强调色上的前景 |
| `--ok / --warn / --danger / --info` | `#2e7d5b` `#b45309` `#b42318` `#2563a8` | `#4caf86` `#e0962f` `#e2604f` `#6aa9e0` | 状态色 |

**严禁**：紫 / 靛 / 品红系配色（如 `#6366f1` `#8b5cf6` `#d946ef`）；除焦橙外的第二个强调色。

### 3.3 字体与排版

| 令牌 | 值 |
| --- | --- |
| `--font-sans` | `"DIN Next", Bahnschrift, "思源黑体", "Source Han Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, "Segoe UI", sans-serif` |
| `--font-mono` | `"Cascadia Mono", Consolas, "SFMono-Regular", Menlo, "DejaVu Sans Mono", "Courier New", monospace` |
| 字号 | `--fs-display 30` `--fs-h1 28` `--fs-h2 20` `--fs-h3 15` `--fs-body 14` `--fs-sm 13` `--fs-xs 11`（px） |
| 字重 | `--fw-regular 400` / `--fw-medium 500` / `--fw-semibold 600` |
| 行高 | `--lh-tight 1.25` / `--lh-normal 1.55` / `--lh-loose 1.75` |
| 字距 | `--tracking-label .12em`（小号大写元信息） / `--tracking-tight -.01em`（标题） |

约定：标题 600 字重；正文 400；元信息一律用 `.meta-label`（小号 + 大写 + 拉字距 + `--text-muted`）；数字与代码一律用 `.mono`（等宽 + `tabular-nums`）。

### 3.4 间距 / 圆角 / 阴影 / 动效

- 间距刻度：`--sp-1 4` `--sp-2 8` `--sp-3 12` `--sp-4 16` `--sp-5 20` `--sp-6 24` `--sp-8 32` `--sp-10 40` `--sp-12 48` `--sp-16 64`（px）。**所有间距必须取自刻度。**
- 圆角：`--r-xs 3` `--r-sm 5` `--r-md 8` `--r-lg 12` `--r-pill 999`
- 阴影：`--shadow-1`（贴近）/ `--shadow-2`（浮起）/ `--shadow-3`（抽屉）；一律配合发丝描边使用，禁止厚重投影。
- 动效：`--dur-fast 120ms` / `--dur-base 200ms` / `--dur-slow 320ms`，缓动 `--ease-out cubic-bezier(.22,.85,.24,1)`。
- 纹理：`--grid-line` + `--grid-size 32px` 构成页面底纹，`background-attachment: fixed`。

### 3.5 断点（写在媒体查询中，非令牌）

| 断点 | 行为 |
| --- | --- |
| `> 1080px` | 标准形态：工具页 7:5 非对称双栏、首页主视觉单列 |
| `≤ 1080px` | 双栏折叠为单列 |
| `≤ 900px` | 侧边栏转为覆盖式抽屉（`html[data-drawer="open"]`），顶栏按钮变为菜单图标 |
| `≤ 720px` | 收紧内边距、按钮撑满、工具条换行堆叠、字号下调 |

### 3.6 图标规范

- 全部来自 `assets/js/icons.js` 的 `PATHS`，通过 `icon(name, size)` 生成。
- 规格统一：`viewBox="0 0 24 24"`、`fill="none"`、`stroke="currentColor"`、`stroke-width="1.6"`、圆角端点、`aria-hidden="true"`。
- **禁止 emoji 作为图标**；**禁止**引入外部图标字体或图标文件。

---

## 4. 布局规范

### 4.1 应用外壳

- 结构：`.shell`（flex）→ `.sidebar`（sticky，`height:100vh`）+ `.shell__main`（顶栏 + 内容区）。
- 侧边栏宽度：展开 `--sidebar-w 264px`，收起 `--sidebar-w-collapsed 64px`；收起态保留图标 + 悬停浮层显示名称（浮层为 `body` 级 `position:fixed`，避免被 `overflow:hidden` 裁剪）。
- 侧边栏内容自上而下：品牌区（图标 + 站名）→ 工具列表（含 `.nav__label` 计数）。**不设隐私声明脚注**（见 §8.5）。
- 顶栏高度 `--topbar-h 56px`，sticky；含收起按钮、面包屑、主题按钮。**不设隐私/本地计算徽标**（见 §8.5）。
- 收起状态持久化于 `toolbox:sidebar`，取值 `expanded | collapsed`。

### 4.2 内容区

- `.workspace`：`max-width: --content-max 1280px`，左对齐（不居中），内边距 `--sp-8` ~ `--sp-12`；**工具页通过 `body[data-tool] .workspace` 把上内边距收紧为 `--sp-6`**，首页保持 `--sp-8`。
- 首页区块顺序：主视觉（**单列**：眉标 + 主旨标题 + 一段功能定位语）→ 章节标题 → 工具卡片网格 → 页脚。
- 工具页区块顺序：工具头部 → **预设工具条**（如有）→ 内联面板（另存为 / 导入 / 错误）→ 7:5 非对称双栏 → 页脚。
- 工具页双栏内的分工（以《文本行合并》为基准形态）：
  - **左列 = 纵向工作流**：输入面板 → 主操作条（合并按钮）→ 输出面板；输入与输出两块面板上下排列，构成「吕」字形。
  - **右列 = 独立参数列**：参数（选项）面板 + 统计面板，自成一列。
  - 输出**不得**再以整宽面板形式出现在页面底部（避免占用底部空间、把「输入—输出」的因果链拉开）。

### 4.3 工具卡片与列表现状

- 工具卡片：图标 + 状态徽标 + 名称 + 说明 + `tool-id` 元信息 + 箭头；`status: planned` 时边框为虚线。
- 列表项：图标 + 名称 + 状态徽标；当前项左侧 3px 强调色竖条 + 底色高亮 + `aria-current="page"`。

---

## 5. 组件规范

> 通用组件定义在 `assets/css/tool.css`；外壳组件在 `assets/css/shell.css`。新增工具应优先复用，不得重复造轮子。

| 组件 | 类名 | 要点 |
| --- | --- | --- |
| 工具头部 | `.tool-head` `.tool-head__main` `.tool-head__eyebrow` `.tool-head__title` `.tool-head__desc` `.tool-head__icon` | 紧凑基线，取值见 §5.1 |
| 面板 | `.panel` `.panel__head` `.panel__body` `.panel__foot` | 表面色 + 发丝描边 + `--shadow-1`；头尾用 `--bg-inset` |
| 双栏 | `.panel-grid`（7:5） / `.panel-stack` | 上间距 `--sp-3`；`≤1080px` 折叠为单列 |
| 按钮 | `.btn` `.btn--primary` `.btn--ghost` | `--primary` 用强调色；`:active` 下沉 1px |
| 图标按钮 | `.icon-btn` | 34px 方形（工具条内可收紧到 30px） |
| 输入 | `.input` `.textarea` `.select` | 聚焦时强调色描边 + `--accent-ring` 光环 |
| 复选框 | `.checkbox` | 用 `accent-color: var(--accent)` |
| 提示条 | `.notice`（`--warn` / `--danger`） | 左侧 3px 语义色竖条，非全边框着色 |
| 徽标 | `.badge`（`--ok` / `--warn`） | 药丸形，小号字 |
| 空状态 | `.empty` `.empty__title` `.empty__text` | 虚线框 + 引导文案 |
| 输出区 | `.output` | 等宽、`pre-wrap`、`break-word`、可选中 |
| 统计 | `.stats` `.stat__value` `.stat__label` | 值为等宽大号，标签为 `.meta-label` 风格 |
| 元信息 | `.meta-label` `.mono` `.rule` | — |

**状态约定**：禁用态一律使用**虚线描边 + 内嵌底色**，而不是把文字降到不可读；聚焦态为 2px 强调色外描边。

### 5.1 工具头部基线（紧凑）

工具页顶部采用**紧凑基线**，避免首屏被标题区挤占。全部取值取自令牌，改动必须同步本节：

| 属性 | 取值 | 令牌 |
| --- | --- | --- |
| `.tool-head` `gap` | 16px | `--sp-4` |
| `.tool-head` `padding-bottom` | 12px | `--sp-3` |
| `.tool-head__eyebrow` `margin-bottom` | 4px | `--sp-1` |
| `.tool-head__title` `font-size` | 20px | `--fs-h2` |
| `.tool-head__desc` `margin-top` | 4px | `--sp-1` |
| `.tool-head__desc` `font-size` | 13px | `--fs-sm` |
| `.tool-head__desc` 宽度上限 | 不设（随容器，单行优先） | — |
| `.tool-head__icon` | 40×40，内部图标 20px | `--sp-10` |
| `@media (max-width: 720px)` 下的标题 | 18px | — |
| `@media (max-width: 1080px)` 下的 `.tool-head` | 纵向排列、`gap: --sp-4` | `--sp-4` |

补充约定：

1. **工具页标题刻意使用 `--fs-h2`（20px）而非 `--fs-h1`（28px）**。`--fs-h1` 保留给未来可能的全屏/大标题场景，本组件不使用。
2. **头部描述文案应控制在一行内（约 ≤40 个中文字符）**。需要更多说明时，改由工具内的 `.notice` 或字段级 `.field__hint` 承载，**不得**把头部重新撑高。
3. **工具页内容区上内边距比首页更紧凑**：`body[data-tool] .workspace { padding-top: var(--sp-6) }`。该规则以**选择器作用域**生效，因此首页 `.hero` 的主视觉留白不受影响；新增工具页因 §9.1 的 `body[data-tool]` 契约天然继承，无需额外处理。
4. **间距节奏原则**：跨组件留白取 `--sp-3` / `--sp-4`，组件内部取 `--sp-1` / `--sp-2`。刻意制造节奏差，避免相邻多处使用 `--sp-6`（24px）形成「成片等距空白」——那是页面显得松散的主因。

---

## 6. 交互与动效规范

| 项 | 约定 |
| --- | --- |
| 防抖 | 文本类实时计算使用 **180ms** 防抖；选项类变化立即执行并取消挂起任务 |
| 挂起结算 | **复制、下载等即时操作前必须先结算挂起的防抖刷新**，避免读到旧结果 |
| 离散反馈 | 复制成功按钮内联变化约 **1500ms**；状态行文本约 **4000ms** 后清除；两段式删除确认 **3000ms** 超时复位 |
| 反馈通道 | 一律使用 `role="status"` + `aria-live="polite"`；结果区**不设**实时朗读（避免逐键噪音） |
| 原生弹窗 | **禁止** `window.prompt` / `window.confirm` / `window.alert`；改用内联表单、两段式确认、内联提示条 |
| 键盘 | 主操作绑定 `Ctrl/Cmd + Enter`；`Esc` 依次关闭最上层的内联面板 / 清除错误提示 |
| 焦点 | 打开内联表单后自动聚焦并全选 |
| 手动合并的定位 | 手动触发主操作（主按钮 / `Ctrl/Cmd + Enter`）且结果非空时，若**输出面板底部**（含「复制结果」）超出视口，则平滑滚动使其进入视口（底部留 24px 余量）；**已完整可见时不得滚动**（避免无谓跳动）；`prefers-reduced-motion: reduce` 下改为瞬时定位 |
| 动效 | 仅用透明度与位移，时长 120~320ms；`prefers-reduced-motion: reduce` 下全部退化为无动画 |
| 悬停 | 卡片/列表项位移不超过 3px；不做夸张缩放 |

---

## 7. 无障碍规范

- 每个表单控件必须有**显式关联**的 `<label for=...>` 或 `aria-labelledby`。
- 纯图标按钮必须同时具备 `aria-label` 与 `title`。
- 侧边栏收起按钮暴露 `aria-expanded` 与 `aria-controls`；当前列表项暴露 `aria-current="page"`。
- 页面提供「跳到主内容」跳过链接（首个可聚焦元素）。
- 焦点可见：`:focus-visible` 使用 2px 强调色外描边，不得移除。
- 色彩对比度满足 WCAG AA；信息不得只靠颜色传达（状态同时有文字或形状差异）。
- 全流程可仅用键盘完成。

---

## 8. 数据与隐私

### 8.1 `localStorage` 键命名规范

```
toolbox:<tool-id>:<key>      工具私有数据
toolbox:<全局键>              跨工具/外壳数据
```

当前键清单（**新增键必须登记在此**）：

| 键 | 归属 | 内容 | 值域 |
| --- | --- | --- | --- |
| `toolbox:theme` | 外壳 | 主题偏好 | `system` / `light` / `dark` |
| `toolbox:sidebar` | 外壳 | 侧边栏收起状态 | `expanded` / `collapsed` |
| `toolbox:text-line-merge:presets` | 工具 | 自定义预设数组 | `[{ id, name, config, createdAt }]` |
| `toolbox:text-line-merge:config` | 工具 | 上次参数与预设选择 | `{ config, presetId }` |
| `toolbox:sql-format:presets` | 工具 | 《SQL 格式化》自定义预设数组 | `[{ id, name, config, createdAt }]` |
| `toolbox:sql-format:config` | 工具 | 《SQL 格式化》上次参数与预设选择 | `{ config, presetId }` |

### 8.2 数据边界（必须在界面上如实告知用户）

- 数据存于**当前浏览器**，刷新与重开浏览器后保留。
- **无痕模式、清除浏览器数据、更换浏览器或设备后为空**，且**不跨设备同步**。
- 迁移/备份的唯一手段是工具自带的**导出 / 导入**（JSON 文件或 JSON 文本）。

### 8.3 禁止事项

- **禁止持久化任何用户输入内容**（粘贴的文本、文件内容等），只允许持久化「配置」。
- **禁止**读写 `localStorage` 时不包 `try/catch`：隐私模式下必须静默降级为「本次会话内有效」，不得阻断渲染。
- **禁止**导入时跳过校验直接写入；必须**先整体校验通过，再一次性写入**，不得部分写入造成脏数据。

### 8.4 导入导出安全要求

- 导出文件必须带版本号（当前 `version: 1`）与来源标识（`app` / `tool`）。
- 导入必须校验：顶层为对象 → `app` / `tool` 匹配 → 版本匹配 → `presets` 为数组 → 逐条校验并归一化（缺失补默认、非法回退、未知字段丢弃）。
- 校验失败必须**整体拒绝**并给出**可读的中文错误**，且不写入任何数据。
- 导入后必须明确回报「新增 / 覆盖 / 跳过非法」条数，不做静默处理。
- 文件读取必须使用本地 API（`FileReader` / `Blob`），**不得上传**。

### 8.5 隐私表述的呈现原则（硬性 UI 约定）

「本地计算 / 数据不出设备」是本项目的核心价值，但**重复陈述会稀释它，而不是强化它**。因此：

1. **每个页面最多只出现一次**此类表述。
2. **只放在真正处理用户数据的位置**——即工具页的结果面板（当前为「零网络请求 · 零数据上传」，紧邻「复制结果」）。用户在接触自己数据的那一刻看到它，说服力最强。
3. **共享外壳（侧边栏、顶栏、页脚）一律不重复声明**：侧边栏只放品牌与工具列表，顶栏只放操作控件，页脚只放版本信息。
4. **首页仅在 H1 主旨标题中体现定位**（「全部在*本机*完成的工具集」）；hero 的补充文案只讲功能（独立成页、参数可保存为预设），不复述隐私主张。
5. **例外**：`assets/noscript.html` 是 JS 被禁用时的唯一说明页，其正文即为此说明，不受本约定限制。

**新增工具时**：不要在工具头部或工具条里再写一遍隐私声明；如需就地提示，复用结果面板的既有位置与措辞。

---

## 9. 工具扩展契约（新增工具必须遵守）

### 9.1 三步流程

1. **建目录与页面**：`tools/<tool-id>/index.html`，其中必须保留：
   - `<body data-tool="<tool-id>">`
   - `<div id="shell-root"></div>`
   - `<main class="workspace" id="workspace">`（内含 `<header class="tool-head">`、`<div id="tool-body">`、`<footer data-site-footer>`）
   - `<head>` 中同步加载 `../../assets/js/theme-boot.js`（必须在样式表之前）
   - 结尾加载 `../../assets/js/shell.js`（`type="module"`）
2. **写处理模块**：`tools/<tool-id>/<tool-id>.js`，导出 `init(ctx)`，可选导出 `meta` 与清理函数。
3. **注册**：在 `assets/js/registry.js` 的 `TOOLS` 中追加一条 `ToolRecord`。**这是唯一需要改动的共享文件。**

### 9.2 `ToolRecord` 字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `string` | 唯一标识，须与 `body[data-tool]` 一致 |
| `name` | `string` | 显示名称 |
| `icon` | `string` | `icons.js` 中的键；未命中会回退为 `dot` |
| `description` | `string` | 一句话说明（用于首页卡片） |
| `path` | `string` | 页面路径，**站点根相对** |
| `entry` | `string` | 模块路径，**站点根相对** |
| `status` | `'ready' \| 'planned'` | `planned` 显示「开发中」角标与虚线卡片 |
| `keywords` | `string[]` | 可选，预留检索 |

### 9.3 `init(ctx)` 契约

```js
export function init(ctx) {
  // ctx.root      HTMLElement          工具页内容区（main.workspace）
  // ctx.tool      object               registry 中的 ToolRecord
  // ctx.site      object               SITE 元信息
  // ctx.utils     { dom, clipboard, text }  公共能力，必须复用
  // ctx.icons     { icon(name, size) }
  // ctx.toSiteUrl (p: string) => string
  return () => {}; // 可选：清理函数（须注销全部监听与定时器）
}
```

**必须遵守**：

- 界面渲染进 `ctx.root` 内的 `#tool-body`；不得操作外壳与其它工具的 DOM。
- 不导入其它工具模块，不定义跨工具全局状态。
- 返回清理函数时必须清除**全部**定时器与事件监听（`dom.on` 已返回解绑函数）。
- 模块内部推荐三层：**纯函数核心 → 存储适配层 → UI 编排层**；核心算法必须可脱离 DOM 直接导入验证。
- 动态 `import()` 失败由外壳兜底渲染可读错误；工具自身的关键失败也应给出可读提示，不静默。

### 9.4 能力复用清单（禁止重复实现）

| 需求 | 必须使用 |
| --- | --- |
| 复制到剪贴板 | `ctx.utils.clipboard.copyText`（已含非安全上下文降级） |
| 行拆分 / 规范化 | `ctx.utils.text.splitLines` / `normalizeLineEndings` / `toLines` |
| 字符数 / 行数统计 | `ctx.utils.text.countChars`（按 Unicode 码点）/ `countLines` |
| DOM 创建与事件绑定 | `ctx.utils.dom.el` / `qs` / `on`（返回解绑函数）/ `escapeHtml` |
| 图标 | `ctx.icons.icon(name, size)` |
| 颜色 / 间距 / 字号 | `assets/css/tokens.css` 的令牌 |

### 9.5 样式归属规则

- **禁止**向 `assets/css/tool.css` 添加只服务于单个工具的样式。
- 工具专属样式写入 `tools/<tool-id>/<tool-id>.css`，并在该工具页 `<head>` 中链接。
- 只有当某样式**确实**会被第二个工具复用时，才允许上移到共享样式文件（并由改动者同时更新本节）。

---

## 10. 《文本行合并》功能规格

> 工具 id：`text-line-merge`；页面 `tools/text-line-merge/`；模块 v1.0.0；状态 `ready`。

### 10.1 参数模型（所有功能的唯一开关集合）

| 字段 | 类型 | 默认值 | 取值域 | 说明 |
| --- | --- | --- | --- | --- |
| `separator` | `string` | `","` | 任意字符串（含 `""`） | 行间分隔符；`""` 表示直接拼接 |
| `prefix` | `string` | `""` | 任意字符串 | 每行前缀 |
| `suffix` | `string` | `""` | 任意字符串 | 每行后缀 |
| `trim` | `boolean` | `false` | — | 合并前去除每行首尾空白 |
| `dropEmpty` | `boolean` | `false` | — | 丢弃（trim 后）为空的行 |
| `escape` | `boolean` | `false` | — | 是否启用转义 |
| `escapeChar` | `string` | `"'"` | 任意非空字符串（`""` 视为不转义） | 被转义的字符 |
| `escapeMode` | `'double' \| 'backslash'` | `'double'` | — | `double`：`'`→`''`；`backslash`：`'`→`\'` |

### 10.2 合并顺序（不可变更）

```
按行拆分 → 逐行 trim（可选） → 丢弃空行（可选） → 行内容转义（可选） → 套前后缀 → 用分隔符 join
```

- 转义**只作用于行内容**，不作用于前后缀。
- `dropEmpty` 判定发生在 `trim` **之后**（即 `trim=false` 时，纯空白行**不算**空行）。
- 转义实现必须用 `split/join`（可安全处理含正则元字符的转义字符），并在 `escapeChar === ""` 时短路。

### 10.3 内置预设（= 一组参数取值，不得含专属逻辑）

| id | 名称 | 参数 |
| --- | --- | --- |
| `comma` | 英文逗号合并（默认） | `separator: ","` |
| `comma-space` | 英文逗号 + 空格 | `separator: ", "` |
| `sql-list` | SQL 列表 | `separator: ","`、`prefix/suffix: "'"`、`trim`、`dropEmpty`、`escape` 全开 |
| `space` | 空格合并 | `separator: " "` |
| `pipe` | 竖线分隔 | `separator: " \| "` |
| `concat` | 直接拼接 | `separator: ""` |

**新增预设只需向 `BUILTIN_PRESETS` 追加数据**，禁止为其编写任何分支代码（R7）。

### 10.4 自定义预设

- 保存在 `toolbox:text-line-merge:presets`，上限 **200** 条，名称上限 **40** 字符。
- 另存为：名称不得为空、不得与内置预设同名；与已有自定义预设同名则**覆盖**其参数。
- 删除：两段式内联确认；删除后回退到默认预设 `comma`。
- 参数被手动改动后，预设下拉切换为「自定义（未保存）」，可随时另存。
- 预设下拉分组：`内置预设` / `我的预设`；仅在「自定义」状态下追加「自定义（未保存）」项。

### 10.5 导入 / 导出

- 导出结构：

  ```json
  {
    "app": "local-toolbox",
    "tool": "text-line-merge",
    "version": 1,
    "exportedAt": "ISO-8601",
    "config": { },
    "presets": [{ "name": "…", "config": { } }]
  }
  ```

- 导出与「复制 JSON」在无自定义预设时禁用并给出提示。
- 导入支持「选择 `.json` 文件」与「粘贴 JSON 文本」两条路径，共用同一校验函数。
- 冲突策略：**同名以导入内容为准覆盖**。
- **导入只恢复预设，不自动改动当前正在编辑的参数。**
- 完成后回报：`导入完成：新增 N 条，覆盖 M 条[，超出上限跳过 K 条][，忽略非法 J 条]`。

### 10.6 界面与交互

- **预设工具条**：预设下拉 + 「另存为」「删除」「恢复默认」「复制 JSON」「导出」「导入」。删除、导出、复制 JSON 在不可用时禁用并给出 `title` 说明。
- **顶部紧凑节奏**：工具头部采用 §5.1 紧凑基线；预设工具条上间距 `--sp-4`、内边距 `--sp-2 --sp-3`；状态提示行上间距 `--sp-1`、行高 16px；`.panel-grid` 上间距 `--sp-3`。**状态提示行必须始终占位**（不得改回 `:empty { display: none }`）——否则状态出现/消失会改变页面高度，触发浏览器滚动锚定补偿，使「合并后自动滚动」的落点不确定。
- **页面结构（「吕」字形）**：7:5 非对称双栏。
  - **左列（纵向工作流）**：输入面板 → **主操作条** → 输出面板。输入与输出上下排列构成「吕」字形。
  - **右列（独立参数列）**：合并选项面板 + 统计面板，自成一列，不占用页面底部空间。
- **主操作条**：紧贴输入面板正下方、横跨左列整宽的强调色主按钮「合并」，是本工具唯一的主操作入口；`Ctrl/Cmd + Enter` 与之等价。主操作条之上不再有其它按钮，之下即为输出面板。
- **输入面板**：标题栏显示实时行数；文本域（不低于 260px 高、可拖拽调整）；底部为「清空」+ `Ctrl+Enter` 快捷键提示。
- **选项区**（右列）：分隔符 / 前缀 / 后缀（各带**效果片段**如 `甲,乙`、`'甲`）；处理规则三个复选框；转义分组（转义字符 + 转义方式）在未启用转义时呈**虚线禁用态**。
- **实时预览**：输入与选项变化后 180ms 防抖刷新；「合并」按钮与 `Ctrl/Cmd+Enter` 立即结算。
- **输出面板**（左列，输入面板正下方）：空输入显示空状态，有结果显示单行文本；底部为「复制结果」（成功后按钮变勾号 +「已复制」并转绿 1500ms）与「下载为 .txt」（本地 Blob）。
- **统计**：输入行数 / 参与合并行数 / 输出字符数（`countChars` 按码点）。
- **合并后的自动滚动**：手动触发合并（主按钮或 `Ctrl/Cmd+Enter`）且结果非空时，把**输出面板底部（含「复制结果」按钮）**滚动进视口，便于立刻复制；结果为空时仅给出提示、不滚动；目标已完整可见时不滚动。

### 10.7 边界行为（必须保持）

| 场景 | 行为 |
| --- | --- |
| 输入为空 | 结果区显示空状态；三项统计为 0；输出 0 字符 |
| 输入含末尾换行 | `countLines` 不计入末尾空行 |
| 分隔符为 `""` | 直接拼接，无分隔符 |
| 纯空白行 + `trim=false` | 视为非空，参与合并 |
| 纯空白行 + `trim=true` + `dropEmpty=true` | 被丢弃 |
| `escapeChar` 为 `""` | 短路，不转义 |
| 转义关闭 | 行内容原样输出 |
| 输入为空时点击「合并」 | 提示「暂无可合并的内容。」，且不触发滚动 |
| 手动合并时输出底部已完整可见 | 不滚动（避免无谓跳动） |
| 复制时防抖未结算 | 先结算再复制（不得复制到旧结果） |
| 剪贴板不可用 | 提示「复制失败，请手动选择结果文本复制。」 |
| `localStorage` 不可用 | 提示仅在当前页面内有效，功能不中断 |

### 10.8 纯函数 API（可导出、可脱离 DOM 验证）

```js
export const DEFAULT_CONFIG;
export const BUILTIN_PRESETS;
export function normalizeConfig(partial);        // 归一化：补默认 / 非法回退 / 丢弃未知字段
export function configEquals(a, b);              // 配置等价比较
export function selectLines(lines, config);      // 按配置筛选与裁剪行
export function escapeLine(content, config);     // 单行转义
export function mergeLines(lines, config);       // 合并为单行字符串（对 selectLines 输出幂等）
export function serializePresets(presets, cfg);  // 生成导出对象
export function parseImportPayload(raw);         // { presets, stats } 或抛可读错误
export function loadCustomPresets() / saveCustomPresets(list);
export function loadSession() / saveSession(config, presetId);
```

---

## 11. 变更操作指南

### 11.1 典型案例

| 想做的事 | 属于 | 正确做法 |
| --- | --- | --- |
| 给工具加一个新的处理选项 | **D？→ 先检查** | 若只是新增一个可选参数，属 B：先在 §10.1 增补字段与默认值，再改代码；若该选项会改变既有默认输出，属 D，需确认 |
| 新增一个预设 | B / A | 只在 §10.3 表格加一行 + `BUILTIN_PRESETS` 加一条数据 |
| 调整配色或间距 | C | 改 `tokens.css` 并同步 §3.2 / §3.4 表格，然后检查全部页面与两套主题 |
| 换掉某个 CSS 令牌名 | C | 需全仓搜索替换，并同步本文档所有引用 |
| 新增一个工具 | B | 按 §9 三步；同时在 §8.1 登记其存储键（若有） |
| 给《SQL 格式化》加一个格式化参数 | B / D | 先在 §13.2 增补字段与默认值，再改 `normalizeConfig` 与控制项；若该参数会改变既有默认输出，属 D，需先确认 |
| 引入一个 UI 库 / 图标库 | **D** | 违反 R3/R4，必须先取得明确同意 |
| 加一个「云端同步预设」 | **D** | 违反 R1/R2/R5，必须先取得明确同意 |
| 把用户输入缓存到本地以便恢复 | **D** | 违反 R5，必须先取得明确同意 |

### 11.2 提交纪律

- 仅在明确要求时提交；提交信息使用**中文** + Conventional Commits 规范；必要时按功能分批提交。
- **严禁**提交任何密钥、令牌、口令、私钥、`.env`、个人身份信息、包含用户名的绝对路径。
- 提交前自检：`git status` 是否包含不该出现的文件；是否误提交了 `.codebuddy/`、临时脚本、本地导出文件。

---

## 12. 版本管理（Git）

> 本节对应 §2.1 技术栈表中的「版本管理」条目。

- **只在明确要求时提交**：严禁在未获用户明确要求时执行 `git commit` / `git push`。
- 提交信息使用**中文**并遵循 Conventional Commits：`feat(<范围>): <说明>`、
  `fix(<范围>): <说明>`、`docs: <说明>`、`chore: <说明>`。
- 提交信息正文引用本文档章节，例如 `refs docs/DESIGN.md §13`；必要时按功能分批提交。
- 提交前必须做隐私自检：不含密钥/令牌/口令/私钥、个人身份信息、含用户名的绝对路径、
  `.codebuddy/` 目录与临时脚本。

---

## 13. 《SQL 格式化》功能规格

> 工具 id：`sql-format`；页面 `tools/sql-format/`；模块 v1.0.0；状态 `ready`。

### 13.1 定位与布局例外

面向 **Oracle / PostgreSQL** 的 SQL 编辑器，提供格式化、语法高亮、关键词搜索、
选中相同文本全部高亮，并含行号、括号匹配、Tab 与自动缩进等基础编辑器能力。
全部计算在本机完成，不发起任何网络请求，不引用任何第三方资源。

**布局例外（相对 §4.2）**：本工具为**以全宽编辑器为主体**的工作台，主区采用
`grid: minmax(0,1fr) 320px`（左编辑器 + 右选项窄列），**不套用 §4.2 的 7:5 非对称双栏**。
理由：代码可读性依赖行宽与行号槽，7:5 会把编辑器压到无法完整展示格式化后的语句；
而格式化选项虽多，均为短控件，320px 窄列即可容纳。`≤1080px` 时折为上下单列
（编辑器在上、选项在下）。

全页隐私表述只出现一次，位于编辑器面板脚注（「零网络请求 · 零数据上传」），遵循 §8.5。

### 13.2 参数模型（所有行为都是用户可配置选项）

| 字段 | 类型 | 默认值 | 取值域 | 说明 |
| --- | --- | --- | --- | --- |
| `dialect` | `string` | `"oracle"` | `oracle` / `postgres` | 方言；决定保留字/内置函数/数据类型识别集合与特有语法处理 |
| `indentStyle` | `string` | `"space"` | `space` / `tab` | 缩进单位 |
| `indentWidth` | `number` | `2` | `2` / `4` / `8` | 空格缩进宽度（`indentStyle: tab` 时忽略） |
| `keywordCase` | `string` | `"upper"` | `upper` / `lower` / `preserve` | 保留字大小写 |
| `functionCase` | `string` | `"lower"` | `upper` / `lower` / `preserve` | 内置函数名大小写 |
| `identifierCase` | `string` | `"preserve"` | `upper` / `lower` / `preserve` | 未加引号标识符大小写；**双引号标识符与字符串永不改写** |
| `commaPosition` | `string` | `"trailing"` | `trailing` / `leading` | 逗号置于行尾，或作为新行行首 |
| `clauseNewline` | `boolean` | `true` | — | 是否让 `SELECT` / `FROM` / `WHERE` / `GROUP BY` / `ORDER BY` 等主子句各起一行 |
| `selectListNewline` | `string` | `"auto"` | `always` / `auto` / `never` | 选择列表是否逐列换行；`auto` 表示仅当该行超过 `lineWidth`（且 `lineWidth > 0`）时换行 |
| `lineWidth` | `number` | `100` | `0` / `80` / `100` / `120` | 软性行宽上限（字符数）；`0` 表示不限制 |
| `parenNewline` | `boolean` | `false` | — | 括号内是否换行并缩进（函数参数、`IN` 列表等） |
| `logicalIndent` | `boolean` | `true` | — | 子句内的 `AND` / `OR` 是否换行并缩进 |
| `blankLines` | `string` | `"collapse"` | `preserve` / `collapse` | 原有多余空行是保留，还是压缩为单行 |

归一化规则：缺失字段补默认、类型或取值不符回退默认、未知字段丢弃（`normalizeConfig`）。

### 13.3 Oracle / PostgreSQL 方言差异

| 维度 | Oracle | PostgreSQL |
| --- | --- | --- |
| 标识符引号 | 双引号 `"..."` | 双引号 `"..."` |
| 字符串 | `'...'`（`''` 转义）、`q'[...]'`、`n'...'` | `'...'`（`''` 转义）、`E'...'`（反斜杠转义）、`$tag$...$tag$` 美元引用 |
| 分页 | `ROWNUM` / `FETCH FIRST ... ROWS ONLY` | `LIMIT ... OFFSET ...` |
| 特有保留字 | `ROWNUM` `DUAL` `NVL` `DECODE` `VARCHAR2` `NVARCHAR2` `NUMBER` `MINUS` `CONNECT` `START` `PRIOR` | `RETURNING` `ILIKE` `SERIAL` `BIGSERIAL` `JSONB` `ARRAY` `CONFLICT` `MATERIALIZED` |
| 特有运算符/语法 | `(+)` 外连接标记、PL/SQL 块与 `/` 结束符 | `::` 类型转换、`->` / `->>` / `#>` JSON 取值 |
| 大小写习惯 | 未加引号标识符按大写存储 | 未加引号标识符按小写存储 |

两方言共用「标准 SQL 保留字基集」，再各自并入方言特有保留字。**方言只影响识别集合与该类的
折行/大小写处理，不改变配置文件格式**。

### 13.4 内置预设（= 一组参数取值，不得含专属逻辑）

| id | 名称 | 参数要点 |
| --- | --- | --- |
| `standard` | 标准（默认） | 全默认值（Oracle / 2 空格 / 关键字大写 / 每子句换行） |
| `compact` | 紧凑风格 | `clauseNewline:false`、`selectListNewline:"never"`、`logicalIndent:false` |
| `expanded` | 展开风格 | `selectListNewline:"always"`、`parenNewline:true`、`logicalIndent:true` |
| `leading-comma` | 前导逗号 | `commaPosition:"leading"` |
| `lowercase` | 关键字小写 | `keywordCase:"lower"`、`functionCase:"lower"` |
| `indent-4` | 四空格缩进 | `indentWidth:4` |
| `tab-indent` | Tab 缩进 | `indentStyle:"tab"` |
| `postgres` | PostgreSQL 惯例 | `dialect:"postgres"` |
| `oracle` | Oracle 惯例 | `dialect:"oracle"` |

新增预设只需向 `BUILTIN_PRESETS` 追加数据，禁止为其编写任何分支代码（R7）。

### 13.5 编辑器能力规格

- **实现方式（零依赖）**：`textarea`（透明文字，承担输入、选区、光标与浏览器原生撤销）
  + 高亮覆盖层（`<pre>` 内按逻辑行分块的 `<span>`）+ 左侧行号槽；三者共用同一套字体、
  行高、内边距与软换行规则，纵向滚动通过 `transform` 同步。
- **语法高亮层级**：保留字（`--accent` 系）、数据类型与内置函数（`--warn` 系）、
  字符串（`--ok` 系）、数字（`--info` 系）、注释（`--text-faint` 斜体）、
  运算符与标点（`--text-muted`）、双引号标识符、绑定变量；普通标识符使用默认文字色。
  明暗双主题均满足 WCAG AA，且信息不单靠颜色传达。
- **关键词搜索**：搜索条默认收起，`Ctrl/Cmd + F` 展开并聚焦；支持「区分大小写」与
  「全词匹配」；显示「当前序号 / 命中总数」；`Enter` / `Shift + Enter` 与上/下一个按钮
  循环定位并把当前命中滚动进可视区；命中项浅底高亮，当前命中额外描边；无命中时给出可读提示。
- **选中相同文本全部高亮**：当选区非空、不含换行、长度 ≤ **64** 字符时，自动高亮全文
  所有相同出现处（区分大小写），样式与搜索命中可区分；选区变化立即重算。
- **行号**：逻辑行逐行编号（`aria-hidden`），随内容软换行高度自适应，纵向滚动同步。
- **括号匹配**：光标邻近 `()` / `[]` / `{}` 时与配对括号共同高亮；未配对时仅光标侧括号
  以 `--danger` 错误态呈现。
- **Tab / 自动缩进**：`Tab` 单行插入一个缩进单位、多行选区整体缩进；`Shift + Tab` 反缩进；
  `Enter` 按当前行缩进与括号深度自动续缩进；缩进改动优先走
  `document.execCommand("insertText")` 以保留浏览器原生撤销，失败时降级为
  `setRangeText` + 手动派发 `input` 事件。
- **快捷键**：`Ctrl/Cmd + Enter` 格式化；`Ctrl/Cmd + F` 搜索；`Tab` / `Shift + Tab` 缩进；
  `Esc` 依次关闭最上层内联面板并收起搜索条。
- **格式化是显式动作（重要）**：本工具的输入区与结果区是**同一块画布**，因此参数（含方言、预设）
  的改动只影响**下一次**格式化，**不会**在编辑过程中自动改写正文——否则会持续打断用户输入、
  破坏撤销栈。唯一入口是「格式化」按钮与 `Ctrl/Cmd + Enter`；选项面板的提示文案必须如实写明
  「点『格式化』后生效」，不得写成「即时生效」。
- **格式化必须覆盖式替换（重要）**：格式化结果用于**整体替换编辑区现有内容**（含用户当前选区），
  **绝不**插入到光标处。实现上有两条硬性要求，缺一即出缺陷：
  1. 写入前必须让编辑区**取回焦点**。点击「格式化」按钮后焦点在按钮上，此时 `document.execCommand`
     的编辑命令会静默失效或落到旧的插入点，表现为「格式化结果被拼接到原文后面」；
  2. 必须先**全选**现有内容再写入，并在写入后**校验实际结果**（值是否真的改变），未生效时退化为
     `setRangeText`——`execCommand` 会在失败时返回 `true`，不可只依据返回值判断。
  写入完成后光标归位到文档开头，并清除选中相同文本的高亮。

### 13.6 渲染与性能约定

- 高亮渲染使用 **`requestAnimationFrame` 合并**（而非 180ms 防抖）：高亮必须逐键跟随输入，
  防抖会造成明显迟滞；§6 的 180ms 防抖针对的是「结果类实时计算」（如《文本行合并》的预览）。
  统计数字（行数 / 字符数 / 光标位置）同步即时更新。
- 高亮层整层用**一次字符串拼接 + 一次赋值**渲染，不逐 token 建 DOM。
- **同一命中跨多个 token 时必须合并为一个标记元素**：`a.id` 这类命中会覆盖 `a` / `.` / `id`
  三个 token，若每个 token 段各套一个 `<mark>`，圆角与「当前命中」描边会被切断成多块。
  正确做法是按「同一标记覆盖的连续段」合并，只输出**一个** `<mark>`，其内部再按 token 分别着色。
- 滚动同步只在 rAF 中写一次 `transform`，不在 `scroll` 回调里直接读写布局。
- **超大输入保护**：文本超过 **300000** 字符时停止语法高亮与搜索高亮，仅保留纯文本编辑，
  并给出可读提示；此时也不计算选中相同文本高亮。
- 命中渲染上限 **5000** 条，超出只渲染前 5000 条并提示。
- 高亮层与行号槽的 HTML 由用户输入派生，**全部文本必须经 `dom.escapeHtml` 转义**后再拼接。

### 13.7 导入 / 导出

- 导出结构：

  ```json
  {
    "app": "local-toolbox",
    "tool": "sql-format",
    "version": 1,
    "exportedAt": "ISO-8601",
    "config": { },
    "presets": [{ "name": "…", "config": { } }]
  }
  ```

- 与《文本行合并》一致：导出与「复制 JSON」在无自定义预设时禁用并给出提示；
  导入支持「选择 `.json` 文件」与「粘贴 JSON 文本」两条路径并共用同一校验函数；
  同名以导入内容为准覆盖；**导入只恢复预设，不改动当前正在编辑的 SQL 与当前参数**；
  完成后回报 `导入完成：新增 N 条，覆盖 M 条[，超出上限跳过 K 条][，忽略非法 J 条]`。
- 上限：自定义预设 **200** 条，名称 **40** 字符。

### 13.8 边界行为（必须保持）

| 场景 | 行为 |
| --- | --- |
| 输入为空点击「格式化」 | 提示「暂无可格式化的内容。」，不写入任何文本 |
| SQL 含未闭合字符串/注释 | 不抛错；未闭合部分整体作为一个 token，格式化不破坏其内容 |
| 输入含 `--` 行注释 | 注释内容不被改写大小写，且其后同行内容不参与折行重排 |
| 文本超过 300000 字符 | 跳过高亮与搜索高亮，提示「文本过大，已关闭高亮以保证流畅」 |
| 搜索框内容为空 | 不产生命中，计数区为空 |
| 搜索无命中 | 提示「未找到匹配项。」，不移动光标 |
| 选中内容含换行或超过 64 字符 | 不做相同文本高亮 |
| 光标在括号内或紧邻括号 | 高亮配对括号；未配对时仅光标侧括号转为错误态 |
| 格式化时存在挂起的高亮渲染 | 先结算挂起渲染，再读取编辑器当前文本进行格式化 |
| 点击「格式化」按钮（焦点在按钮上） | **覆盖式替换**编辑区全部内容，绝不插入到光标处（见 §13.5） |
| 编辑区存在选区时点击「格式化」 | 选区连同全文一起被格式化结果覆盖，且写入后光标归位到开头 |
| 搜索命中跨越多个 token（如 `a.id`） | 只生成一个 `<mark>`，高亮连续不断裂（见 §13.6） |
| 重复点击「格式化」 | 结果幂等，提示「当前内容已是该格式，无需调整。」 |
| 剪贴板不可用 | 提示「复制失败，请手动选择文本复制。」 |
| `localStorage` 不可用 | 提示仅在当前页面内有效，功能不中断 |

### 13.9 纯函数 API（可导出、可脱离 DOM 验证）

```js
export const DEFAULT_CONFIG;
export const BUILTIN_PRESETS;
export const DIALECTS;                              // ['oracle', 'postgres']
export function normalizeConfig(partial);
export function configEquals(a, b);
export function tokenize(sql, dialect);             // → [{ type, value, start, end }]
export function buildBracketPairs(tokens);          // → Map<index, index>
export function findMatches(text, query, options);  // → [{ start, end }]
export function formatSql(sql, config);             // → 格式化后的 SQL
export function serializePresets(presets, cfg);
export function parseImportPayload(raw);
export function loadCustomPresets() / saveCustomPresets(list);
export function loadSession() / saveSession(config, presetId);
```

### 13.10 存储键

| 键 | 内容 |
| --- | --- |
| `toolbox:sql-format:presets` | 自定义预设列表 |
| `toolbox:sql-format:config` | 上次使用的参数与预设选择 |

**SQL 文本本身不做任何持久化**（R5），输入内容只存在于内存与当前 DOM。

---

## 附录 A：令牌速查

```
颜色    --bg-base --bg-surface --bg-inset --bg-sunken --bg-hover --bg-active --bg-scrim
        --text-strong --text-body --text-muted --text-faint --text-invert
        --hairline --hairline-strong
        --accent --accent-hover --accent-soft --accent-ring --accent-contrast
        --ok --ok-soft --warn --warn-soft --danger --danger-soft --info --info-soft
字体    --font-sans --font-mono
字号    --fs-display --fs-h1 --fs-h2 --fs-h3 --fs-body --fs-sm --fs-xs
字重    --fw-regular --fw-medium --fw-semibold
行高    --lh-tight --lh-normal --lh-loose
字距    --tracking-tight --tracking-label
间距    --sp-1 --sp-2 --sp-3 --sp-4 --sp-5 --sp-6 --sp-8 --sp-10 --sp-12 --sp-16
圆角    --r-xs --r-sm --r-md --r-lg --r-pill
阴影    --shadow-1 --shadow-2 --shadow-3
动效    --dur-fast --dur-base --dur-slow --ease-out --ease-in-out
布局    --sidebar-w --sidebar-w-collapsed --topbar-h --content-max
纹理    --grid-line --grid-size
```

## 附录 B：关键常量

| 位置 | 常量 | 值 |
| --- | --- | --- |
| `text-line-merge.js` | `DEBOUNCE_MS` | 180 |
| | `FEEDBACK_MS` | 2000（状态行实际清除 = ×2 = 4000ms） |
| | 复制按钮复原 | 1500ms |
| | 删除确认超时 | 3000ms |
| | `MAX_PRESETS` | 200 |
| | `MAX_NAME_LENGTH` | 40 |
| | `EXPORT_VERSION` | 1 |
| `shell.js` | `SIDEBAR_KEY` | `toolbox:sidebar` |
| | `NARROW_MEDIA` | `(max-width: 900px)` |
| `theme.js` | `THEME_KEY` | `toolbox:theme` |
| `sql-format.js` | `DEBOUNCE_MS` | 0（高亮走 rAF 合并，见 §13.6） |
| | `FEEDBACK_MS` | 2000（状态行实际清除 = ×2 = 4000ms） |
| | 复制按钮复原 | 1500ms |
| | 删除确认超时 | 3000ms |
| | `MAX_PRESETS` | 200 |
| | `MAX_NAME_LENGTH` | 40 |
| | `EXPORT_VERSION` | 1 |
| | `MAX_HIGHLIGHT_CHARS` | 300000 |
| | `MAX_MATCHES` | 5000 |
| | `MAX_SAME_SELECTION` | 64 |
