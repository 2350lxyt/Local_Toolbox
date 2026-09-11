# 本地工具箱 · 设计文档

> **本文档是本项目的设计基准（Single Source of Truth）。**
> 后续任何功能调整都必须先比对本文档；若确需改变既定设计，**必须先更新本文档并写明变更理由**，再改动代码。
> 提交信息的正文中请引用相关章节（例如 `refs docs/DESIGN.md §10.3`）。

- 文档版本：1.0.0
- 最近更新：2026-09-11
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
| `> 1080px` | 标准形态：工具页 7:5 非对称双栏、首页 7:5 主视觉 |
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
- 侧边栏内容自上而下：品牌区 → 工具列表（含 `.nav__label` 计数）→ 隐私声明脚注。
- 顶栏高度 `--topbar-h 56px`，sticky；含收起按钮、面包屑、右侧「本地计算」徽标与主题按钮。
- 收起状态持久化于 `toolbox:sidebar`，取值 `expanded | collapsed`。

### 4.2 内容区

- `.workspace`：`max-width: --content-max 1280px`，左对齐（不居中），内边距 `--sp-8` ~ `--sp-12`。
- 首页区块顺序：主视觉（7:5 非对称）→ 章节标题 → 工具卡片网格 → 页脚。
- 工具页区块顺序：工具头部 → **预设工具条**（如有）→ 内联面板（另存为 / 导入 / 错误）→ 7:5 双栏（左输入，右选项与统计）→ 整宽结果区 → 页脚。

### 4.3 工具卡片与列表现状

- 工具卡片：图标 + 状态徽标 + 名称 + 说明 + `tool-id` 元信息 + 箭头；`status: planned` 时边框为虚线。
- 列表项：图标 + 名称 + 状态徽标；当前项左侧 3px 强调色竖条 + 底色高亮 + `aria-current="page"`。

---

## 5. 组件规范

> 通用组件定义在 `assets/css/tool.css`；外壳组件在 `assets/css/shell.css`。新增工具应优先复用，不得重复造轮子。

| 组件 | 类名 | 要点 |
| --- | --- | --- |
| 面板 | `.panel` `.panel__head` `.panel__body` `.panel__foot` | 表面色 + 发丝描边 + `--shadow-1`；头尾用 `--bg-inset` |
| 双栏 | `.panel-grid`（7:5） / `.panel-stack` | `≤1080px` 折叠为单列 |
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
- **选项区**：分隔符 / 前缀 / 后缀（各带**效果片段**如 `甲,乙`、`'甲`）；处理规则三个复选框；转义分组（转义字符 + 转义方式）在未启用转义时呈**虚线禁用态**。
- **实时预览**：输入与选项变化后 180ms 防抖刷新；「合并」按钮与 `Ctrl/Cmd+Enter` 立即结算。
- **结果区**：空输入显示空状态，有结果显示单行文本；「复制结果」成功后按钮变勾号 +「已复制」并转绿 1500ms；「下载为 .txt」使用本地 Blob。
- **统计**：输入行数 / 参与合并行数 / 输出字符数（`countChars` 按码点）。
- **输入面板**：文本域 + 「清空」+ `Ctrl+Enter` 快捷键提示 + 实时行数小标签。

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
| 引入一个 UI 库 / 图标库 | **D** | 违反 R3/R4，必须先取得明确同意 |
| 加一个「云端同步预设」 | **D** | 违反 R1/R2/R5，必须先取得明确同意 |
| 把用户输入缓存到本地以便恢复 | **D** | 违反 R5，必须先取得明确同意 |

### 11.2 提交纪律

- 仅在明确要求时提交；提交信息使用**中文** + Conventional Commits 规范；必要时按功能分批提交。
- **严禁**提交任何密钥、令牌、口令、私钥、`.env`、个人身份信息、包含用户名的绝对路径。
- 提交前自检：`git status` 是否包含不该出现的文件；是否误提交了 `.codebuddy/`、临时脚本、本地导出文件。

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
