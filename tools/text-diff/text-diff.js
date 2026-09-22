/**
 * 《文本对比》
 * ==================================================================
 * 工具 id：text-diff（docs/DESIGN.md §15）
 *
 * 分层（§9.3）：
 *   ① 纯函数内核  ── diff-core.js（差分/统计/折叠/搜索）+ highlight.js（代码高亮），可在 Node 中直接断言；
 *   ② 存储适配层  ── 只持久化**选项**（`toolbox:text-diff:config`，按实例分区）；
 *   ③ UI 编排层   ── 编辑器表面（透明 textarea + 高亮层 + 行号槽）、三视图、搜索、导航、拖拽。
 *
 * 关键约定：
 *   - 两侧文本内容、搜索关键词、拖入的文件内容**一律不落盘**（R5）；
 *   - 编辑器表面为「透明 textarea 叠加高亮层」：textarea 负责输入/选区/IME/撤销，高亮层负责渲染；
 *   - 可编辑视图**不插入占位行**（textarea 内容必须与用户文本逐字一致），
 *     因此该视图按「原始行 1:1」渲染，两栏滚动用**行号映射**同步；
 *   - 占位行与折叠只存在于**只读渲染视图**（统一 / 折叠）；
 *   - 模块内不得有任何可变模块级状态（多实例共享同一模块，§9.3 第 8 条）。
 */

import {
  AUTO_VIEW_MIN_WIDTH,
  CONTEXT_VALUES,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  MAX_FOLD_RENDER_ROWS,
  MAX_HIGHLIGHT_CHARS,
  VIEW_VALUES,
  configEquals,
  diffLines,
  diffWords,
  findMatches,
  foldRows,
  normalizeConfig,
  splitText,
  textMetrics,
} from "./diff-core.js";
import { LANGUAGE_LIST, LANGUAGES, detectLanguage, mergeSegments, tokenizeLines } from "./highlight.js";

const CONFIG_KEY = "toolbox:text-diff:config";
const DEBOUNCE_MS = 180;
const STATUS_CLEAR_MS = 4000;
/** 单次渲染最多做多少行的词级细化（避免超大差异把渲染拖慢） */
const MAX_WORD_DIFF_ROWS = 600;
/**
 * 差异缩略图宽度（px）。
 * 实际宽度由 CSS 决定（`.td-minimap { width: 14px }`，CSS 无法引用 JS 常量），
 * 这里保留常量是为了与 §15.13 / 附录 B 的登记一致：**两处需同时维护**。
 */
const MINIMAP_WIDTH = 14;
/** 单个差异标记的最小高度：保证只有一行的差异不因取整而消失 */
const MINIMAP_MIN_MARK_PX = 2;
/** 差异块超过此数则把相邻标记聚合为连续色带，避免上万个 DOM 节点 */
const MINIMAP_MAX_MARKS = 400;
/** 跳转后目标行落在可视区的纵向位置（1/3 处，视线更自然） */
const SCROLL_ANCHOR_RATIO = 1 / 3;
/** 分隔线：命中区宽度（px，与 text-diff.css 的 .td-split__splitter 一致） */
const SPLITTER_W = 7;
/** 分隔线：任一侧的最小宽度（px）——拖动时换算成比例下限，避免把某一侧拖到看不见 */
const MIN_PANE_WIDTH = 160;
/** 分隔线：键盘调整步长（比例，2%） */
const SPLIT_STEP = 0.02;
/** 分隔线：持久化比例的可接受范围（超出回退 50:50） */
const SPLIT_RATIO_MIN = 0.05;
const SPLIT_RATIO_MAX = 0.95;
/** 分隔线：默认与重置值（等宽） */
const SPLIT_DEFAULT = 0.5;
/** 拖动分隔线期间：行号槽行高同步的节流间隔（ms）——软换行下该同步是 O(行数)，每帧全量会掉帧 */
const DRAG_GUTTER_SYNC_MS = 120;
/** 分隔线比例的存储键与结构版本（§15.11；跨实例共享的纯视图偏好） */
const SPLIT_KEY = "toolbox:text-diff:split";
const SPLIT_VERSION = 1;

/** 按实例推导配置键（§8.1：serial <= 1 沿用默认键） */
function sessionKeyOf(instance) {
  return instance && instance.serial > 1 ? `${CONFIG_KEY}:${instance.serial}` : CONFIG_KEY;
}

/* ────────────────────────────────────────────────────────────────
 * 模板
 * ──────────────────────────────────────────────────────────────── */

const TEMPLATE = `
<p class="td-status" id="td-status" role="status" aria-live="polite"></p>

<div class="notice notice--danger" data-error hidden>
  <span class="notice__icon" aria-hidden="true">__I_ALERT__</span>
  <div class="notice__body">
    <p class="notice__title">操作失败</p>
    <p class="notice__text" data-error-text></p>
  </div>
</div>

<!-- 置顶紧凑工具条：只放高频操作（视图切换 / 差异导航 / 搜索），选项收进「更多选项」 -->
<div class="td-topbar" data-topbar>
  <div class="td-views" role="group" aria-label="视图切换">
    <button class="td-view-btn" type="button" data-view="auto">自动</button>
    <button class="td-view-btn" type="button" data-view="side">并排</button>
    <button class="td-view-btn" type="button" data-view="unified">统一</button>
  </div>

  <div class="td-nav" role="group" aria-label="差异导航">
    <button class="td-icon-btn" type="button" data-action="prev-diff" title="上一个差异（Shift + F7）" aria-label="上一个差异">__I_UP__</button>
    <button class="td-icon-btn" type="button" data-action="next-diff" title="下一个差异（F7）" aria-label="下一个差异">__I_DOWN__</button>
    <span class="td-nav__count" data-diff-count role="status">无差异</span>
  </div>

  <span class="td-topbar__spacer"></span>

  <!-- 搜索条槽位：并排视图下两条搜索条各自挂在所属栏的面板头里（§15.7），
       只读渲染视图（统一 / 折叠）没有面板头，此时临时挂到这个槽位 -->
  <div class="td-searchbar" data-search-bar hidden></div>

  <button class="td-options-toggle" type="button" data-action="toggle-options" aria-expanded="false" aria-controls="td-options">
    更多选项 __I_DOWN__
  </button>
</div>

<!-- 折叠区：不常改的选项（字号 / 语言 / 对比口径 / 显示开关 / 上下文 / 图例） -->
<div class="td-options" id="td-options" data-options hidden>
  <div class="td-options__grid">
    <div class="td-field">
      <label class="td-field__label" for="td-font">字号（px）</label>
      <input class="input" type="number" id="td-font" data-role="fontSize" step="1" />
    </div>
    <div class="td-field">
      <label class="td-field__label" for="td-lang">代码高亮语言</label>
      <select class="select" id="td-lang" data-role="language"></select>
    </div>
    <div class="td-field">
      <label class="td-field__label" for="td-context">上下文行数（折叠相同行）</label>
      <select class="select" id="td-context" data-role="context"></select>
    </div>
    <div class="td-field">
      <span class="td-field__label">显示</span>
      <div class="td-field__row">
        <label class="checkbox"><input type="checkbox" data-role="softWrap" /><span>软换行</span></label>
        <label class="checkbox"><input type="checkbox" data-role="inlineHighlight" /><span>行内高亮</span></label>
        <label class="checkbox"><input type="checkbox" data-role="syncScroll" /><span>滚动同步</span></label>
      </div>
    </div>
    <div class="td-field td-field--wide">
      <span class="td-field__label">对比选项（只影响判定，不改写原文）</span>
      <div class="td-field__row">
        <label class="checkbox"><input type="checkbox" data-role="ignoreCase" /><span>忽略大小写</span></label>
        <label class="checkbox"><input type="checkbox" data-role="ignoreTrailingSpace" /><span>忽略首尾空白</span></label>
        <label class="checkbox"><input type="checkbox" data-role="ignoreAllSpace" /><span>忽略全部空白</span></label>
        <label class="checkbox"><input type="checkbox" data-role="ignoreBlankLines" /><span>忽略空行</span></label>
        <label class="checkbox"><input type="checkbox" data-role="ignoreLineEnding" /><span>忽略行尾符</span></label>
      </div>
    </div>
  </div>

  <ul class="td-legend">
    <li class="td-legend__item"><span class="td-legend__swatch td-legend__swatch--insert" aria-hidden="true"></span>新增行（<span class="mono">+</span>）</li>
    <li class="td-legend__item"><span class="td-legend__swatch td-legend__swatch--delete" aria-hidden="true"></span>删除行（<span class="mono">−</span>）</li>
    <li class="td-legend__item"><span class="td-legend__swatch td-legend__swatch--modify" aria-hidden="true"></span>修改行（<span class="mono">~</span>）</li>
    <li class="td-legend__item"><span class="td-legend__swatch td-legend__swatch--word" aria-hidden="true"></span>行内变动的词（加强底纹 + 下缘实色条）</li>
    <li class="td-legend__item"><span class="td-legend__swatch td-legend__swatch--placeholder" aria-hidden="true"></span>无对应行（仅只读视图）</li>
  </ul>
</div>

<!-- 紧凑统计条：一行放下四个数字与相似度，省出垂直空间给对比区 -->
<div class="td-meta">
  <span class="td-meta__item td-meta__item--insert">新增 <b data-stat="insert">0</b></span>
  <span class="td-meta__item td-meta__item--delete">删除 <b data-stat="delete">0</b></span>
  <span class="td-meta__item td-meta__item--modify">修改 <b data-stat="modify">0</b></span>
  <span class="td-meta__item">相同 <b data-stat="same">0</b></span>
  <span class="td-meta__item" data-summary></span>
</div>

<div class="td-main" data-main>
  <div class="td-split" data-view-side>
    <section class="td-pane" data-side="left">
      <div class="td-pane__head">
        <h2 class="td-pane__title">左侧</h2>
        <label class="btn btn--ghost" for="td-file-left">__I_UP__ 选择文件…</label>
        <input class="sr-only" type="file" id="td-file-left" data-file="left" />
        <button class="btn btn--ghost" type="button" data-action="open-search" data-side="left" aria-label="搜索左栏">__I_SEARCH__ 搜索</button>
        <div class="td-search" data-search="left" hidden>
          <input class="input" type="search" data-search-input="left" aria-label="在左栏搜索" placeholder="左栏查找…" />
          <label class="checkbox"><input type="checkbox" data-search-case="left" /><span>Aa</span></label>
          <label class="checkbox"><input type="checkbox" data-search-word="left" /><span>词</span></label>
          <button class="td-icon-btn" type="button" data-action="search-prev" data-side="left" title="上一个匹配（Shift + Enter）" aria-label="左栏上一个匹配">__I_UP__</button>
          <button class="td-icon-btn" type="button" data-action="search-next" data-side="left" title="下一个匹配（Enter）" aria-label="左栏下一个匹配">__I_DOWN__</button>
          <span class="td-search__count" data-search-count="left" role="status">0 / 0</span>
          <button class="td-icon-btn" type="button" data-action="search-close" data-side="left" title="关闭左栏搜索" aria-label="关闭左栏搜索">__I_CLOSE__</button>
        </div>
      </div>
      <div class="td-editor" data-editor="left">
        <div class="td-gutter" data-gutter="left" aria-hidden="true"></div>
        <div class="td-surface">
          <div class="td-layer" data-layer="left" aria-hidden="true"></div>
          <textarea class="td-input" data-input="left" spellcheck="false" wrap="off" aria-label="左侧文本"></textarea>
        </div>
      </div>
    </section>

    <!-- 可拖拽分隔条（§15.1）：视觉是居中 1px 发丝线，命中区 7px（触屏 14px）；
         键盘可调整（← / → 各 2%，Home / End 到极值，Enter 或双击恢复等宽） -->
    <div
      class="td-split__splitter"
      data-splitter
      role="separator"
      aria-orientation="vertical"
      aria-label="左右栏宽度"
      title="拖动调整左右栏宽度；双击或回车恢复等宽"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow="50"
      tabindex="0"
    ><span class="td-split__splitter-line" aria-hidden="true"></span></div>

    <section class="td-pane" data-side="right">
      <div class="td-pane__head">
        <h2 class="td-pane__title">右侧</h2>
        <label class="btn btn--ghost" for="td-file-right">__I_UP__ 选择文件…</label>
        <input class="sr-only" type="file" id="td-file-right" data-file="right" />
        <button class="btn btn--ghost" type="button" data-action="open-search" data-side="right" aria-label="搜索右栏">__I_SEARCH__ 搜索</button>
        <div class="td-search" data-search="right" hidden>
          <input class="input" type="search" data-search-input="right" aria-label="在右栏搜索" placeholder="右栏查找…" />
          <label class="checkbox"><input type="checkbox" data-search-case="right" /><span>Aa</span></label>
          <label class="checkbox"><input type="checkbox" data-search-word="right" /><span>词</span></label>
          <button class="td-icon-btn" type="button" data-action="search-prev" data-side="right" title="上一个匹配（Shift + Enter）" aria-label="右栏上一个匹配">__I_UP__</button>
          <button class="td-icon-btn" type="button" data-action="search-next" data-side="right" title="下一个匹配（Enter）" aria-label="右栏下一个匹配">__I_DOWN__</button>
          <span class="td-search__count" data-search-count="right" role="status">0 / 0</span>
          <button class="td-icon-btn" type="button" data-action="search-close" data-side="right" title="关闭右栏搜索" aria-label="关闭右栏搜索">__I_CLOSE__</button>
        </div>
      </div>
      <div class="td-editor" data-editor="right">
        <div class="td-gutter" data-gutter="right" aria-hidden="true"></div>
        <div class="td-surface">
          <div class="td-layer" data-layer="right" aria-hidden="true"></div>
          <textarea class="td-input" data-input="right" spellcheck="false" wrap="off" aria-label="右侧文本"></textarea>
        </div>
      </div>
    </section>
  </div>

  <div class="td-single" data-view-rendered hidden>
    <div class="td-editor td-editor--rendered">
      <div class="td-gutter" data-gutter="rendered" aria-hidden="true"></div>
      <div class="td-surface">
        <div class="td-layer" data-layer="rendered"></div>
      </div>
    </div>
    <p class="field__hint" data-rendered-note></p>
  </div>

  <!-- 差异缩略图（§15.13）：装饰性视觉导航，键盘等价路径是 F7 / 上一个下一个差异 -->
  <div class="td-minimap" data-minimap aria-hidden="true"></div>
</div>
`;

