/**
 * 工具：《文本行合并》—— 独立处理模块
 * ------------------------------------------------------------------
 * 契约：本模块只导出 init(ctx)，由 assets/js/shell.js 在加载
 *      tools/text-line-merge/index.html 后动态 import 并调用。
 *
 * 解耦约定：
 *   - 不导入其它工具的代码，不读写跨工具的全局状态；
 *   - 与外壳之间只通过 ctx（容器、注册表记录、公共工具函数）交互；
 *   - 通用能力复用 ctx.utils（剪贴板 / 文本 / DOM）。
 *
 * 分层：
 *   1. 纯函数核心  normalizeConfig / selectLines / escapeLine / mergeLines /
 *                  configEquals / serializePresets / parseImportPayload
 *   2. 存储适配层  loadCustomPresets / saveCustomPresets / loadSession / saveSession
 *   3. UI 编排层   init(ctx)
 *
 * 隐私：全部计算在本机完成；仅「参数配置」与「自定义预设」写入 localStorage，
 *      绝不持久化输入文本，也不发起任何网络请求。
 */

/* ================================================================== 常量 */

const STORAGE_PREFIX = "toolbox:text-line-merge";
const PRESETS_KEY = `${STORAGE_PREFIX}:presets`;
const SESSION_KEY = `${STORAGE_PREFIX}:config`;

const EXPORT_VERSION = 1;
const EXPORT_APP = "local-toolbox";
const EXPORT_TOOL = "text-line-merge";

const MAX_PRESETS = 200;
const MAX_NAME_LENGTH = 40;
const DEBOUNCE_MS = 180;
const FEEDBACK_MS = 2000;

/** 预设下拉中代表「已手动改动、尚未保存」的哨兵值 */
const CUSTOM_ID = "__custom__";

/** 效果片段的示例文字（参数前置可见） */
const SAMPLE_LEFT = "甲";
const SAMPLE_RIGHT = "乙";

const ESCAPE_MODES = ["double", "backslash"];

/** 全部配置字段，用于归一化与比较 */
const CONFIG_KEYS = [
  "separator",
  "prefix",
  "suffix",
  "trim",
  "dropEmpty",
  "escape",
  "escapeChar",
  "escapeMode",
];

/* ========================================================== 纯函数核心 */

function asString(value, fallback) {
  return typeof value === "string" ? value : fallback;
}

function asBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

/** 默认参数：即「英文逗号合并」预设 */
export const DEFAULT_CONFIG = Object.freeze({
  separator: ",",
  prefix: "",
  suffix: "",
  trim: false,
  dropEmpty: false,
  escape: false,
  escapeChar: "'",
  escapeMode: "double",
});

/**
 * 把任意输入归一化为合法配置：缺失字段补默认值、类型不符回退、未知字段丢弃。
 * @param {Object} [partial]
 * @returns {typeof DEFAULT_CONFIG}
 */
export function normalizeConfig(partial) {
  const source = partial && typeof partial === "object" && !Array.isArray(partial) ? partial : {};
  return {
    separator: asString(source.separator, DEFAULT_CONFIG.separator),
    prefix: asString(source.prefix, DEFAULT_CONFIG.prefix),
    suffix: asString(source.suffix, DEFAULT_CONFIG.suffix),
    trim: asBoolean(source.trim, DEFAULT_CONFIG.trim),
    dropEmpty: asBoolean(source.dropEmpty, DEFAULT_CONFIG.dropEmpty),
    escape: asBoolean(source.escape, DEFAULT_CONFIG.escape),
    escapeChar: asString(source.escapeChar, DEFAULT_CONFIG.escapeChar),
    escapeMode: ESCAPE_MODES.includes(source.escapeMode)
      ? source.escapeMode
      : DEFAULT_CONFIG.escapeMode,
  };
}

/** 两份配置是否等价（用于判断当前参数是否仍与所选预设一致） */
export function configEquals(a, b) {
  const left = normalizeConfig(a);
  const right = normalizeConfig(b);
  return CONFIG_KEYS.every((key) => left[key] === right[key]);
}

/**
 * 依据配置筛选与裁剪行：去首尾空白（可选）→ 丢弃空行（可选）。
 * 不套前后缀，供统计「参与合并行数」使用。
 * @param {string[]} lines
 * @param {Object} config
 * @returns {string[]}
 */
export function selectLines(lines, config) {
  const cfg = normalizeConfig(config);
  const result = [];
  for (const raw of Array.isArray(lines) ? lines : []) {
    const line = cfg.trim ? raw.trim() : raw;
    if (cfg.dropEmpty && line === "") continue;
    result.push(line);
  }
  return result;
}

/**
 * 对单行内容做转义（仅作用于行内容，不影响前后缀）。
 * 使用 split/join 而非正则，可安全处理任意长度、含正则元字符的转义字符。
 * @param {string} content
 * @param {Object} config
 * @returns {string}
 */
export function escapeLine(content, config) {
  const cfg = normalizeConfig(config);
  if (!cfg.escape || cfg.escapeChar === "") return content;
  const replacement =
    cfg.escapeMode === "backslash" ? `\\${cfg.escapeChar}` : cfg.escapeChar + cfg.escapeChar;
  return content.split(cfg.escapeChar).join(replacement);
}

