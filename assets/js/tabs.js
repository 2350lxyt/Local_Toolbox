/**
 * 标签工作台（Tabs Workspace）
 * ------------------------------------------------------------------
 * 把「左侧工具列表」的点击从「整页跳转」改为「页内打开标签页」，并且以**实例**为单位管理标签：
 *   1. 同一工具可重复打开多个互相独立的实例（各自独立面板、独立 init()、独立配置键）；
 *   2. 重复打开时显示名自动追加数字后缀（「文本名 (2)」…），原标签名称与内容不变；
 *   3. 标签可手动重命名（双击 / 菜单 / F2），允许重名，输入时实时显示；
 *   4. 面板常驻保活：切换标签只改可见性，绝不重建 DOM 或重复 init() —— 输入内容因此不丢；
 *   5. 两段式关闭、拖拽排序、拖到画面右侧并排显示（最多两栏）、实例数量上限；
 *   6. 布局持久化（仅实例 id / 工具 id / 显示名 / 顺序 / 分栏 / 激活，绝不含任何输入内容）与 hash 直链；
 *   7. 无障碍：tablist 语义、roving tabindex、方向键 / F2 / Delete、标签菜单（拖拽的键盘等价路径）。
 *
 * 契约与设计依据：docs/DESIGN.md §2.6 / §4.4 / §5.2 / §6 / §7 / §8.1 / §9.3。
 * 本文件不包含任何具体工具的业务逻辑。
 */

import { STATUS_LABEL, getToolById } from "./registry.js";
import { icon } from "./icons.js";
import * as dom from "./utils/dom.js";

/* ------------------------------------------------------------ 常量 */

export const TABS_KEY = "toolbox:tabs";
export const TABS_MAX_PANES = 2;
export const TABS_HASH_PREFIX = "#/";
export const CLOSE_CONFIRM_MS = 3000;
export const TOAST_MS = 4000;
/** 同时打开的标签实例数上限（多个重型工具实例并存时保守取值） */
export const MAX_INSTANCES = 8;
/** 标签显示名长度上限（与预设名一致） */
export const MAX_NAME_LENGTH = 40;

/** 布局持久化版本（v1 = 工具 id 数组，v2 = 实例记录，见 docs/DESIGN.md §8.1） */
const LAYOUT_VERSION = 2;
/** 实例 id 分隔符：`<tool-id>--<serial>` */
const INSTANCE_SEP = "--";
/** 栏位标识；并排上限由 TABS_MAX_PANES 决定（docs/DESIGN.md §4.4） */
const PANE_IDS = ["primary", "secondary"].slice(0, TABS_MAX_PANES);

/* -------------------------------------------------------- 纯函数工具 */

/** 工具是否可以被挂载为标签面板 */
function isMountable(tool) {
  return Boolean(tool && tool.status === "ready" && tool.entry);
}

/** 实例 id → `<toolId>--<serial>` */
export function instanceIdFor(toolId, serial) {
  return `${toolId}${INSTANCE_SEP}${serial}`;
}

/** 从实例 id 反解序号；不匹配该工具时返回 0 */
export function serialFromInstanceId(id, toolId) {
  if (typeof id !== "string" || typeof toolId !== "string") return 0;
  if (!id.startsWith(`${toolId}${INSTANCE_SEP}`)) return 0;
  const serial = Number.parseInt(id.slice(toolId.length + INSTANCE_SEP.length), 10);
  return Number.isInteger(serial) && serial > 0 ? serial : 0;
}

/**
 * 取当前未占用的最小正整数序号（关闭即回收，保证实例配置键数量有界）。
 * @param {number[]} takenSerials 已被占用的序号
 */
export function nextSerial(takenSerials) {
  const used = new Set(
    (Array.isArray(takenSerials) ? takenSerials : []).filter(
      (value) => Number.isInteger(value) && value > 0
    )
  );
  let serial = 1;
  while (used.has(serial)) serial += 1;
  return serial;
}

/**
 * 取最小可用显示名：`base`、`base (2)`、`base (3)`…（与所有现有实例显示名精确比较）。
 * @param {string} base 基础名（通常是工具名）
 * @param {string[]} takenNames 已被占用的显示名（含用户自定义名）
 */
export function nextInstanceName(base, takenNames) {
  const used = new Set(
    (Array.isArray(takenNames) ? takenNames : []).filter((name) => typeof name === "string")
  );
  const name = String(base === null || base === undefined ? "" : base).trim() || "标签";
  if (!used.has(name)) return name;
  let index = 2;
  while (used.has(`${name} (${index})`)) index += 1;
  return `${name} (${index})`;
}

/** 规范化用户输入的标签名（去首尾空白 + 截断到上限）；空串表示无效 */
export function normalizeNameInput(value) {
  return String(value === null || value === undefined ? "" : value)
    .trim()
    .slice(0, MAX_NAME_LENGTH);
}

/* --------------------------------------------------------------- 主体 */

/**
 * 创建标签工作区控制器。
 * @param {Object} options
 * @param {(tool: object, root: HTMLElement, instance: object) => Promise<Function>} options.loadTool
 *        动态加载工具模块并调用 init(ctx)；instance 会作为 ctx.instance 传给工具
 * @param {(host: HTMLElement, message: string) => void} [options.renderError] 渲染可读的加载失败提示
 * @param {(scope?: ParentNode) => void} [options.renderFooter]                填充页脚（与独立页保持一致）
 * @param {(instance: object|null) => void} [options.onActiveChange]           激活实例变化（供外壳同步侧栏高亮与面包屑）
 * @param {() => void} [options.requestLayoutSignal]                           请求外壳派发一次重测量信号
 * @returns {Object|null}
 */
