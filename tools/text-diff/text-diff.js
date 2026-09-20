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

  <div class="td-searchbar" data-search-bar hidden>
    <div class="td-search" data-search="left" hidden>
      <input class="input" type="search" data-search-input="left" aria-label="在左栏搜索" placeholder="左栏查找…" />
      <label class="checkbox"><input type="checkbox" data-search-case="left" /><span>Aa</span></label>
      <label class="checkbox"><input type="checkbox" data-search-word="left" /><span>词</span></label>
      <button class="td-icon-btn" type="button" data-action="search-prev" data-side="left" title="上一个匹配（Shift + Enter）" aria-label="左栏上一个匹配">__I_UP__</button>
      <button class="td-icon-btn" type="button" data-action="search-next" data-side="left" title="下一个匹配（Enter）" aria-label="左栏下一个匹配">__I_DOWN__</button>
      <span class="td-search__count" data-search-count="left" role="status">0 / 0</span>
      <button class="td-icon-btn" type="button" data-action="search-close" data-side="left" title="关闭左栏搜索" aria-label="关闭左栏搜索">__I_CLOSE__</button>
    </div>

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
    <li class="td-legend__item"><span class="td-legend__swatch td-legend__swatch--modify" aria-hidden="true"></span>修改行（<span class="mono">~</span>，行内底纹为变动词）</li>
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
      </div>
      <div class="td-editor" data-editor="left">
        <div class="td-gutter" data-gutter="left" aria-hidden="true"></div>
        <div class="td-surface">
          <div class="td-layer" data-layer="left" aria-hidden="true"></div>
          <textarea class="td-input" data-input="left" spellcheck="false" wrap="off" aria-label="左侧文本"></textarea>
        </div>
      </div>
    </section>

    <div class="td-split__divider" aria-hidden="true"></div>

    <section class="td-pane" data-side="right">
      <div class="td-pane__head">
        <h2 class="td-pane__title">右侧</h2>
        <label class="btn btn--ghost" for="td-file-right">__I_UP__ 选择文件…</label>
        <input class="sr-only" type="file" id="td-file-right" data-file="right" />
        <button class="btn btn--ghost" type="button" data-action="open-search" data-side="right" aria-label="搜索右栏">__I_SEARCH__ 搜索</button>
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
    search: { left: { hits: [], index: -1 }, right: { hits: [], index: -1 } },
    syncing: false,
    renderRaf: 0,
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
      layerHtml = '<div class="td-row"><span class="td-seg td-tok-plain">（空）</span></div>';
    }

    gutter.innerHTML = gutterHtml;
    layer.innerHTML = layerHtml;

    if (input.value !== state.text[side]) input.value = state.text[side];
    // 让 textarea 与内容等高，滚动完全由外层 .td-editor 承担
    input.style.height = `${layer.scrollHeight}px`;
    input.style.width = `${Math.max(layer.scrollWidth, nodes.editor[side].clientWidth - nodes.gutter[side].offsetWidth)}px`;
  }

  /* ── 渲染：只读视图（统一 / 折叠）───────────────────────── */
  function renderReadOnly() {
    const left = state.model.left;
    const right = state.model.right;
    const segments = foldRows(state.result.rows, state.config.context, state.expanded);
    const renderable = segments.reduce((sum, segment) => sum + (segment.type === "gap" ? 1 : segment.rows.length), 0);

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
    nodes.diffCount.textContent =
      state.currentBlock < 0 ? `共 ${total} 处差异` : `第 ${state.currentBlock + 1} / ${total} 处差异`;
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
    // 两个搜索条都关闭时不保留空框
    nodes.searchBar.hidden = nodes.search.left.hidden && nodes.search.right.hidden;
  }

  /**
   * 让对比区吃满「视口内剩余高度」：页面本身不滚动，滚动只发生在编辑器内部。
   * 高度由 JS 实测（而非写死 vh 常量），因此选项折叠展开、工具栏换行都能自适应。
   */
  function updateEditorHeight() {
    const activeEditor = nodes.split.hidden ? nodes.rendered.querySelector(".td-editor") : nodes.editor.left;
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
    updateEditorHeight();
  }

  /** 「更多选项」折叠区：不常改的选项收进这里，把垂直空间让给对比区 */
  function toggleOptions(force) {
    const next = typeof force === "boolean" ? force : nodes.optionsPanel.hidden;
    nodes.optionsPanel.hidden = !next;
    nodes.optionsToggle.setAttribute("aria-expanded", String(next));
    updateEditorHeight();
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

  function scrollEditorToLine(side, line) {
    if (line === null) return;
    const editor = nodes.editor[side];
    const model = state.model[side];
    if (!model) return;
    const rowIndex = model.rowOfLine[line] === undefined ? line : model.rowOfLine[line];
    const lineHeight = measureLineHeight(side);
    editor.scrollTop = Math.max(0, rowIndex * lineHeight - editor.clientHeight / 3);
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
    nodes.search[side].hidden = false;
    nodes.searchBar.hidden = false;
    nodes.searchInput[side].focus();
    nodes.searchInput[side].select();
  }

  function closeSearch(side) {
    nodes.search[side].hidden = true;
    state.search[side].index = -1;
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
    bind(nodes.editor[side], "scroll", () => syncScrollFrom(side));
    bind(nodes.editor[side], "focus", () => {
      state.focusSide = side;
    });
  });

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
    });
    observer.observe(nodes.main);
  }

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
      openSearch(sideOfActiveElement());
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
  compute();
  setStatus("把两段文本分别粘进两侧，或把文件拖到对应栏即可开始对比。", "info");

  return () => {
    Object.keys(timers).forEach(clearTimer);
    if (state.renderRaf) window.cancelAnimationFrame(state.renderRaf);
    if (observer) observer.disconnect();
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