/**
 * 合并为单行字符串。
 * 顺序：拆分行 → 去首尾空白（可选）→ 丢弃空行（可选）→ 行内容转义（可选）→ 套前后缀 → 分隔符连接。
 * 对 selectLines 的输出再调用本函数是幂等的。
 * @param {string[]} lines
 * @param {Object} config
 * @returns {string}
 */
export function mergeLines(lines, config) {
  const cfg = normalizeConfig(config);
  const items = selectLines(lines, config).map(
    (line) => `${cfg.prefix}${escapeLine(line, cfg)}${cfg.suffix}`
  );
  return items.join(cfg.separator);
}

/** 生成一个可读、低碰撞的本地 id */
function createPresetId() {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** 内置预设：与自定义预设共用同一结构，仅是一组参数取值 */
export const BUILTIN_PRESETS = [
  {
    id: "comma",
    name: "英文逗号合并",
    description: "以英文逗号分隔，不加前后缀",
    config: normalizeConfig({ separator: "," }),
  },
  {
    id: "comma-space",
    name: "英文逗号 + 空格",
    description: "以「逗号 + 空格」分隔，便于阅读",
    config: normalizeConfig({ separator: ", " }),
  },
  {
    id: "sql-list",
    name: "SQL 列表",
    description: "每行加英文单引号，合并为 SQL 的 IN 列表",
    config: normalizeConfig({
      separator: ",",
      prefix: "'",
      suffix: "'",
      trim: true,
      dropEmpty: true,
      escape: true,
      escapeChar: "'",
      escapeMode: "double",
    }),
  },
  {
    id: "space",
    name: "空格合并",
    description: "以单个空格分隔",
    config: normalizeConfig({ separator: " " }),
  },
  {
    id: "pipe",
    name: "竖线分隔",
    description: "以竖线加空格分隔",
    config: normalizeConfig({ separator: " | " }),
  },
  {
    id: "concat",
    name: "直接拼接",
    description: "不使用分隔符，逐行首尾相接",
    config: normalizeConfig({ separator: "" }),
  },
].map((preset) => ({ ...preset, builtin: true }));

/** 按 id 查找内置预设 */
function findBuiltin(id) {
  return BUILTIN_PRESETS.find((preset) => preset.id === id) || null;
}

/**
 * 生成导出用的数据对象（带版本号，便于将来演进）。
 * @param {Array} presets 自定义预设
 * @param {Object} currentConfig 当前参数（仅作备份参考，导入时不会自动应用）
 * @returns {Object}
 */
export function serializePresets(presets, currentConfig) {
  return {
    app: EXPORT_APP,
    tool: EXPORT_TOOL,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    config: normalizeConfig(currentConfig),
    presets: (Array.isArray(presets) ? presets : []).map((preset) => ({
      name: preset.name,
      config: normalizeConfig(preset.config),
    })),
  };
}

/**
 * 解析并校验导入内容。校验失败整体抛错，绝不部分写入。
 * @param {string|Object} raw JSON 文本或已解析对象
 * @returns {{ presets: Array<{name: string, config: Object}>, stats: { total: number, valid: number, skipped: number } }}
 */
export function parseImportPayload(raw) {
  let data = raw;

  if (typeof raw === "string") {
    const text = raw.trim();
    if (text === "") {
      throw new Error("导入内容为空，请粘贴 JSON 文本或选择 JSON 文件。");
    }
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
    throw new Error(
      `不支持的版本号 ${String(data.version)}，当前仅支持 ${EXPORT_VERSION}。`
    );
  }
  if (!Array.isArray(data.presets)) {
    throw new Error("JSON 结构不正确：缺少 presets 数组。");
  }

  const source = data.presets;
  const presets = [];
  let skipped = 0;

  source.forEach((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      skipped += 1;
      return;
    }
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (name === "" || !item.config || typeof item.config !== "object") {
      skipped += 1;
      return;
    }
    presets.push({
      name: name.slice(0, MAX_NAME_LENGTH),
      config: normalizeConfig(item.config),
    });
  });

  if (presets.length === 0) {
    throw new Error("未解析到任何有效的预设记录。");
  }

  return {
    presets,
    stats: { total: source.length, valid: presets.length, skipped },
  };
}

/* ======================================================== 存储适配层 */

function readJson(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw);
  } catch (error) {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    return false;
  }
}

/** 归一化一条自定义预设记录，非法时返回 null */
function normalizePresetRecord(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const name = typeof item.name === "string" ? item.name.trim().slice(0, MAX_NAME_LENGTH) : "";
  if (name === "") return null;
  return {
    id: typeof item.id === "string" && item.id !== "" ? item.id : createPresetId(),
    name,
    config: normalizeConfig(item.config),
    createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
    builtin: false,
  };
}

/** 读取自定义预设列表（存储不可用或数据损坏时返回空数组） */
export function loadCustomPresets() {
  const raw = readJson(PRESETS_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizePresetRecord).filter(Boolean).slice(0, MAX_PRESETS);
}

/** 写入自定义预设列表，返回是否成功 */
export function saveCustomPresets(presets) {
  return writeJson(PRESETS_KEY, presets);
}

