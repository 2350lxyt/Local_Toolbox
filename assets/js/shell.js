/**
 * 应用外壳（Shell）
 * ------------------------------------------------------------------
 * 职责：
 *   1. 解析站点根路径（兼容 CloudBase 根路径与 GitHub Pages 子路径）；
 *   2. 渲染左侧工具列表与顶部栏，处理列表收起/展开与状态持久化；
 *   3. 高亮当前工具、渲染面包屑与首页工具总览；
 *   4. 按运行模式分派（docs/DESIGN.md §2.5）：
 *      - 标签工作台模式（入口页 index.html）：交给 tabs.js 在页内打开标签，不再整页跳转；
 *      - 独立页模式（tools/<id>/index.html）：动态挂载单个工具模块并调用其 init(ctx)；
 *   5. 提供加载失败的兜底提示，避免单个工具报错导致整页空白。
 *
 * 本文件不包含任何具体工具的业务逻辑。
 */

import { TOOLS, SITE, STATUS_LABEL, getToolById } from "./registry.js";
import { createTabsWorkspace } from "./tabs.js";
import { icon } from "./icons.js";
import * as dom from "./utils/dom.js";
import * as clipboard from "./utils/clipboard.js";
import * as text from "./utils/text.js";
import {
  THEME_LABEL,
  THEME_ICON,
  cycleThemePref,
  getThemePref,
  initTheme,
} from "./theme.js";

/* ------------------------------------------------------------------ 路径 */

/**
 * 站点根 URL：本文件位于 assets/js/ 下，向上两级即站点根。
 * 以此解析的相对路径天然同时适用于根域名与子路径部署。
 */
export const SITE_ROOT = new URL("../../", import.meta.url);

/** 把注册表中的「站点根相对路径」解析为可直接使用的绝对地址 */
export function toSiteUrl(relativePath) {
  return new URL(relativePath, SITE_ROOT).href;
}

/* ------------------------------------------------------------ 常量与状态 */

const SIDEBAR_KEY = "toolbox:sidebar";
const NARROW_MEDIA = "(max-width: 900px)";
/** 侧栏宽度过渡（--dur-base 200ms）结束后再补一次重测量（docs/DESIGN.md §4.4） */
const LAYOUT_SIGNAL_DELAY = 240;

const root = document.documentElement;

/**
 * 统一重测量信号。
 * 面板被隐藏、并排分栏、侧栏开合都会让工具侧量到的布局失效，而这些变化不会触发
 * window 的原生 resize，因此由外壳代为派发一次（docs/DESIGN.md §4.4、§9.3）。
 */
function requestLayoutSignal() {
  const fire = () => window.dispatchEvent(new Event("resize"));
  window.requestAnimationFrame(fire);
  window.setTimeout(fire, LAYOUT_SIGNAL_DELAY);
}

function isNarrow() {
  try {
    return window.matchMedia(NARROW_MEDIA).matches;
  } catch (error) {
    return false;
  }
}

function readSidebarState() {
  try {
    const value = window.localStorage.getItem(SIDEBAR_KEY);
    if (value === "collapsed" || value === "expanded") return value;
  } catch (error) {
    /* 忽略 */
  }
  return "expanded";
}

function writeSidebarState(value) {
  try {
    window.localStorage.setItem(SIDEBAR_KEY, value);
  } catch (error) {
    /* 忽略 */
  }
}

/* ------------------------------------------------------------ 结构渲染 */

/** 渲染占位符模板（{{KEY}} 全局替换，同一占位符可多次出现） */
function tpl(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match
  );
}

const SHELL_TEMPLATE = `
<a class="skip-link" href="#workspace">跳到主内容</a>
<div class="shell">
  <aside class="sidebar" id="sidebar" aria-label="工具列表">
    <div class="sidebar__head">
      <a class="brand" href="{{HOME}}">
        <span class="brand__mark" aria-hidden="true">{{BRAND_ICON}}</span>
        <span class="brand__text">
          <span class="brand__name">{{SITE_NAME}}</span>
        </span>
      </a>
    </div>
    <nav class="sidebar__nav" aria-labelledby="nav-label">
      <p class="nav__label meta-label" id="nav-label">工具集 <span class="nav__count">{{COUNT}}</span></p>
      <ul class="nav__list" data-nav-list></ul>
    </nav>
  </aside>
  <div class="sidebar-backdrop" data-action="close-drawer" aria-hidden="true"></div>
  <div class="shell__main">
    <header class="topbar">
      <button class="icon-btn" type="button" data-action="toggle-sidebar" aria-controls="sidebar">{{TOGGLE_ICON}}</button>
      <nav class="crumbs" aria-label="当前位置" data-crumbs></nav>
      <div class="topbar__spacer"></div>
      <div class="topbar__actions">
        <button class="icon-btn" type="button" data-action="cycle-theme">{{THEME_ICON}}</button>
      </div>
    </header>
  </div>
</div>`;

