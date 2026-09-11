/**
 * 应用外壳（Shell）
 * ------------------------------------------------------------------
 * 职责：
 *   1. 解析站点根路径（兼容 CloudBase 根路径与 GitHub Pages 子路径）；
 *   2. 渲染左侧工具列表与顶部栏，处理列表收起/展开与状态持久化；
 *   3. 高亮当前工具、渲染面包屑与首页工具总览；
 *   4. 依据 body[data-tool] 动态挂载对应工具模块并调用其 init(ctx)；
 *   5. 提供加载失败的兜底提示，避免单个工具报错导致整页空白。
 *
 * 本文件不包含任何具体工具的业务逻辑。
 */

import { TOOLS, SITE, STATUS_LABEL, getToolById } from "./registry.js";
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

const root = document.documentElement;

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

/** 渲染左侧列表 */
function renderNav(list) {
  if (!list) return;
  const activeId = document.body.dataset.tool || "";
  list.innerHTML = TOOLS.map((tool) => navItemMarkup(tool, tool.id === activeId)).join("");

  if (TOOLS.length === 0) {
    list.innerHTML = '<li class="nav__empty">暂未注册任何工具</li>';
  }
}

/** 渲染面包屑 */
function renderCrumbs(host) {
  if (!host) return;
  const activeId = document.body.dataset.tool || "";
  const active = getToolById(activeId);
  const home = dom.escapeHtml(toSiteUrl("index.html"));

  if (!active) {
    host.innerHTML = '<span class="crumbs__current">工具集</span>';
    return;
  }

  host.innerHTML =
    `<a class="crumbs__link" href="${home}">工具集</a>` +
    `<span class="crumbs__sep" aria-hidden="true">/</span>` +
    `<span class="crumbs__current">${dom.escapeHtml(active.name)}</span>`;
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
      `<a class="tool-card__link" href="${dom.escapeHtml(toSiteUrl(tool.path))}">` +
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

/** 填充页脚共享信息 */
function renderFooter() {
  const host = dom.qs("[data-site-footer]");
  if (!host) return;
  // 页脚只放版本信息：隐私/本地计算表述统一收敛到工具结果面板（docs/DESIGN.md §8.5）
  host.innerHTML = `<span class="foot__meta mono">${dom.escapeHtml(SITE.name)} v${dom.escapeHtml(SITE.version)}</span>`;
}

/* --------------------------------------------------------- 侧边栏交互 */

function setupSidebar() {
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

/** 依据 body[data-tool] 动态挂载工具模块 */
async function mountTool() {
  const toolId = document.body.dataset.tool;
  if (!toolId) return;

  const host = dom.qs("#workspace") || document.body;
  const tool = getToolById(toolId);

  if (!tool) {
    renderBlockError(host, `未在注册表（assets/js/registry.js）中找到 id 为「${toolId}」的工具。`);
    return;
  }

  if (!tool.entry) {
    renderBlockError(host, `工具「${tool.name}」未配置处理模块（entry）。`);
    return;
  }

  try {
    const module = await import(/* @vite-ignore */ toSiteUrl(tool.entry));
    if (typeof module.init !== "function") {
      throw new Error(`模块 ${tool.entry} 未导出 init(ctx) 函数`);
    }

    const cleanup = module.init({
      root: host,
      tool,
      site: SITE,
      utils: { dom, clipboard, text },
      icons: { icon },
      toSiteUrl,
    });

    if (typeof cleanup === "function") {
      window.addEventListener("pagehide", cleanup, { once: true });
    }
  } catch (error) {
    console.error("[toolbox] 工具模块加载失败：", error);
    renderBlockError(host, `${error && error.message ? error.message : error}`);
  }
}

/* --------------------------------------------------------------- 启动 */

function bootstrap() {
  const mount = dom.qs("#shell-root");
  const workspace = dom.qs("#workspace");

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

  renderNav(dom.qs("[data-nav-list]"));
  renderCrumbs(dom.qs("[data-crumbs]"));
  renderToolGrid();
  renderFooter();

  setupSidebar();
  setupNavTooltip();
  setupThemeButton();

  mountTool();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
} else {
  bootstrap();
}

export { bootstrap };