/** 读取上次使用的参数与预设选择 */
export function loadSession() {
  const raw = readJson(SESSION_KEY, null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return {
    config: normalizeConfig(raw.config),
    presetId: typeof raw.presetId === "string" ? raw.presetId : "",
  };
}

/** 写入上次使用的参数与预设选择 */
export function saveSession(config, presetId) {
  return writeJson(SESSION_KEY, { config: normalizeConfig(config), presetId });
}

/* ============================================================ 界面模板 */

const TEMPLATE = `
<div class="tlm-toolbar">
  <div class="tlm-toolbar__group">
    <label class="meta-label" for="tlm-preset">预设</label>
    <select class="select tlm-preset" id="tlm-preset"></select>
  </div>
  <div class="tlm-toolbar__actions">
    <button class="btn" type="button" data-action="save-preset">__I_SAVE__ 另存为</button>
    <button class="btn" type="button" data-action="delete-preset">__I_TRASH__ 删除</button>
    <button class="icon-btn" type="button" data-action="reset-config" title="恢复默认预设" aria-label="恢复默认预设">__I_REFRESH__</button>
    <button class="icon-btn" type="button" data-action="copy-json" title="复制预设 JSON" aria-label="复制预设 JSON">__I_JSON__</button>
    <button class="btn" type="button" data-action="export-presets">__I_DOWNLOAD__ 导出</button>
    <button class="btn" type="button" data-action="import-presets">__I_UPLOAD__ 导入</button>
  </div>
</div>

<p class="tlm-status" id="tlm-status" role="status" aria-live="polite"></p>

<form class="tlm-inline" data-save-form hidden>
  <label class="sr-only" for="tlm-preset-name">预设名称</label>
  <input class="input" id="tlm-preset-name" type="text" maxlength="40" autocomplete="off"
         placeholder="输入预设名称，例如：英文逗号 + 单引号" />
  <button class="btn btn--primary" type="submit">保存</button>
  <button class="btn btn--ghost" type="button" data-action="cancel-save">取消</button>
</form>

<div class="tlm-migrate" data-import-panel hidden>
  <div class="tlm-migrate__head">
    <h3 class="tlm-migrate__title">导入预设</h3>
    <button class="icon-btn" type="button" data-action="close-import" title="关闭" aria-label="关闭导入面板">__I_CLOSE__</button>
  </div>
  <p class="tlm-migrate__note">
    JSON 在本机浏览器内解析，不会上传。同名预设将以导入内容为准覆盖。
  </p>
  <div class="tlm-migrate__row">
    <label class="btn" for="tlm-import-file">__I_UPLOAD__ 选择 JSON 文件</label>
    <input class="sr-only" type="file" id="tlm-import-file" accept=".json,application/json" />
    <span class="tlm-migrate__file mono" data-import-filename>未选择文件</span>
  </div>
  <div class="field">
    <label class="field__label" for="tlm-import-text">
      <span>或直接粘贴 JSON</span>
      <span class="field__hint">与「导出 / 复制 JSON」的内容格式一致</span>
    </label>
    <textarea class="textarea textarea--compact" id="tlm-import-text" spellcheck="false"
              placeholder='{"app":"local-toolbox","tool":"text-line-merge","version":1,"presets":[…]}'></textarea>
  </div>
  <div class="tlm-migrate__actions">
    <button class="btn btn--primary" type="button" data-action="confirm-import">导入预设</button>
    <button class="btn btn--ghost" type="button" data-action="close-import">取消</button>
  </div>
</div>

<div class="notice notice--danger" data-error hidden>
  <span class="notice__icon" aria-hidden="true">__I_ALERT__</span>
  <div class="notice__body">
    <p class="notice__title">操作失败</p>
    <p class="notice__text" data-error-text></p>
  </div>
</div>

<div class="panel-grid">
  <!-- 左列：纵向工作流（输入 → 合并 → 输出），输入与输出构成「吕」字形 -->
  <div class="panel-stack">
    <section class="panel tlm-block--input" aria-labelledby="tlm-panel-input">
      <div class="panel__head">
        <h2 class="panel__title" id="tlm-panel-input">__I_INPUT__ 输入文本</h2>
        <span class="panel__hint" data-input-lines>0 行</span>
      </div>
      <div class="panel__body">
        <div class="field">
          <div class="field__label">
            <span>待合并内容</span>
            <span class="field__hint">每行一段，支持粘贴任意多行文本</span>
          </div>
          <textarea class="textarea" id="tlm-input" spellcheck="false"
                    placeholder="在此粘贴需要合并的多行文本…" aria-describedby="tlm-input-note"></textarea>
          <p class="field__hint" id="tlm-input-note">示例：第一行 / 第二行 / 第三行</p>
        </div>
      </div>
      <div class="panel__foot">
        <button class="btn btn--ghost" type="button" data-action="clear-input">__I_TRASH__ 清空</button>
        <span class="panel__spacer"></span>
        <span class="panel__hint">快捷键 <kbd>Ctrl</kbd> + <kbd>Enter</kbd> 执行合并</span>
      </div>
    </section>

    <!-- 主操作条：紧贴输入面板正下方，横跨左列整宽 -->
    <div class="tlm-action-bar">
      <button class="btn btn--primary" type="button" data-action="merge">__I_MERGE__ 合并</button>
    </div>

    <!-- 输出面板：位于输入面板正下方，与输入面板共同构成「吕」字形 -->
    <section class="panel tlm-result" aria-labelledby="tlm-panel-output">
      <div class="panel__head">
        <h2 class="panel__title" id="tlm-panel-output">__I_OUTPUT__ 合并结果</h2>
        <span class="panel__hint mono" data-result-meta>单行输出</span>
      </div>
      <div class="panel__body">
        <div class="output tlm-output" data-output hidden></div>
        <div class="empty" data-output-empty>
          <p class="empty__title">暂无结果</p>
          <p class="empty__text">在上方输入多行文本后，合并结果会实时显示在这里。</p>
        </div>
      </div>
      <div class="panel__foot" data-output-foot>
        <button class="btn btn--primary" type="button" data-action="copy">__I_COPY__ 复制结果</button>
        <button class="btn" type="button" data-action="download">__I_DOWNLOAD__ 下载为 .txt</button>
        <span class="panel__spacer"></span>
        <span class="panel__hint">零网络请求 · 零数据上传</span>
      </div>
    </section>
  </div>

  <!-- 右列：独立参数列（选项 + 统计），不占用页面底部空间 -->
  <div class="panel-stack">
    <section class="panel tlm-block--options" aria-labelledby="tlm-panel-options">
      <div class="panel__head">
        <h2 class="panel__title" id="tlm-panel-options">__I_REFRESH__ 合并选项</h2>
        <span class="panel__hint">实时预览</span>
      </div>
      <div class="panel__body">
        <div class="field">
          <label class="field__label" for="tlm-separator">
            <span>分隔符</span>
            <span class="field__hint">留空表示直接拼接</span>
          </label>
          <input class="input" id="tlm-separator" type="text" autocomplete="off" spellcheck="false" />
          <p class="field__hint tlm-effect">效果：<code data-effect="separator"></code></p>
        </div>

        <div class="field">
          <label class="field__label" for="tlm-prefix">
            <span>每行前缀</span>
            <span class="field__hint">加在每行开头</span>
          </label>
          <input class="input" id="tlm-prefix" type="text" autocomplete="off" spellcheck="false" />
          <p class="field__hint tlm-effect">效果：<code data-effect="prefix"></code></p>
        </div>

        <div class="field">
          <label class="field__label" for="tlm-suffix">
            <span>每行后缀</span>
            <span class="field__hint">加在每行结尾</span>
          </label>
          <input class="input" id="tlm-suffix" type="text" autocomplete="off" spellcheck="false" />
          <p class="field__hint tlm-effect">效果：<code data-effect="suffix"></code></p>
        </div>

        <div class="field">
          <span class="field__label">处理规则</span>
          <label class="checkbox">
            <input type="checkbox" id="tlm-trim" />
            <span>去除每行首尾空白</span>
          </label>
          <label class="checkbox">
            <input type="checkbox" id="tlm-drop-empty" />
            <span>忽略空行</span>
          </label>
          <label class="checkbox">
            <input type="checkbox" id="tlm-escape" />
            <span>启用转义（仅作用于行内容）</span>
          </label>
        </div>

        <div class="field tlm-escape-group" data-escape-group>
          <label class="field__label" for="tlm-escape-char">
            <span>转义字符</span>
            <span class="field__hint">默认英文单引号</span>
          </label>
          <input class="input" id="tlm-escape-char" type="text" maxlength="4" autocomplete="off"
                 spellcheck="false" />

          <label class="field__label" for="tlm-escape-mode">转义方式</label>
          <select class="select" id="tlm-escape-mode">
            <option value="double">双写：' 变为 ''</option>
            <option value="backslash">反斜杠：' 变为 \\'</option>
          </select>
        </div>
      </div>
    </section>

    <section class="panel tlm-block--stats" aria-labelledby="tlm-panel-stats">
      <div class="panel__head">
        <h2 class="panel__title" id="tlm-panel-stats">统计</h2>
      </div>
      <div class="panel__body">
        <div class="stats">
          <div class="stat">
            <div class="stat__value" data-stat="input-lines">0</div>
            <div class="stat__label">输入行数</div>
          </div>
          <div class="stat">
            <div class="stat__value" data-stat="merged-lines">0</div>
            <div class="stat__label">参与合并</div>
          </div>
          <div class="stat">
            <div class="stat__value" data-stat="output-chars">0</div>
            <div class="stat__label">输出字符</div>
          </div>
        </div>
      </div>
    </section>
  </div>
</div>
`;

const ICON_TOKENS = {
  __I_SAVE__: ["save", 15],
  __I_TRASH__: ["trash", 15],
  __I_REFRESH__: ["refresh", 15],
  __I_JSON__: ["fileJson", 15],
  __I_DOWNLOAD__: ["download", 15],
  __I_UPLOAD__: ["upload", 15],
  __I_CLOSE__: ["close", 15],
  __I_ALERT__: ["alert", 18],
  __I_INPUT__: ["merge", 16],
  __I_OUTPUT__: ["check", 16],
  __I_MERGE__: ["merge", 15],
  __I_COPY__: ["copy", 15],
};

/* ========================================================== 通用小工具 */

/** 触发本地文件下载（Blob + 对象 URL，用完即释放） */
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
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 以 UTF-8 读取本地文件（FileReader 本地解析，不上传） */
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result === null ? "" : reader.result));
    reader.onerror = () => reject(new Error("文件读取失败，请重试。"));
    reader.readAsText(file, "utf-8");
  });
}