/** 生成一个左侧列表项 */
function navItemMarkup(tool, isActive) {
  const status = STATUS_LABEL[tool.status] || STATUS_LABEL.planned;
  return (
    `<li>` +
    `<a class="nav__item${isActive ? " is-active" : ""}" ` +
    `href="${dom.escapeHtml(toSiteUrl(tool.path))}" ` +
    `data-tool="${dom.escapeHtml(tool.id)}" ` +
    `data-name="${dom.escapeHtml(tool.name)}" ` +
    `data-status="${dom.escapeHtml(tool.status)}"` +
    (isActive ? ' aria-current="page"' : "") +
    `>` +
    `<span class="nav__icon" aria-hidden="true">${icon(tool.icon, 18)}</span>` +
    `<span class="nav__text">${dom.escapeHtml(tool.name)}</span>` +
    `<span class="nav__badge">${dom.escapeHtml(status)}</span>` +
    `</a></li>`
  );
}

/** 渲染左侧列表（activeId 为空表示尚未打开任何工具） */
function renderNav(list, activeId = "") {
  if (!list) return;
  list.innerHTML = TOOLS.map((tool) => navItemMarkup(tool, tool.id === activeId)).join("");

  if (TOOLS.length === 0) {
    list.innerHTML = '<li class="nav__empty">暂未注册任何工具</li>';
  }
}

/**
 * 同步左侧列表的当前项高亮（切换/关闭标签时调用，不重建列表）。
 * 侧栏是**工具**列表，因此按 `toolId` 高亮（同一工具存在激活实例即高亮）；
 * 面包屑则显示**实例显示名**（同一工具可能有多个实例，见 docs/DESIGN.md §4.4）。
 * @param {{toolId: string, name?: string}|null} instance 当前激活实例视图（null 表示首页）
 * @param {Object} [options]
 */
function syncNavActive(instance = null, options = {}) {
  const toolId = instance ? instance.toolId : "";
  const list = dom.qs("[data-nav-list]");
  if (list) {
    dom.qsa(".nav__item", list).forEach((item) => {
      const isActive = Boolean(toolId) && item.dataset.tool === toolId;
      item.classList.toggle("is-active", isActive);
      if (isActive) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    });
  }
  syncCrumbs(instance, options);
}

/**
 * 渲染面包屑。
 * @param {{toolId: string, name?: string}|null} instance 当前激活实例视图
 * @param {Object} [options]
 * @param {boolean} [options.linkHome=true] 「工具集」是否为链接；标签模式下置 false，
 *        避免一次无意义的整页刷新（docs/DESIGN.md §4.4）
 */
function syncCrumbs(instance = null, options = {}) {
  const host = dom.qs("[data-crumbs]");
  if (!host) return;
  const tool = instance ? getToolById(instance.toolId) : null;
  const home = dom.escapeHtml(toSiteUrl("index.html"));
  const homeMarkup =
    options.linkHome === false
      ? '<span class="crumbs__link">工具集</span>'
      : `<a class="crumbs__link" href="${home}">工具集</a>`;

  if (!tool) {
    host.innerHTML = '<span class="crumbs__current">工具集</span>';
    return;
  }

  const label = instance && instance.name ? instance.name : tool.name;
  host.innerHTML =
    homeMarkup +
    `<span class="crumbs__sep" aria-hidden="true">/</span>` +
    `<span class="crumbs__current">${dom.escapeHtml(label)}</span>`;
}

