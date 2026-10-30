/**
 * 《公式计算器》工具模块（docs/DESIGN.md §16）
 * ------------------------------------------------------------------
 * 契约：本模块只导出 `init(ctx)`，由 `assets/js/shell.js` 在加载
 *      `tools/formula-calc/index.html` 后动态 import 并调用。
 * 解耦约定：
 *   - 不导入其它工具的代码，不读写跨工具的全局状态；
 *   - 与外壳之间只通过 `ctx`（容器、注册表记录、公共工具函数）交互；
 *   - 通用能力复用 `ctx.utils`（剪贴板 / DOM），图标走 `ctx.icons`。
 *
 * 模块内部三层（§9.3）：
 *   1. 纯函数核心 → `./formula-core.js`（可脱离 DOM 在 Node 中断言）；
 *   2. 存储适配层 → 本文件顶部导出的 `readJson` / `loadConfig` / `normalizeHistory` 等；
 *   3. UI 编排层 → `init()` 内部。
 *
 * 数据边界：本工具**只有** `toolbox:formula-calc:history` 允许保存用户输入，
 * 这是 §16.7 记录的 R5 唯一例外；`config` 键**不得**出现任何用户输入内容。
 */
import {
  BRACKET_HUE_COUNT,
  ERROR_CODES,
  MAX_VARIABLES,
  STEP_LABELS,
  VAR_HUE_COUNT,
  analyzeFormula,
  annotateFormula,
  evaluateFormula,
  explainSteps,
  formatNumber,
  normalizeFormula,
  parseCellValue,
  stripEmbeddedValues,
} from "./formula-core.js";

/* ── 常量（附录 B 已登记）────────────────────────────────── */

const STORAGE_PREFIX = "toolbox:formula-calc";
/** 选项键（按实例分区，§9.3 第 7 条） */
const CONFIG_KEY = `${STORAGE_PREFIX}:config`;
/** 历史记录键（**跨实例共享**；R5 唯一例外，§16.7） */
const HISTORY_KEY = `${STORAGE_PREFIX}:history`;

const HISTORY_VERSION = 1;
const EXPORT_VERSION = 1;
const EXPORT_APP = "local-toolbox";
const EXPORT_TOOL = "formula-calc";

/** 历史条数上限（R5 例外的边界之一，§16.7） */
export const MAX_HISTORY = 50;
/** 数据行数上限 */
export const MAX_ROWS = 200;

const DEBOUNCE_MS = 180;
const FEEDBACK_MS = 2000;
const CONFIRM_MS = 3000;
/** 公式框自动增高的上限（px）：超出后公式框内部滚动（§16.9，附录 B 已登记） */
const MAX_FORMULA_BOX_H = 240;
/** 点 chip 定位后，目标列高亮持续时长（§16.4，附录 B 已登记） */
const LOCATE_FLASH_MS = 1200;

/* ── 存储适配层（纯函数，可脱离 DOM 验证）──────────────── */

/** 读取 JSON；任何异常（无痕模式 / 配额满 / 非法 JSON）都静默返回 fallback（§8.3） */
export function readJson(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw);
  } catch (error) {
    return fallback;
  }
}

/** 写入 JSON；返回是否成功，调用方据此决定要不要提示降级（§8.3） */
export function writeJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * 实例级配置键（§8.1 / §9.3）：`serial <= 1`（含工具独立页）沿用默认键，
 * 第 2 个及以后实例各用独立键，避免多实例互相覆盖参数。
 * 历史记录键**不分区**（属「我的历史」，与 presets / 日历覆盖层同性质）。
 */
export function instanceSessionKey(instance) {
  const serial = instance && Number.isInteger(instance.serial) ? instance.serial : 1;
  return serial > 1 ? `${CONFIG_KEY}:${serial}` : CONFIG_KEY;
}

/** 参数归一化（§16.2）：只认下列布尔开关，其余一律回默认值 */
export function normalizeConfig(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    historyEnabled: source.historyEnabled !== false,
    showSteps: source.showSteps !== false,
    autoFillFromFormula: source.autoFillFromFormula !== false,
    syntaxHighlight: source.syntaxHighlight !== false,
    restoreLastOnMount: source.restoreLastOnMount !== false,
    // v1.7.25：变量取值解析（默认开）—— 关闭后变量名后的数字不再算取值（`X-5` 即 X 减 5，§16.2）
    extractValues: source.extractValues !== false,
  };
}