export function createTabsWorkspace(options = {}) {
  const { loadTool, renderError, renderFooter, onActiveChange, requestLayoutSignal } = options;

  const workspaceRoot = dom.qs("[data-tabs-workspace]");
  const workspace = dom.qs("#workspace");
  const homeView = dom.qs("[data-home-view]");
  if (!workspaceRoot || !workspace) return null;

  const workbench = dom.qs("[data-workbench]", workspaceRoot);
  const dropzone = dom.qs("[data-dropzone]", workspaceRoot);
  const toastEl = dom.qs("[data-tabs-toast]", workspaceRoot);
  if (!workbench) return null;

  function paneRef(paneId) {
    const root = dom.qs(`[data-pane="${paneId}"]`, workbench);
    return {
      id: paneId,
      root,
      list: root ? dom.qs("[data-tablist]", root) : null,
      view: root ? dom.qs("[data-pane-view]", root) : null,
    };
  }

  const panes = { primary: paneRef("primary"), secondary: paneRef("secondary") };

  /** 状态：每个栏内的**实例**顺序 + 各栏激活实例 + 当前聚焦栏（§4.4） */
  const state = {
    panes: { primary: [], secondary: [] },
    active: { primary: "", secondary: "" },
    focused: "primary",
  };

  /**
   * 实例记录表：instanceId → 记录
   * {
   *   id, toolId, serial, name, renamed, renaming,
   *   tab:   { el, main, nameEl, close, menu, rename },
   *   panel: { el, host, titleEl, cleanup, mounted, mounting }
   * }
   */
  const instances = new Map();

  const disposers = [];
  let deckEl = null; // 标签菜单容器
  let menuAnchor = null;
  let armedCloseId = "";
  let armTimer = 0;
  let toastTimer = 0;
  let dragId = "";
  let destroyed = false;

  const bind = (target, type, handler, opts) => {
    if (!target) return;
    disposers.push(dom.on(target, type, handler, opts));
  };

  /* --------------------------------------------------------- 基础查询 */

  const instanceIds = () => [...state.panes.primary, ...state.panes.secondary];
  const recordOf = (id) => instances.get(id) || null;
  const paneOf = (id) => PANE_IDS.find((paneId) => state.panes[paneId].includes(id)) || "";
  const nameOf = (id) => {
    const record = instances.get(id);
    if (record) return record.name;
    const tool = getToolById(id);
    return tool ? tool.name : id;
  };
  const toolIdOf = (id) => {
    const record = instances.get(id);
    if (record) return record.toolId;
    return getToolById(id) ? id : "";
  };
  const namesInUse = () => [...instances.values()].map((record) => record.name);
  const serialsOfTool = (toolId) =>
    [...instances.values()]
      .filter((record) => record.toolId === toolId)
      .map((record) => record.serial);

  /** 供外壳使用的实例视图（不外泄内部节点引用） */
  const publicInstance = (record) =>
    record
      ? {
          id: record.id,
          toolId: record.toolId,
          serial: record.serial,
          name: record.name,
          renamed: record.renamed,
        }
      : null;

  /** 某工具 serial 最小的实例（hash 直链定位用） */
  function findInstanceByTool(toolId) {
    return (
      [...instances.values()]
        .filter((record) => record.toolId === toolId)
        .sort((a, b) => a.serial - b.serial)[0] || null
    );
  }

  function isNarrow() {
    try {
      return window.matchMedia("(max-width: 900px)").matches;
    } catch (error) {
      return false;
    }
  }

  /** 当前激活实例：优先聚焦栏的激活项，否则退回任一非空栏 */
  function activeInstanceId() {
    if (state.panes[state.focused].length && state.active[state.focused]) {
      return state.active[state.focused];
    }
    for (const paneId of PANE_IDS) {
      if (state.panes[paneId].length && state.active[paneId]) return state.active[paneId];
    }
    return "";
  }

  /* ----------------------------------------------------------- 持久化 */

  function readLayout() {
    try {
      const raw = window.localStorage.getItem(TABS_KEY);
      if (!raw) return null;
      return normalizeLayout(JSON.parse(raw));
    } catch (error) {
      return null;
    }
  }

  function writeLayout() {
    try {
      window.localStorage.setItem(
        TABS_KEY,
        JSON.stringify({
          version: LAYOUT_VERSION,
          instances: instanceIds()
            .map((id) => recordOf(id))
            .filter(Boolean)
            .map((record) => ({
              id: record.id,
              tool: record.toolId,
              name: record.name,
              renamed: record.renamed,
            })),
          panes: { primary: [...state.panes.primary], secondary: [...state.panes.secondary] },
          active: { ...state.active },
          focused: state.focused,
        })
      );
    } catch (error) {
      /* 隐私模式 / 存储被禁用：静默降级为「本次会话内有效」，不阻断渲染（§8.3） */
    }
  }

  /**
   * 归一化持久化数据，并兼容 v1（`panes` 内为工具 id 字符串）→ v2（实例记录）的迁移。
   * 规则：过滤未注册 / 未就绪工具、去重实例 id、序号冲突时改派最小可用序号、
   *      显示名冲突时按后缀规则顺延、总数收敛到 MAX_INSTANCES、主栏非空、栏数 ≤ 2。
   */
  function normalizeLayout(data) {
    const out = {
      instances: [],
      panes: { primary: [], secondary: [] },
      active: { primary: "", secondary: "" },
      focused: "primary",
    };
    const source = data && typeof data === "object" ? data : {};

    const byId = new Map();
    const serialsByTool = new Map();
    const names = [];

    const register = (candidateId, tool, wantedName, renamed) => {
      const used = serialsByTool.get(tool.id) || new Set();
      let serial = serialFromInstanceId(candidateId, tool.id);
      if (!serial || used.has(serial)) serial = nextSerial([...used]);
      const id = instanceIdFor(tool.id, serial);
      if (byId.has(id)) return "";

      const trimmed = typeof wantedName === "string" ? normalizeNameInput(wantedName) : "";
      const name = trimmed || nextInstanceName(tool.name, names);

      used.add(serial);
      serialsByTool.set(tool.id, used);
      names.push(name);
      byId.set(id, { id, toolId: tool.id, serial, name, renamed: Boolean(renamed) });
      return id;
    };

    // v2 的实例声明表（v1 数据没有这一段，全部走工具 id 迁移分支）
    const declared = new Map();
    if (Array.isArray(source.instances)) {
      source.instances.forEach((item) => {
        if (item && typeof item === "object" && typeof item.id === "string") {
          declared.set(item.id, item);
        }
      });
    }

    const sourcePanes = source.panes && typeof source.panes === "object" ? source.panes : {};
    PANE_IDS.forEach((paneId) => {
      const values = Array.isArray(sourcePanes[paneId]) ? sourcePanes[paneId] : [];
      values.forEach((value) => {
        if (typeof value !== "string" || byId.size >= MAX_INSTANCES) return;
        const declaration = declared.get(value) || null;
        const toolId = declaration && typeof declaration.tool === "string" ? declaration.tool : value;
        const tool = getToolById(toolId);
        if (!isMountable(tool)) return;
        const id = register(
          declaration ? value : "",
          tool,
          declaration ? declaration.name : "",
          declaration ? declaration.renamed : false
        );
        if (!id) return;
        if (!out.panes[paneId].includes(id)) out.panes[paneId].push(id);
      });
    });

    out.instances = [...byId.values()];

    // 主栏必须非空：只剩并排栏时整体迁回主栏（§4.4 分栏收敛）
    if (!out.panes.primary.length && out.panes.secondary.length) {
      out.panes.primary = out.panes.secondary;
      out.panes.secondary = [];
    }

    const sourceActive =
      source.active && typeof source.active === "object" ? source.active : {};
    PANE_IDS.forEach((paneId) => {
      const list = out.panes[paneId];
      const wanted = sourceActive[paneId];
      // v2：激活项就是实例 id，直接命中
      if (list.includes(wanted)) {
        out.active[paneId] = wanted;
        return;
      }
      // v1（迁移）：激活项是工具 id，映射到该栏中该工具 serial 最小的实例，尽量保住原状态
      if (typeof wanted === "string") {
        const match = list.find((id) => byId.get(id) && byId.get(id).toolId === wanted);
        if (match) {
          out.active[paneId] = match;
          return;
        }
      }
      out.active[paneId] = list[0] || "";
    });

    out.focused =
      PANE_IDS.includes(source.focused) && out.panes[source.focused].length
        ? source.focused
        : out.panes.primary.length
        ? "primary"
        : "secondary";

    return out;
  }

  /* --------------------------------------------------------------- hash */

  /** hash 只编码「哪个工具」（§2.6）：`#/<toolId>` */
  function hashToolId() {
    const raw = window.location.hash || "";
    if (!raw.startsWith(TABS_HASH_PREFIX)) return "";
    let id = raw.slice(TABS_HASH_PREFIX.length);
    try {
      id = decodeURIComponent(id);
    } catch (error) {
      /* 非法编码：按原样比较 */
    }
    id = id.trim();
    return isMountable(getToolById(id)) ? id : "";
  }

  /** 把当前激活实例所属的工具同步到 hash：用 replaceState，不污染前进后退历史（§2.6） */
  function syncHash(toolId) {
    const next = toolId ? `${TABS_HASH_PREFIX}${encodeURIComponent(toolId)}` : "";
    if ((window.location.hash || "") === next) return;
    try {
      const url = next || `${window.location.pathname}${window.location.search}`;
      window.history.replaceState(null, "", url);
    } catch (error) {
      /* 忽略：hash 只是增强，失败不影响功能 */
    }
  }

  /* ------------------------------------------------------------ 轻提示 */

  function toast(message, tone) {
    if (!toastEl) return;
    if (toastTimer) window.clearTimeout(toastTimer);
    toastEl.textContent = message;
    toastEl.dataset.tone = tone || "info";
    toastEl.hidden = false;
    toastTimer = window.setTimeout(() => {
      toastEl.hidden = true;
      toastTimer = 0;
    }, TOAST_MS);
  }

  /* ------------------------------------------------------- 标签与面板 */

  function createTab(record, tool) {
    const wrap = dom.el("div", {
      className: "tab",
      dataset: { instance: record.id, tool: tool.id },
      attrs: { role: "presentation", draggable: "true" },
    });

    // 内联重命名输入框：与 .tab__main 是**兄弟关系**（role=tab 内不得嵌套可聚焦元素），
    // 编辑时隐藏 main、显示该输入框（占同一位置）
    const rename = dom.el("input", {
      className: "tab__rename",
      attrs: {
        type: "text",
        maxlength: String(MAX_NAME_LENGTH),
        autocomplete: "off",
        spellcheck: "false",
        hidden: true,
      },
    });

    const main = dom.el("button", {
      className: "tab__main",
      attrs: {
        type: "button",
        role: "tab",
        id: `tab-${record.id}`,
        "aria-controls": `tabpanel-${record.id}`,
        "aria-selected": "false",
        tabindex: "-1",
      },
    });
    main.innerHTML =
      `<span class="tab__icon" aria-hidden="true">${icon(tool.icon, 15)}</span>` +
      `<span class="tab__name"></span>`;

    const close = dom.el("button", {
      className: "tab__close",
      attrs: { type: "button" },
    });
    close.innerHTML = icon("close", 13);

    const more = dom.el("button", {
      className: "tab__menu",
      attrs: { type: "button", title: "标签操作", "aria-haspopup": "menu", "aria-expanded": "false" },
    });
    more.innerHTML = icon("more", 13);

    dom.append(wrap, [rename, main, close, more]);
    return { el: wrap, main, nameEl: dom.qs(".tab__name", main), close, menu: more, rename };
  }

  function createPanel(record, tool) {
    const article = dom.el("article", {
      className: "tabpanel",
      dataset: { instance: record.id, tool: tool.id },
      attrs: {
        role: "tabpanel",
        id: `tabpanel-${record.id}`,
        "aria-labelledby": `tab-${record.id}`,
        tabindex: "0",
        hidden: true,
      },
    });

    const head = dom.el("header", { className: "tool-head" });
    head.innerHTML =
      `<div class="tool-head__main">` +
      `<div class="tool-head__eyebrow">` +
      `<p class="meta-label">工具 / ${dom.escapeHtml(tool.id)}</p>` +
      `<span class="badge badge--ok">${dom.escapeHtml(STATUS_LABEL[tool.status] || "")}</span>` +
      `</div>` +
      `<h1 class="tool-head__title"></h1>` +
      `<p class="tool-head__desc">${dom.escapeHtml(tool.description)}</p>` +
      `</div>` +
      `<div class="tool-head__icon" aria-hidden="true">${icon(tool.icon, 26)}</div>`;

    const host = dom.el("div", { attrs: { "data-tool-body": "" } });
    const foot = dom.el("footer", { className: "site-foot", attrs: { "data-site-footer": "" } });

    dom.append(article, [head, host, foot]);
    return { el: article, host, foot, titleEl: dom.qs(".tool-head__title", head) };
  }

  /** 把实例的显示名刷到所有可见位置（标签栏 + 面板标题 + 无障碍文案），不重建节点 */
  function applyInstanceName(record) {
    const tab = record.tab;
    if (tab) {
      if (tab.nameEl) tab.nameEl.textContent = record.name;
      dom.setAttrs(tab.main, { title: record.name });
      dom.setAttrs(tab.close, {
        "aria-label": `关闭「${record.name}」`,
        title: `关闭「${record.name}」`,
      });
      dom.setAttrs(tab.menu, { "aria-label": `「${record.name}」的标签操作` });
    }
    if (record.panel && record.panel.titleEl) {
      record.panel.titleEl.textContent = record.name;
    }
  }

  /** 为实例创建标签节点与面板节点（只创建一次，之后永远复用） */
  function ensureNodes(record) {
    if (record.tab && record.panel) return;
    const tool = getToolById(record.toolId);
    if (!isMountable(tool)) return;

    record.tab = createTab(record, tool);
    const panel = createPanel(record, tool);
    record.panel = {
      el: panel.el,
      host: panel.host,
      titleEl: panel.titleEl,
      cleanup: null,
      mounted: false,
      mounting: false,
    };
    applyInstanceName(record);
    setupRenameInput(record);
    if (typeof renderFooter === "function") renderFooter(panel.el);
  }

  /** 惰性挂载：实例首次可见时才动态 import 并 init()（§4.4） */
  async function mountPanel(id) {
    const record = instances.get(id);
    if (!record || !record.panel) return;
    const panel = record.panel;
    if (panel.mounted || panel.mounting || typeof loadTool !== "function") return;
    const tool = getToolById(record.toolId);
    if (!tool) return;

    panel.mounting = true;
    try {
      const cleanup = await loadTool(tool, panel.el, publicInstance(record));
      // 挂载期间实例可能已被关闭：立即回收，避免监听器泄漏到脱离文档的节点上
      if (instances.get(id) !== record || !panel.el.isConnected) {
        if (typeof cleanup === "function") cleanup();
        return;
      }
      panel.cleanup = typeof cleanup === "function" ? cleanup : null;
      panel.mounted = true;
    } catch (error) {
      console.error(`[toolbox] 工具「${record.toolId}」实例「${record.name}」加载失败：`, error);
      panel.mounted = true; // 不再重试，避免反复报错
      if (instances.get(id) === record && panel.el.isConnected) {
        if (typeof renderError === "function") {
          renderError(panel.host, error && error.message ? error.message : String(error));
        }
      }
    } finally {
      panel.mounting = false;
      if (!destroyed && requestLayoutSignal) requestLayoutSignal();
    }
  }

  /* ------------------------------------------------------------ 渲染 */

  /** 把栏内节点按 state 顺序移动到位（append 复用既有节点，绝不重建） */
  function renderTabs() {
    PANE_IDS.forEach((paneId) => {
      const pane = panes[paneId];
      if (!pane.list || !pane.view) return;
      state.panes[paneId].forEach((id) => {
        const record = instances.get(id);
        if (!record) return;
        if (record.tab) pane.list.append(record.tab.el);
        if (record.panel) pane.view.append(record.panel.el);
      });
      // 清理已关闭的节点（其清理函数已在 closeInstance 中调用）
      Array.from(pane.list.querySelectorAll(".tab")).forEach((node) => {
        if (!state.panes[paneId].includes(node.dataset.instance)) node.remove();
      });
      // 只有一个标签时谈不上「排序 / 并排」，隐藏提示避免给出无意义的引导
      const hint = dom.qs("[data-pane-hint]", pane.root);
      if (hint) hint.hidden = state.panes[paneId].length < 2;
    });
  }

  /** 同步激活态、ARIA、面板显隐、hash 与持久化 */
  function syncActiveUI() {
    PANE_IDS.forEach((paneId) => {
      const activeId = state.active[paneId];
      state.panes[paneId].forEach((id) => {
        const record = instances.get(id);
        if (!record) return;
        const active = id === activeId;
        if (record.tab) {
          record.tab.el.classList.toggle("is-active", active);
          record.tab.main.setAttribute("aria-selected", String(active));
          record.tab.main.tabIndex = active ? 0 : -1;
        }
        if (record.panel) record.panel.el.hidden = !active;
      });
      if (activeId) revealTab(paneId, activeId);
      if (activeId) mountPanel(activeId);
    });

    const activeId = activeInstanceId();
    const record = recordOf(activeId);
    syncHash(record ? record.toolId : "");
    writeLayout();
    if (typeof onActiveChange === "function") onActiveChange(publicInstance(record));
    if (requestLayoutSignal) requestLayoutSignal();
  }

  /** 让激活的标签在横向标签栏里可见（不触发整页滚动） */
  function revealTab(paneId, id) {
    const pane = panes[paneId];
    const record = instances.get(id);
    if (!pane || !pane.list || !record || !record.tab || pane.root.hidden) return;
    const listRect = pane.list.getBoundingClientRect();
    const itemRect = record.tab.el.getBoundingClientRect();
    if (!listRect.width || !itemRect.width) return;
    if (itemRect.left < listRect.left) {
      pane.list.scrollLeft -= listRect.left - itemRect.left;
    } else if (itemRect.right > listRect.right) {
      pane.list.scrollLeft += itemRect.right - listRect.right;
    }
  }

  /** 首页总览 ↔ 标签工作台切换 + 分栏开关 */
  function syncVisibility() {
    const hasTabs = instanceIds().length > 0;
    const split = state.panes.secondary.length > 0;

    workspace.dataset.view = hasTabs ? "tabs" : "home";
    if (homeView) homeView.hidden = hasTabs;
    workspaceRoot.hidden = !hasTabs;
    panes.primary.root.hidden = !hasTabs;
    panes.secondary.root.hidden = !split;
    workbench.dataset.split = split ? "on" : "off";
  }

  /* ------------------------------------------------------------- 操作 */

  /** 新建一个工具实例（点击左侧工具项/首页卡片 = 每次新建，§4.4） */
  function openInstance(toolId) {
    const tool = getToolById(toolId);
    if (!tool) return "";
    if (!isMountable(tool)) {
      toast(
        `「${tool.name}」${tool.status === "planned" ? "正在开发中" : "暂不可用"}，暂时无法打开。`,
        "warn"
      );
      return "";
    }
    if (instances.size >= MAX_INSTANCES) {
      toast(`最多同时打开 ${MAX_INSTANCES} 个标签，请先关闭部分标签。`, "warn");
      return "";
    }

    const serial = nextSerial(serialsOfTool(tool.id));
    const record = {
      id: instanceIdFor(tool.id, serial),
      toolId: tool.id,
      serial,
      name: nextInstanceName(tool.name, namesInUse()),
      renamed: false,
      renaming: false,
      tab: null,
      panel: null,
    };
    instances.set(record.id, record);
    ensureNodes(record);

    const target =
      state.focused === "secondary" && state.panes.secondary.length ? "secondary" : "primary";
    state.panes[target].push(record.id);
    state.active[target] = record.id;
    state.focused = target;

    syncVisibility();
    renderTabs();
    syncActiveUI();
    return record.id;
  }

  /** 激活某栏内的实例（并聚焦该栏） */
  function activate(id, focusTab = false) {
    const record = instances.get(id);
    if (!record) return;
    const paneId = paneOf(id);
    if (!paneId) return;

    if (record.renaming) endRename(record);

    state.active[paneId] = id;
    state.focused = paneId;
    syncVisibility();
    renderTabs();
    syncActiveUI();
    if (focusTab && record.tab) record.tab.main.focus();
  }

  /** 点击栏内任意位置即把该栏设为聚焦栏（侧栏高亮随之切换） */
  function focusPane(paneId) {
    if (!PANE_IDS.includes(paneId) || state.focused === paneId) return;
    if (!state.panes[paneId].length) return;
    state.focused = paneId;
    syncActiveUI();
  }

  /** 关闭实例：执行清理函数、摘除节点、把激活权交给右邻（无则左邻） */
  function closeInstance(id) {
    const record = instances.get(id);
    if (!record) return;
    const paneId = paneOf(id);
    if (!paneId) return;

    if (record.renaming) endRename(record, { restoreFocus: false });

    const list = state.panes[paneId];
    const index = list.indexOf(id);
    const label = record.name;

    if (record.panel) {
      try {
        if (typeof record.panel.cleanup === "function") record.panel.cleanup();
      } catch (error) {
        console.error(`[toolbox] 实例「${label}」清理失败：`, error);
      }
      record.panel.el.remove();
    }
    if (record.tab) record.tab.el.remove();
    instances.delete(id);

    list.splice(index, 1);
    state.active[paneId] = list[index] || list[index - 1] || "";
    if (armedCloseId === id) armedCloseId = "";

    normalizeState();
    syncVisibility();
    renderTabs();
    syncActiveUI();
    toast(`已关闭「${label}」`, "ok");
  }

  /** 移动实例：同栏排序或跨栏并排（§4.4 第 5、6 条） */
  function moveInstance(id, targetPane, index) {
    const source = paneOf(id);
    if (!source || !PANE_IDS.includes(targetPane)) return;

    if (targetPane === "secondary" && state.panes.primary.length < 2) {
      toast("需要至少两个标签才能并排显示。", "warn");
      return;
    }

    const sourceList = state.panes[source];
    const targetList = state.panes[targetPane];
    const from = sourceList.indexOf(id);

    sourceList.splice(from, 1);
    let at = typeof index === "number" && index >= 0 ? index : targetList.length;
    if (source === targetPane && from < at) at -= 1;
    at = Math.max(0, Math.min(at, targetList.length));
    targetList.splice(at, 0, id);

    state.active[targetPane] = id;
    state.focused = targetPane;

    normalizeState();
    syncVisibility();
    renderTabs();
    syncActiveUI();
  }

  /** 退出并排：并排栏的标签全部并回主栏 */
  function collapseSplit() {
    if (!state.panes.secondary.length) return;
    state.panes.primary = state.panes.primary.concat(state.panes.secondary);
    state.panes.secondary = [];
    state.active.secondary = "";
    state.focused = "primary";
    normalizeState();
    syncVisibility();
    renderTabs();
    syncActiveUI();
    toast("已退出并排显示。", "ok");
  }

  /** 分栏/激活项收敛：实例必须存在；主栏必须非空；激活项必须存在于本栏 */
  function normalizeState() {
    PANE_IDS.forEach((paneId) => {
      state.panes[paneId] = state.panes[paneId].filter((id) => instances.has(id));
      const list = state.panes[paneId];
      if (list.length && !list.includes(state.active[paneId])) state.active[paneId] = list[0];
      if (!list.length) state.active[paneId] = "";
    });

    if (!state.panes.primary.length && state.panes.secondary.length) {
      state.panes.primary = state.panes.secondary;
      state.panes.secondary = [];
      state.active.primary = state.active.secondary || state.panes.primary[0] || "";
      state.active.secondary = "";
      state.focused = "primary";
    }

    if (!state.panes.secondary.length && state.focused === "secondary") {
      state.focused = "primary";
    }
  }

  /* --------------------------------------------------- 重命名（内联编辑） */

  function setupRenameInput(record) {
    const input = record.tab ? record.tab.rename : null;
    if (!input) return;

    bind(input, "pointerdown", (event) => event.stopPropagation());
    bind(input, "dblclick", (event) => event.stopPropagation());

    // 输入时实时更新（输入框就在标签内，所见即所得），并同步宽度与提示
    bind(input, "input", () => {
      const draft = normalizeNameInput(input.value);
      input.title = draft || "名称不能为空";
      input.style.width = `${Math.min(MAX_NAME_LENGTH, Math.max(6, draft.length + 2))}ch`;
    });

    bind(input, "keydown", (event) => {
      // Esc / Enter 必须就地处理并阻止外泄：避免触发全局「撤销关闭待确认」或工具内联面板关闭
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        commitRename(record.id, input.value);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancelRename(record.id);
        return;
      }
      // 其余按键（含方向键、Tab）只属于输入框，不再冒泡给标签栏的键盘处理
      event.stopPropagation();
    });

    bind(input, "blur", () => {
      if (record.renaming) commitRename(record.id, input.value);
    });
  }

  /** 进入内联重命名（双击标题 / 菜单 / F2） */
  function beginRename(id) {
    const record = instances.get(id);
    if (!record || !record.tab || record.renaming) return;

    // 同一时刻只允许一个标签处于重命名态，并且不与「关闭待确认」叠加
    instances.forEach((item) => {
      if (item.renaming && item !== record) endRename(item);
    });
    disarmClose();
    activate(id);

    const input = record.tab.rename;
    record.renaming = true;
    record.tab.el.setAttribute("draggable", "false");
    record.tab.main.hidden = true;
    input.value = record.name;
    input.title = record.name;
    input.style.width = `${Math.min(MAX_NAME_LENGTH, Math.max(6, record.name.length + 2))}ch`;
    dom.setAttrs(input, { "aria-label": `重命名标签：${record.name}` });
    input.hidden = false;
    input.focus();
    input.select();
    toast(`重命名「${record.name}」：Enter 保存，Esc 取消。`, "info");
  }

  /** 退出编辑态（不改变名称） */
  function endRename(record, opts = {}) {
    if (!record || !record.renaming) return;
    record.renaming = false;
    const tab = record.tab;
    if (!tab) return;
    if (tab.rename) {
      tab.rename.hidden = true;
      tab.rename.value = "";
    }
    tab.main.hidden = false;
    tab.el.setAttribute("draggable", "true");
    if (opts.restoreFocus !== false && tab.main.isConnected) tab.main.focus();
  }

  /** 提交重命名：空名视为取消并提示；成功则更新显示、落盘并播报（允许重名） */
  function commitRename(id, value) {
    const record = instances.get(id);
    if (!record || !record.renaming) return;
    const next = normalizeNameInput(value);
    endRename(record);

    if (!next) {
      toast("名称不能为空，已保留原名。", "warn");
      return;
    }
    if (next === record.name) return;

    record.name = next;
    record.renamed = true;
    applyInstanceName(record);
    writeLayout();
    if (typeof onActiveChange === "function" && activeInstanceId() === id) {
      onActiveChange(publicInstance(record));
    }
    toast(`已重命名为「${next}」`, "ok");
  }

  function cancelRename(id) {
    const record = instances.get(id);
    if (!record || !record.renaming) return;
    const name = record.name;
    endRename(record);
    toast(`已取消重命名，「${name}」保持不变。`, "info");
  }

  /* ------------------------------------------------- 两段式关闭确认 */

  function handleCloseClick(id) {
    if (armedCloseId !== id) {
      armClose(id);
      return;
    }
    disarmClose();
    closeInstance(id);
  }

  function armClose(id) {
    disarmClose();
    const record = instances.get(id);
    if (!record || !record.tab) return;
    armedCloseId = id;
    record.tab.close.classList.add("is-armed");
    record.tab.close.innerHTML = `<span class="tab__close-label">确认关闭</span>`;
    dom.setAttrs(record.tab.close, {
      "aria-label": `确认关闭「${record.name}」`,
      title: "再次点击确认关闭",
    });
    armTimer = window.setTimeout(disarmClose, CLOSE_CONFIRM_MS);
    toast(`再次点击关闭按钮即可关闭「${record.name}」。`, "warn");
  }

  function disarmClose() {
    if (armTimer) {
      window.clearTimeout(armTimer);
      armTimer = 0;
    }
    if (!armedCloseId) return;
    const record = instances.get(armedCloseId);
    armedCloseId = "";
    if (!record || !record.tab) return;
    record.tab.close.classList.remove("is-armed");
    record.tab.close.innerHTML = icon("close", 13);
    dom.setAttrs(record.tab.close, {
      "aria-label": `关闭「${record.name}」`,
      title: `关闭「${record.name}」`,
    });
  }

  /* --------------------------------------------------------- 标签菜单 */

  function menuItem(label, iconName, handler) {
    const item = dom.el("button", {
      className: "tabmenu__item",
      attrs: { type: "button", role: "menuitem", tabindex: "-1" },
    });
    item.innerHTML = `<span aria-hidden="true">${icon(iconName, 15)}</span><span></span>`;
    item.lastElementChild.textContent = label;
    dom.on(item, "click", handler);
    return item;
  }

  function openMenu(id, anchor) {
    const record = instances.get(id);
    if (!deckEl || !anchor || !record) return;
    menuAnchor = anchor;

    const inSecondary = paneOf(id) === "secondary";
    deckEl.replaceChildren(
      menuItem("重命名", "pencil", () => {
        closeMenu();
        beginRename(id);
      }),
      dom.el("div", { className: "tabmenu__sep", attrs: { role: "separator" } }),
      menuItem(inSecondary ? "移回主栏" : "在右侧并排显示", "columns", () => {
        const target = inSecondary ? "primary" : "secondary";
        closeMenu();
        moveInstance(id, target, inSecondary ? 0 : null);
      }),
      dom.el("div", { className: "tabmenu__sep", attrs: { role: "separator" } }),
      menuItem("关闭该标签", "close", () => {
        closeMenu();
        armClose(id);
        if (record.tab) record.tab.close.focus();
      })
    );

    deckEl.hidden = false;
    const anchorRect = anchor.getBoundingClientRect();
    const deckRect = deckEl.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - deckRect.width - 8));
    let top = anchorRect.bottom + 6;
    if (top + deckRect.height > window.innerHeight - 8) {
      top = Math.max(8, anchorRect.top - deckRect.height - 6);
    }
    deckEl.style.left = `${Math.round(left)}px`;
    deckEl.style.top = `${Math.round(top)}px`;
    anchor.setAttribute("aria-expanded", "true");

    const first = deckEl.querySelector(".tabmenu__item");
    if (first) first.focus();
  }

  function closeMenu() {
    if (!deckEl || deckEl.hidden) {
      if (menuAnchor) menuAnchor.setAttribute("aria-expanded", "false");
      menuAnchor = null;
      return;
    }
    deckEl.hidden = true;
    if (menuAnchor) menuAnchor.setAttribute("aria-expanded", "false");
    menuAnchor = null;
  }

  /* ------------------------------------------------------------- 拖拽 */

  function clearDragState() {
    if (dragId) {
      const record = instances.get(dragId);
      if (record && record.tab) record.tab.el.classList.remove("is-dragging");
    }
    dragId = "";
    delete document.body.dataset.dragging;
    dom.qsa(".tabstrip__marker").forEach((node) => node.remove());
    if (dropzone) dropzone.classList.remove("is-over");
  }

  /** 计算插入位置：指针越过某个标签的中线即插到它前面 */
  function computeDropIndex(list, clientX) {
    const items = Array.from(list.querySelectorAll(".tab"));
    for (let index = 0; index < items.length; index += 1) {
      const rect = items[index].getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) return index;
    }
    return items.length;
  }

  function showMarker(list, index) {
    let marker = list.querySelector(".tabstrip__marker");
    if (!marker) {
      marker = dom.el("div", { className: "tabstrip__marker", attrs: { "aria-hidden": "true" } });
    }
    const items = Array.from(list.querySelectorAll(".tab"));
    const reference = items[index] || null;
    if (reference) list.insertBefore(marker, reference);
    else list.append(marker);
  }

  /* ---------------------------------------------------------- 事件绑定 */

  function setupPaneEvents() {
    PANE_IDS.forEach((paneId) => {
      const pane = panes[paneId];
      if (!pane.list || !pane.view) return;

      bind(pane.list, "click", (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;
        const tabEl = target.closest(".tab");
        if (!tabEl) return;
        const id = tabEl.dataset.instance;
        focusPane(paneId);

        if (target.closest(".tab__close")) {
          handleCloseClick(id);
          return;
        }
        if (target.closest(".tab__menu")) {
          // 再次点击同一个「⋯」即关闭菜单（切换）
          if (menuAnchor === target.closest(".tab__menu") && deckEl && !deckEl.hidden) closeMenu();
          else openMenu(id, target.closest(".tab__menu"));
          return;
        }
        if (target.closest(".tab__main")) activate(id);
      });

      // 双击标签标题进入重命名（需求 4：直观的重命名界面）
      bind(pane.list, "dblclick", (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target || !target.closest(".tab__main")) return;
        const tabEl = target.closest(".tab");
        if (!tabEl) return;
        event.preventDefault();
        beginRename(tabEl.dataset.instance);
      });

      bind(pane.list, "keydown", (event) => onTablistKeydown(event, paneId));

      bind(pane.list, "contextmenu", (event) => {
        const tabEl = event.target instanceof Element ? event.target.closest(".tab") : null;
        if (!tabEl) return;
        event.preventDefault();
        openMenu(tabEl.dataset.instance, tabEl.querySelector(".tab__menu"));
      });

      // 栏内任意交互都把该栏设为聚焦栏（侧栏高亮随聚焦栏走）
      bind(pane.view, "pointerdown", () => focusPane(paneId));
      bind(pane.view, "focusin", () => focusPane(paneId));

      // 拖拽
      bind(pane.list, "dragstart", onDragStart);
      bind(pane.list, "dragover", onDragOver);
      bind(pane.list, "dragleave", () => {
        const marker = pane.list.querySelector(".tabstrip__marker");
        if (marker) marker.remove();
      });
      bind(pane.list, "drop", onDrop);
    });
  }

  function onTablistKeydown(event, paneId) {
    const ids = state.panes[paneId];
    if (!ids.length) return;
    const target = event.target instanceof Element ? event.target : null;
    // 重命名输入框内的按键只属于输入框（方向键、Delete 等不得被标签栏劫持）
    if (target && target.classList.contains("tab__rename")) return;

    const tabEl = target ? target.closest(".tab") : null;
    const currentId = (tabEl && tabEl.dataset.instance) || state.active[paneId];
    const index = ids.indexOf(currentId);

    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const delta = event.key === "ArrowRight" ? 1 : -1;
      activate(ids[(index + delta + ids.length) % ids.length], true);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      activate(event.key === "Home" ? ids[0] : ids[ids.length - 1], true);
      return;
    }
    if (event.key === "F2") {
      event.preventDefault();
      beginRename(currentId);
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      handleCloseClick(currentId);
      return;
    }
    if (event.key === "Escape") {
      disarmClose();
      return;
    }
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const record = instances.get(currentId);
      if (record && record.tab) openMenu(currentId, record.tab.menu);
    }
  }

  function onDragStart(event) {
    const tabEl = event.target instanceof Element ? event.target.closest(".tab") : null;
    if (!tabEl) return;
    const id = tabEl.dataset.instance;
    const record = instances.get(id);
    if (!record || record.renaming || !paneOf(id)) return;

    dragId = id;
    tabEl.classList.add("is-dragging");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      try {
        event.dataTransfer.setData("text/plain", id);
      } catch (error) {
        /* 某些环境禁止写入 dataTransfer：不影响拖拽本身 */
      }
    }
    // 只有当「拖到右侧并排」确实可执行时才浮现投放区，避免给出不可用的承诺
    const canSplit = !isNarrow() && !state.panes.secondary.length && state.panes.primary.length >= 2;
    if (canSplit) document.body.dataset.dragging = "on";
  }

  function onDragOver(event) {
    if (!dragId) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    showMarker(event.currentTarget, computeDropIndex(event.currentTarget, event.clientX));
  }

  function onDrop(event) {
    if (!dragId) return;
    event.preventDefault();
    const list = event.currentTarget;
    const paneId = list.closest("[data-pane]").dataset.pane;
    const index = computeDropIndex(list, event.clientX);
    const id = dragId;
    clearDragState();
    moveInstance(id, paneId, index);
  }

  function setupDropzone() {
    if (!dropzone) return;
    bind(dropzone, "dragover", (event) => {
      if (!dragId) return;
      event.preventDefault();
      dropzone.classList.add("is-over");
    });
    bind(dropzone, "dragleave", () => dropzone.classList.remove("is-over"));
    bind(dropzone, "drop", (event) => {
      if (!dragId) return;
      event.preventDefault();
      const id = dragId;
      clearDragState();
      moveInstance(id, "secondary", null);
    });
  }

  function setupMenuEvents() {
    deckEl = dom.el("div", { className: "tabmenu", attrs: { role: "menu", hidden: true } });
    document.body.appendChild(deckEl);

    bind(deckEl, "keydown", (event) => {
      const items = Array.from(deckEl.querySelectorAll(".tabmenu__item"));
      const index = items.indexOf(document.activeElement);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const next = items[(index + delta + items.length) % items.length];
        if (next) next.focus();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        const anchor = menuAnchor;
        closeMenu();
        if (anchor) anchor.focus();
      }
    });

    bind(document, "pointerdown", (event) => {
      if (deckEl.hidden) return;
      if (!(event.target instanceof Element)) return;
      if (deckEl.contains(event.target)) return;
      if (event.target.closest(".tab__menu")) return; // 交给 click 处理切换
      closeMenu();
    });
    bind(window, "resize", closeMenu);
    bind(window, "scroll", closeMenu, true);
  }

  function setupGlobalEvents() {
    // 拖拽在任何位置结束都要清理状态（Esc 取消也要）
    bind(document, "dragend", clearDragState);
    bind(document, "keydown", (event) => {
      if (event.key !== "Escape") return;
      if (dragId) clearDragState();
      if (armedCloseId) disarmClose();
    });

    // 直链与浏览器前进后退：hash 只表达「哪个工具」，落在其 serial 最小的实例上（§2.6）
    bind(window, "hashchange", () => {
      const toolId = hashToolId();
      if (!toolId) return;
      const existing = findInstanceByTool(toolId);
      if (existing) activate(existing.id);
      else openInstance(toolId);
    });

    // 窄屏切换：并排自动转为上下堆叠，需要重新测量
    let media = null;
    const onNarrowChange = () => {
      syncVisibility();
      if (requestLayoutSignal) requestLayoutSignal();
    };
    try {
      media = window.matchMedia("(max-width: 900px)");
      if (media && typeof media.addEventListener === "function") {
        media.addEventListener("change", onNarrowChange);
        disposers.push(() => media.removeEventListener("change", onNarrowChange));
      } else if (media && typeof media.addListener === "function") {
        media.addListener(onNarrowChange);
        disposers.push(() => media.removeListener(onNarrowChange));
      }
    } catch (error) {
      media = null;
    }

    bind(dom.qs('[data-action="collapse-split"]', workspaceRoot), "click", collapseSplit);
  }

  /* --------------------------------------------------------------- 启动 */

  function boot() {
    const stored = readLayout();
    if (stored) {
      stored.instances.forEach((instance) => {
        if (instances.size >= MAX_INSTANCES) return;
        instances.set(instance.id, { ...instance, renaming: false, tab: null, panel: null });
        ensureNodes(instances.get(instance.id));
      });
      state.panes = stored.panes;
      state.active = stored.active;
      state.focused = stored.focused;
    }

    const fromHash = hashToolId();
    if (fromHash) {
      const existing = findInstanceByTool(fromHash);
      if (existing) {
        const paneId = paneOf(existing.id) || "primary";
        state.active[paneId] = existing.id;
        state.focused = paneId;
      } else {
        openInstance(fromHash);
      }
    }

    normalizeState();
    syncVisibility();
    renderTabs();
    syncActiveUI();
  }

  function destroy() {
    destroyed = true;
    disarmClose();
    closeMenu();
    clearDragState();
    if (toastTimer) {
      window.clearTimeout(toastTimer);
      toastTimer = 0;
    }
    instances.forEach((record) => {
      try {
        if (record.panel && typeof record.panel.cleanup === "function") record.panel.cleanup();
      } catch (error) {
        console.error("[toolbox] 实例清理失败：", error);
      }
    });
    instances.clear();
    if (deckEl) {
      deckEl.remove();
      deckEl = null;
    }
    disposers.forEach((dispose) => dispose());
    disposers.length = 0;
  }

  setupPaneEvents();
  setupDropzone();
  setupMenuEvents();
  setupGlobalEvents();

  return { boot, openInstance, destroy };
}

export default createTabsWorkspace;