/** 首页工具总览卡片 */
function renderToolGrid() {
  const grid = dom.qs("[data-tool-grid]");
  if (!grid) return;

  grid.innerHTML = TOOLS.map((tool) => {
    const status = STATUS_LABEL[tool.status] || STATUS_LABEL.planned;
    const planned = tool.status !== "ready";
    return (
      `<li class="tool-card${planned ? " is-planned" : ""}">` +
      `<a class="tool-card__link" href="${dom.escapeHtml(toSiteUrl(tool.path))}" ` +
      `data-tool="${dom.escapeHtml(tool.id)}">` +
      `<span class="tool-card__top">` +
      `<span class="tool-card__icon" aria-hidden="true">${icon(tool.icon, 20)}</span>` +
      `<span class="badge badge--${planned ? "warn" : "ok"}">${dom.escapeHtml(status)}</span>` +
      `</span>` +
      `<span class="tool-card__name">${dom.escapeHtml(tool.name)}</span>` +
      `<span class="tool-card__desc">${dom.escapeHtml(tool.description)}</span>` +
      `<span class="tool-card__foot">` +
      `<span class="meta-label">${dom.escapeHtml(tool.id)}</span>` +
      `<span class="tool-card__go" aria-hidden="true">${icon("arrowRight", 16)}</span>` +
      `</span>` +
      `</a></li>`
    );
  }).join("");

  const counter = dom.qs("[data-tool-count]");
  if (counter) counter.textContent = String(TOOLS.length);
}

/**
 * 填充页脚共享信息。
 * @param {ParentNode} [scope=document] 作用域；标签面板创建后传入面板节点
 */
function renderFooter(scope = document) {
  const host = dom.qs("[data-site-footer]", scope);
  if (!host) return;
  // 页脚只放版本信息：隐私/本地计算表述统一收敛到工具结果面板（docs/DESIGN.md §8.5）
  host.innerHTML = `<span class="foot__meta mono">${dom.escapeHtml(SITE.name)} v${dom.escapeHtml(SITE.version)}</span>`;
}

/* --------------------------------------------------------- 侧边栏交互 */

function setupSidebar(options = {}) {
  const { onLayoutChange } = options;
  const toggle = dom.qs('[data-action="toggle-sidebar"]');
  const backdrop = dom.qs(".sidebar-backdrop");

  const syncButton = () => {
    if (!toggle) return;
    const narrow = isNarrow();
    const drawerOpen = root.dataset.drawer === "open";
    const expanded = root.dataset.sidebar !== "collapsed";

    if (narrow) {
      toggle.innerHTML = icon(drawerOpen ? "close" : "menu", 18);
      toggle.setAttribute("aria-expanded", String(drawerOpen));
      toggle.setAttribute("aria-label", drawerOpen ? "关闭工具列表" : "打开工具列表");
      toggle.title = drawerOpen ? "关闭工具列表" : "打开工具列表";
      return;
    }

    toggle.innerHTML = icon(expanded ? "panelLeftClose" : "panelLeftOpen", 18);
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.setAttribute("aria-label", expanded ? "收起工具列表" : "展开工具列表");
    toggle.title = expanded ? "收起工具列表" : "展开工具列表";
  };

  const closeDrawer = () => {
    delete root.dataset.drawer;
    syncButton();
  };

  dom.on(toggle, "click", () => {
    if (isNarrow()) {
      if (root.dataset.drawer === "open") {
        closeDrawer();
      } else {
        root.dataset.drawer = "open";
        syncButton();
      }
      return;
    }
    const next = root.dataset.sidebar === "collapsed" ? "expanded" : "collapsed";
    root.dataset.sidebar = next;
    writeSidebarState(next);
    syncButton();
    // 侧栏宽度变化会改变面板栏宽：通知工具重新测量（§4.4）
    if (onLayoutChange) onLayoutChange();
  });

  dom.on(backdrop, "click", closeDrawer);

  dom.on(document, "keydown", (event) => {
    if (event.key === "Escape" && root.dataset.drawer === "open") closeDrawer();
  });

  window.addEventListener("resize", () => {
    if (!isNarrow()) closeDrawer();
    syncButton();
  });

  // 同步引导脚本已写入的状态
  root.dataset.sidebar = readSidebarState();
  syncButton();

  return { syncButton };
}