/** 读取选项 */
export function loadConfig(storageKey = CONFIG_KEY) {
  const raw = readJson(storageKey, null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return normalizeConfig(null);
  return normalizeConfig(raw.config);
}

/** 写入选项（只写三个布尔值，绝不含用户输入） */
export function saveConfig(config, storageKey = CONFIG_KEY) {
  return writeJson(storageKey, { config: normalizeConfig(config) });
}

/** 历史条目归一化：逐条校验，非法条目返回 null（调用方丢弃） */
export function normalizeHistoryItem(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const formula = typeof raw.formula === "string" ? raw.formula : "";
  if (formula.trim() === "") return null;

  const variables = Array.isArray(raw.variables)
    ? raw.variables.filter((name) => typeof name === "string" && name !== "").slice(0, MAX_VARIABLES)
    : [];
  // 单元格一律按「原始写法」保存（可能是 `15%` 或 `1,000`），**按变量名索引**，公式调序不会串值
  const readCells = (source) => {
    const holder = {};
    if (!source || typeof source !== "object" || Array.isArray(source)) return holder;
    variables.forEach((name) => {
      const value = source[name];
      if (typeof value === "string") holder[name] = value;
      else if (typeof value === "number") holder[name] = String(value);
    });
    return holder;
  };

  // 整张变量表的**全部行**（§16.7）；同时兼容早期的单行结构（只有 `cells`）
  const rawRows = Array.isArray(raw.rows) ? raw.rows : [];
  const rows = rawRows.slice(0, MAX_ROWS).map((row) => readCells(row && row.cells ? row.cells : row));
  if (rows.length === 0) rows.push(readCells(raw.cells));

  const selectedRow = Number.isInteger(raw.selectedRow) && raw.selectedRow >= 0 ? raw.selectedRow : 0;
  const createdAt = Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : Date.now();
  const updatedAt = Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : createdAt;

  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : `h-${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
    formula,
    variables,
    rows,
    selectedRow,
    createdAt,
    updatedAt,
  };
}

/** 读取历史（越界截断、非法条目丢弃；读取本身不报错，失败即空数组） */
export function loadHistory() {
  const raw = readJson(HISTORY_KEY, null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  if (!Array.isArray(raw.items)) return [];
  return raw.items.map(normalizeHistoryItem).filter(Boolean).slice(0, MAX_HISTORY);
}

/** 写入历史（按 MAX_HISTORY 截断） */
export function saveHistory(items) {
  return writeJson(HISTORY_KEY, {
    version: HISTORY_VERSION,
    items: (Array.isArray(items) ? items : []).slice(0, MAX_HISTORY).map(normalizeHistoryItem).filter(Boolean),
  });
}

/** 导出外壳（§8.4：必须带版本号与来源标识） */
export function serializeHistory(items, exportedAt = new Date().toISOString()) {
  return {
    app: EXPORT_APP,
    tool: EXPORT_TOOL,
    version: EXPORT_VERSION,
    exportedAt,
    items: (Array.isArray(items) ? items : []).map(normalizeHistoryItem).filter(Boolean),
  };
}

/**
 * 解析并校验导入内容：**先整体校验，再一次性写入**（§8.4）。
 * 校验失败**整体抛错**，绝不部分写入。
 */
export function parseImportPayload(rawInput) {
  let data = rawInput;

  if (typeof rawInput === "string") {
    const text = rawInput.trim();
    if (text === "") throw new Error("导入内容为空，请选择 JSON 文件或粘贴 JSON 文本。");
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new Error("JSON 解析失败，请确认内容是合法的 JSON。");
    }
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("JSON 结构不正确：顶层应为一个对象。");
  }
  if (data.app !== undefined && data.app !== EXPORT_APP) {
    throw new Error(`该文件并非本工具的导出结果（app = ${String(data.app)}）。`);
  }
  if (data.tool !== undefined && data.tool !== EXPORT_TOOL) {
    throw new Error(`该文件属于其它工具（tool = ${String(data.tool)}），无法导入。`);
  }
  if (data.version !== undefined && data.version !== EXPORT_VERSION) {
    throw new Error(`不支持的版本号 ${String(data.version)}，当前仅支持 ${EXPORT_VERSION}。`);
  }
  if (!Array.isArray(data.items)) {
    throw new Error("JSON 结构不正确：缺少 items 数组。");
  }

  const source = data.items;
  const items = [];
  let skipped = 0;
  source.forEach((entry) => {
    const item = normalizeHistoryItem(entry);
    if (item) items.push(item);
    else skipped += 1;
  });
  if (items.length === 0) throw new Error("未解析到任何有效的历史记录。");

  return { items, stats: { total: source.length, valid: items.length, skipped } };
}

/* ── 模板 ───────────────────────────────────────────────── */

const ICON_TOKENS = Object.freeze({
  __I_ALERT__: ["alert", 16],
  __I_CALC__: ["calculator", 15],
  __I_COPY__: ["copy", 15],
  __I_GEAR__: ["settings", 16],
  __I_DOWNLOAD__: ["download", 15],
  __I_PLUS__: ["plus", 15],
  __I_TRASH__: ["trash", 15],
__I_SWAP__: ["refresh", 15],
  __I_UPLOAD__: ["upload", 15],
  __I_EMPTY_STEPS__: ["alignLeft", 20],
  __I_EMPTY_TABLE__: ["columns", 20],
  __I_EMPTY_HISTORY__: ["hourglass", 20],
});

const TEMPLATE = `
<p class="fc-status" role="status" aria-live="polite" data-status></p>

<div class="fc-layout">
  <!-- 左栏（独立一列，高度不影响右栏两块的位置，§16.1） -->
  <div class="fc-col fc-col--left">
  <!-- 公式计算面板（公式 + 结果 + 过程合一，§16.1 / §16.9） -->
  <section class="panel fc-area-calc rise" style="--d: 0ms">
    <div class="panel__head">
      <h2 class="panel__title">公式计算<span class="fc-panel-meta" data-formula-meta></span></h2>
      <div class="fc-head-tools">
        <span class="panel__hint">零网络请求 · 零数据上传</span>
        <button
          class="icon-btn fc-gear"
          type="button"
          data-action="toggle-options"
          aria-expanded="false"
          aria-controls="__ID__options"
          aria-label="选项"
          title="选项"
        >__I_GEAR__</button>
      </div>
      <!-- 选项弹窗：挂在面板标题下方（role=dialog，Escape / 点外部关闭，见 §16.9） -->
      <div class="fc-options" id="__ID__options" data-options hidden role="dialog" aria-label="选项">
        <p class="fc-options__title">选项</p>
        <label class="checkbox"><input type="checkbox" data-config="historyEnabled" /> 记录历史</label>
        <label class="checkbox"><input type="checkbox" data-config="showSteps" /> 展示分步过程</label>
        <label class="checkbox"><input type="checkbox" data-config="autoFillFromFormula" /> 从公式自动填值</label>
        <label class="checkbox"><input type="checkbox" data-config="syntaxHighlight" /> 语法着色</label>
        <label class="checkbox"><input type="checkbox" data-config="restoreLastOnMount" /> 打开时恢复上次</label>
        <label class="checkbox" title="开启时：变量名后紧跟的数字算它的取值（含负数，如 调价-7.38 → -7.38）；关闭时：数字一律按独立数值处理（X-5 即 X 减 5）"><input type="checkbox" data-config="extractValues" /> 变量取值解析</label>
      </div>
    </div>
    <div class="panel__body">
      <div class="field">
        <label class="field__label" for="__ID__formula">
          <span>公式</span>
          <span class="field__hint">变量名只用字母、中文或下划线；紧跟在变量名后的数字算它的取值；Enter 记入历史、Alt+Enter 换行</span>
        </label>
        <div class="fc-formula">
          <div class="fc-formula__box">
            <div class="fc-formula__layer" data-formula-layer aria-hidden="true"></div>
            <textarea
              class="fc-formula__input"
              id="__ID__formula"
              rows="1"
              spellcheck="false"
              autocomplete="off"
              placeholder="(100+300)*2 或 单价10*数量25*折扣率0.9"
              data-formula
            ></textarea>
          </div>
          <button class="btn btn--ghost" type="button" data-action="clear-formula">__I_TRASH__ 清空</button>
        </div>
      </div>

      <!-- 结果行：紧跟公式栏且**常驻**（v1.7.3）—— 「计算」「复制」都收在这里，不翻过程也能看到结果 -->
      <div class="fc-result-line" data-result-line>
        <span class="fc-result-line__label">结果</span>
        <span class="fc-result-line__value" data-result-value>—</span>
        <span class="fc-result-line__row" data-result-row></span>
        <span class="panel__spacer"></span>
        <button class="btn btn--primary" type="button" data-action="commit" title="按当前变量表结算一次，并把这条公式与整张变量表记入历史">__I_CALC__ 记入历史</button>
        <button class="btn" type="button" data-action="copy-result" disabled>__I_COPY__ 复制</button>
      </div>

      <div class="fc-chips" data-chips></div>

      <div class="notice notice--danger" data-error hidden>
        <span class="notice__icon" aria-hidden="true">__I_ALERT__</span>
        <div class="notice__body">
          <p class="notice__title">公式无法计算</p>
          <p class="notice__text" data-error-text></p>
        </div>
      </div>

      <div class="fc-block" data-formula-block hidden>
        <p class="fc-block__label">
          <span>公式（去掉取值）</span>
          <button
            class="btn btn--ghost"
            type="button"
            data-action="apply-stripped"
            title="把上面的公式替换为去掉取值的变量形式（变量表已填的值会保留）"
          >__I_SWAP__ 替换输入公式</button>
        </p>
        <p class="fc-formula-line" data-formula-line></p>
      </div>

      <div class="fc-block" data-steps-block hidden>
        <p class="fc-block__label">计算过程<span class="fc-panel-meta" data-steps-meta></span></p>
        <div class="empty" data-steps-empty>
          <span class="empty__icon" aria-hidden="true">__I_EMPTY_STEPS__</span>
          <p class="empty__title">暂无计算过程</p>
          <p class="empty__text">输入公式并填写取值后，这里会逐步展示计算过程。</p>
        </div>
        <ol class="fc-steps" data-steps hidden></ol>
      </div>

    </div>
  </section>
  </div>

  <!-- 右栏（独立一列：变量表在上、历史在下；两块位置不受左栏高度影响） -->
  <div class="fc-col fc-col--right">
  <section class="panel fc-area-table rise" style="--d: 60ms">
    <div class="panel__head">
      <h2 class="panel__title">变量表</h2>
      <div class="fc-toolbar">
        <button class="btn" type="button" data-action="add-row">__I_PLUS__ 增行</button>
        <button class="btn" type="button" data-action="remove-row">__I_TRASH__ 删行</button>
        <button class="btn btn--ghost" type="button" data-action="clear-rows">清空取值</button>
      </div>
    </div>
    <div class="panel__body">
      <div class="fc-table-scroll" data-table-scroll hidden>
        <table class="fc-table">
          <thead data-table-head></thead>
          <tbody data-table-body></tbody>
        </table>
      </div>
      <div class="empty" data-table-empty>
        <span class="empty__icon" aria-hidden="true">__I_EMPTY_TABLE__</span>
        <p class="empty__title">还没有变量</p>
        <p class="empty__text">写下含变量的公式（例如 单价10*数量25），变量会自动出现在这里。</p>
      </div>
      <div class="fc-table-foot">
        <span class="fc-table-foot__meta" data-table-meta></span>
      </div>
    </div>
  </section>

  <!-- 右栏下：历史记录（位置固定，不随变量表行数或左栏高度移动） -->
  <section class="panel fc-area-history rise" style="--d: 120ms">
    <div class="panel__head">
      <h2 class="panel__title">历史记录<span class="badge" data-history-count>0</span></h2>
    <div class="fc-toolbar">
      <button class="btn" type="button" data-action="export-history">__I_DOWNLOAD__ 导出</button>
      <button class="btn" type="button" data-action="toggle-import">__I_UPLOAD__ 导入</button>
      <button class="btn" type="button" data-action="clear-history">__I_TRASH__ 清空</button>
    </div>
  </div>
  <div class="panel__body">
    <div class="fc-import" data-import hidden>
      <div class="fc-import__row">
        <label class="btn" for="__ID__import-file">__I_UPLOAD__ 选择 JSON 文件</label>
        <input class="sr-only" type="file" id="__ID__import-file" accept=".json,application/json" data-import-file />
        <span class="fc-import__file mono" data-import-filename>未选择文件</span>
      </div>
      <div class="field">
        <label class="field__label" for="__ID__import-text">
          <span>或直接粘贴 JSON</span>
          <span class="field__hint">与「导出」的内容格式一致</span>
        </label>
        <textarea
          class="textarea textarea--compact"
          id="__ID__import-text"
          spellcheck="false"
          placeholder='{"app":"local-toolbox","tool":"formula-calc","version":1,"items":[…]}'
          data-import-text
        ></textarea>
      </div>
      <div class="fc-import__actions">
        <button class="btn btn--primary" type="button" data-action="confirm-import">导入历史</button>
        <button class="btn btn--ghost" type="button" data-action="close-import">取消</button>
      </div>
    </div>

    <div class="fc-history__search" data-history-search-row hidden>
      <input
        class="input"
        type="search"
        spellcheck="false"
        autocomplete="off"
        placeholder="筛选公式或变量名"
        aria-label="筛选历史记录"
        data-history-search
      />
      <button class="btn btn--ghost" type="button" data-action="clear-history-query" hidden>清空</button>
    </div>
    <p class="fc-history__filter" data-history-filter hidden></p>

    <ul class="fc-history" data-history hidden></ul>
    <div class="empty" data-history-empty>
      <span class="empty__icon" aria-hidden="true">__I_EMPTY_HISTORY__</span>
      <p class="empty__title" data-history-empty-title>暂无历史记录</p>
      <p class="empty__text" data-history-empty-text>点「记入历史」或按 Enter 才会存下一条（含整张变量表），最多保留 __MAX__ 条。</p>
    </div>
    <p class="fc-history__note">历史保存在本机浏览器，最多 __MAX__ 条，不跨设备同步；可导出备份或随时清空。</p>
    </div>
  </section>
  </div>
</div>
`;

/* ── 工具入口 ───────────────────────────────────────────── */

/**
 * 工具入口。
 * @param {Object} ctx
 * @param {HTMLElement} ctx.root   工具页内容区（标签面板容器；独立页为 main.workspace）
 * @param {Object} ctx.tool        注册表中的工具记录
 * @param {Object} ctx.instance    标签实例信息（§9.3 第 7 条）
 * @param {Object} ctx.utils       公共能力 { dom, clipboard, text }（§9.4 必须复用）
 * @param {Object} ctx.icons       { icon(name, size) }
 * @returns {() => void} 清理函数（须注销全部监听与定时器）
 */
export function init(ctx) {
  const { root, tool, utils, icons } = ctx;
  // 宿主解析：标签面板内为 [data-tool-body]，独立页为 #tool-body（§9.3 第 1 条）
  const host = root.querySelector("[data-tool-body]") || root.querySelector("#tool-body");
  if (!host) return () => {};

  const { dom, clipboard } = utils;
  const escapeHtml = dom.escapeHtml;

  // 同一工具可开多个实例：面板内 DOM id 必须按实例唯一，否则 <label for> / aria-* 会串到别的实例（§9.3 第 9 条）
  const uid = `fc-${ctx.instance && Number.isInteger(ctx.instance.serial) ? ctx.instance.serial : 1}`;
  const storageKey = instanceSessionKey(ctx.instance);

  // `__MAX__` 由常量注入：历史区文案里的条数上限必须与 MAX_HISTORY 同源，不得手写数字（§16.7）
  host.innerHTML = TEMPLATE.replace(/__ID__/g, uid)
    .replace(/__MAX__/g, String(MAX_HISTORY))
    .replace(/__I_\w+__/g, (token) => {
      const entry = ICON_TOKENS[token];
      return entry ? icons.icon(entry[0], entry[1]) : "";
    });

  const el = (selector) => host.querySelector(selector);
  const nodes = {
    status: el("[data-status]"),
    formula: el("[data-formula]"),
    formulaBox: el(".fc-formula__box"),
    formulaLayer: el("[data-formula-layer]"),
    formulaBlock: el("[data-formula-block]"),
    formulaLine: el("[data-formula-line]"),
    stepsBlock: el("[data-steps-block]"),
    resultRow: el("[data-result-row]"),
    copyButton: el('[data-action="copy-result"]'),
    commitButton: el('[data-action="commit"]'),
    formulaMeta: el("[data-formula-meta]"),
    chips: el("[data-chips]"),
    error: el("[data-error]"),
    errorText: el("[data-error-text]"),
    optionsToggle: el('[data-action="toggle-options"]'),
    options: el("[data-options]"),
    tableScroll: el("[data-table-scroll]"),
    tableHead: el("[data-table-head]"),
    tableBody: el("[data-table-body]"),
    tableEmpty: el("[data-table-empty]"),
    tableMeta: el("[data-table-meta]"),
    steps: el("[data-steps]"),
    stepsEmpty: el("[data-steps-empty]"),
    stepsMeta: el("[data-steps-meta]"),
    resultLine: el("[data-result-line]"),
    resultValue: el("[data-result-value]"),
    history: el("[data-history]"),
    historyEmpty: el("[data-history-empty]"),
    historyCount: el("[data-history-count]"),
    historySearchRow: el("[data-history-search-row]"),
    historySearch: el("[data-history-search]"),
    historyFilter: el("[data-history-filter]"),
    historyClearQuery: host.querySelector('[data-action="clear-history-query"]'),
    historyEmptyTitle: el("[data-history-empty-title]"),
    historyEmptyText: el("[data-history-empty-text]"),
    importPanel: el("[data-import]"),
    importFile: el("[data-import-file]"),
    importFileName: el("[data-import-filename]"),
    importText: el("[data-import-text]"),
    clearFormula: el('[data-action="clear-formula"]'),
    clearHistory: el('[data-action="clear-history"]'),
  };

  /** 定时器集合，清理时统一回收 */
  const timers = { compute: 0, status: 0, confirm: 0, revoke: 0 };
  /** 在飞的 FileReader（导入时）：清理函数里要中止，避免实例被关掉后仍继续写存储 */
  let activeReader = null;
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

  // 公式框增高上限交给 CSS 变量（常量登记在附录 B）
  if (nodes.formulaBox) nodes.formulaBox.style.setProperty("--fc-formula-max-h", `${MAX_FORMULA_BOX_H}px`);

  const CLEAR_FORMULA_LABEL = nodes.clearFormula.innerHTML;
  const CLEAR_HISTORY_LABEL = nodes.clearHistory.innerHTML;

  const state = {
    config: loadConfig(storageKey),
    formula: "",
    analysis: null,
    variables: [],
    rows: [{ cells: {} }],
    evaluations: [],
    selectedRow: 0,
    history: [],
    /** 历史筛选词（**只影响显示**，不写存储、不影响淘汰与恢复，§16.7） */
    historyQuery: "",
    /** 当前编辑命中的历史条目 id（用于列表高亮） */
    activeHistoryId: "",
    /**
     * 自动填值的**记账**（v1.7.14）：变量名 → 上一次由公式预填进第一行的**原样写法**。
     * 只有当单元格内容仍等于这里的记录（或为空格子）时才认为它「仍然是自动的」，
     * 从而在公式里的取值变化后同步更新；用户手改过的格会从记账里删除，公式再变也不覆盖它。
     * **不落盘**（只存在于内存，与「输入不持久化」口径一致）。
     */
    autoFilled: {},
    storageWarned: false,
    armed: { clearFormula: false, clearHistory: false, deleteId: "" },
  };

  /* ── 存储：读写与降级 ─────────────────────────────────── */

  function warnStorageOnce() {
    if (state.storageWarned) return;
    state.storageWarned = true;
    showError("本地存储不可用（可能处于无痕模式），本次的历史与选项仅在当前页面内有效。");
  }

  /**
   * 落盘历史。`historyEnabled` 关闭时**不写任何存储** —— 连导入、删除、清空都不写，
   * 否则 R5 例外的边界（§8.3 例外清单第 5 条 / §16.7）就被击穿了。
   * @returns {boolean} 是否真的写入了存储
   */
  function persistHistory() {
    if (!state.config.historyEnabled) return false;
    if (!saveHistory(state.history)) warnStorageOnce();
    return true;
  }

  /* ── 状态与错误 ───────────────────────────────────────── */

  function setStatus(message, tone) {
    if (!nodes.status) return;
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
    }, FEEDBACK_MS * 2);
  }

  function showError(message) {
    nodes.errorText.textContent = message;
    nodes.error.hidden = false;
  }

  function clearError() {
    nodes.error.hidden = true;
    nodes.errorText.textContent = "";
  }

  /* ── 求值 ─────────────────────────────────────────────── */

  /**
   * 逐行求值。单元格写法的**原样**会通过 `<变量名>::raw` 传给核心，
   * 从而在「变量替换」步骤里显示 `折扣率 = 15%（0.15）`（§16.4 / §16.5）。
   */
  function evaluateRow(index) {
    const row = state.rows[index];
    const values = {};
    const invalid = [];

    state.variables.forEach((variable) => {
      const raw = row.cells[variable.name] === undefined ? "" : String(row.cells[variable.name]);
      const parsed = parseCellValue(raw);
      if (!parsed.ok) {
        invalid.push({ name: variable.name, error: parsed.message || parsed.error });
        return;
      }
      if (parsed.empty) return;
      values[variable.name] = parsed.value;
      if (parsed.raw !== formatNumber(parsed.value)) values[`${variable.name}::raw`] = parsed.raw;
    });

    if (invalid.length > 0) {
      return { kind: "invalid", ok: false, invalid, error: invalid[0].error };
    }
    if (!state.analysis) {
      return { kind: "idle", ok: false };
    }

    const result = evaluateFormula(state.formula, values, parseOptions());
    if (result.ok) {
      return { kind: "ok", ok: true, value: result.value, text: formatNumber(result.value), values };
    }
    if (result.code === ERROR_CODES.missingValues) {
      return { kind: "pending", ok: false, missing: result.missing || [], values };
    }
    return { kind: "error", ok: false, error: result.error, code: result.code, values };
  }

  function evaluateAll() {
    state.evaluations = state.rows.map((row, index) => evaluateRow(index));
  }

  /* ── 变量表数据同步 ───────────────────────────────────── */

  /**
   * 变量集合变化时对齐每行的单元格（单元格按**变量名**索引，公式调整顺序不会串值）。
   *
   * **取值预填跟随公式（v1.7.14，§16.4）**：公式里提取到的取值填进**第一行**，并且当公式里的取值
   * 发生变化时（例如 `单价10` → `单价10.5`，含小数），**仍处于「自动」状态的单元格会同步更新**。
   * 原实现「只要格子非空就永不写入」会让 chips 已经显示新取值、表格却还留着旧值 ——
   * 结果自然按旧值算，看起来就是「公式里的小数没被采用」。
   * 判定「仍处于自动状态」靠 `state.autoFilled` 记账：内容与记账一致（或为空）才更新；
   * 用户在单元格里手改过就会从记账里删除，此后公式再变也不覆盖它。
   */
  function syncRows() {
    const names = state.variables.map((variable) => variable.name);
    state.rows.forEach((row) => {
      Object.keys(row.cells).forEach((name) => {
        if (!names.includes(name)) delete row.cells[name];
      });
    });
    // 变量消失后它的记账也失效
    Object.keys(state.autoFilled).forEach((name) => {
      if (!names.includes(name)) delete state.autoFilled[name];
    });
    if (state.rows.length === 0) state.rows.push({ cells: {} });
    if (state.selectedRow >= state.rows.length) state.selectedRow = state.rows.length - 1;

    if (!state.config.autoFillFromFormula) {
      // 关掉自动填值即「忘记归属」：现有内容一律视为用户自己的
      state.autoFilled = {};
      return;
    }
    const first = state.rows[0];
    state.variables.forEach((variable) => {
      const name = variable.name;
      const raw = variable.prefillRaw;
      if (raw === null || raw === undefined) return; // 公式没给取值：保持原样，不清空也不猜
      const current = String(first.cells[name] === undefined ? "" : first.cells[name]).trim();
      const tracked = Object.prototype.hasOwnProperty.call(state.autoFilled, name)
        ? String(state.autoFilled[name]).trim()
        : null;
      // 空格子，或内容仍是上一次自动填入的那个值 → 同步为新取值；用户手改过的格不动
      if (current === "" || (tracked !== null && current === tracked)) {
        first.cells[name] = raw;
        state.autoFilled[name] = raw;
      }
    });
  }

  /* ── 渲染：着色（§16.13）─────────────────────────────── */

  /** 变量色的类名（超出配色数量后循环） */
  function hueClass(varIndex) {
    return `fc-hue-${(Math.max(0, varIndex) % VAR_HUE_COUNT) + 1}`;
  }

  /** 彩虹括号的类名（按嵌套深度循环）。深度从 1 起 ⇒ 先减 1 再取模，否则第一层会错位到第 2 个色 */
  function depthClass(depth) {
    return `fc-depth-${((Math.max(1, depth) - 1) % BRACKET_HUE_COUNT) + 1}`;
  }

  /**
   * 把核心给出的着色片段渲染成 HTML。
   * **只加颜色、不增删任何字符**（含空白）—— 否则透明输入框与叠加层会错位（§16.13）。
   */
  function segmentsHtml(segments) {
    return (segments || [])
      .map((segment) => {
        const text = escapeHtml(segment.text);
        if (!state.config.syntaxHighlight) return text;
        if (segment.kind === "var") {
          return `<span class="fc-tok fc-tok--var ${hueClass(segment.varIndex)}">${text}</span>`;
        }
        if (segment.kind === "number") {
          // 变量替换而来的数字：加 `fc-tok--origin` ⇒ 沿用该变量的颜色（§16.13）
          return Number.isInteger(segment.varIndex)
            ? `<span class="fc-tok fc-tok--number fc-tok--origin ${hueClass(segment.varIndex)}">${text}</span>`
            : `<span class="fc-tok fc-tok--number">${text}</span>`;
        }
        if (segment.kind === "paren") {
          return `<span class="fc-tok fc-tok--paren ${depthClass(segment.depth)}">${text}</span>`;
        }
        if (segment.kind === "operator") return `<span class="fc-tok fc-tok--op">${text}</span>`;
        if (segment.kind === "space") return text;
        return `<span class="fc-tok fc-tok--unknown">${text}</span>`;
      })
      .join("");
  }

  /** 叠加层随输入框横向滚动一起平移（长公式时两者必须严格同步） */
  function syncLayerScroll() {
    if (!nodes.formulaLayer || !nodes.formula) return;
    nodes.formulaLayer.style.transform = `translateX(${-nodes.formula.scrollLeft}px)`;
  }

  /** 公式框随内容自动增高（上限由 CSS 的 `max-height` 兜住，超出后公式框内部滚动，§16.9） */
  function autoGrow() {
    if (!nodes.formula) return;
    nodes.formula.style.height = "auto";
    nodes.formula.style.height = `${nodes.formula.scrollHeight}px`;
  }

  /**
   * 公式输入框背后的彩色叠加层（§16.13）；关闭着色时回落为普通输入框。
   * 叠加层与文本域**逐像素同度量**（同字体 / 字号 / 行高 / 换行方式、都无内边距与边框），
   * 因此换行位置一致，多行也不会错位；焦点环只画在外层 box 上（§16.1「不得双重边框」）。
   */
  function renderFormulaLayer() {
    if (!nodes.formulaLayer) return;
    const colored = Boolean(state.config.syntaxHighlight);
    if (nodes.formulaBox) nodes.formulaBox.classList.toggle("is-plain", !colored);
    nodes.formulaLayer.innerHTML = colored
      ? segmentsHtml(annotateFormula(nodes.formula.value, parseOptions()).segments)
      : "";
    autoGrow();
    syncLayerScroll();
  }

  /* ── 渲染：公式卡片 ───────────────────────────────────── */

  function renderChips() {
    if (state.variables.length === 0) {
      const text = nodes.formula.value.trim() === "" ? "先写下公式，例如 (100+300)*2 或 单价10*数量25" : "公式中没有变量，直接计算";
      nodes.chips.innerHTML = `<span class="fc-chips__empty">${escapeHtml(text)}</span>`;
      return;
    }
    nodes.chips.innerHTML = state.variables
      .map((variable, index) => {
        const value =
          variable.prefillRaw === null ? "" : `<span class="fc-chip__meta">= ${escapeHtml(variable.prefillRaw)}</span>`;
        const count = variable.count > 1 ? `<span class="fc-chip__meta">出现 ${variable.count} 次</span>` : "";
        // 真实按钮：点按即定位到该变量所在列（§16.4 v1.7.4），键盘 Enter / Space 同样可用
        return (
          `<button class="fc-chip ${hueClass(index)}" type="button" data-locate="${index}" ` +
          `title="定位到「${escapeHtml(variable.name)}」列" ` +
          `aria-label="定位到变量 ${escapeHtml(variable.name)} 所在列">` +
          `<span class="fc-chip__name">${escapeHtml(variable.name)}</span>${value}${count}</button>`
        );
      })
      .join("");
  }

  function renderFormulaMeta() {
    if (!state.analysis) {
      nodes.formulaMeta.textContent = "";
      return;
    }
    const parts = [`变量 ${state.variables.length} 个`, `数据 ${state.rows.length} 行`];
    nodes.formulaMeta.textContent = parts.join(" · ");
  }

  /* ── 渲染：变量表 ─────────────────────────────────────── */

  function resultCellText(evaluation) {
    if (!evaluation) return { text: "", tone: "is-pending" };
    if (evaluation.kind === "ok") return { text: evaluation.text, tone: "" };
    if (evaluation.kind === "pending") return { text: `待填写：${evaluation.missing.join("、")}`, tone: "is-pending" };
    if (evaluation.kind === "invalid") return { text: evaluation.error, tone: "is-error" };
    if (evaluation.kind === "error") return { text: evaluation.error, tone: "is-error" };
    return { text: "", tone: "is-pending" };
  }

  function renderTable() {
    const hasVariables = state.variables.length > 0;
    nodes.tableScroll.hidden = !hasVariables;
    nodes.tableEmpty.hidden = hasVariables;
    nodes.tableMeta.textContent = hasVariables
      ? `变量 ${state.variables.length} / ${MAX_VARIABLES} 个 · 数据 ${state.rows.length} / ${MAX_ROWS} 行`
      : "";

    if (!hasVariables) {
      nodes.tableHead.innerHTML = "";
      nodes.tableBody.innerHTML = "";
      return;
    }

    nodes.tableHead.innerHTML =
      '<tr><th class="fc-table__cell--index" scope="col">行</th>' +
      state.variables
        // 表头与该列单元格用**同一个变量色**，公式与表格一眼对得上（§16.13）
        .map(
          (variable, index) =>
            `<th scope="col" data-column="${index}" class="${hueClass(index)}">` +
            `<span class="fc-var-name">${escapeHtml(variable.name)}</span></th>`
        )
        .join("") +
      '<th class="fc-table__cell--result" scope="col">结果</th></tr>';

    nodes.tableBody.innerHTML = state.rows
      .map((row, index) => {
        const evaluation = state.evaluations[index];
        const result = resultCellText(evaluation);
        const cells = state.variables
          .map((variable, column) => {
            const raw = row.cells[variable.name] === undefined ? "" : String(row.cells[variable.name]);
            const invalid =
              evaluation && evaluation.kind === "invalid" && evaluation.invalid.some((item) => item.name === variable.name);
            return (
              `<td class="fc-cell ${hueClass(column)}${invalid ? " is-invalid" : ""}" data-column="${column}">` +
              `<input class="input" type="text" spellcheck="false" autocomplete="off" ` +
              `data-cell="${index}:${column}" value="${escapeHtml(raw)}" ` +
              `aria-label="${escapeHtml(variable.name)} 第 ${index + 1} 行取值" /></td>`
            );
          })
          .join("");
        const selected = index === state.selectedRow;
        return (
          `<tr class="${selected ? "is-selected" : ""}" data-row="${index}">` +
          `<td class="fc-table__cell--index">` +
          `<button class="fc-pick" type="button" data-pick="${index}" aria-pressed="${selected}" ` +
          `aria-label="查看第 ${index + 1} 行的计算过程">${index + 1}</button></td>` +
          cells +
          `<td class="fc-table__cell--result"><span class="fc-result ${result.tone}" data-result="${index}">` +
          `${escapeHtml(result.text)}</span></td></tr>`
        );
      })
      .join("");
  }

  /** 只刷新某一行的结果单元格与非法态（避免重建整表导致输入框失焦，§16.9） */
  function refreshRow(index) {
    const evaluation = state.evaluations[index];
    const result = resultCellText(evaluation);
    const node = nodes.tableBody.querySelector(`[data-result="${index}"]`);
    if (node) {
      node.textContent = result.text;
      node.className = `fc-result ${result.tone}`.trim();
    }
    state.variables.forEach((variable, column) => {
      const cell = nodes.tableBody.querySelector(`[data-cell="${index}:${column}"]`);
      if (!cell) return;
      const holder = cell.closest(".fc-cell");
      if (!holder) return;
      const invalid =
        evaluation && evaluation.kind === "invalid" && evaluation.invalid.some((item) => item.name === variable.name);
      holder.classList.toggle("is-invalid", Boolean(invalid));
    });
  }

  /**
   * 点 chip 定位到该变量所在列（§16.4 v1.7.4）：目标列短暂高亮 + 在变量表视口内**横向滚动居中**。
   * 定位是纯视图行为：不改变选中行、不改变任何取值、也不改变计算结果。
   */
  function locateColumn(index) {
    const target = nodes.tableHead.querySelector(`[data-column="${index}"]`);
    if (!target) return;

    // 横向滚动必须落在**最近的可滚动祖先**（变量表视口）上，不能假定 window（§9.3）
    if (nodes.tableScroll) {
      const scroller = nodes.tableScroll;
      const targetRect = target.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      const left =
        scroller.scrollLeft + (targetRect.left - scrollerRect.left) - (scrollerRect.width - targetRect.width) / 2;
      scroller.scrollLeft = Math.max(0, Math.min(left, scroller.scrollWidth - scroller.clientWidth));
    }

    clearTimer("locate");
    Array.from(nodes.tableScroll.querySelectorAll(".is-flash")).forEach((node) => node.classList.remove("is-flash"));
    Array.from(nodes.tableScroll.querySelectorAll(`[data-column="${index}"]`)).forEach((node) =>
      node.classList.add("is-flash")
    );
    timers.locate = window.setTimeout(() => {
      Array.from(nodes.tableScroll.querySelectorAll(".is-flash")).forEach((node) => node.classList.remove("is-flash"));
    }, LOCATE_FLASH_MS);

    const variable = state.variables[index];
    setStatus(`已定位到「${variable ? variable.name : ""}」列`, "ok");
  }

  /** 清空历史筛选（清的是筛选词，不是历史，§16.7） */
  function clearHistoryQuery() {
    state.historyQuery = "";
    if (nodes.historySearch) nodes.historySearch.value = "";
    renderHistory();
  }

  /* ── 渲染：分步过程 ───────────────────────────────────── */

  /**
   * 结果行（紧跟公式栏、**常驻**，v1.7.3）：不翻分步过程也要能直接看到结果，
   * 因此它与「分步过程」分开渲染 —— 关掉分步展示时结果依然在。
   * 行内的「计算」「复制」也在这里同步可用状态（无结果时「复制」禁用）。
   */
  function renderResult() {
    const row = state.rows[state.selectedRow];
    const evaluation = state.analysis && row ? state.evaluations[state.selectedRow] : null;
    const result = evaluation ? resultCellText(evaluation) : { text: "—", tone: "is-pending" };

    nodes.resultValue.textContent = evaluation && evaluation.kind === "ok" ? evaluation.text : result.text;
    nodes.resultValue.className = `fc-result-line__value${
      result.tone === "is-error" ? " is-error" : result.tone === "is-pending" ? " is-pending" : ""
    }`;
    nodes.resultRow.textContent =
      state.analysis && row && state.rows.length > 1 ? `第 ${state.selectedRow + 1} 行 / 共 ${state.rows.length} 行` : "";
    if (nodes.copyButton) nodes.copyButton.disabled = !(evaluation && evaluation.kind === "ok");
    // v1.7.26：按钮已更名为「记入历史」，其唯一职责就是写历史；
    // 「记录历史」关闭时它无事可做，禁用并说明原因，而不是让用户点了没反应。
    if (nodes.commitButton) {
      const historyOff = !state.config.historyEnabled;
      nodes.commitButton.disabled = historyOff;
      nodes.commitButton.title = historyOff
        ? "「记录历史」已关闭（齿轮 → 记录历史），开启后才能记入历史"
        : "按当前变量表结算一次，并把这条公式与整张变量表记入历史";
    }
  }

  function renderSteps() {
    const row = state.rows[state.selectedRow];
    const evaluation = state.evaluations[state.selectedRow];
    const hasVariables = state.variables.length > 0;

    nodes.stepsMeta.textContent = hasVariables ? `第 ${state.selectedRow + 1} 行 / 共 ${state.rows.length} 行` : "";

    // 「过滤取值后的变量形式公式」：解析成功就展示（即使该行还没填值）——
    // 它是核对「替换前 vs 替换后」的基准行，必须排在计算过程之前（§16.5）
    nodes.formulaBlock.hidden = !state.analysis;
    nodes.formulaLine.innerHTML = state.analysis ? segmentsHtml(state.analysis.formulaSegments) : "";

    if (!state.analysis || !row) {
      nodes.stepsBlock.hidden = true;
      nodes.steps.hidden = true;
      nodes.stepsEmpty.hidden = false;
      return;
    }
    nodes.stepsBlock.hidden = false;
    // 结果行由 renderResult 单独负责（常驻），这里不再隐藏/显示它（v1.7.3）

    if (!evaluation || evaluation.kind !== "ok" || !state.config.showSteps) {
      nodes.steps.hidden = true;
      nodes.stepsEmpty.hidden = false;
      nodes.stepsEmpty.querySelector(".empty__title").textContent =
        evaluation && evaluation.kind === "ok" ? "分步展示已关闭" : "暂无计算过程";
      nodes.stepsEmpty.querySelector(".empty__text").textContent =
        evaluation && evaluation.kind === "ok"
          ? "在「选项」里打开「展示分步过程」即可看到逐步化简。"
          : "填写该行全部变量的取值后，这里会逐步展示计算过程。";
      return;
    }

    const explained = explainSteps(state.formula, evaluation.values, parseOptions());
    if (!explained.ok) {
      nodes.steps.hidden = true;
      nodes.stepsEmpty.hidden = false;
      return;
    }

    nodes.stepsEmpty.hidden = explained.steps.length > 0;
    nodes.steps.hidden = explained.steps.length === 0;
    nodes.steps.innerHTML = explained.steps
      .map((step) => {
        const omitted = step.label === STEP_LABELS.omitted;
        // 优先用核心给的着色片段；折叠说明行没有片段，退回纯文本
        const expr = step.segments ? segmentsHtml(step.segments) : escapeHtml(step.expr);
        return (
          `<li class="fc-step${omitted ? " fc-step--omitted" : ""}">` +
          `<span class="fc-step__index">${step.index}</span>` +
          '<span class="fc-step__body">' +
          `<span class="fc-step__expr">${expr}</span>` +
          '<span class="fc-step__meta">' +
          `<span class="fc-step__label">${escapeHtml(step.label)}</span>` +
          `<span>${escapeHtml(step.detail)}</span>` +
          "</span></span></li>"
        );
      })
      .join("");
  }

  /* ── 渲染：历史记录 ───────────────────────────────────── */

  function formatRelativeTime(timestamp) {
    const diff = Date.now() - timestamp;
    if (!Number.isFinite(diff) || diff < 0) return "刚刚";
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (diff < minute) return "刚刚";
    if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
    if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
    if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
    const date = new Date(timestamp);
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  /**
   * 历史条目的结果：按当前核心规则**重算**（不存冗余快照，避免规则改动后快照与结果不一致）。
   * 显示的是该条目**记录时选中的那一行**的结果。
   */
  function historyResult(item) {
    const row = item.rows[Math.min(Math.max(item.selectedRow, 0), item.rows.length - 1)] || {};
    const values = {};
    item.variables.forEach((name) => {
      const parsed = parseCellValue(row[name] === undefined ? "" : row[name]);
      if (parsed.ok && !parsed.empty) values[name] = parsed.value;
    });
    const result = evaluateFormula(item.formula, values, parseOptions());
    if (result.ok) return { text: formatNumber(result.value), tone: "" };
    if (result.code === ERROR_CODES.missingValues) return { text: "待填写", tone: "" };
    return { text: "无法计算", tone: "is-error" };
  }

  /**
   * 历史筛选（§16.7 v1.7.4）：按**公式原文或变量名**做不区分大小写的包含匹配。
   * 只影响显示 —— 不写存储、不改条目、不影响恢复，也不影响 50 条 FIFO 淘汰。
   */
  function filteredHistory() {
    const query = state.historyQuery.trim().toLowerCase();
    if (query === "") return state.history;
    return state.history.filter(
      (item) =>
        String(item.formula).toLowerCase().includes(query) ||
        item.variables.some((name) => String(name).toLowerCase().includes(query))
    );
  }

  function renderHistory() {
    const visible = filteredHistory();
    const filtering = state.historyQuery.trim() !== "";
    // 标题上的条数始终是**总数**，筛选结果由下方的「筛选出 N / M 条」交代，避免两处口径打架
    nodes.historyCount.textContent = String(state.history.length);
    nodes.historySearchRow.hidden = state.history.length === 0;
    nodes.historyFilter.hidden = !filtering;
    nodes.historyFilter.textContent = `筛选出 ${visible.length} / ${state.history.length} 条`;
    if (nodes.historyClearQuery) nodes.historyClearQuery.hidden = !filtering;
    nodes.historyEmpty.hidden = visible.length > 0;
    nodes.history.hidden = visible.length === 0;
    if (nodes.historyEmptyTitle) {
      // 空态要分清「还没记录」「筛不到」「根本不会记录」三种，否则文案会与实际行为打架（§16.7）
      if (filtering) {
        nodes.historyEmptyTitle.textContent = "没有匹配的历史记录";
        nodes.historyEmptyText.textContent = "换个关键词试试，或清空筛选条件。";
      } else if (!state.config.historyEnabled) {
        nodes.historyEmptyTitle.textContent = "历史记录已关闭";
        nodes.historyEmptyText.textContent =
          "「记录历史」已关闭（齿轮 → 记录历史），开启后才能保存新条目；已存的条目仍可查看、导出。";
      } else {
        nodes.historyEmptyTitle.textContent = "暂无历史记录";
        nodes.historyEmptyText.textContent = `点「记入历史」或按 Enter 才会存下一条（含整张变量表），最多保留 ${MAX_HISTORY} 条。`;
      }
    }
    nodes.history.innerHTML = visible
      .map((item) => {
        const result = historyResult(item);
        const current = item.id === state.activeHistoryId;
        const armed = state.armed.deleteId === item.id;
        return (
          `<li class="fc-history__item${current ? " is-current" : ""}">` +
          `<button class="fc-history__restore" type="button" data-restore="${escapeHtml(item.id)}">` +
          // title：条目里的公式会被省略号截断，hover 看完整原文（§16.7 v1.7.4）
          `<span class="fc-history__formula" title="${escapeHtml(item.formula)}">${escapeHtml(item.formula)}</span>` +
          '<span class="fc-history__meta">' +
          `<span>${item.variables.length} 个变量 · ${item.rows.length} 行 · ${formatRelativeTime(item.updatedAt)}</span>` +
          `<span class="fc-history__result${result.tone}">= ${escapeHtml(result.text)}</span>` +
          "</span></button>" +
          '<span class="fc-history__actions">' +
          // 单条删除同样走两段式确认（§16.7）：先变成「确认删除？」再点一次才真的删
          `<button class="btn btn--ghost${armed ? " is-armed" : ""}" type="button" data-delete="${escapeHtml(item.id)}" ` +
          `aria-label="${armed ? "确认删除这条历史" : "删除这条历史"}">${armed ? "确认删除？" : icons.icon("trash", 14)}</button>` +
          "</span></li>"
        );
      })
      .join("");
  }

  /* ── 历史写入（去重合并 + FIFO 淘汰，§16.7）──────────── */

  /**
   * 写入一条历史。**只在触发计算（`commit()`）时调用** —— 这是 §16.7 的硬性口径。
   * @returns {boolean} 是否真的生成 / 更新了条目
   */
  function recordHistory() {
    if (!state.config.historyEnabled) return false;
    if (!state.analysis) return false;

    const succeeded = state.evaluations.some((evaluation) => evaluation && evaluation.kind === "ok");
    if (!succeeded) return false; // 仅在求值成功时写入（R5 例外的边界之一）

    const key = normalizeFormula(state.formula).replace(/\s+/g, "");
    // 快照保存**整张变量表**（不是只看选中行）：恢复时公式与每一行取值一起回来（§16.7）
    const rows = state.rows.map((row) => {
      const cells = {};
      state.variables.forEach((variable) => {
        const raw = row.cells[variable.name];
        cells[variable.name] = raw === undefined ? "" : String(raw);
      });
      return cells;
    });
    const snapshot = {
      formula: state.formula,
      variables: state.variables.map((variable) => variable.name),
      rows,
      selectedRow: state.selectedRow,
    };

    const existingIndex = state.history.findIndex((item) => normalizeFormula(item.formula).replace(/\s+/g, "") === key);
    const now = Date.now();
    let item;
    if (existingIndex >= 0) {
      // 同一公式的连续编辑只更新同一条并置顶，避免「边打边算」把 50 条上限灌满前缀碎片
      item = { ...state.history[existingIndex], ...snapshot, updatedAt: now };
      state.history.splice(existingIndex, 1);
    } else {
      item = { id: `h-${now}-${Math.random().toString(36).slice(2, 8)}`, ...snapshot, createdAt: now, updatedAt: now };
    }
    state.history.unshift(item);
    state.activeHistoryId = item.id;
    if (state.history.length > MAX_HISTORY) state.history.length = MAX_HISTORY;

    persistHistory();
    renderHistory();
    return true;
  }

  /* ── 主流程 ───────────────────────────────────────────── */

  function renderAll() {
    renderFormulaMeta();
    renderFormulaLayer();
    renderChips();
    renderTable();
    renderResult();
    renderSteps();
    renderHistory();
  }

  /**
   * 重算并重绘。**不写历史** —— 历史只认 `commit()`（§16.7）。
   * 公式**暂时**非法时保留上一次的变量与表格（边打字边闪很难用），只展示错误提示。
   * @returns {Object} 核心的分析结果（供调用方判断错误类型）
   */
  /** v1.7.25：解析选项（「变量取值解析」开关，§16.2 / §16.3）—— 所有核心调用统一从这里取，避免口径分叉 */
  const parseOptions = () => ({ extractValues: state.config.extractValues });

  function recompute() {
    state.formula = nodes.formula.value;
    const analysis = analyzeFormula(state.formula, parseOptions());

    if (analysis.ok) {
      state.analysis = analysis;
      state.variables = analysis.variables;
      syncRows();
      clearError();
      evaluateAll();
      renderAll();
      return analysis;
    }

    state.analysis = null;
    state.evaluations = [];
    if (analysis.code === ERROR_CODES.empty) {
      clearError();
      state.variables = [];
      state.rows = [{ cells: {} }];
      state.selectedRow = 0;
      state.autoFilled = {}; // 连带清掉自动填值的记账（表格已归零）
    } else {
      showError(analysis.error);
    }
    renderAll();
    return analysis;
  }

  function scheduleRecompute() {
    clearTimer("compute");
    timers.compute = window.setTimeout(() => recompute(), DEBOUNCE_MS);
  }

  /**
   * 触发计算：点「记入历史」按钮或按 `Enter`（`Ctrl/Cmd + Enter` 同义）。
   * 这是**唯一**写历史的入口 —— 输入、编辑单元格、切换行、改选项都只重算不写库（§16.7）。
   */
  function commit() {
    clearTimer("compute");
    const analysis = recompute();
    if (!analysis || analysis.code === ERROR_CODES.empty) {
      setStatus("先写下公式，结果会即时显示；记入历史需要一条能算通的公式。", "warn");
      return;
    }
    if (!analysis.ok) {
      setStatus("公式有误，请先按提示修正。", "warn");
      return;
    }

    const evaluation = state.evaluations[state.selectedRow];
    const recorded = recordHistory();
    if (evaluation && evaluation.kind === "ok") {
      // 只有真的写进去了才说「已记入历史」；关闭时如实说明本次没记，别让用户以为存下了（§16.7）
      if (recorded) setStatus(`已记入历史 · 结果 ${evaluation.text}`, "ok");
      else if (!state.config.historyEnabled)
        setStatus(`已算出 ${evaluation.text}；「记录历史」已关闭，本次未记录`, "warn");
      else setStatus(`已算出 ${evaluation.text}`, "ok");
      return;
    }
    if (evaluation && evaluation.kind === "pending") {
      setStatus(`还有变量未填值：${evaluation.missing.join("、")}`, "warn");
      return;
    }
    if (evaluation && evaluation.kind === "error") {
      setStatus(evaluation.error, "danger");
      return;
    }
    setStatus("已计算，但当前行没有可记录的结果。", "warn");
  }

  /* ── 行选择与增删 ─────────────────────────────────────── */

  function selectRow(index) {
    if (index < 0 || index >= state.rows.length) return;
    if (index !== state.selectedRow) {
      state.selectedRow = index;
      Array.from(nodes.tableBody.querySelectorAll("tr[data-row]")).forEach((row) => {
        const current = Number(row.dataset.row) === index;
        row.classList.toggle("is-selected", current);
        const pick = row.querySelector("[data-pick]");
        if (pick) pick.setAttribute("aria-pressed", String(current));
      });
    }
    renderFormulaMeta();
    // 结果行与分步都属于**当前选中行**：换行必须一起刷新（v1.7.14，§16.9 结果行的「第 N 行」标记 / §16.10）
    renderResult();
    renderSteps();
  }

  function addRow() {
    if (state.variables.length === 0) {
      setStatus("先写下含变量的公式，再增行。", "warn");
      return;
    }
    if (state.rows.length >= MAX_ROWS) {
      setStatus(`数据行数已达上限 ${MAX_ROWS} 行。`, "warn");
      return;
    }
    state.rows.push({ cells: {} });
    state.selectedRow = state.rows.length - 1;
    evaluateAll();
    renderAll();
    setStatus(`已新增第 ${state.rows.length} 行`, "ok");
  }

  function removeRow() {
    if (state.rows.length <= 1) {
      setStatus("至少保留一行数据。", "warn");
      return;
    }
    // 预填的目标行就是第一行：它被删掉后「自动状态」的记账随之失效（v1.7.14）
    if (state.selectedRow === 0) state.autoFilled = {};
    state.rows.splice(state.selectedRow, 1);
    state.selectedRow = Math.max(0, Math.min(state.selectedRow, state.rows.length - 1));
    evaluateAll();
    renderAll();
    setStatus("已删除该行数据", "warn");
  }

  /** 清空各行的取值（保留行数与表结构），便于同一公式换一批数据重算 */
  function clearRows() {
    const hasValue = state.rows.some((row) => Object.keys(row.cells).length > 0);
    if (!hasValue) {
      setStatus("变量表已经是空的。", "warn");
      return;
    }
    state.rows = state.rows.map(() => ({ cells: {} }));
    state.autoFilled = {}; // 全线清空后重新开始记账（下一轮重算会按公式重新预填）
    evaluateAll();
    renderAll();
    setStatus(`已清空 ${state.rows.length} 行的取值`, "warn");
  }

  /* ── 两段式确认（§6）─────────────────────────────────── */

  function resetClearFormula() {
    state.armed.clearFormula = false;
    nodes.clearFormula.classList.remove("is-armed");
    nodes.clearFormula.innerHTML = CLEAR_FORMULA_LABEL;
  }

  function resetClearHistory() {
    state.armed.clearHistory = false;
    nodes.clearHistory.classList.remove("is-armed");
    nodes.clearHistory.innerHTML = CLEAR_HISTORY_LABEL;
  }

  function clearFormula() {
    if (!state.armed.clearFormula) {
      state.armed.clearFormula = true;
      nodes.clearFormula.classList.add("is-armed");
      nodes.clearFormula.textContent = "确认清空？";
      clearTimer("confirm");
      timers.confirm = window.setTimeout(resetClearFormula, CONFIRM_MS);
      return;
    }
    clearTimer("confirm");
    resetClearFormula();
    nodes.formula.value = "";
    state.rows = [{ cells: {} }];
    state.selectedRow = 0;
    state.autoFilled = {};
    recompute({ record: false });
    setStatus("已清空公式与变量表", "warn");
    nodes.formula.focus();
  }

  function clearHistory() {
    if (state.history.length === 0) {
      setStatus("暂无历史记录可清空。", "warn");
      return;
    }
    if (!state.armed.clearHistory) {
      state.armed.clearHistory = true;
      nodes.clearHistory.classList.add("is-armed");
      nodes.clearHistory.textContent = "确认清空？";
      clearTimer("confirm");
      timers.confirm = window.setTimeout(resetClearHistory, CONFIRM_MS);
      return;
    }
    clearTimer("confirm");
    resetClearHistory();
    const removed = state.history.length;
    state.history = [];
    state.activeHistoryId = "";
    state.armed.deleteId = "";
    const persisted = persistHistory();
    renderHistory();
    // 「记录历史」关闭时清空**不落盘**（§16.7 边界：关闭即不写任何存储），必须如实说明，
    // 否则用户以为删干净了，刷新后条目又回来。上限只是规则，不该出现在「已清空」这种结果句里。
    setStatus(
      persisted ? `已清空历史记录，共删除 ${removed} 条` : `已清空当前列表（${removed} 条），但「记录历史」已关闭，本次未写入存储；刷新后已存条目会回来`,
      "warn"
    );
  }

  /* ── 恢复 / 删除单条 ─────────────────────────────────── */

  /** 当前编辑若尚未进历史且已求值成功，则补记一条（恢复历史前调用，避免静默丢失，见 §16.7） */
  function backfillCurrentEdit() {
    if (!state.config.historyEnabled) return;
    if (!state.analysis) return;
    const key = normalizeFormula(state.formula).replace(/\s+/g, "");
    if (!key) return;
    if (state.history.some((entry) => normalizeFormula(entry.formula).replace(/\s+/g, "") === key)) return;
    if (!state.evaluations.some((evaluation) => evaluation && evaluation.kind === "ok")) return;
    recordHistory();
  }

  function restoreHistory(id) {
    const item = state.history.find((entry) => entry.id === id);
    if (!item) return;
    backfillCurrentEdit();
    nodes.formula.value = item.formula;
    // 恢复出来的取值是**用户当时的数据**，不再属于「自动填值」→ 清掉记账，公式再变也不覆盖（v1.7.14）
    state.autoFilled = {};
    // 恢复**整张变量表**与当时选中的行（§16.7）
    state.rows = item.rows.length > 0 ? item.rows.map((cells) => ({ cells: { ...cells } })) : [{ cells: {} }];
    state.selectedRow = Math.max(0, Math.min(item.selectedRow, state.rows.length - 1));
    state.activeHistoryId = item.id;
    recompute({ record: false });
    renderHistory();
    setStatus(`已恢复：${item.formula}（${item.rows.length} 行数据）`, "ok");
  }

  function deleteHistory(id) {
    if (state.armed.deleteId !== id) {
      state.armed.deleteId = id;
      clearTimer("confirm");
      renderHistory();
      timers.confirm = window.setTimeout(() => {
        state.armed.deleteId = "";
        renderHistory();
      }, CONFIRM_MS);
      return;
    }

    clearTimer("confirm");
    state.armed.deleteId = "";
    const index = state.history.findIndex((entry) => entry.id === id);
    if (index < 0) {
      renderHistory();
      return;
    }
    const [removed] = state.history.splice(index, 1);
    if (state.activeHistoryId === id) state.activeHistoryId = "";
    const persisted = persistHistory();
    renderHistory();
    // 与「清空」同口径：关闭状态下的删除不落盘，得说明，别让用户以为已经删掉了（§16.7）
    setStatus(
      persisted ? `已删除历史：${removed.formula}` : `已从当前列表移除：${removed.formula}（「记录历史」已关闭，未写入存储，刷新后会回来）`,
      "warn"
    );
  }

  /* ── 选项 ─────────────────────────────────────────────── */

  function renderConfigInputs() {
    Array.from(host.querySelectorAll("[data-config]")).forEach((input) => {
      input.checked = Boolean(state.config[input.dataset.config]);
    });
  }

  /** 齿轮弹窗的「点外部关闭」监听：只在打开期间存在，关闭时立刻解绑（避免监听堆积） */
  let detachOutsideClick = null;

  function toggleOptions(force) {
    const next = typeof force === "boolean" ? force : nodes.options.hidden;
    nodes.options.hidden = !next;
    nodes.optionsToggle.setAttribute("aria-expanded", String(next));

    if (detachOutsideClick) {
      detachOutsideClick();
      detachOutsideClick = null;
    }
    if (!next) return;

    // 打开：聚焦首个控件 → 键盘用户可直接切换选项；点击浮层外部即关闭（§16.9）
    const firstControl = nodes.options.querySelector("input");
    if (firstControl) firstControl.focus();
    detachOutsideClick = dom.on(document, "pointerdown", (event) => {
      if (nodes.options.contains(event.target) || nodes.optionsToggle.contains(event.target)) return;
      toggleOptions(false);
      nodes.optionsToggle.focus();
    });
  }

  function updateConfig(key, value) {
    state.config = normalizeConfig({ ...state.config, [key]: value });
    if (!saveConfig(state.config, storageKey)) warnStorageOnce();

    if (key === "showSteps") {
      renderSteps();
      return;
    }
    if (key === "syntaxHighlight") {
      renderFormulaLayer();
      renderSteps();
      return;
    }
    if (key === "autoFillFromFormula") {
      recompute();
      return;
    }
    if (key === "extractValues") {
      // 开关影响**解析**本身：必须整体重算（变量、预填、着色、分步一起变）
      recompute();
      setStatus(
        value
          ? "已开启变量取值解析：变量名后紧跟的数字（含负数，如 调价-7.38）算作它的取值。"
          : "已关闭变量取值解析：变量名后的数字按独立数值处理（X-5 即 X 减 5）。",
        "info"
      );
      return;
    }
    if (key === "historyEnabled") {
      // 关闭后不写任何存储（§16.7）；已写入的历史保留，由用户自行清空
      setStatus(
        value
          ? "已开启「记录历史」：之后算出的结果可以存进历史"
          : "已关闭「记录历史」：新结果不再保存（已存的条目仍保留，可导出或清空）",
        value ? "ok" : "warn"
      );
      // 主按钮「记入历史」与历史空态都取决于这个开关，必须一起刷新（v1.7.26）
      renderResult();
      renderHistory();
    }
  }

  /* ── 复制结果 ─────────────────────────────────────────── */

  function copyResult() {
    const evaluation = state.evaluations[state.selectedRow];
    if (!evaluation || evaluation.kind !== "ok") {
      setStatus("当前行还没有可复制的结果。", "warn");
      return;
    }
    clipboard
      .copyText(evaluation.text)
      .then(() => setStatus(`已复制结果 ${evaluation.text}`, "ok"))
      .catch(() => setStatus("复制失败，请手动选择结果文本。", "warn"));
  }

  /* ── 导入 / 导出（§8.4）──────────────────────────────── */

  function downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    timers.revoke = window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      activeReader = reader;
      const release = () => {
        if (activeReader === reader) activeReader = null;
      };
      reader.onload = () => {
        release();
        resolve(String(reader.result === null ? "" : reader.result));
      };
      reader.onerror = () => {
        release();
        reject(new Error("文件读取失败，请重试。"));
      };
      reader.onabort = release;
      reader.readAsText(file, "utf-8");
    });
  }

  function dateStamp() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  }

  function exportHistory() {
    if (state.history.length === 0) {
      setStatus("暂无历史记录可导出。", "warn");
      return;
    }
    downloadFile(
      `formula-calc-history-${dateStamp()}.json`,
      JSON.stringify(serializeHistory(state.history), null, 2),
      "application/json"
    );
    setStatus(`已导出 ${state.history.length} 条历史`, "ok");
  }

  function toggleImportPanel(force) {
    const next = typeof force === "boolean" ? force : nodes.importPanel.hidden;
    nodes.importPanel.hidden = !next;
    if (next) nodes.importText.focus();
    else {
      nodes.importText.value = "";
      nodes.importFile.value = "";
      nodes.importFileName.textContent = "未选择文件";
      clearError();
    }
  }

  async function confirmImport() {
    clearError();
    let raw = nodes.importText.value.trim();
    const file = nodes.importFile.files && nodes.importFile.files[0];

    if (raw === "" && file) {
      try {
        raw = await readFileAsText(file);
      } catch (error) {
        showError(error.message);
        return;
      }
    }
    // 读取期间实例可能已被关闭（面板卸载）：此时不得再继续写存储（§9.3 第 5 条）
    if (!host.isConnected) return;
    if (raw === "") {
      showError("请选择 JSON 文件，或粘贴 JSON 文本后再导入。");
      return;
    }

    let parsed;
    try {
      parsed = parseImportPayload(raw);
    } catch (error) {
      showError(error.message);
      return;
    }

    let added = 0;
    let overwritten = 0;
    let overflow = 0;
    parsed.items.forEach((item) => {
      const key = normalizeFormula(item.formula).replace(/\s+/g, "");
      const index = state.history.findIndex((entry) => normalizeFormula(entry.formula).replace(/\s+/g, "") === key);
      if (index >= 0) {
        state.history[index] = { ...state.history[index], ...item, id: state.history[index].id };
        overwritten += 1;
      } else if (state.history.length < MAX_HISTORY) {
        state.history.push(item);
        added += 1;
      } else {
        overflow += 1;
      }
    });
    state.history.sort((a, b) => b.updatedAt - a.updatedAt);

    const persisted = persistHistory();
    renderHistory();

    const parts = [`新增 ${added} 条`, `覆盖 ${overwritten} 条`];
    if (overflow > 0) parts.push(`超出上限跳过 ${overflow} 条`);
    if (parsed.stats.skipped > 0) parts.push(`忽略非法 ${parsed.stats.skipped} 条`);
    if (!persisted) parts.push("历史记录已关闭，本次未写入存储");
    setStatus(`导入完成：${parts.join("，")}`, added + overwritten > 0 ? "ok" : "warn");
    toggleImportPanel(false);
  }

  /* ── 事件绑定 ─────────────────────────────────────────── */

  // 输入时：立即刷新彩色叠加层（着色是「边打字边看」的，不能等防抖），再防抖重算结果
  bind(nodes.formula, "input", () => {
    renderFormulaLayer();
    scheduleRecompute();
  });
  bind(nodes.formula, "scroll", syncLayerScroll);
  bind(nodes.formula, "keydown", (event) => {
    if (event.key !== "Enter") return;
    // Alt+Enter 插入换行（长公式排版，§16.9）；其余 Enter 一律触发「计算」
    if (event.altKey) return;
    event.preventDefault();
    commit();
  });

  bind(nodes.tableBody, "input", (event) => {
    const input = event.target.closest("[data-cell]");
    if (!input) return;
    const [rowIndex, column] = input.dataset.cell.split(":").map(Number);
    const variable = state.variables[column];
    if (!variable || !state.rows[rowIndex]) return;
    state.rows[rowIndex].cells[variable.name] = input.value;
    // 第一行是自动填值的落点：用户一旦手改，该格就归用户所有 —— 从记账里删除，
    // 此后公式里的取值再变也不会覆盖它（v1.7.14，§16.4）
    if (rowIndex === 0) delete state.autoFilled[variable.name];
    // 每行互相独立：只重算被编辑的这一行，立即刷新它的结果与非法态
    state.evaluations[rowIndex] = evaluateRow(rowIndex);
    refreshRow(rowIndex);
    // 顶部结果行（含「复制」可用状态）与分步都属于**选中行**，编辑它时必须一并刷新（v1.7.14）
    if (rowIndex === state.selectedRow) {
      renderResult();
      renderSteps();
    }
  });

  bind(nodes.tableBody, "click", (event) => {
    const pick = event.target.closest("[data-pick]");
    if (pick) {
      selectRow(Number(pick.dataset.pick));
      return;
    }
    const row = event.target.closest("tr[data-row]");
    if (!row || event.target.closest("input")) return;
    selectRow(Number(row.dataset.row));
  });

  // 点变量 chip → 定位到该变量所在列（纯视图行为，§16.4）
  bind(nodes.chips, "click", (event) => {
    const chip = event.target.closest("[data-locate]");
    if (!chip) return;
    locateColumn(Number(chip.dataset.locate));
  });

  bind(nodes.optionsToggle, "click", () => toggleOptions());
  host.querySelectorAll("[data-config]").forEach((input) => {
    bind(input, "change", () => updateConfig(input.dataset.config, input.checked));
  });

  bind(host.querySelector('[data-action="commit"]'), "click", commit);
  // 「复制」入口只有结果行一处（v1.7.3 起），但仍按选择器绑定，避免日后加回入口时漏绑
  Array.from(host.querySelectorAll('[data-action="copy-result"]')).forEach((button) => {
    bind(button, "click", copyResult);
  });
  bind(nodes.clearFormula, "click", clearFormula);

  // 「替换输入公式」（v1.7.25）：去掉取值 → 变量形式；变量表已填的值保持不变
  // （syncRows 只在格子为空、或内容仍是上次自动填入值时才同步，替换后新公式没有取值 ⇒ 不覆盖）
  bind(host.querySelector('[data-action="apply-stripped"]'), "click", () => {
    const next = stripEmbeddedValues(nodes.formula.value, parseOptions());
    if (next === nodes.formula.value) {
      setStatus("当前公式里没有可移除的取值。", "info");
      return;
    }
    nodes.formula.value = next;
    clearTimer("compute");
    recompute();
    setStatus("已移除取值，公式已还原为变量形式；变量表已填的值保持不变。", "ok");
  });
  bind(host.querySelector('[data-action="add-row"]'), "click", addRow);
  bind(host.querySelector('[data-action="remove-row"]'), "click", removeRow);
  bind(host.querySelector('[data-action="clear-rows"]'), "click", clearRows);

  bind(nodes.history, "click", (event) => {
    const restore = event.target.closest("[data-restore]");
    if (restore) {
      restoreHistory(restore.dataset.restore);
      return;
    }
    const remove = event.target.closest("[data-delete]");
    if (remove) deleteHistory(remove.dataset.delete);
  });

  bind(host.querySelector('[data-action="export-history"]'), "click", exportHistory);
  bind(host.querySelector('[data-action="toggle-import"]'), "click", () => toggleImportPanel());
  bind(host.querySelector('[data-action="confirm-import"]'), "click", confirmImport);
  bind(host.querySelector('[data-action="close-import"]'), "click", () => toggleImportPanel(false));
  bind(nodes.clearHistory, "click", clearHistory);

  // 历史筛选（§16.7 v1.7.4）：只改显示，不动存储
  if (nodes.historySearch) {
    bind(nodes.historySearch, "input", () => {
      state.historyQuery = nodes.historySearch.value;
      renderHistory();
    });
    bind(nodes.historySearch, "keydown", (event) => {
      if (event.key !== "Escape") return;
      // 输入框内的 Esc 就地清筛选并阻止外泄（避免触发外壳的其它 Esc 行为）
      event.preventDefault();
      event.stopPropagation();
      clearHistoryQuery();
    });
  }
  if (nodes.historyClearQuery) bind(nodes.historyClearQuery, "click", clearHistoryQuery);

  bind(nodes.importFile, "change", () => {
    const file = nodes.importFile.files && nodes.importFile.files[0];
    nodes.importFileName.textContent = file ? file.name : "未选择文件";
    clearError();
  });

  // 快捷键归属：标签工作台内只有「焦点在本工具面板内」时才响应，否则并排/多标签时一次按键会同时触发多个工具（§9.3 第 2 条）
  const inTabsWorkspace = Boolean(root.closest("[data-tabs-workspace]"));
  bind(document, "keydown", (event) => {
    if (inTabsWorkspace && !root.contains(event.target)) return;
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      commit();
      return;
    }
    if (event.key === "Escape") {
      if (!nodes.importPanel.hidden) toggleImportPanel(false);
      else if (!nodes.options.hidden) {
        toggleOptions(false);
        nodes.optionsToggle.focus();
      } else if (state.armed.deleteId) {
        state.armed.deleteId = "";
        renderHistory();
      } else if (state.armed.clearFormula) resetClearFormula();
      else if (state.armed.clearHistory) resetClearHistory();
      else if (!nodes.error.hidden) clearError();
    }
  });

  /* ── 初始化 ───────────────────────────────────────────── */

  state.history = loadHistory();
  renderConfigInputs();
  nodes.formula.value = state.formula;
  recompute({ record: false });
  renderAll();

  // 挂载时自动恢复（§16.7 v1.7.6）：工具状态只在内存里，而外壳会重建面板、页面也可能被重新加载，
  // 于是「算到一半的东西」会丢。历史已落盘，包一层把它放回面板即可 ——
  // 只读既有的 history 键、只在初次挂载（此刻面板必为空）、历史为空则静默、且可由参数关闭。
  if (state.config.restoreLastOnMount && state.history.length > 0) {
    restoreHistory(state.history[0].id);
    setStatus("已恢复上次的公式与取值（可在选项里关闭）", "ok");
  }

  console.info(
    `[toolbox] 已挂载工具「${tool.name}」：历史 ${state.history.length} / ${MAX_HISTORY} 条，历史记录${state.config.historyEnabled ? "已开启" : "已关闭"}`
  );

  return () => {
    Object.keys(timers).forEach(clearTimer);
    if (detachOutsideClick) {
      detachOutsideClick();
      detachOutsideClick = null;
    }
    if (activeReader) {
      try {
        activeReader.abort();
      } catch (error) {
        /* 读取已结束，忽略 */
      }
      activeReader = null;
    }
    disposers.forEach((dispose) => dispose());
    dom.clear(host);
  };
}

export const meta = {
  id: "formula-calc",
  version: "1.0.0",
  status: "ready",
};

export default init;