/** 模板中的图标占位符 → [icons.js 键, 尺寸] */
const ICON_TOKENS = {
  __I_ALERT__: ["alert", 18],
  __I_UP__: ["chevronUp", 15],
  __I_DOWN__: ["chevronDown", 15],
  __I_SEARCH__: ["search", 15],
  __I_CLOSE__: ["close", 14],
};

/** 行级差异在行号槽里的符号（不只靠颜色传达） */
const KIND_MARK = Object.freeze({ insert: "+", delete: "−", modify: "~", same: "" });
/** 统一视图的行前缀 */
const KIND_PREFIX = Object.freeze({ insert: "+", delete: "−", same: " " });

/* ────────────────────────────────────────────────────────────────
 * 入口
 * ──────────────────────────────────────────────────────────────── */

/**
 * @param {Object} ctx 外壳注入的上下文（§9.3）
 * @returns {Function} 清理函数：注销全部监听、定时器、rAF 与 ResizeObserver
 */
export function init(ctx) {
  const { root, utils, icons } = ctx;
  const { dom } = utils;

  const host = root.querySelector("[data-tool-body]") || root.querySelector("#tool-body");
  if (!host) return () => {};

  const uid = `td-${ctx.instance && ctx.instance.serial ? ctx.instance.serial : 1}`;
  const sessionKey = sessionKeyOf(ctx.instance);

  host.innerHTML = TEMPLATE.replace(/(id="|for="|aria-labelledby="|aria-controls=")td-/g, (match, prefix) => `${prefix}${uid}-`).replace(
    /__I_\w+__/g,
    (token) => {
      const entry = ICON_TOKENS[token];
      return entry ? icons.icon(entry[0], entry[1]) : "";
    }
  );

  const el = (selector) => host.querySelector(selector);
  const qsa = (selector) => Array.from(host.querySelectorAll(selector));

  const nodes = {
    status: el(`#${uid}-status`),
    error: el("[data-error]"),
    errorText: el("[data-error-text]"),
    context: el('[data-role="context"]'),
    fontSize: el('[data-role="fontSize"]'),
    language: el('[data-role="language"]'),
    softWrap: el('[data-role="softWrap"]'),
    inlineHighlight: el('[data-role="inlineHighlight"]'),
    syncScroll: el('[data-role="syncScroll"]'),
    ignoreCase: el('[data-role="ignoreCase"]'),
    ignoreTrailingSpace: el('[data-role="ignoreTrailingSpace"]'),
    ignoreAllSpace: el('[data-role="ignoreAllSpace"]'),
    ignoreBlankLines: el('[data-role="ignoreBlankLines"]'),
    ignoreLineEnding: el('[data-role="ignoreLineEnding"]'),
    diffCount: el("[data-diff-count]"),
    summary: el("[data-summary]"),
    stats: {
      insert: el('[data-stat="insert"]'),
      delete: el('[data-stat="delete"]'),
      modify: el('[data-stat="modify"]'),
      same: el('[data-stat="same"]'),
    },
    split: el("[data-view-side]"),
    rendered: el("[data-view-rendered]"),
    renderedGutter: el('[data-gutter="rendered"]'),
    renderedLayer: el('[data-layer="rendered"]'),
    renderedNote: el("[data-rendered-note]"),
    main: el("[data-main]"),
    minimap: el("[data-minimap]"),
    splitter: el("[data-splitter]"),
    paneHead: {
      left: el('[data-side="left"] .td-pane__head'),
      right: el('[data-side="right"] .td-pane__head'),
    },
    searchButton: {
      left: el('[data-action="open-search"][data-side="left"]'),
      right: el('[data-action="open-search"][data-side="right"]'),
    },
    editor: { left: el('[data-editor="left"]'), right: el('[data-editor="right"]') },
    gutter: { left: el('[data-gutter="left"]'), right: el('[data-gutter="right"]') },
    layer: { left: el('[data-layer="left"]'), right: el('[data-layer="right"]') },
    input: { left: el('[data-input="left"]'), right: el('[data-input="right"]') },
    searchBar: el("[data-search-bar]"),
    optionsToggle: el('[data-action="toggle-options"]'),
    optionsPanel: el("[data-options]"),
    search: { left: el('[data-search="left"]'), right: el('[data-search="right"]') },
    searchInput: { left: el('[data-search-input="left"]'), right: el('[data-search-input="right"]') },
    searchCase: { left: el('[data-search-case="left"]'), right: el('[data-search-case="right"]') },
    searchWord: { left: el('[data-search-word="left"]'), right: el('[data-search-word="right"]') },
    searchCount: { left: el('[data-search-count="left"]'), right: el('[data-search-count="right"]') },
    fileInput: { left: el('[data-file="left"]'), right: el('[data-file="right"]') },
  };

  if (!nodes.split || !nodes.input.left || !nodes.input.right || !nodes.renderedLayer) return () => {};

  /** 只读渲染视图的滚动容器（与并排的两栏不同，它没有 textarea） */
  nodes.renderedEditor = nodes.rendered.querySelector(".td-editor");

  /* ── 资源池 ─────────────────────────────────────────────── */
  const timers = { debounce: 0, status: 0 };
  const disposers = [];
  const bind = (target, type, handler, options) => {
    disposers.push(dom.on(target, type, handler, options));
  };
  const clearTimer = (key) => {
    if (timers[key]) {
      window.clearTimeout(timers[key]);
      timers[key] = 0;
    }
  };

  /* ── 状态（每个实例一份）───────────────────────────────── */
  const state = {
    config: normalizeConfig(readStoredConfig()),
    text: { left: "", right: "" },
    result: null,
    model: { left: null, right: null },
    rowOfLine: { left: [], right: [] },
    lineOfRow: { left: [], right: [] },
    currentBlock: -1,
    expanded: new Set(),
    /** 当前只读视图里「被折叠区间」的行范围（缩略图点进去时用于先展开再滚动，§15.13） */
    foldGaps: [],
    search: { left: { hits: [], index: -1 }, right: { hits: [], index: -1 } },
    syncing: false,
    /** 两栏分隔比例（纯视图状态，不属 §15.2 参数模型；持久化在 toolbox:text-diff:split） */
    split: SPLIT_DEFAULT,
    /** 是否正在拖动分隔线（拖动中只改比例 + rAF 重排，不写存储） */
    splitting: false,
    /** 拖动中最近一次「行号槽行高同步」的时间戳（节流用，见 DRAG_GUTTER_SYNC_MS） */
    splitGutterAt: 0,
    renderRaf: 0,
    layoutRaf: 0,
    viewportRaf: 0,
    jumpRaf: 0,
    syncHoldRaf: 0,
    /**
     * 行号槽行高同步过的「层宽度」：宽度不变时折行结果不变，避免每次重排都做 O(行数) 的同步。
     * 注意键必须是**层自己的宽度**而不是容器宽度——缩略图显示/隐藏、竖向滚动条出现都会改变层宽，
     * 而容器宽度不变（§15.5）。
     */
    gutterSyncWidth: { left: -1, right: -1, rendered: -1 },
    /** 缩略图上一次写入的几何（避免无谓写样式） */
    minimapTop: -1,
    minimapHeight: -1,
    minimapHidden: null,
    /** 缩略图拖拽状态与最近一次指针位置（拖拽中只滚动，松手才更新导航状态） */
    dragging: false,
    pointerRow: null,
    storageWarned: false,
    detected: "",
    focusSide: "left",
  };

  function readStoredConfig() {
    try {
      const raw = window.localStorage.getItem(sessionKey);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && parsed.config ? parsed.config : {};
    } catch (error) {
      return {};
    }
  }

  function writeStoredConfig() {
    try {
      window.localStorage.setItem(sessionKey, JSON.stringify({ config: state.config }));
      return true;
    } catch (error) {
      return false;
    }
  }

  /* ── 反馈 ───────────────────────────────────────────────── */
  function setStatus(message, tone) {
    clearTimer("status");
    nodes.status.textContent = message || "";
    if (!message) {
      delete nodes.status.dataset.tone;
      return;
    }
    nodes.status.dataset.tone = tone || "info";
    timers.status = window.setTimeout(() => {
      nodes.status.textContent = "";
      delete nodes.status.dataset.tone;
    }, STATUS_CLEAR_MS);
  }

  function showError(message) {
    nodes.errorText.textContent = message;
    nodes.error.hidden = false;
  }

  function clearError() {
    nodes.error.hidden = true;
    nodes.errorText.textContent = "";
  }

  function warnStorageOnce() {
    if (state.storageWarned) return;
    state.storageWarned = true;
    showError("本地存储不可用（可能处于无痕模式），本次的选项仅在当前页面内有效。");
  }

  /* ── 选项读写 ───────────────────────────────────────────── */
  function readConfig() {
    const next = normalizeConfig({
      view: state.config.view === "auto" || state.config.view === "side" || state.config.view === "unified" ? state.config.view : "auto",
      context: nodes.context.value === "all" ? "all" : Number(nodes.context.value),
      softWrap: nodes.softWrap.checked,
      fontSize: Number(nodes.fontSize.value),
      language: nodes.language.value,
      inlineHighlight: nodes.inlineHighlight.checked,
      syncScroll: nodes.syncScroll.checked,
      ignoreCase: nodes.ignoreCase.checked,
      ignoreTrailingSpace: nodes.ignoreTrailingSpace.checked,
      ignoreAllSpace: nodes.ignoreAllSpace.checked,
      ignoreBlankLines: nodes.ignoreBlankLines.checked,
      ignoreLineEnding: nodes.ignoreLineEnding.checked,
      searchCaseSensitive: nodes.searchCase.left.checked && nodes.searchCase.right.checked,
      searchWholeWord: nodes.searchWord.left.checked && nodes.searchWord.right.checked,
    });
    next.view = state.config.view; // 视图由按钮驱动，不从表单读
    return next;
  }

  function writeConfigToForm(config) {
    nodes.context.value = String(config.context);
    nodes.fontSize.value = String(config.fontSize);
    nodes.language.value = config.language;
    nodes.softWrap.checked = config.softWrap;
    nodes.inlineHighlight.checked = config.inlineHighlight;
    nodes.syncScroll.checked = config.syncScroll;
    nodes.ignoreCase.checked = config.ignoreCase;
    nodes.ignoreTrailingSpace.checked = config.ignoreTrailingSpace;
    nodes.ignoreAllSpace.checked = config.ignoreAllSpace;
    nodes.ignoreBlankLines.checked = config.ignoreBlankLines;
    nodes.ignoreLineEnding.checked = config.ignoreLineEnding;
    nodes.searchCase.left.checked = config.searchCaseSensitive;
    nodes.searchCase.right.checked = config.searchCaseSensitive;
    nodes.searchWord.left.checked = config.searchWholeWord;
    nodes.searchWord.right.checked = config.searchWholeWord;
  }

  function commitConfig(next, options = {}) {
    if (!configEquals(next, state.config)) {
      state.config = next;
      if (!writeStoredConfig()) warnStorageOnce();
    }
    if (options.render !== false) scheduleRender();
  }

  /* ── 有效视图 ───────────────────────────────────────────── */
  function effectiveView() {
    if (state.config.view !== "auto") return state.config.view;
    const width = nodes.main.clientWidth || 0;
    return width >= AUTO_VIEW_MIN_WIDTH ? "side" : "unified";
  }

  function isReadOnlyView() {
    return effectiveView() === "unified" || state.config.context !== "all";
  }

  /* ── 计算与渲染调度 ─────────────────────────────────────── */
  function scheduleCompute() {
    clearTimer("debounce");
    timers.debounce = window.setTimeout(compute, DEBOUNCE_MS);
  }

  function compute() {
    clearTimer("debounce");
    state.result = diffLines(state.text.left, state.text.right, state.config);
    if (state.result.degraded) setStatus(state.result.reason, "warn");
    scheduleRender();
  }

  function scheduleRender() {
    if (state.renderRaf) return;
    state.renderRaf = window.requestAnimationFrame(() => {
      state.renderRaf = 0;
      renderAll();
    });
  }

  /* ── 行模型：把差分行映射回两侧原始行 ───────────────────── */
  function buildSideModel(side) {
    const other = side === "left" ? "right" : "left";
    const source = state.text[side];
    const lines = splitText(source).lines.map((line) => line.text);
    const otherLines = splitText(state.text[other]).lines.map((line) => line.text);
    const kinds = new Array(lines.length).fill("same");
    const rowOfLine = new Array(lines.length).fill(0);
    const lineOfRow = new Array(state.result.rows.length).fill(null);
    const wordSegments = new Map();

    let wordBudget = MAX_WORD_DIFF_ROWS;

    state.result.rows.forEach((row, rowIndex) => {
      const ownIndex = side === "left" ? row.left : row.right;
      const otherIndex = side === "left" ? row.right : row.left;
      if (ownIndex !== null) {
        rowOfLine[ownIndex] = rowIndex;
        lineOfRow[rowIndex] = ownIndex;
        if (row.kind !== "same") kinds[ownIndex] = row.kind;
      }

      if (row.kind !== "modify" || ownIndex === null || otherIndex === null) return;
      if (!state.config.inlineHighlight || wordBudget <= 0) return;
      wordBudget -= 1;
      const ownLine = lines[ownIndex] === undefined ? "" : lines[ownIndex];
      const otherLine = otherLines[otherIndex] === undefined ? "" : otherLines[otherIndex];
      const pair = side === "left" ? diffWords(ownLine, otherLine, state.config) : diffWords(otherLine, ownLine, state.config);
      if (!pair) return;
      wordSegments.set(ownIndex, side === "left" ? pair.left : pair.right);
    });

    // 代码高亮（超长文本自动关闭并在界面提示）
    let tokens = null;
    const metrics = textMetrics(source);
    const languageId = state.config.language;
    if (languageId !== "text" && metrics.chars > 0 && metrics.chars <= MAX_HIGHLIGHT_CHARS) {
      tokens = tokenizeLines(lines, languageId);
    }

    const term = nodes.searchInput[side].value;
    const matches = term
      ? findMatches(
          source,
          term,
          Object.assign({}, state.config, {
            searchCaseSensitive: nodes.searchCase[side].checked,
            searchWholeWord: nodes.searchWord[side].checked,
          })
        )
      : [];
    const hitsByLine = new Map();
    matches.forEach((hit, index) => {
      if (!hitsByLine.has(hit.line)) hitsByLine.set(hit.line, []);
      hitsByLine.get(hit.line).push({ start: hit.start, end: hit.end, index });
    });

    return { side, lines, kinds, rowOfLine, lineOfRow, wordSegments, tokens, hitsByLine, matches };
  }

  /* ── 渲染：片段 → HTML ──────────────────────────────────── */
  function escapeHtml(value) {
    return dom.escapeHtml(value);
  }

  function segmentHtml(segments, hits, currentHitIndex) {
    if (!segments || segments.length === 0) return "";
    let html = "";
    let cursor = 0;

    segments.forEach((segment) => {
      const text = segment.text;
      const start = cursor;
      const end = cursor + text.length;
      cursor = end;

      const typeClass = segment.type ? ` td-tok-${segment.type}` : "";
      const changedClass = segment.changed ? " td-seg--changed" : "";
      const lineHits = (hits || []).filter((hit) => hit.start < end && hit.end > start);

      if (lineHits.length === 0) {
        html += `<span class="td-seg${typeClass}${changedClass}">${escapeHtml(text)}</span>`;
        return;
      }

      // 命中与片段取交集后按边界切分（保证与差异底纹叠加而不互相破坏）
      let offset = start;
      lineHits.forEach((hit) => {
        const from = Math.max(hit.start, start);
        const to = Math.min(hit.end, end);
        if (from > offset) {
          html += `<span class="td-seg${typeClass}${changedClass}">${escapeHtml(text.slice(offset - start, from - start))}</span>`;
        }
        if (to > from) {
          const current = hit.index === currentHitIndex ? " td-seg--hit-current" : "";
          html += `<span class="td-seg td-seg--hit${typeClass}${changedClass}${current}">${escapeHtml(text.slice(from - start, to - start))}</span>`;
        }
        offset = to;
      });
      if (offset < end) {
        html += `<span class="td-seg${typeClass}${changedClass}">${escapeHtml(text.slice(offset - start))}</span>`;
      }
    });

    return html;
  }

  function lineSegments(model, lineIndex) {
    const text = model.lines[lineIndex] === undefined ? "" : model.lines[lineIndex];
    const words = model.wordSegments.get(lineIndex) || null;
    if (model.tokens) return mergeSegments(model.tokens[lineIndex] || [], words);
    if (words) return words.map((segment) => ({ text: segment.text, type: "plain", changed: segment.changed }));
    return [{ text, type: "plain", changed: false }];
  }

  /* ── 渲染：可编辑视图（一栏 = 行号槽 + 高亮层 + 透明 textarea）── */
  function renderEditor(side) {
    const model = state.model[side];
    const gutter = nodes.gutter[side];
    const layer = nodes.layer[side];
    const input = nodes.input[side];
    const hits = model.matches.length > 0 ? model.hitsByLine : null;
    const currentHit = state.search[side].index;

    let gutterHtml = "";
    let layerHtml = "";

    model.lines.forEach((line, index) => {
      const kind = model.kinds[index];
      const mark = kind === "same" ? "" : KIND_MARK[kind];
      const rowIndex = model.rowOfLine[index];
      const isCurrent = state.currentBlock >= 0 && state.result.blocks[state.currentBlock]
        ? rowIndex >= state.result.blocks[state.currentBlock].rowStart && rowIndex <= state.result.blocks[state.currentBlock].rowEnd
        : false;

      gutterHtml += `<div class="td-gutter__row td-gutter__row--${kind}${isCurrent ? " td-gutter__row--current" : ""}"><span class="td-gutter__mark">${mark}</span><span class="td-gutter__num">${index + 1}</span></div>`;
      layerHtml += `<div class="td-row td-row--${kind}${isCurrent ? " td-row--current" : ""}">${segmentHtml(lineSegments(model, index), hits ? hits.get(index) : null, currentHit)}</div>`;
    });

    if (model.lines.length === 0) {
      // 占位行两侧各来一个：保持「行号槽 ↔ 高亮层按下标 1:1 成对」这一不变量（空侧也不破例，
      // 行高同步依赖它；行号槽的占位行是空的，视觉上与改动前一致）
      gutterHtml =
        '<div class="td-gutter__row"><span class="td-gutter__mark"></span><span class="td-gutter__num"></span></div>';
      layerHtml = '<div class="td-row"><span class="td-seg td-tok-plain">（空）</span></div>';
    }

    gutter.innerHTML = gutterHtml;
    layer.innerHTML = layerHtml;

    if (input.value !== state.text[side]) input.value = state.text[side];
    // 让 textarea 与内容等高，滚动完全由外层 .td-editor 承担
    input.style.height = `${layer.scrollHeight}px`;
    // 层宽由 CSS 的 `width: max-content`（未软换行时，见 §15.5）原生算好，这里同步 textarea 的宽度，
    // 保证输入层与高亮层几何一致（光标/选区不错位）
    input.style.width = `${Math.max(layer.scrollWidth, nodes.editor[side].clientWidth - nodes.gutter[side].offsetWidth)}px`;
  }

  /* ── 渲染：只读视图（统一 / 折叠）───────────────────────── */
  function renderReadOnly() {
    const left = state.model.left;
    const right = state.model.right;
    const segments = foldRows(state.result.rows, state.config.context, state.expanded);
    const renderable = segments.reduce((sum, segment) => sum + (segment.type === "gap" ? 1 : segment.rows.length), 0);

    state.foldGaps = [];

    if (renderable > MAX_FOLD_RENDER_ROWS) {
      nodes.renderedNote.textContent = `折叠视图需渲染约 ${renderable} 行，超过上限 ${MAX_FOLD_RENDER_ROWS} 行；请把「上下文行数」切到「只看差异」或缩小输入。`;
      nodes.renderedGutter.innerHTML = "";
      nodes.renderedLayer.innerHTML = "";
      return;
    }

    nodes.renderedNote.textContent =
      state.config.context === "all"
        ? "统一视图为只读展示：切到「并排」即可编辑。"
        : "折叠视图为只读：把「上下文行数」切回「全部」即可编辑；点击折叠条可展开该段。";

    let gutterHtml = "";
    let layerHtml = "";
    // 只读视图里「视觉行」与「源行」不是一一对应（修改行占两行、折叠占一行），
    // 因此把所有行都标上 data-row，导航时按源行精确滚动
    let sourceRow = 0;

    const pushRow = (side, lineIndex, kind, prefix, note, rowIndex) => {
      const model = side === "left" ? left : right;
      const mark = prefix === " " ? (note || "") : prefix;
      const number = lineIndex === null ? "" : String(lineIndex + 1);
      const block = state.currentBlock >= 0 ? state.result.blocks[state.currentBlock] : null;
      const current = Boolean(block) && rowIndex >= block.rowStart && rowIndex <= block.rowEnd;
      const segs = lineIndex === null ? [] : lineSegments(model, lineIndex);
      const hits = lineIndex !== null && model.hitsByLine.has(lineIndex) ? model.hitsByLine.get(lineIndex) : null;

      gutterHtml += `<div class="td-gutter__row td-gutter__row--${kind}${current ? " td-gutter__row--current" : ""}" data-row="${rowIndex}"><span class="td-gutter__mark">${mark}</span><span class="td-gutter__num">${number}</span></div>`;
      layerHtml += `<div class="td-row td-row--${kind}${current ? " td-row--current" : ""}" data-row="${rowIndex}"><span class="td-row__prefix">${prefix === " " ? "&nbsp;&nbsp;" : escapeHtml(prefix + " ")}</span>${segmentHtml(segs, hits, state.search[side].index)}</div>`;
    };

    segments.forEach((segment) => {
      if (segment.type === "gap") {
        // 记录折叠区间的行范围：缩略图点进这段时要先展开再滚动（§15.13）
        state.foldGaps.push({ key: segment.key, start: sourceRow, end: sourceRow + segment.count });
        gutterHtml += `<div class="td-gutter__row" data-row="${sourceRow}"><span class="td-gutter__mark"></span><span class="td-gutter__num"></span></div>`;
        layerHtml += `<div class="td-row td-row--placeholder" data-row="${sourceRow}"><button class="td-fold" type="button" data-fold="${escapeHtml(segment.key)}" aria-expanded="false">⋯ 折叠 ${segment.count} 行相同内容（点击展开）⋯</button></div>`;
        sourceRow += segment.count;
        return;
      }

      segment.rows.forEach((row) => {
        if (row.kind === "same") pushRow("left", row.left, "same", " ", "", sourceRow);
        else if (row.kind === "delete") pushRow("left", row.left, "delete", "−", "", sourceRow);
        else if (row.kind === "insert") pushRow("right", row.right, "insert", "+", "", sourceRow);
        else {
          pushRow("left", row.left, "modify", "−", "~", sourceRow);
          pushRow("right", row.right, "modify", "+", "~", sourceRow);
        }
        sourceRow += 1;
      });
    });

    nodes.renderedGutter.innerHTML = gutterHtml;
    nodes.renderedLayer.innerHTML = layerHtml;
  }

  /* ── 渲染：统计 / 计数 / 视图切换 ───────────────────────── */
  function renderStats() {
    const stats = state.result.stats;
    nodes.stats.insert.textContent = String(stats.insert);
    nodes.stats.delete.textContent = String(stats.delete);
    nodes.stats.modify.textContent = String(stats.modify);
    nodes.stats.same.textContent = String(stats.same);

    if (stats.base === 0) {
      nodes.summary.textContent = "两侧均为空：粘入文本或拖入文件后开始对比。";
      return;
    }

    const percent = Math.round(stats.similarity * 1000) / 10;
    const language = effectiveLanguage();
    const auto = state.config.language === "auto";
    nodes.summary.textContent =
      `相似度 ${percent}%（口径：相同 ${stats.same} 行 ÷ 较大侧 ${stats.base} 行）` +
      (language ? ` · 代码高亮：${languageLabel(language)}${auto ? "（自动识别）" : ""}` : "");
  }

  function renderNav() {
    const total = state.result.blocks.length;
    const has = total > 0;
    qsa('[data-action="prev-diff"], [data-action="next-diff"]').forEach((button) => {
      button.disabled = !has;
    });
    if (!has) {
      nodes.diffCount.textContent = "两侧内容一致";
      return;
    }
    // 差异过多时缩略图会聚合显示，就在计数旁说明，避免用户以为漏画了标记
    const suffix = total > MINIMAP_MAX_MARKS ? "（缩略图已聚合）" : "";
    nodes.diffCount.textContent =
      state.currentBlock < 0 ? `共 ${total} 处差异${suffix}` : `第 ${state.currentBlock + 1} / ${total} 处差异`;
  }

  function renderViewSwitch() {
    // 折叠档位（context 非 all）必须是只读渲染视图——textarea 物理上无法折叠行（§15.4）
    const view = isReadOnlyView() ? "unified" : effectiveView();
    nodes.split.hidden = view !== "side";
    nodes.rendered.hidden = view === "side";
    qsa("[data-view]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.view === state.config.view);
      button.setAttribute("aria-pressed", String(button.dataset.view === state.config.view));
    });
    host.dataset.wrap = state.config.softWrap ? "on" : "off";
    host.style.setProperty("--td-font-size", `${state.config.fontSize}px`);
    // textarea 的换行行为必须与高亮层保持一致：关闭软换行时用 wrap="off"，否则 textarea 会自行折行而与高亮层错位
    ["left", "right"].forEach((side) => {
      nodes.input[side].wrap = state.config.softWrap ? "soft" : "off";
    });
  }

  function renderSearchBars() {
    ["left", "right"].forEach((side) => {
      const term = nodes.searchInput[side].value;
      const hits = state.search[side].hits;
      const current = state.search[side].index >= 0 ? state.search[side].index + 1 : 0;
      nodes.searchCount[side].textContent = term ? `${current} / ${hits.length}` : "0 / 0";
    });
    // 归属与槽位可见性统一交给 placeSearchBars：并排 → 各自面板头；只读视图 → 顶栏槽位
    placeSearchBars();
  }

  /* ── 行号槽对齐（软换行，§15.5 硬性）────────────────────── */
  /**
   * 修复「软换行下行号错位」。
   * 行号槽与高亮层是**两列独立 DOM**：长行只在层里折行（该行因此变高），行号槽那一行恒为单行高，
   * 于是从第一条折行的行开始，行号会**逐行累积错位**。
   * 两列严格按索引 1:1 成对（唯一可依赖的不变量），故按下标配对同步行高即可，无需重构 DOM
   * （重构会丢掉行号槽整列底色与 sticky 左固定、以及只读视图的 data-row 导航语义）。
   * @param {boolean} force 刚重建过行元素时必须同步；否则仅在容器宽度变化时才需要（宽度不变 → 行高不变）
   */
  function syncGutterHeights(force) {
    const pairs = [
      ["left", nodes.gutter.left, nodes.layer.left],
      ["right", nodes.gutter.right, nodes.layer.right],
      ["rendered", nodes.renderedGutter, nodes.renderedLayer],
    ];

    if (!state.config.softWrap) {
      // 关闭软换行时各行等高等宽，无需同步（行元素每次渲染都是新建的，不会残留上次的行高）
      pairs.forEach(([key]) => {
        state.gutterSyncWidth[key] = -1;
      });
      return;
    }

    pairs.forEach(([key, gutter, layer]) => {
      // 另一档视图不可见时行高为 0，跳过，避免把 0 写进行号槽
      if (!gutter || !layer || layer.offsetParent === null) {
        state.gutterSyncWidth[key] = -1;
        return;
      }
      const width = layer.clientWidth;
      if (!force && width === state.gutterSyncWidth[key]) return;
      state.gutterSyncWidth[key] = width;

      const rows = layer.children;
      const cells = gutter.children;
      const heights = new Array(rows.length);
      // 先集中读完再集中写：读—写交替会触发逐行重排，代价高得多。
      // 必须取 rect（小数）而不是 offsetHeight（整数）：行高是「1.6 × 字号」这类小数，
      // 逐行取整会累积成可见错位（长文档下每行差 0.4px，几百行就是上百像素）。
      for (let index = 0; index < rows.length; index += 1) {
        heights[index] = rows[index].getBoundingClientRect().height;
      }
      // 按「累计高度」回写：每格写的是「到本行为止的目标累计高度 − 已写累计高度」，
      // 这样即使浏览器对显式高度做子像素取整，两列的累计偏移也严格一致，误差不累积。
      let target = 0;
      let written = 0;
      for (let index = 0; index < heights.length; index += 1) {
        target += heights[index];
        const cell = cells[index];
        // 行号槽与高亮层按下标 1:1 成对；下标错位（异常输入）时放弃本次同步，绝不写出错误高度
        if (!cell) return;
        cell.style.height = `${target - written}px`;
        written = target;
      }
    });
  }

  /** 当前可见对比区的滚动容器（并排取左栏：两侧按行同步，滚动比例一致） */
  function activeScroller() {
    return nodes.split.hidden ? nodes.renderedEditor : nodes.editor.left;
  }

  /**
   * 轻量重排：只重新实测高度、同步行号槽行高与缩略图几何，**不重建 DOM**。
   * 容器宽度变化会改变折行结果（行高随之变化），因此不能只在视图自动切换时才响应。
   */
  function scheduleLayoutSync() {
    if (state.layoutRaf) return;
    state.layoutRaf = window.requestAnimationFrame(() => {
      state.layoutRaf = 0;
      updateEditorHeight();
      // 先定缩略图的几何：它显示/隐藏会改变对比区宽度，进而改变折行结果，
      // 因此必须在同步行高**之前**完成（否则会按旧宽度量出偏小的行高）。
      updateMinimapGeometry();
      syncGutterHeights(false);
      updateMinimapViewport();
    });
  }

  /**
   * 让对比区吃满「视口内剩余高度」：页面本身不滚动，滚动只发生在编辑器内部。
   * 高度由 JS 实测（而非写死 vh 常量），因此选项折叠展开、工具栏换行都能自适应。
   */
  function updateEditorHeight() {
    const activeEditor = activeScroller();
    if (!activeEditor) return;

    const scroller = nodes.main.closest(".pane__view");
    const bottom = scroller ? scroller.getBoundingClientRect().bottom : window.innerHeight;
    // 面板自身的内边距 + 编辑器下方的一切（面板页脚、外边距、提示行等）都会占用滚动高度，
    // 因此不用「逐项累加预估」，而是按实测差值一次性收敛（高度与内容底边是 1:1 关系，一次即准）
    const panel = nodes.main.closest(".tabpanel");
    const panelPaddingBottom = panel ? parseFloat(window.getComputedStyle(panel).paddingBottom) || 0 : 0;
    const mainRect = nodes.main.getBoundingClientRect();
    // main 之下、面板内容底边之上还有面板页脚与外边距；其高度与编辑器高度无关，可实测后一次性扣除
    const belowMain = panel
      ? Math.max(0, Math.round(panel.getBoundingClientRect().bottom - panelPaddingBottom - mainRect.bottom))
      : 0;
    const target = bottom - panelPaddingBottom - belowMain - 8;

    const current = Number(nodes.main.dataset.editorH || 0);
    const overflow = Math.round(mainRect.bottom - target);
    const base = current || Math.round(target - activeEditor.getBoundingClientRect().top);
    const height = Math.max(280, Math.min(1200, Math.round(base - overflow)));

    if (current === height) return;
    nodes.main.dataset.editorH = String(height);
    nodes.main.style.setProperty("--td-editor-h", `${height}px`);
  }

  /* ── 差异缩略图（§15.13）────────────────────────────────── */
  /** 聚合时的着色优先级：修改 > 删除 > 新增（一段里只要含修改就按修改着色） */
  const MARK_PRIORITY = Object.freeze({ insert: 0, delete: 1, modify: 2 });

  /** 差异块过多时把相邻块并成连续色带，避免上万个 DOM 节点把渲染拖慢 */
  function minimapMarks(blocks) {
    if (blocks.length <= MINIMAP_MAX_MARKS) return { marks: blocks, aggregated: false };
    const step = Math.ceil(blocks.length / MINIMAP_MAX_MARKS);
    const marks = [];
    for (let index = 0; index < blocks.length; index += step) {
      const slice = blocks.slice(index, index + step);
      let kind = "insert";
      slice.forEach((block) => {
        if (MARK_PRIORITY[block.kind] > MARK_PRIORITY[kind]) kind = block.kind;
      });
      marks.push({ rowStart: slice[0].rowStart, rowEnd: slice[slice.length - 1].rowEnd, kind });
    }
    return { marks, aggregated: true };
  }

  /** 标记几何：按「对齐行空间」的比例映射（与软换行、滚动位置都无关） */
  function layoutMinimapMarks() {
    const track = nodes.minimap;
    if (!track) return;
    const total = state.result && state.result.rows ? state.result.rows.length : 0;
    const height = track.clientHeight;
    if (!total || height < 1) return;

    Array.from(track.querySelectorAll("[data-mark]")).forEach((mark) => {
      const start = Number(mark.dataset.rowStart || 0);
      const end = Number(mark.dataset.rowEnd || start);
      const top = Math.min(Math.round((start / total) * height), Math.max(0, height - 1));
      const size = Math.max(MINIMAP_MIN_MARK_PX, Math.round(((end - start + 1) / total) * height));
      mark.style.top = `${top}px`;
      mark.style.height = `${Math.max(MINIMAP_MIN_MARK_PX, Math.min(size, height - top))}px`;
    });
  }

  function renderMinimap() {
    const track = nodes.minimap;
    if (!track) return;
    const blocks = state.result ? state.result.blocks : [];
    const current = state.currentBlock >= 0 ? blocks[state.currentBlock] : null;
    const { marks, aggregated } = minimapMarks(blocks);

    track.dataset.state = blocks.length === 0 ? "clean" : "diff";
    track.title = aggregated
      ? `差异缩略图：共 ${blocks.length} 处差异，已聚合显示；点击或拖动可跳转到对应位置`
      : "差异缩略图：点击或拖动可跳转到对应位置";

    const html = marks
      .map((block, index) => {
        const isCurrent = Boolean(current) && block.rowStart <= current.rowEnd && block.rowEnd >= current.rowStart;
        return `<span class="td-minimap__mark td-minimap__mark--${block.kind}${
          isCurrent ? " is-current" : ""
        }" data-mark="${index}" data-row-start="${block.rowStart}" data-row-end="${block.rowEnd}"></span>`;
      })
      .join("");

    // 视口带排在最前，标记绘制在其上；每次整体重建，因此视口位置由 updateMinimapViewport 重写
    track.innerHTML = `<span class="td-minimap__view" data-minimap-view hidden></span>${html}`;
    layoutMinimapMarks();
    updateMinimapViewport();
  }

  /** 缩略图的纵向几何：必须与「编辑器区域」对齐（并排视图里编辑器上方还有面板头，只能实测） */
  function updateMinimapGeometry() {
    const track = nodes.minimap;
    if (!track || !nodes.main) return;
    const scroller = activeScroller();
    const mainRect = nodes.main.getBoundingClientRect();
    const editorRect = scroller ? scroller.getBoundingClientRect() : null;
    // 对比区不可见（标签未激活）或尚未布局时，没有可对齐的几何
    const hidden = (nodes.split.hidden && nodes.rendered.hidden) || !editorRect || editorRect.height < 1 || mainRect.height < 1;

    if (hidden) {
      if (state.minimapHidden !== true) {
        state.minimapHidden = true;
        track.hidden = true;
      }
      return;
    }

    const top = Math.round(editorRect.top - mainRect.top);
    const height = Math.round(editorRect.height);
    if (state.minimapHidden === false && state.minimapTop === top && state.minimapHeight === height) return;
    state.minimapHidden = false;
    state.minimapTop = top;
    state.minimapHeight = height;
    track.hidden = false;
    track.style.marginTop = `${top}px`;
    track.style.height = `${height}px`;
    layoutMinimapMarks();
  }

  /** 视口带：表示当前可见的行范围（并排以左栏的滚动比例代表，两侧按行同步） */
  function updateMinimapViewport() {
    const track = nodes.minimap;
    if (!track || track.hidden) return;
    const view = track.querySelector("[data-minimap-view]");
    const scroller = activeScroller();
    if (!view || !scroller) return;

    const range = scroller.scrollHeight - scroller.clientHeight;
    const height = track.clientHeight;
    if (range <= 1 || height < 1) {
      view.hidden = true;
      return;
    }
    view.hidden = false;
    view.style.top = `${Math.round((scroller.scrollTop / scroller.scrollHeight) * height)}px`;
    view.style.height = `${Math.max(6, Math.round((scroller.clientHeight / scroller.scrollHeight) * height))}px`;
  }

  /** 滚动事件高频触发，视口带更新用 rAF 合并 */
  function scheduleMinimapViewport() {
    if (state.viewportRaf) return;
    state.viewportRaf = window.requestAnimationFrame(() => {
      state.viewportRaf = 0;
      updateMinimapViewport();
    });
  }

  /* ── 跳转（缩略图点击 / 拖动，§15.13）────────────────────── */
  /**
   * 精确滚动：把目标元素放到容器的 1/3 处。
   * 软换行下行高不等，**禁止**用「行号 × 行高」估算（那是关闭软换行时的算法）。
   */
  function scrollElementInto(container, element) {
    if (!container || !element) return;
    const containerRect = container.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const offset =
      container.scrollTop + (elementRect.top - containerRect.top) - container.clientHeight * SCROLL_ANCHOR_RATIO;
    const max = Math.max(0, container.scrollHeight - container.clientHeight);
    container.scrollTop = Math.max(0, Math.min(max, offset));
  }

  /**
   * 显式跳转期间暂停「被动滚动同步」。
   * 否则程序化滚动产生的 scroll 事件会让另一侧按行同步（顶部对齐）覆盖掉本侧的 1/3 落点，
   * 两侧虽仍对齐，但落点位置与用户点击的位置不再对应（§15.13）。
   * 保持两个帧：程序化滚动引发的 scroll 事件必定在下一帧内派发完毕。
   */
  function holdSyncDuringJump() {
    state.syncing = true;
    if (state.syncHoldRaf) return;
    state.syncHoldRaf = window.requestAnimationFrame(() => {
      state.syncHoldRaf = window.requestAnimationFrame(() => {
        state.syncHoldRaf = 0;
        state.syncing = false;
      });
    });
  }

  /** 该侧在某个对齐行上「最近的实际行」（插入行只存在于另一侧，该侧此行为空） */
  function nearestLineOfRow(side, rowIndex) {
    const map = state.model[side] ? state.model[side].lineOfRow : null;
    if (!map) return null;
    for (let index = rowIndex; index >= 0; index -= 1) {
      if (map[index] !== null && map[index] !== undefined) return map[index];
    }
    for (let index = rowIndex + 1; index < map.length; index += 1) {
      if (map[index] !== null && map[index] !== undefined) return map[index];
    }
    return null;
  }

  /** 只读视图里找不到精确行时取最近的一个（折叠段的占位行只在段首带 data-row） */
  function nearestRenderedRow(target) {
    let best = null;
    let distance = Infinity;
    Array.from(nodes.renderedLayer.querySelectorAll("[data-row]")).forEach((row) => {
      const gap = Math.abs(Number(row.dataset.row) - target);
      if (gap < distance) {
        distance = gap;
        best = row;
      }
    });
    return best;
  }

  /**
   * 跳到「对齐行空间」的某一行。
   * 并排视图两侧一起跳——跳转是**显式指令**，不受「滚动同步」开关影响；
   * 只读视图里目标行若被折叠，先展开该段再滚动（§15.13）。
   * @returns {boolean} 是否成功定位
   */
  function scrollToRow(rowIndex) {
    const total = state.result && state.result.rows ? state.result.rows.length : 0;
    if (total === 0) return false;
    const target = Math.max(0, Math.min(total - 1, Math.round(rowIndex)));

    if (effectiveView() === "side") {
      holdSyncDuringJump();
      let moved = false;
      ["left", "right"].forEach((side) => {
        const line = nearestLineOfRow(side, target);
        if (line === null) return;
        const element = nodes.layer[side].children[line];
        if (!element) return;
        scrollElementInto(nodes.editor[side], element);
        moved = true;
      });
      return moved;
    }

    const gap = state.foldGaps.find((entry) => target >= entry.start && target < entry.end);
    if (gap) {
      state.expanded.add(gap.key);
      renderAll();
    }

    const element = nodes.renderedLayer.querySelector(`[data-row="${target}"]`) || nearestRenderedRow(target);
    if (!element) {
      setStatus("该位置在当前折叠视图下无法显示，请把「上下文行数」切到「全部」。", "warn");
      return false;
    }
    scrollElementInto(nodes.renderedEditor, element);
    return true;
  }

  /** 指针位置 → 对齐行索引 */
  function rowAtPointer(event) {
    const track = nodes.minimap;
    const total = state.result && state.result.rows ? state.result.rows.length : 0;
    const height = track ? track.clientHeight : 0;
    if (!track || !total || height < 1) return null;
    const rect = track.getBoundingClientRect();
    const offset = event.clientY - rect.top - track.clientTop;
    const ratio = Math.max(0, Math.min(1, offset / height));
    return Math.min(total - 1, Math.floor(ratio * total));
  }

  function blockIndexAtRow(row) {
    if (!state.result) return -1;
    return state.result.blocks.findIndex((block) => row >= block.rowStart && row <= block.rowEnd);
  }

  /** 拖动中只滚动（rAF 合并）；导航状态与重渲染留到松手时做，避免每帧重建 DOM */
  function scheduleMinimapJump() {
    if (state.jumpRaf) return;
    state.jumpRaf = window.requestAnimationFrame(() => {
      state.jumpRaf = 0;
      if (state.pointerRow === null) return;
      scrollToRow(state.pointerRow);
      updateMinimapViewport();
    });
  }

  /** 落点：同步「当前差异块」与计数（与 F7 / 上一个下一个差异保持一致） */
  function finishMinimapJump() {
    state.dragging = false;
    const row = state.pointerRow;
    state.pointerRow = null;
    if (row === null) return;

    const index = blockIndexAtRow(row);
    if (index >= 0) {
      if (index !== state.currentBlock) {
        state.currentBlock = index;
        renderAll();
      }
      scrollToRow(row);
      setStatus(`已跳到第 ${index + 1} / ${state.result.blocks.length} 处差异`, "ok");
      return;
    }

    scrollToRow(row);
    setStatus(`已跳到第 ${row + 1} 行（该位置不是差异行）`, "info");
  }

  function renderAll() {
    state.model.left = buildSideModel("left");
    state.model.right = buildSideModel("right");

    ["left", "right"].forEach((side) => {
      state.search[side].hits = state.model[side].matches;
      const count = state.search[side].hits.length;
      // 首次出现命中即自动定位到第一个，避免计数停在「0 / N」（与浏览器查找行为一致）
      if (count === 0) state.search[side].index = -1;
      else if (state.search[side].index < 0 || state.search[side].index >= count) state.search[side].index = 0;
    });

    renderViewSwitch();
    renderStats();
    renderNav();
    renderSearchBars();
    renderEditor("left");
    renderEditor("right");
    renderReadOnly();
    // 顺序要紧：先按实测高度把对比区定下来，再同步行号槽行高、最后排布缩略图
    updateEditorHeight();
    syncGutterHeights(true);
    renderMinimap();
    updateMinimapGeometry();
    updateMinimapViewport();
  }

  /** 「更多选项」折叠区：不常改的选项收进这里，把垂直空间让给对比区 */
  function toggleOptions(force) {
    const next = typeof force === "boolean" ? force : nodes.optionsPanel.hidden;
    nodes.optionsPanel.hidden = !next;
    nodes.optionsToggle.setAttribute("aria-expanded", String(next));
    updateEditorHeight();
    // 展开/收起会改变编辑器的可用高度（进而改变竖向滚动条与层的可用宽度），补一次轻量重排
    scheduleLayoutSync();
  }

  /* ── 语言 ───────────────────────────────────────────────── */
  function effectiveLanguage() {
    if (state.config.language === "text") return "";
    if (state.config.language !== "auto") return state.config.language;
    return state.detected || detectLanguage(state.text.left || state.text.right);
  }

  function languageLabel(id) {
    const entry = LANGUAGES[id];
    return entry ? entry.label : id;
  }

  function renderLanguageOptions() {
    nodes.language.innerHTML = LANGUAGE_LIST.map(
      (entry) => `<option value="${escapeHtml(entry.id)}">${escapeHtml(entry.label)}</option>`
    ).join("");
  }

  /** 上下文档位由常量驱动渲染，避免界面与规格漂移 */
  function renderContextOptions() {
    const labels = { all: "全部（可编辑）", 10: "10 行", 3: "3 行", 1: "1 行", 0: "只看差异" };
    nodes.context.innerHTML = CONTEXT_VALUES.map(
      (value) => `<option value="${String(value)}">${escapeHtml(labels[value] || String(value))}</option>`
    ).join("");
  }

  /* ── 差异导航 ───────────────────────────────────────────── */
  function goToBlock(delta) {
    const total = state.result.blocks.length;
    if (total === 0) {
      setStatus("两侧内容一致，没有差异可跳转。", "warn");
      return;
    }
    const next = state.currentBlock < 0 ? (delta > 0 ? 0 : total - 1) : (state.currentBlock + delta + total) % total;
    state.currentBlock = next;
    renderAll();
    scrollToBlock();
    setStatus(`已跳到第 ${next + 1} / ${total} 处差异`, "ok");
  }

  function scrollToBlock() {
    const block = state.result.blocks[state.currentBlock];
    if (!block) return;
    const view = effectiveView();

    if (view === "side") {
      const leftLine = firstLineInBlock("left", block);
      const rightLine = firstLineInBlock("right", block);
      scrollEditorToLine("left", leftLine);
      scrollEditorToLine("right", rightLine);
      return;
    }

    const target = nodes.renderedLayer.querySelector(`[data-row="${block.rowStart}"]`);
    if (target && typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "center" });
  }

  function firstLineInBlock(side, block) {
    for (let index = block.rowStart; index <= block.rowEnd; index += 1) {
      const row = state.result.rows[index];
      const line = side === "left" ? row.left : row.right;
      if (line !== null) return line;
    }
    return null;
  }

  /**
   * 跳到某一侧的行（差异导航与搜索都走这里）。
   * 按目标行元素**实测**定位——软换行下行高不等，「行号 × 行高」的估算会偏（§15.5）。
   */
  function scrollEditorToLine(side, line) {
    if (line === null) return;
    const model = state.model[side];
    if (!model) return;
    const element = nodes.layer[side].children[line];
    if (!element) return;
    holdSyncDuringJump();
    scrollElementInto(nodes.editor[side], element);
  }

  function measureLineHeight(side) {
    const row = nodes.layer[side].querySelector(".td-row");
    if (row && row.offsetHeight > 0) return row.offsetHeight;
    const fontSize = state.config.fontSize;
    return Math.round(fontSize * 1.6);
  }

  /* ── 滚动同步（可编辑视图按行号映射；软换行时退化为比例同步）── */
  function syncScrollFrom(side) {
    if (!state.config.syncScroll || effectiveView() !== "side" || state.syncing) return;
    const other = side === "left" ? "right" : "left";
    const source = nodes.editor[side];
    const target = nodes.editor[other];
    state.syncing = true;

    if (state.config.softWrap) {
      const sourceMax = Math.max(1, source.scrollHeight - source.clientHeight);
      const targetMax = Math.max(0, target.scrollHeight - target.clientHeight);
      target.scrollTop = (source.scrollTop / sourceMax) * targetMax;
    } else {
      const lineHeight = measureLineHeight(side);
      const topLine = Math.max(0, Math.round(source.scrollTop / lineHeight));
      const model = state.model[side];
      const otherModel = state.model[other];
      const rowIndex = model.rowOfLine[Math.min(topLine, model.rowOfLine.length - 1)] || 0;
      const targetLine = otherModel.lineOfRow[rowIndex];
      target.scrollTop = targetLine === null || targetLine === undefined ? target.scrollTop : targetLine * lineHeight;
    }
    target.scrollLeft = source.scrollLeft;
    state.syncing = false;
  }

  /* ── 分栏分隔线（§15.1）─────────────────────────────────── */
  /**
   * 比例下限 / 上限：按容器**实测宽度**换算，保证任一侧不窄于 MIN_PANE_WIDTH。
   * 注意左栏 = 比例 × 容器宽，而右栏 = 容器宽 − 左栏 − **分隔条轨道宽**，
   * 因此上限必须把分隔条宽度算进去（否则右栏会比下限少 7px，触屏下少 14px）。
   */
  function splitBounds() {
    const width = nodes.split ? nodes.split.getBoundingClientRect().width : 0;
    if (!width) return { min: SPLIT_RATIO_MIN, max: SPLIT_RATIO_MAX };
    const track = nodes.splitter ? nodes.splitter.getBoundingClientRect().width : 0;
    const min = Math.min(0.5, Math.max(SPLIT_RATIO_MIN, MIN_PANE_WIDTH / width));
    const max = Math.max(min, Math.min(SPLIT_RATIO_MAX, 1 - (MIN_PANE_WIDTH + track) / width));
    return { min, max };
  }

  function applySplit(bounds) {
    if (!nodes.split) return;
    nodes.split.style.setProperty("--td-split-left", `${(state.split * 100).toFixed(2)}%`);
    if (!nodes.splitter) return;
    const range = bounds || splitBounds();
    nodes.splitter.setAttribute("aria-valuenow", String(Math.round(state.split * 100)));
    // 可达区间随容器宽度变化：播报区间必须与实际能调到的范围一致（否则读屏会报出调不到的值）
    nodes.splitter.setAttribute("aria-valuemin", String(Math.round(range.min * 100)));
    nodes.splitter.setAttribute("aria-valuemax", String(Math.round(range.max * 100)));
  }

  /**
   * 设置分隔比例（自动夹紧到最小宽度允许的范围）。
   * @returns {boolean} 比例是否真的改变（避免无谓重排与无谓写存储）
   */
  function setSplit(ratio, options = {}) {
    const bounds = splitBounds();
    const next = Math.max(bounds.min, Math.min(bounds.max, ratio));
    if (!Number.isFinite(next) || Math.abs(next - state.split) < 0.0005) return false;
    state.split = next;
    applySplit(bounds);
    // 栏宽变了 → 折行结果、行号槽行高、缩略图几何、对比区高度都要跟着重算
    if (options.resync !== false) scheduleLayoutSync();
    return true;
  }

  /**
   * 拖动中的重排：对比区高度与缩略图几何每帧跟上（便宜，只读少量几何）；
   * 「行号槽行高同步」是 O(行数) 且只在软换行下才有意义，因此按 DRAG_GUTTER_SYNC_MS 节流，
   * 松手时由 endSplitDrag 走一次 scheduleLayoutSync 全量对齐。
   */
  function scheduleSplitResync() {
    if (state.layoutRaf) return;
    state.layoutRaf = window.requestAnimationFrame(() => {
      state.layoutRaf = 0;
      updateEditorHeight();
      updateMinimapGeometry();
      updateMinimapViewport();
      if (!state.config.softWrap) return;
      const now = Date.now();
      if (now - state.splitGutterAt < DRAG_GUTTER_SYNC_MS) return;
      state.splitGutterAt = now;
      syncGutterHeights(false);
    });
  }

  /** 指针位置 → 比例（相对两栏容器） */
  function splitRatioAt(event) {
    if (!nodes.split) return null;
    const rect = nodes.split.getBoundingClientRect();
    if (!rect.width) return null;
    return (event.clientX - rect.left) / rect.width;
  }

  function readStoredSplit() {
    try {
      const raw = window.localStorage.getItem(SPLIT_KEY);
      if (!raw) return SPLIT_DEFAULT;
      const parsed = JSON.parse(raw);
      const ratio = parsed && typeof parsed === "object" ? Number(parsed.ratio) : NaN;
      return Number.isFinite(ratio) && ratio >= SPLIT_RATIO_MIN && ratio <= SPLIT_RATIO_MAX ? ratio : SPLIT_DEFAULT;
    } catch (error) {
      return SPLIT_DEFAULT;
    }
  }

  function commitSplit() {
    try {
      window.localStorage.setItem(
        SPLIT_KEY,
        JSON.stringify({ version: SPLIT_VERSION, ratio: Number(state.split.toFixed(4)) })
      );
      return true;
    } catch (error) {
      return false;
    }
  }

  function splitPercentText() {
    const left = Math.round(state.split * 100);
    return `左 ${left}% / 右 ${100 - left}%`;
  }

  /** 键盘 / 双击调整：一次调整即落地存储（与外壳侧栏宽度同做法） */
  function commitSplitChange(message) {
    if (!commitSplit()) warnStorageOnce();
    if (message) setStatus(message, "info");
  }

  function nudgeSplit(delta) {
    if (!setSplit(state.split + delta * SPLIT_STEP)) return;
    commitSplitChange(`分栏比例：${splitPercentText()}`);
  }

  function moveSplitToBoundary(which) {
    const bounds = splitBounds();
    if (!setSplit(which === "min" ? bounds.min : bounds.max)) return;
    commitSplitChange(`分栏比例：${splitPercentText()}（已到${which === "min" ? "最小" : "最大"}宽度）`);
  }

  function resetSplit() {
    if (!setSplit(SPLIT_DEFAULT)) return;
    commitSplitChange("已恢复等宽分栏（50:50）");
  }

  function beginSplitDrag(event) {
    if (!nodes.splitter) return;
    if (typeof event.button === "number" && event.button !== 0) return;
    event.preventDefault();
    // preventDefault 会连带取消鼠标聚焦，这里显式聚焦，松手后即可用方向键微调
    nodes.splitter.focus();
    state.splitting = true;
    // 拖动态挂在**本实例容器**上（不是 html）：多实例互不干扰，且随面板 DOM 一起被清理
    if (nodes.main) nodes.main.classList.add("is-splitting");
    if (nodes.splitter.setPointerCapture && typeof event.pointerId === "number") {
      try {
        nodes.splitter.setPointerCapture(event.pointerId);
      } catch (error) {
        /* 捕获失败不致命：仍可在分隔条上拖动，窗口级 pointerup 兜底复位 */
      }
    }
    const ratio = splitRatioAt(event);
    if (ratio !== null) setSplit(ratio, { resync: false });
    scheduleSplitResync();
  }

  function moveSplitDrag(event) {
    if (!state.splitting) return;
    // 按键已松开却因捕获丢失而收不到 pointerup 时在此复位，避免「悬停即拖动」的粘滞状态
    if (!event.buttons) {
      endSplitDrag(event, false);
      return;
    }
    const ratio = splitRatioAt(event);
    if (ratio === null) return;
    if (setSplit(ratio, { resync: false })) scheduleSplitResync();
  }

  function endSplitDrag(event, commit) {
    const wasSplitting = state.splitting;
    state.splitting = false;
    if (nodes.main) nodes.main.classList.remove("is-splitting");
    if (
      nodes.splitter &&
      nodes.splitter.hasPointerCapture &&
      event &&
      typeof event.pointerId === "number" &&
      nodes.splitter.hasPointerCapture(event.pointerId)
    ) {
      nodes.splitter.releasePointerCapture(event.pointerId);
    }
    if (commit !== false && wasSplitting) commitSplitChange(`已调整分栏：${splitPercentText()}（双击分隔线可恢复等宽）`);
    scheduleLayoutSync();
  }

  /* ── 搜索条归属（§15.7）─────────────────────────────────── */
  /**
   * 并排视图：每栏搜索条挂在**本栏面板头**里（与「搜索」按钮同一行），打开时隐藏该按钮；
   * 只读渲染视图没有面板头 → 回退到置顶工具条的槽位，且只保留焦点侧那一条（否则又挤在一起）。
   */
  function placeSearchBars() {
    const readOnly = nodes.split.hidden;
    ["left", "right"].forEach((side) => {
      const bar = nodes.search[side];
      const slot = readOnly ? nodes.searchBar : nodes.paneHead[side];
      if (slot && bar.parentElement !== slot) slot.appendChild(bar);
      const button = nodes.searchButton[side];
      if (button) button.hidden = !bar.hidden;
    });
    if (!nodes.searchBar) return;
    nodes.searchBar.hidden = !readOnly;
    // 只读视图下槽位只显示焦点侧那一条 —— 这是**纯展示层隐藏**（不改 state.search 的开合状态），
    // 否则切回并排时该侧会落到「搜索条关了、按钮也隐藏了」的不可发现状态。
    if (readOnly) nodes.searchBar.dataset.focus = state.focusSide === "right" ? "right" : "left";
    else delete nodes.searchBar.dataset.focus;
  }

  /* ── 搜索 ───────────────────────────────────────────────── */
  /** 当前「焦点所在栏」（以 activeElement 为准，退化到最近一次聚焦的栏） */
  function sideOfActiveElement() {
    const active = document.activeElement;
    if (active) {
      if (nodes.editor.right.contains(active)) return "right";
      if (nodes.editor.left.contains(active)) return "left";
    }
    return state.focusSide === "right" ? "right" : "left";
  }

  function openSearch(side) {
    clearError();
    state.focusSide = side;
    nodes.search[side].hidden = false;
    // 归属先落位（并排 → 本栏面板头；只读视图 → 顶栏槽位），否则聚焦的是一个不可见元素
    placeSearchBars();
    nodes.searchInput[side].focus();
    nodes.searchInput[side].select();
    // 搜索条会让面板头或工具条变高（挤压对比区），对比区高度与缩略图几何要跟上
    scheduleLayoutSync();
  }

  function closeSearch(side) {
    nodes.search[side].hidden = true;
    state.search[side].index = -1;
    placeSearchBars();
    scheduleRender();
  }

  function stepSearch(side, delta) {
    const hits = state.search[side].hits;
    if (hits.length === 0) {
      setStatus("未找到匹配项。", "warn");
      return;
    }
    const next = state.search[side].index < 0 ? (delta > 0 ? 0 : hits.length - 1) : (state.search[side].index + delta + hits.length) % hits.length;
    state.search[side].index = next;
    renderAll();
    const hit = hits[next];
    if (effectiveView() === "side") scrollEditorToLine(side, hit.line);
    setStatus(`第 ${next + 1} / ${hits.length} 个匹配`, "info");
  }

  /* ── 载入（文件 / 文本）─────────────────────────────────── */
  function loadText(side, text, sourceLabel) {
    state.text[side] = typeof text === "string" ? text : "";
    const metrics = textMetrics(state.text[side]);
    state.currentBlock = -1;
    state.expanded.clear();
    compute();
    setStatus(`已载入 ${sourceLabel}（${metrics.lines} 行，覆盖原有内容）`, "ok");
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("文件读取失败，请重试。"));
      reader.readAsText(file, "utf-8");
    });
  }

  function acceptFile(side, file) {
    if (!file) return;
    readFileAsText(file)
      .then((text) => {
        if (text.indexOf("\u0000") >= 0) {
          showError("这不是文本文件（含二进制内容），未载入。");
          return;
        }
        if (text.length === 0) {
          showError("文件为空，未载入。");
          return;
        }
        clearError();
        loadText(side, text, file.name);
      })
      .catch((error) => showError(error.message));
  }

  /* ── 事件：选项 ─────────────────────────────────────────── */
  const optionInputs = [
    nodes.context,
    nodes.fontSize,
    nodes.language,
    nodes.softWrap,
    nodes.inlineHighlight,
    nodes.syncScroll,
    nodes.ignoreCase,
    nodes.ignoreTrailingSpace,
    nodes.ignoreAllSpace,
    nodes.ignoreBlankLines,
    nodes.ignoreLineEnding,
  ];

  optionInputs.forEach((input) => {
    bind(input, "change", () => {
      if (input === nodes.language) state.detected = detectLanguage(state.text.left || state.text.right);
      commitConfig(readConfig());
      compute();
    });
    if (input === nodes.fontSize) {
      bind(input, "input", () => commitConfig(readConfig()));
    }
  });

  qsa("[data-view]").forEach((button) => {
    bind(button, "click", () => {
      const next = normalizeConfig(Object.assign({}, state.config, { view: button.dataset.view }));
      if (!VIEW_VALUES.includes(button.dataset.view)) return;
      state.config = next;
      if (!writeStoredConfig()) warnStorageOnce();
      renderAll();
      setStatus(`视图：${button.textContent.trim()}${button.dataset.view === "auto" ? "（按可用宽度自动切换）" : ""}`, "info");
    });
  });

  /* ── 事件：导航与「更多选项」────────────────────────────── */
  bind(el('[data-action="prev-diff"]'), "click", () => goToBlock(-1));
  bind(el('[data-action="next-diff"]'), "click", () => goToBlock(1));
  bind(nodes.optionsToggle, "click", () => toggleOptions());

  /* ── 事件：分栏分隔线（鼠标 / 触屏 / 触控笔走同一条指针路径，§15.1）── */
  if (nodes.splitter) {
    bind(nodes.splitter, "pointerdown", beginSplitDrag);
    bind(nodes.splitter, "pointermove", moveSplitDrag);
    bind(nodes.splitter, "pointerup", (event) => endSplitDrag(event, true));
    bind(nodes.splitter, "pointercancel", (event) => endSplitDrag(event, false));
    // 捕获被隐式释放（面板切走等）也要复位，避免光标与 user-select 粘住
    bind(nodes.splitter, "lostpointercapture", () => {
      state.splitting = false;
      if (nodes.main) nodes.main.classList.remove("is-splitting");
    });
    // 未成功建立捕获时的兜底：指针移出分隔条后再松手，也能结束拖拽
    // （否则整页会停在 col-resize + 禁选状态，直到指针再次划过分隔条）
    bind(window, "pointerup", () => {
      if (state.splitting) endSplitDrag(null, true);
    });
    bind(window, "pointercancel", () => {
      if (state.splitting) endSplitDrag(null, false);
    });
    bind(window, "blur", () => {
      if (state.splitting) endSplitDrag(null, false);
    });
    // 拖动中防止误选中正文：捕获期间 selectstart 会被重定向到捕获元素上
    bind(nodes.splitter, "selectstart", (event) => {
      if (state.splitting) event.preventDefault();
    });
    bind(nodes.splitter, "dblclick", (event) => {
      event.preventDefault();
      resetSplit();
    });
    bind(nodes.splitter, "keydown", (event) => {
      switch (event.key) {
        case "ArrowLeft":
        case "ArrowUp":
          nudgeSplit(-1);
          break;
        case "ArrowRight":
        case "ArrowDown":
          nudgeSplit(1);
          break;
        case "Home":
          moveSplitToBoundary("min");
          break;
        case "End":
          moveSplitToBoundary("max");
          break;
        case "Enter":
        case " ":
          resetSplit();
          break;
        default:
          return;
      }
      event.preventDefault();
    });
  }

  /* ── 事件：搜索 ─────────────────────────────────────────── */
  qsa('[data-action="open-search"]').forEach((button) => {
    bind(button, "click", () => openSearch(button.dataset.side));
  });
  qsa('[data-action="search-close"]').forEach((button) => {
    bind(button, "click", () => closeSearch(button.dataset.side));
  });
  qsa('[data-action="search-next"]').forEach((button) => {
    bind(button, "click", () => stepSearch(button.dataset.side, 1));
  });
  qsa('[data-action="search-prev"]').forEach((button) => {
    bind(button, "click", () => stepSearch(button.dataset.side, -1));
  });

  ["left", "right"].forEach((side) => {
    bind(nodes.searchInput[side], "input", () => {
      state.search[side].index = -1;
      scheduleRender();
    });
    bind(nodes.searchInput[side], "keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        stepSearch(side, event.shiftKey ? -1 : 1);
      }
    });
    bind(nodes.searchInput[side], "focus", () => {
      // 焦点在哪一栏的搜索条上，就以哪一栏为「焦点侧」（Ctrl+F 与只读视图槽位都依赖它）
      state.focusSide = side;
      if (nodes.split.hidden) placeSearchBars();
    });
    // 搜索条现在挂在面板头里：拖入文本/文件必须落到输入框（原生行为），
    // 不得冒泡到面板的 drop 处理器去覆盖整栏正文
    bind(nodes.search[side], "dragover", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    bind(nodes.search[side], "drop", (event) => event.stopPropagation());
    ["searchCase", "searchWord"].forEach((key) => {
      bind(nodes[key][side], "change", () => commitConfig(readConfig()));
    });
  });

  /* ── 事件：编辑器输入与滚动 ─────────────────────────────── */
  ["left", "right"].forEach((side) => {
    bind(nodes.input[side], "input", () => {
      state.text[side] = nodes.input[side].value;
      state.currentBlock = -1;
      scheduleCompute();
    });
    bind(nodes.editor[side], "scroll", () => {
      syncScrollFrom(side);
      scheduleMinimapViewport();
    });
    bind(nodes.editor[side], "focus", () => {
      state.focusSide = side;
    });
  });

  bind(nodes.renderedEditor, "scroll", scheduleMinimapViewport);

  /* ── 事件：缩略图（点击 / 按住拖动 = 跳转，§15.13）────────── */
  if (nodes.minimap) {
    bind(nodes.minimap, "pointerdown", (event) => {
      if (typeof event.button === "number" && event.button !== 0) return;
      event.preventDefault();
      state.dragging = true;
      state.pointerRow = rowAtPointer(event);
      if (nodes.minimap.setPointerCapture && typeof event.pointerId === "number") {
        try {
          nodes.minimap.setPointerCapture(event.pointerId);
        } catch (error) {
          /* 捕获失败不致命：仍按未捕获处理（松手/划过即可结束拖拽） */
        }
      }
      if (state.pointerRow !== null) scrollToRow(state.pointerRow);
    });

    bind(nodes.minimap, "pointermove", (event) => {
      if (!state.dragging) return;
      // 按键已松开却因捕获丢失而收不到 pointerup 时，在这里结束拖拽，
      // 否则「悬停即擦洗」会一直生效（状态粘滞）
      if (!event.buttons) {
        state.dragging = false;
        state.pointerRow = null;
        return;
      }
      const row = rowAtPointer(event);
      if (row === null || row === state.pointerRow) return;
      state.pointerRow = row;
      scheduleMinimapJump(); // 拖动中只滚动，rAF 合并
    });

    const releaseCapture = (event) => {
      if (nodes.minimap.hasPointerCapture && typeof event.pointerId === "number" && nodes.minimap.hasPointerCapture(event.pointerId)) {
        nodes.minimap.releasePointerCapture(event.pointerId);
      }
    };

    bind(nodes.minimap, "pointerup", (event) => {
      releaseCapture(event);
      finishMinimapJump();
    });
    bind(nodes.minimap, "pointercancel", (event) => {
      releaseCapture(event);
      state.dragging = false;
      state.pointerRow = null;
    });
    // 捕获被隐式释放（面板切走、元素被隐藏等）也要复位，避免拖拽状态粘住
    bind(nodes.minimap, "lostpointercapture", () => {
      state.dragging = false;
      state.pointerRow = null;
    });
  }

  /* ── 事件：折叠展开 ─────────────────────────────────────── */
  bind(nodes.renderedLayer, "click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("[data-fold]") : null;
    if (!button) return;
    state.expanded.add(button.dataset.fold);
    renderAll();
  });

  /* ── 事件：拖拽载入 ─────────────────────────────────────── */
  ["left", "right"].forEach((side) => {
    const pane = nodes.editor[side].closest(".td-pane");
    if (!pane) return;

    bind(pane, "dragover", (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      pane.classList.add("is-drop");
    });
    bind(pane, "dragleave", (event) => {
      if (event.target === pane) pane.classList.remove("is-drop");
    });
    bind(pane, "drop", (event) => {
      event.preventDefault();
      pane.classList.remove("is-drop");
      const dataTransfer = event.dataTransfer;
      if (!dataTransfer) return;

      const file = dataTransfer.files && dataTransfer.files.length ? dataTransfer.files[0] : null;
      if (file) {
        acceptFile(side, file);
        return;
      }
      const text = dataTransfer.getData("text/plain");
      if (text) loadText(side, text, "拖入的文本");
      else setStatus("没有可载入的内容。", "warn");
    });

    bind(nodes.fileInput[side], "change", () => {
      const file = nodes.fileInput[side].files && nodes.fileInput[side].files[0];
      acceptFile(side, file);
      nodes.fileInput[side].value = "";
    });
  });

  /* ── 事件：视图自动切换（容器宽度，而非窗口宽度）────────── */
  let observer = null;
  if (typeof window.ResizeObserver === "function") {
    observer = new window.ResizeObserver(() => {
      if (state.config.view === "auto") scheduleRender();
      // 宽度变化会改变折行结果（行高随之变化），必须重新同步行号槽；
      // 高度变化要重新实测对比区高度；面板由隐藏变可见（0 → N）也走这里。
      scheduleLayoutSync();
    });
    observer.observe(nodes.main);
  }

  // 窗口尺寸变化：观察器只看容器的盒子，窗口变矮时容器盒子不变，需要自己补一次实测
  bind(window, "resize", scheduleLayoutSync);

  /* ── 快捷键（带标签工作台焦点守卫，§9.3）────────────────── */
  const inTabsWorkspace = Boolean(root.closest("[data-tabs-workspace]"));
  bind(document, "keydown", (event) => {
    if (inTabsWorkspace && !root.contains(event.target)) return;

    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      compute();
      state.currentBlock = -1;
      goToBlock(1);
      return;
    }

    if ((event.ctrlKey || event.metaKey) && (event.key === "f" || event.key === "F")) {
      event.preventDefault();
      const side = sideOfActiveElement();
      // 只读视图没有面板头、两条搜索条都在同一个槽位里：该侧已打开时切到另一侧，
      // 否则用户在这个视图下无法改搜另一栏（面板头的「搜索」按钮此时不可见）
      const readOnly = nodes.split.hidden;
      openSearch(readOnly && !nodes.search[side].hidden ? (side === "left" ? "right" : "left") : side);
      return;
    }

    if (event.key === "F7") {
      event.preventDefault();
      goToBlock(event.shiftKey ? -1 : 1);
      return;
    }

    if (event.key === "Escape") {
      if (!nodes.search.left.hidden) closeSearch("left");
      else if (!nodes.search.right.hidden) closeSearch("right");
      else if (!nodes.error.hidden) clearError();
    }
  });

  /* ── 启动 ───────────────────────────────────────────────── */
  renderLanguageOptions();
  renderContextOptions();
  nodes.fontSize.min = String(FONT_SIZE_MIN);
  nodes.fontSize.max = String(FONT_SIZE_MAX);
  writeConfigToForm(state.config);
  // 恢复上次的分栏比例（纯视图偏好；非法值已在 readStoredSplit 中回退 50:50）
  state.split = readStoredSplit();
  applySplit();
  placeSearchBars();
  compute();
  setStatus("把两段文本分别粘进两侧，或把文件拖到对应栏即可开始对比。", "info");

  return () => {
    Object.keys(timers).forEach(clearTimer);
    [state.renderRaf, state.layoutRaf, state.viewportRaf, state.jumpRaf, state.syncHoldRaf].forEach((handle) => {
      if (handle) window.cancelAnimationFrame(handle);
    });
    if (observer) observer.disconnect();
    // 若在拖动分隔线途中关闭面板，拖动态必须一起复位
    // （拖动态类是挂在 nodes.main 上的，随 DOM 一起移除，这里显式复位状态即可）
    state.splitting = false;
    if (nodes.main) nodes.main.classList.remove("is-splitting");
    disposers.forEach((dispose) => dispose());
    dom.clear(host);
  };
}

export const meta = {
  id: "text-diff",
  version: "1.0.0",
  status: "ready",
};

export default init;