/** 收起态下悬停显示工具名称的浮层（fixed 定位，避免被侧边栏裁剪） */
function setupNavTooltip() {
  const list = dom.qs("[data-nav-list]");
  if (!list) return;

  const tip = dom.el("div", { className: "nav-tooltip", attrs: { role: "tooltip" } });
  document.body.appendChild(tip);

  const hide = () => tip.classList.remove("is-visible");

  const show = (item) => {
    if (root.dataset.sidebar !== "collapsed" || isNarrow()) return;
    const rect = item.getBoundingClientRect();
    tip.textContent = item.dataset.name || "";
    tip.style.top = `${Math.round(rect.top + rect.height / 2)}px`;
    tip.style.left = `${Math.round(rect.right + 10)}px`;
    tip.classList.add("is-visible");
  };

  dom.on(list, "pointerenter", (event) => {
    const item = event.target instanceof Element ? event.target.closest(".nav__item") : null;
    if (item) show(item);
  }, true);

  dom.on(list, "pointerleave", hide, true);
  dom.on(window, "scroll", hide, true);

  return hide;
}

/* ----------------------------------------------------------- 主题交互 */

function setupThemeButton() {
  const button = dom.qs('[data-action="cycle-theme"]');
  if (!button) return () => {};

  const sync = () => {
    const pref = getThemePref();
    button.innerHTML = icon(THEME_ICON[pref] || "monitor", 18);
    const label = `主题：${THEME_LABEL[pref]}（点击切换）`;
    button.setAttribute("aria-label", label);
    button.title = label;
  };

  dom.on(button, "click", () => {
    cycleThemePref();
    sync();
  });

  sync();
  return initTheme();
}

/* ------------------------------------------------------- 工具模块挂载 */

/** 渲染可读的错误提示，避免单点失败导致空白页 */
function renderBlockError(host, message) {
  if (!host) return;
  const box = dom.el("div", { className: "notice notice--danger" });
  box.innerHTML =
    `<span class="notice__icon" aria-hidden="true">${icon("alert", 18)}</span>` +
    `<div class="notice__body"><p class="notice__title">工具加载失败</p>` +
    `<p class="notice__text">${dom.escapeHtml(message)}</p></div>`;
  host.prepend(box);
}

/** 已注入过的工具私有样式（按绝对地址去重） */
const injectedStyles = new Set();

/**
 * 按需注入工具私有样式。
 * 标签工作台会在同一页面里同时挂载多个工具，工具的私有 CSS 因此不能再只依赖
 * 「工具页 `<head>` 里的 `<link>`」，而要按 `ToolRecord.styles` 注入（docs/DESIGN.md §9.2 / §9.5）。
 * 工具独立页中同址样式已存在，这里会自动跳过。
 * @param {Object} tool 注册表中的工具记录
 */
function ensureToolStyles(tool) {
  const styles = Array.isArray(tool.styles) ? tool.styles : [];
  styles.forEach((relativePath) => {
    const href = toSiteUrl(relativePath);
    if (injectedStyles.has(href)) return;
    injectedStyles.add(href);

    const exists = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).some(
      (link) => link.href === href
    );
    if (exists) return;

    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.toolStyle = tool.id;
    document.head.appendChild(link);
  });
}

/**
 * 动态加载工具模块并在给定根节点内 init()。
 * 标签工作台与工具独立页共用同一加载逻辑（docs/DESIGN.md §9.3）。
 * @param {Object} tool 注册表中的工具记录
 * @param {HTMLElement} host `ctx.root`（标签模式为面板容器，独立页为 main#workspace）
 * @param {Object} [instance] 标签实例视图 `{ id, toolId, serial, name, renamed }`；
 *        独立页无实例概念，缺省时等价于「该工具的首个实例」（serial = 1，沿用既有配置键）
 * @returns {Promise<Function>} 清理函数（关闭标签或离开页面时调用）
 */
async function loadToolModule(tool, host, instance) {
  if (!tool.entry) throw new Error(`工具「${tool.name}」未配置处理模块（entry）。`);

  ensureToolStyles(tool);

  const module = await import(/* @vite-ignore */ toSiteUrl(tool.entry));
  if (typeof module.init !== "function") {
    throw new Error(`模块 ${tool.entry} 未导出 init(ctx) 函数`);
  }

  const cleanup = module.init({
    root: host,
    tool,
    site: SITE,
    instance: instance || {
      id: tool.id,
      toolId: tool.id,
      serial: 1,
      name: tool.name,
      renamed: false,
    },
    utils: { dom, clipboard, text },
    icons: { icon },
    toSiteUrl,
  });

  return typeof cleanup === "function" ? cleanup : () => {};
}