/** 生成下载文件名用的日期串：20260911 */
function dateStamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

/* ============================================================== 入口 */

/**
 * 工具入口。
 * @param {Object} ctx
 * @param {HTMLElement} ctx.root      工具页内容区（main.workspace）
 * @param {Object} ctx.tool           注册表中的工具记录
 * @param {Object} ctx.utils          公共工具函数集合 { dom, clipboard, text }
 * @param {Object} ctx.icons          { icon(name, size) }
 * @param {(p: string) => string} ctx.toSiteUrl 站点根相对路径解析
 * @returns {() => void} 清理函数
 */
export function init(ctx) {
  const { root, tool, utils, icons } = ctx;
  const host = root.querySelector("#tool-body");
  if (!host) return () => {};

  const { dom, clipboard, text: textUtils } = utils;

  /* ---------- 渲染模板 ---------- */
  host.innerHTML = TEMPLATE.replace(/__I_\w+__/g, (token) => {
    const entry = ICON_TOKENS[token];
    return entry ? icons.icon(entry[0], entry[1]) : "";
  });

  /* ---------- 节点引用 ---------- */
  const el = (selector) => host.querySelector(selector);
  const nodes = {
    preset: el("#tlm-preset"),
    status: el("#tlm-status"),
    saveForm: el("[data-save-form]"),
    presetName: el("#tlm-preset-name"),
    importPanel: el("[data-import-panel]"),
    importFile: el("#tlm-import-file"),
    importFileName: el("[data-import-filename]"),
    importText: el("#tlm-import-text"),
    error: el("[data-error]"),
    errorText: el("[data-error-text]"),
    input: el("#tlm-input"),
    inputLines: el("[data-input-lines]"),
    separator: el("#tlm-separator"),
    prefix: el("#tlm-prefix"),
    suffix: el("#tlm-suffix"),
    trim: el("#tlm-trim"),
    dropEmpty: el("#tlm-drop-empty"),
    escape: el("#tlm-escape"),
    escapeGroup: el("[data-escape-group]"),
    escapeChar: el("#tlm-escape-char"),
    escapeMode: el("#tlm-escape-mode"),
    output: el("[data-output]"),
    outputEmpty: el("[data-output-empty]"),
    outputFoot: el("[data-output-foot]"),
    resultMeta: el("[data-result-meta]"),
    statInputLines: el('[data-stat="input-lines"]'),
    statMergedLines: el('[data-stat="merged-lines"]'),
    statOutputChars: el('[data-stat="output-chars"]'),
    actions: {
      save: el('[data-action="save-preset"]'),
      remove: el('[data-action="delete-preset"]'),
      reset: el('[data-action="reset-config"]'),
      copyJson: el('[data-action="copy-json"]'),
      exportJson: el('[data-action="export-presets"]'),
      importJson: el('[data-action="import-presets"]'),
      copy: el('[data-action="copy"]'),
      download: el('[data-action="download"]'),
      merge: el('[data-action="merge"]'),
      clear: el('[data-action="clear-input"]'),
    },
    effects: {
      separator: el('[data-effect="separator"]'),
      prefix: el('[data-effect="prefix"]'),
      suffix: el('[data-effect="suffix"]'),
    },
  };

  /* ---------- 运行状态 ---------- */
  const state = {
    customPresets: loadCustomPresets(),
    presetId: "comma",
    result: "",
    syncing: false,
    removeArmed: false,
  };

  /** 定时器集合，清理时统一回收 */
  const timers = { debounce: 0, status: 0, remove: 0, copy: 0 };

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

  /* ------------------------------------------------------ 状态提示 */

  function setStatus(message, tone) {
    if (!nodes.status) return;
    clearTimer("status");
    nodes.status.textContent = message;
    nodes.status.dataset.tone = tone || "info";
    if (message) {
      timers.status = window.setTimeout(() => {
        nodes.status.textContent = "";
        delete nodes.status.dataset.tone;
      }, FEEDBACK_MS * 2);
    }
  }

  function showError(message) {
    if (!nodes.error) return;
    nodes.errorText.textContent = message;
    nodes.error.hidden = false;
  }

  function clearError() {
    if (!nodes.error) return;
    nodes.error.hidden = true;
    nodes.errorText.textContent = "";
  }

  /* -------------------------------------------------- 表单读写同步 */

  function readForm() {
    return normalizeConfig({
      separator: nodes.separator.value,
      prefix: nodes.prefix.value,
      suffix: nodes.suffix.value,
      trim: nodes.trim.checked,
      dropEmpty: nodes.dropEmpty.checked,
      escape: nodes.escape.checked,
      escapeChar: nodes.escapeChar.value,
      escapeMode: nodes.escapeMode.value,
    });
  }

  function writeForm(config) {
    const cfg = normalizeConfig(config);
    state.syncing = true;
    nodes.separator.value = cfg.separator;
    nodes.prefix.value = cfg.prefix;
    nodes.suffix.value = cfg.suffix;
    nodes.trim.checked = cfg.trim;
    nodes.dropEmpty.checked = cfg.dropEmpty;
    nodes.escape.checked = cfg.escape;
    nodes.escapeChar.value = cfg.escapeChar;
    nodes.escapeMode.value = cfg.escapeMode;
    state.syncing = false;
    syncEscapeGroup();
  }

  /** 转义分组在未启用时整体呈禁用态（虚线描边，而非降到不可读） */
  function syncEscapeGroup() {
    const enabled = nodes.escape.checked;
    nodes.escapeGroup.dataset.disabled = enabled ? "false" : "true";
    nodes.escapeChar.disabled = !enabled;
    nodes.escapeMode.disabled = !enabled;
  }

  /** 参数效果片段：让抽象参数一眼可懂 */
  function syncEffects() {
    const cfg = readForm();
    nodes.effects.separator.textContent = `${SAMPLE_LEFT}${cfg.separator}${SAMPLE_RIGHT}`;
    nodes.effects.prefix.textContent = `${cfg.prefix}${SAMPLE_LEFT}`;
    nodes.effects.suffix.textContent = `${SAMPLE_LEFT}${cfg.suffix}`;
  }

  /* ------------------------------------------------------ 预设管理 */

  function allPresets() {
    return [...BUILTIN_PRESETS, ...state.customPresets];
  }

  function currentPreset() {
    return allPresets().find((preset) => preset.id === state.presetId) || null;
  }

  function isCustomSelected() {
    return state.presetId === CUSTOM_ID;
  }

  function renderPresetOptions() {
    const option = (preset) =>
      `<option value="${dom.escapeHtml(preset.id)}">${dom.escapeHtml(preset.name)}</option>`;

    let html = `<optgroup label="内置预设">${BUILTIN_PRESETS.map(option).join("")}</optgroup>`;
    if (state.customPresets.length > 0) {
      html += `<optgroup label="我的预设">${state.customPresets.map(option).join("")}</optgroup>`;
    }
    if (isCustomSelected()) {
      html += `<option value="${CUSTOM_ID}">自定义（未保存）</option>`;
    }

    nodes.preset.innerHTML = html;
    nodes.preset.value = state.presetId;

    const preset = currentPreset();
    const hasCustom = state.customPresets.length > 0;
    nodes.actions.remove.disabled = !preset || preset.builtin === true;
    nodes.actions.remove.title = nodes.actions.remove.disabled
      ? "仅自定义预设可删除"
      : `删除预设「${preset.name}」`;
    nodes.actions.exportJson.disabled = !hasCustom;
    nodes.actions.exportJson.title = hasCustom ? "导出全部自定义预设" : "暂无自定义预设可导出";
    nodes.actions.copyJson.disabled = !hasCustom;
    nodes.actions.copyJson.title = hasCustom ? "复制预设 JSON" : "暂无自定义预设可复制";
  }

  /** 选中预设并填表（syncing 保护避免误判为手动改动） */
  function applyPreset(id, options) {
    const preset = allPresets().find((item) => item.id === id);
    if (!preset) {
      renderPresetOptions();
      return;
    }
    state.presetId = preset.id;
    writeForm(preset.config);
    renderPresetOptions();
    syncEffects();
    refreshNow();
    saveSession(readForm(), state.presetId);
    if (!options || options.silent !== true) {
      setStatus(`已应用预设「${preset.name}」`, "ok");
    }
  }

  /** 标记为「自定义（未保存）」 */
  function markDirty() {
    if (state.syncing) return;
    if (state.presetId === CUSTOM_ID) return;
    state.presetId = CUSTOM_ID;
    renderPresetOptions();
  }

  /** 两段式内联确认，避免使用 window.confirm */
  function resetRemoveButton() {
    state.removeArmed = false;
    nodes.actions.remove.classList.remove("is-armed");
    nodes.actions.remove.innerHTML = `${icons.icon("trash", 15)} 删除`;
  }

  function armRemove() {
    const preset = currentPreset();
    if (!preset || preset.builtin) return;

    if (!state.removeArmed) {
      state.removeArmed = true;
      nodes.actions.remove.classList.add("is-armed");
      nodes.actions.remove.innerHTML = "确认删除？";
      clearTimer("remove");
      timers.remove = window.setTimeout(resetRemoveButton, 3000);
      return;
    }

    clearTimer("remove");
    resetRemoveButton();

    state.customPresets = state.customPresets.filter((item) => item.id !== preset.id);
    saveSession(readForm(), state.presetId);
    const saved = saveCustomPresets(state.customPresets);
    if (!saved) showError("本地存储不可用，删除结果仅在当前页面内有效。");
    setStatus(`已删除预设「${preset.name}」`, "warn");

    // 回退到内置默认预设
    applyPreset("comma", { silent: true });
    renderPresetOptions();
  }

  function openSaveForm() {
    clearError();
    nodes.saveForm.hidden = false;
    const preset = currentPreset();
    nodes.presetName.value = preset && !preset.builtin ? preset.name : "";
    nodes.presetName.focus();
    nodes.presetName.select();
  }

  function closeSaveForm() {
    nodes.saveForm.hidden = true;
    nodes.presetName.value = "";
  }

  function submitSaveForm(event) {
    if (event) event.preventDefault();
    clearError();

    const name = nodes.presetName.value.trim().slice(0, MAX_NAME_LENGTH);
    if (name === "") {
      showError("请输入预设名称。");
      nodes.presetName.focus();
      return;
    }
    if (BUILTIN_PRESETS.some((preset) => preset.name === name)) {
      showError(`「${name}」与内置预设重名，请换一个名称。`);
      nodes.presetName.focus();
      return;
    }

    const config = readForm();
    const existing = state.customPresets.find((preset) => preset.name === name);

    if (existing) {
      existing.config = config;
      state.presetId = existing.id;
      setStatus(`已更新预设「${name}」`, "ok");
    } else {
      if (state.customPresets.length >= MAX_PRESETS) {
        showError(`自定义预设最多 ${MAX_PRESETS} 条，请先删除一些再保存。`);
        return;
      }
      const created = {
        id: createPresetId(),
        name,
        config,
        createdAt: new Date().toISOString(),
        builtin: false,
      };
      state.customPresets.push(created);
      state.presetId = created.id;
      setStatus(`已保存预设「${name}」`, "ok");
    }

    if (!saveCustomPresets(state.customPresets)) {
      showError("本地存储不可用（可能处于无痕模式），本次保存仅在当前页面内有效。");
    }
    saveSession(config, state.presetId);
    closeSaveForm();
    renderPresetOptions();
  }

  /* ------------------------------------------------ 导入 / 导出 */

  function buildExportJson() {
    return JSON.stringify(serializePresets(state.customPresets, readForm()), null, 2);
  }

  function exportJson() {
    if (state.customPresets.length === 0) {
      setStatus("暂无自定义预设可导出，请先「另存为」。", "warn");
      return;
    }
    downloadFile(
      `text-line-merge-presets-${dateStamp()}.json`,
      buildExportJson(),
      "application/json"
    );
    setStatus(`已导出 ${state.customPresets.length} 条预设`, "ok");
  }

  async function copyJson() {
    if (state.customPresets.length === 0) {
      setStatus("暂无自定义预设可复制，请先「另存为」。", "warn");
      return;
    }
    const ok = await clipboard.copyText(buildExportJson());
    setStatus(ok ? "预设 JSON 已复制到剪贴板" : "复制失败，请改用「导出」下载文件。", ok ? "ok" : "danger");
  }

  function toggleImportPanel(force) {
    const next = typeof force === "boolean" ? force : nodes.importPanel.hidden;
    nodes.importPanel.hidden = !next;
    if (next) {
      clearError();
      nodes.importText.focus();
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

    parsed.presets.forEach((item) => {
      const hit = state.customPresets.find((preset) => preset.name === item.name);
      if (hit) {
        hit.config = item.config;
        overwritten += 1;
        return;
      }
      if (state.customPresets.length >= MAX_PRESETS) {
        overflow += 1;
        return;
      }
      state.customPresets.push({
        id: createPresetId(),
        name: item.name,
        config: item.config,
        createdAt: new Date().toISOString(),
        builtin: false,
      });
      added += 1;
    });

    if (!saveCustomPresets(state.customPresets)) {
      showError("本地存储不可用（可能处于无痕模式），本次导入仅在当前页面内有效。");
    }

    const parts = [`新增 ${added} 条`, `覆盖 ${overwritten} 条`];
    if (overflow > 0) parts.push(`超出上限跳过 ${overflow} 条`);
    if (parsed.stats.skipped > 0) parts.push(`忽略非法 ${parsed.stats.skipped} 条`);
    setStatus(`导入完成：${parts.join("，")}`, added + overwritten > 0 ? "ok" : "warn");

    // 导入只恢复预设，不自动改动用户当前正在编辑的参数
    renderPresetOptions();
    nodes.importText.value = "";
    nodes.importFile.value = "";
    nodes.importFileName.textContent = "未选择文件";
    toggleImportPanel(false);
  }

  /* ------------------------------------------------------ 合并与结果 */

  function refreshNow() {
    const raw = nodes.input.value;
    const lines = textUtils.splitLines(raw);
    const cfg = readForm();

    const selected = selectLines(lines, cfg);
    state.result = mergeLines(selected, cfg);

    const totalLines = textUtils.countLines(raw);
    const outputChars = textUtils.countChars(state.result);
    const hasResult = state.result !== "";

    nodes.statInputLines.textContent = String(totalLines);
    nodes.statMergedLines.textContent = String(selected.length);
    nodes.statOutputChars.textContent = String(outputChars);
    nodes.inputLines.textContent = `${totalLines} 行`;

    nodes.output.hidden = !hasResult;
    nodes.outputEmpty.hidden = hasResult;
    if (hasResult) nodes.output.textContent = state.result;
    else nodes.output.textContent = "";

    nodes.resultMeta.textContent = hasResult
      ? `${outputChars} 字符 · ${selected.length} 行参与`
      : "单行输出";

    saveSession(cfg, state.presetId);
  }

  function scheduleRefresh() {
    clearTimer("debounce");
    timers.debounce = window.setTimeout(refreshNow, DEBOUNCE_MS);
  }

  /**
   * 结算尚未到期的防抖刷新。
   * 复制、下载等操作必须先结算，否则在防抖窗口内（约 180ms）立刻操作
   * 会读到上一次的结果甚至空结果。
   */
  function flushPendingRefresh() {
    if (timers.debounce) {
      clearTimer("debounce");
      refreshNow();
    }
  }

  /**
   * 把输出面板底部（含「复制结果」按钮）滚动进视口。
   * 仅在该区域被视口遮挡时才滚动；已完整可见时保持不动，避免无谓跳动。
   */
  function scrollToOutputBottom() {
    const target = nodes.outputFoot;
    if (!target) return;

    const margin = 24;
    const rect = target.getBoundingClientRect();
    const overflow = rect.bottom - (window.innerHeight - margin);
    if (overflow <= 0) return;

    let reduceMotion = false;
    try {
      reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (error) {
      reduceMotion = false;
    }

    const maxTop = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const top = Math.min(Math.max(0, window.scrollY + overflow), maxTop);
    window.scrollTo({ top, behavior: reduceMotion ? "auto" : "smooth" });
  }

  /**
   * 手动触发合并（主操作条按钮与 Ctrl/Cmd+Enter 共用）。
   * 与防抖实时预览的区别：立即结算，并滚动到输出区底部，便于紧接着复制。
   */
  function triggerMerge() {
    clearTimer("debounce");
    refreshNow();

    if (state.result === "") {
      setStatus("暂无可合并的内容。", "warn");
      return;
    }
    setStatus("已按当前参数合并", "ok");

    // 等一帧，确保输出面板尺寸已按新结果更新后再测量位置
    window.requestAnimationFrame(scrollToOutputBottom);
  }

  function onOptionChange() {
    markDirty();
    syncEscapeGroup();
    syncEffects();
    clearTimer("debounce");
    refreshNow();
  }

  async function copyResult() {
    flushPendingRefresh();
    if (state.result === "") {
      setStatus("暂无可复制的结果。", "warn");
      return;
    }
    const ok = await clipboard.copyText(state.result);
    if (!ok) {
      setStatus("复制失败，请手动选择结果文本复制。", "danger");
      return;
    }
    clearTimer("copy");
    nodes.actions.copy.innerHTML = `${icons.icon("check", 15)} 已复制`;
    nodes.actions.copy.classList.add("is-ok");
    timers.copy = window.setTimeout(() => {
      nodes.actions.copy.innerHTML = `${icons.icon("copy", 15)} 复制结果`;
      nodes.actions.copy.classList.remove("is-ok");
    }, 1500);
  }

  function downloadResult() {
    flushPendingRefresh();
    if (state.result === "") {
      setStatus("暂无可下载的结果。", "warn");
      return;
    }
    downloadFile(`text-line-merge-${dateStamp()}.txt`, state.result, "text/plain");
    setStatus("已下载结果文件", "ok");
  }

  function clearInput() {
    nodes.input.value = "";
    refreshNow();
    nodes.input.focus();
  }

  /* ---------------------------------------------------------- 事件 */

  bind(nodes.preset, "change", () => {
    if (nodes.preset.value === CUSTOM_ID) return;
    applyPreset(nodes.preset.value);
  });

  bind(nodes.input, "input", () => {
    scheduleRefresh();
  });

  [nodes.separator, nodes.prefix, nodes.suffix, nodes.escapeChar].forEach((node) => {
    bind(node, "input", onOptionChange);
  });
  [nodes.trim, nodes.dropEmpty, nodes.escape, nodes.escapeMode].forEach((node) => {
    bind(node, "change", onOptionChange);
  });

  bind(nodes.actions.merge, "click", () => triggerMerge());
  bind(nodes.actions.clear, "click", clearInput);
  bind(nodes.actions.copy, "click", copyResult);
  bind(nodes.actions.download, "click", downloadResult);

  bind(nodes.actions.save, "click", openSaveForm);
  bind(nodes.actions.remove, "click", armRemove);
  bind(nodes.actions.reset, "click", () => {
    clearError();
    applyPreset("comma");
  });
  bind(nodes.actions.exportJson, "click", exportJson);
  bind(nodes.actions.copyJson, "click", copyJson);
  bind(nodes.actions.importJson, "click", () => toggleImportPanel());

  bind(nodes.saveForm, "submit", submitSaveForm);
  bind(el('[data-action="cancel-save"]'), "click", closeSaveForm);
  host.querySelectorAll('[data-action="close-import"]').forEach((node) => {
    bind(node, "click", () => toggleImportPanel(false));
  });
  bind(el('[data-action="confirm-import"]'), "click", confirmImport);

  bind(nodes.importFile, "change", () => {
    const file = nodes.importFile.files && nodes.importFile.files[0];
    nodes.importFileName.textContent = file ? file.name : "未选择文件";
    clearError();
  });

  bind(document, "keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      triggerMerge();
      return;
    }
    if (event.key === "Escape") {
      if (!nodes.saveForm.hidden) closeSaveForm();
      else if (!nodes.importPanel.hidden) toggleImportPanel(false);
      else if (!nodes.error.hidden) clearError();
    }
  });

  /* ---------------------------------------------------------- 启动 */

  const session = loadSession();
  if (session) {
    const known = allPresets().some((preset) => preset.id === session.presetId);
    state.presetId = known ? session.presetId : CUSTOM_ID;
    writeForm(session.config);
  } else {
    state.presetId = "comma";
    writeForm(DEFAULT_CONFIG);
  }

  renderPresetOptions();
  syncEscapeGroup();
  syncEffects();
  refreshNow();

  console.info(
    `[toolbox] 已挂载工具「${tool.name}」：内置预设 ${BUILTIN_PRESETS.length} 项，自定义预设 ${state.customPresets.length} 项`
  );

  /* -------------------------------------------------------- 清理 */

  return () => {
    Object.keys(timers).forEach(clearTimer);
    disposers.forEach((dispose) => dispose());
    dom.clear(host);
  };
}

export const meta = {
  id: "text-line-merge",
  version: "1.0.0",
  status: "ready",
};

export default init;