/** 独立页模式：依据 body[data-tool] 把单个工具挂载进 main#workspace（保留既有行为） */
async function mountStandaloneTool() {
  const toolId = document.body.dataset.tool;
  if (!toolId) return;

  const host = dom.qs("#workspace") || document.body;
  const tool = getToolById(toolId);

  if (!tool) {
    renderBlockError(host, `未在注册表（assets/js/registry.js）中找到 id 为「${toolId}」的工具。`);
    return;
  }

  try {
    const cleanup = await loadToolModule(tool, host);
    window.addEventListener("pagehide", cleanup, { once: true });
  } catch (error) {
    console.error("[toolbox] 工具模块加载失败：", error);
    renderBlockError(host, `${error && error.message ? error.message : error}`);
  }
}

/**
 * 标签模式：把左侧列表与首页卡片的点击转成「页内新建标签实例」。
 * 每次点击都新建一个实例（同一工具可重复打开，见 docs/DESIGN.md §4.4）；
 * `href` 保留（右键新标签页、无脚本、中键仍可用），仅在普通左键点击时拦截。
 */
function setupTabbedNavigation(tabs, syncSidebarButton) {
  const handler = (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const target = event.target instanceof Element ? event.target : null;
    const trigger = target ? target.closest("[data-tool]") : null;
    if (!trigger) return;

    event.preventDefault();
    if (root.dataset.drawer === "open") {
      delete root.dataset.drawer;
      if (syncSidebarButton) syncSidebarButton();
    }
    tabs.openInstance(trigger.dataset.tool);
  };

  dom.on(dom.qs("[data-nav-list]"), "click", handler);
  dom.on(dom.qs("[data-tool-grid]"), "click", handler);
}

/* --------------------------------------------------------------- 启动 */

function bootstrap() {
  // 工具独立页在有脚本时会重定向到标签工作台（assets/js/tool-redirect.js），
  // 此时不再渲染独立页外壳，避免跳转前的闪烁。
  if (window.__toolboxRedirecting) return;

  const mount = dom.qs("#shell-root");
  const workspace = dom.qs("#workspace");
  const standaloneToolId = document.body.dataset.tool || "";

  if (mount && workspace) {
    mount.insertAdjacentHTML(
      "beforebegin",
      tpl(SHELL_TEMPLATE, {
        HOME: dom.escapeHtml(toSiteUrl("index.html")),
        BRAND_ICON: icon("merge", 18),
        SITE_NAME: dom.escapeHtml(SITE.name),
        COUNT: String(TOOLS.length),
        TOGGLE_ICON: icon("panelLeftClose", 18),
        THEME_ICON: icon("monitor", 18),
      })
    );

    const shell = mount.previousElementSibling; // .shell
    const main = shell ? shell.querySelector(".shell__main") : null;
    if (main) main.appendChild(workspace);
    mount.remove();
  }

  renderNav(dom.qs("[data-nav-list]"), standaloneToolId);
  syncCrumbs(standaloneToolId ? { toolId: standaloneToolId, name: "" } : null);
  renderToolGrid();
  renderFooter();

  const sidebar = setupSidebar({ onLayoutChange: requestLayoutSignal });
  setupNavTooltip();
  setupThemeButton();

  // 独立页模式（tools/<id>/index.html）：保留「单工具整页」的既有行为
  if (standaloneToolId) {
    mountStandaloneTool();
    return;
  }

  // 入口页 = 标签工作台模式（docs/DESIGN.md §4.4）
  document.body.dataset.mode = "tabs";
  const tabs = createTabsWorkspace({
    loadTool: loadToolModule,
    renderError: renderBlockError,
    renderFooter,
    onActiveChange: (instance) => syncNavActive(instance, { linkHome: false }),
    requestLayoutSignal,
  });

  if (!tabs) return;
  setupTabbedNavigation(tabs, sidebar ? sidebar.syncButton : null);
  tabs.boot();
  window.addEventListener("pagehide", () => tabs.destroy(), { once: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
} else {
  bootstrap();
}

export { bootstrap };
