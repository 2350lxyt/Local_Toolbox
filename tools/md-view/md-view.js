/**
 * 《MD 预览》主模块（docs/DESIGN.md §9.3 契约、§17 规格）
 * ==================================================================
 * 职责：UI 编排 + 存储适配。解析与渲染核心在附加纯函数模块 md-core.js。
 *
 * 布局（§17.3）：**上下分离，不提供左右分栏** —— 编辑区在上（可折叠），
 * 渲染区在下占满剩余空间、独立滚动。渲染为主：一键粘贴渲染成功后**自动收起
 * 编辑区并滚动到渲染区顶部**，直接呈现结果。
 *
 * 多实例安全（§9.3 第 7-9 条）：无模块级可变状态；配置键按 instance.serial 分区；
 * 面板内 DOM id 以 serial 为前缀；document 级快捷键带焦点守卫。
 */

import { renderMarkdown, normalizeOptions } from "./md-core.js";

const TOOL_ID = "md-view";
const CONFIG_PREFIX = "toolbox:md-view";
const DEBOUNCE_MS = 180;
/** 超过该字符数暂停实时渲染（沿用《SQL 格式化》§13 阈值先例），改手动「立即渲染」 */
const LONG_TEXT_LIMIT = 300000;
/** 「已复制」提示的复原时间（毫秒） */
const COPIED_RESET_MS = 2000;
/** 折叠 / 展开编辑区的快捷键（刻意避开 Ctrl+Shift+C —— 那是浏览器 DevTools 检查） */
const COLLAPSE_SHORTCUT = { ctrl: true, alt: true, key: "c" };

/**
 * @param {object} ctx 外壳注入（root / tool / instance / utils / icons / toSiteUrl）
 * @returns {() => void} 清理函数：注销全部监听与定时器（§9.3）
 */
export function init(ctx) {
  const { root, utils, icons, instance } = ctx;
  const { dom, clipboard, text, draft } = utils;

  /* ── 宿主与实例（§9.3 第 1、7 条）────────────────────────── */
  const host = root.querySelector("[data-tool-body]") || root.querySelector("#tool-body");
  if (!host) return () => {};
  const serial = instance && Number(instance.serial) > 1 ? Number(instance.serial) : 1;
  const configKey = serial > 1 ? `${CONFIG_PREFIX}:config:${serial}` : `${CONFIG_PREFIX}:config`;
  const idPrefix = `${TOOL_ID}-${serial}`;

  /* ── 配置（实例级；读写全程 try/catch 静默降级，§8.3）────── */
  const defaults = {
    viewMode: "split", // split = 上下分离 | preview = 仅预览（编辑区收起）
    realtime: true,
    syntaxHighlight: true,
    autoDetectLanguage: true,
    autoLink: true,
    allowRawHtml: false,
  };
  function loadConfig() {
    try {
      const raw = window.localStorage.getItem(configKey);
      if (!raw) return { ...defaults };
      const parsed = JSON.parse(raw);
      const merged = { ...defaults };
      Object.keys(defaults).forEach((key) => {
        if (typeof parsed[key] === typeof defaults[key]) merged[key] = parsed[key];
      });
      return merged;
    } catch {
      return { ...defaults };
    }
  }
  function saveConfig() {
    try {
      window.localStorage.setItem(configKey, JSON.stringify(config));
    } catch {
      /* 存储不可用：仅本次会话生效 */
    }
  }
  const config = loadConfig();

  /* ── 实例内可变状态（闭包持有，非模块级，§9.3 第 8 条）───── */
  let codeBlocks = []; // 与渲染 HTML 中 data-mv-code-copy 索引一一对应的原始代码文本
  let renderTimer = 0;
  let copiedTimer = 0;
  let noticeTimer = 0;
  let editorHeightPx = 0; // 0 = 未拖拽过，用默认比例
  let longTextNoticeShown = false;
  const disposers = [];

  /* ── DOM 构建 ─────────────────────────────────────────────── */

  const toolbar = dom.el("div", { className: "mv-toolbar" });
  const pasteBtn = dom.el("button", {
    className: "btn btn--primary",
    text: "粘贴并渲染",
    attrs: { type: "button", title: "读取剪贴板覆盖编辑区并立即渲染（Ctrl/Cmd + Shift + V）" },
  });
  const renderBtn = dom.el("button", {
    className: "btn btn--ghost",
    html: `${icons.icon("refresh")}<span>立即渲染</span>`,
    attrs: { type: "button", title: "按当前内容重新渲染（Ctrl/Cmd + Enter）" },
  });

  const viewLabel = dom.el("label", { className: "mv-viewlabel", text: "视图", attrs: { for: `${idPrefix}-view` } });
  const viewSelect = dom.el(
    "select",
    {
      className: "select",
      attrs: { id: `${idPrefix}-view` },
      children: [
        dom.el("option", { text: "上下分离", attrs: { value: "split" } }),
        dom.el("option", { text: "仅预览", attrs: { value: "preview" } }),
      ],
    }
  );
  viewSelect.value = config.viewMode;

  const optionsBtn = dom.el("button", {
    className: "btn btn--ghost",
    attrs: { type: "button", "aria-expanded": "false", "aria-controls": `${idPrefix}-options`, title: "渲染选项" },
  });
  optionsBtn.innerHTML = `${icons.icon("settings")}<span>选项</span>`;

  dom.append(toolbar, [pasteBtn, renderBtn, dom.el("span", { className: "mv-toolbar__spacer" }), viewLabel, viewSelect, optionsBtn]);

  const optionsBar = dom.el("div", { className: "mv-options", attrs: { id: `${idPrefix}-options`, hidden: true } });
  const optionDefs = [
    ["realtime", "实时渲染"],
    ["syntaxHighlight", "代码块语法高亮"],
    ["autoDetectLanguage", "自动识别代码语言"],
    ["autoLink", "自动链接"],
    ["allowRawHtml", "允许原始 HTML（仍不加载任何远程资源）"],
  ];
  const optionInputs = optionDefs.map(([key, label]) => {
    const input = dom.el("input", { attrs: { type: "checkbox", id: `${idPrefix}-opt-${key}` } });
    input.checked = Boolean(config[key]);
    const box = dom.el("label", {
      className: "checkbox mv-options__item",
      attrs: { for: `${idPrefix}-opt-${key}` },
      children: [input, dom.el("span", { text: label })],
    });
    return { key, input };
  });
  dom.append(optionsBar, optionInputs.map((entry) => entry.input.parentElement));

  const wrap = dom.el("div", { className: "mv-wrap" });

  /* 编辑区 */
  const editorSection = dom.el("section", { className: "mv-editor", attrs: { "aria-label": "Markdown 源文本" } });
  const editorInput = dom.el("textarea", {
    className: "textarea mv-editor__input",
    attrs: {
      id: `${idPrefix}-input`,
      placeholder: "在此粘贴或输入 Markdown……（Ctrl/Cmd + Shift + V 一键粘贴渲染）",
      spellcheck: "false",
    },
  });
  const editorFoot = dom.el("div", { className: "mv-foot" });
  const clearBtn = dom.el("button", { className: "btn btn--ghost mv-foot__mini", text: "清空", attrs: { type: "button" } });
  const editorStats = dom.el("span", { className: "mv-foot__stats" });
  const editorNotice = dom.el("span", { className: "mv-foot__notice", attrs: { role: "status" } });
  dom.append(editorFoot, [clearBtn, editorNotice, dom.el("span", { className: "mv-foot__spacer" }), editorStats]);
  dom.append(editorSection, [editorInput, editorFoot]);

  /* 分隔条（拖拽调整上下比例；比例仅会话内有效，不落盘） */
  const divider = dom.el("div", {
    className: "mv-divider",
    attrs: { role: "separator", "aria-orientation": "horizontal", tabindex: "0", "aria-label": "调整编辑区与渲染区高度" },
  });

  /* 渲染区（主角） */
  const previewSection = dom.el("section", { className: "mv-preview", attrs: { "aria-label": "渲染结果" } });
  const previewBody = dom.el("div", { className: "mv-preview__body" });
  const preview = dom.el("div", { className: "mv-preview__content" });
  const emptyState = dom.el(
    "div",
    {
      className: "mv-empty",
      children: [
        dom.el("span", { className: "mv-empty__icon", html: icons.icon("eye", 40) }),
        dom.el("p", { className: "mv-empty__title", text: "还没有内容" }),
        dom.el("p", { className: "mv-empty__hint", text: "在上方输入 Markdown，或直接粘贴聊天工具输出的文本" }),
      ],
    }
  );
  const previewFoot = dom.el("div", { className: "mv-foot" });
  const previewWarnings = dom.el("span", { className: "mv-foot__notice" });
  const previewStats = dom.el("span", { className: "mv-foot__stats" });
  dom.append(previewFoot, [previewWarnings, dom.el("span", { className: "mv-foot__spacer" }), previewStats]);
  dom.append(previewBody, [preview, emptyState]);
  dom.append(previewSection, [previewBody, previewFoot]);

  dom.append(wrap, [editorSection, divider, previewSection]);
  dom.append(host, [toolbar, optionsBar, wrap]);

  /* ── 渲染核心流程 ────────────────────────────────────────── */

  function currentOptions() {
    return normalizeOptions({
      syntaxHighlight: config.syntaxHighlight,
      autoDetectLanguage: config.autoDetectLanguage,
      autoLink: config.autoLink,
      allowRawHtml: config.allowRawHtml,
    });
  }

  function updateEditorStats() {
    const value = editorInput.value;
    editorStats.textContent = `${text.countChars(value).toLocaleString()} 字符 · ${text.countLines(value).toLocaleString()} 行`;
    if (text.countChars(value) > LONG_TEXT_LIMIT && config.realtime && !longTextNoticeShown) {
      longTextNoticeShown = true;
      editorNotice.textContent = "内容超过 300000 字符，已暂停实时渲染，请用「立即渲染」手动刷新。";
      if (noticeTimer) window.clearTimeout(noticeTimer);
      noticeTimer = window.setTimeout(() => {
        editorNotice.textContent = "";
        longTextNoticeShown = false;
        noticeTimer = 0;
      }, 6000);
    }
  }

  function renderNow() {
    const result = renderMarkdown(editorInput.value, currentOptions());
    codeBlocks = result.codeBlocks;

    preview.innerHTML = result.html;
    const hasContent = result.stats.blocks > 0 || result.stats.chars > 0;
    preview.hidden = !hasContent;
    emptyState.hidden = hasContent;

    previewStats.textContent = hasContent ? `${result.stats.blocks} 个块 · ${result.stats.chars.toLocaleString()} 字符` : "";
    previewWarnings.textContent = result.warnings.length ? `提示：${result.warnings.join(" ")}` : "";
  }

  function scheduleRender() {
    if (!config.realtime) return;
    if (text.countChars(editorInput.value) > LONG_TEXT_LIMIT) return; // 超长暂停实时渲染
    if (renderTimer) window.clearTimeout(renderTimer);
    renderTimer = window.setTimeout(() => {
      renderTimer = 0;
      renderNow();
    }, DEBOUNCE_MS);
  }

  /* ── 视图模式（上下分离 / 仅预览）────────────────────────── */

  let strip = null;
  function applyViewMode(mode, { scrollPreview = false } = {}) {
    config.viewMode = mode === "preview" ? "preview" : "split";
    viewSelect.value = config.viewMode;
    saveConfig();

    const collapsed = config.viewMode === "preview";
    editorSection.hidden = collapsed;
    divider.hidden = collapsed;

    // 仅预览时保留一条窄横条（首行摘要 + 展开按钮），编辑能力不丢失
    if (collapsed && !strip) {
      strip = dom.el("div", { className: "mv-strip", attrs: { hidden: true } });
      const stripText = dom.el("span", { className: "mv-strip__text" });
      const expandBtn = dom.el("button", { className: "btn btn--ghost mv-strip__btn", text: "展开编辑", attrs: { type: "button" } });
      disposers.push(
        dom.on(expandBtn, "click", () => applyViewMode("split", { scrollPreview: false })),
        dom.on(stripText, "click", () => applyViewMode("split", { scrollPreview: false }))
      );
      dom.append(strip, [dom.el("span", { className: "mv-strip__label", text: "源文本" }), stripText, expandBtn]);
      wrap.insertBefore(strip, previewSection);
      strip._text = stripText;
    }
    if (strip) {
      strip.hidden = !collapsed;
      if (collapsed) strip._text.textContent = text.truncate(editorInput.value.replace(/\s+/g, " ").trim(), 60);
    }
    wrap.classList.toggle("mv-wrap--preview", collapsed);

    if (collapsed && scrollPreview) {
      // 需求：一键粘贴渲染后直接看到结果 —— 滚动到渲染区顶部（最近可滚动祖先，§9.3 第 4 条）
      previewSection.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  /* ── 一键粘贴渲染（先读后清：读取失败不动编辑区内容）────── */

  let pasteBusy = false;
  async function pasteAndRender() {
    if (pasteBusy) return;
    pasteBusy = true;
    pasteBtn.disabled = true;
    try {
      const clipboardText = await clipboard.readText();
      if (!clipboardText || !clipboardText.trim()) {
        editorNotice.textContent = "无法读取剪贴板：权限受限或内容为空。";
        if (noticeTimer) window.clearTimeout(noticeTimer);
        noticeTimer = window.setTimeout(() => {
          editorNotice.textContent = "";
          noticeTimer = 0;
        }, 2500);
        return;
      }
      if (renderTimer) {
        window.clearTimeout(renderTimer);
        renderTimer = 0;
      }
      editorInput.value = clipboardText;
      updateEditorStats();
      draft.saveDraft(TOOL_ID, serial, "input", clipboardText); // 程序赋值不触发 input 事件，草稿在此补写
      renderNow();
      applyViewMode("preview", { scrollPreview: true }); // 自动收起编辑区并滚动到渲染区
    } finally {
      pasteBusy = false;
      pasteBtn.disabled = false;
    }
  }

  /* ── 事件绑定（全部收集进清理函数）──────────────────────── */

  disposers.push(
    dom.on(pasteBtn, "click", pasteAndRender),
    dom.on(renderBtn, "click", renderNow),
    dom.on(clearBtn, "click", () => {
      editorInput.value = "";
      updateEditorStats();
      renderNow();
      editorInput.focus();
    }),
    dom.on(editorInput, "input", () => {
      updateEditorStats();
      scheduleRender();
      draft.saveDraft(TOOL_ID, serial, "input", editorInput.value);
    }),
    dom.on(viewSelect, "change", () => applyViewMode(viewSelect.value)),
    dom.on(optionsBtn, "click", () => {
      const open = optionsBar.hidden;
      optionsBar.hidden = !open;
      optionsBtn.setAttribute("aria-expanded", String(open));
    })
  );

  optionInputs.forEach(({ key, input }) => {
    disposers.push(
      dom.on(input, "change", () => {
        config[key] = input.checked;
        saveConfig();
        renderNow();
      })
    );
  });

  // 代码块「复制」与图片 chip「复制链接」：预览容器上事件委托，单监听服务全部块
  let copiedBtn = null;
  function restoreCopiedLabel() {
    if (copiedBtn) {
      copiedBtn.textContent = copiedBtn.dataset.mvLabel || "复制";
      copiedBtn = null;
    }
    if (copiedTimer) {
      window.clearTimeout(copiedTimer);
      copiedTimer = 0;
    }
  }
  disposers.push(
    dom.on(preview, "click", (event) => {
      const btn = event.target instanceof Element ? event.target.closest("[data-mv-code-copy], [data-mv-copy-url]") : null;
      if (!btn) return;
      const payload =
        btn.dataset.mvCodeCopy !== undefined ? codeBlocks[Number(btn.dataset.mvCodeCopy)] : btn.dataset.mvCopyUrl;
      if (typeof payload !== "string") return;
      clipboard.copyText(payload).then((ok) => {
        if (!ok) return;
        restoreCopiedLabel();
        if (!btn.dataset.mvLabel) btn.dataset.mvLabel = btn.textContent;
        btn.textContent = "已复制";
        copiedBtn = btn;
        copiedTimer = window.setTimeout(() => {
          btn.textContent = btn.dataset.mvLabel || "复制";
          copiedBtn = null;
          copiedTimer = 0;
        }, COPIED_RESET_MS);
      });
    })
  );

  // 分隔条拖拽（Pointer Events；比例仅会话内保留）
  let dragging = false;
  let dragStartY = 0;
  let dragStartHeight = 0;
  function applyEditorHeight() {
    editorSection.style.flex = "none";
    editorSection.style.height = `${editorHeightPx}px`;
  }
  disposers.push(
    dom.on(divider, "pointerdown", (event) => {
      dragging = true;
      dragStartY = event.clientY;
      dragStartHeight = editorSection.getBoundingClientRect().height;
      if (!editorHeightPx) editorHeightPx = dragStartHeight;
      divider.setPointerCapture(event.pointerId);
    }),
    dom.on(divider, "pointermove", (event) => {
      if (!dragging) return;
      const delta = event.clientY - dragStartY;
      const wrapHeight = wrap.getBoundingClientRect().height;
      const next = Math.min(Math.max(dragStartHeight + delta, 120), Math.max(wrapHeight - 200, 120));
      editorHeightPx = next;
      applyEditorHeight();
    }),
    dom.on(divider, "pointerup", () => {
      dragging = false;
    }),
    // 键盘等价路径：↑ / ↓ 微调
    dom.on(divider, "keydown", (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      if (!editorHeightPx) editorHeightPx = editorSection.getBoundingClientRect().height;
      editorHeightPx = Math.max(120, editorHeightPx + (event.key === "ArrowUp" ? -24 : 24));
      applyEditorHeight();
    })
  );

  // 快捷键：焦点在本工具面板内才响应（§9.3 第 2 条——并排 / 多实例时互不串扰）
  disposers.push(
    dom.on(document, "keydown", (event) => {
      if (!root.contains(event.target)) return;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.shiftKey && event.key.toLowerCase() === "v") {
        event.preventDefault();
        pasteAndRender();
        return;
      }
      if (mod && !event.shiftKey && event.key === "Enter") {
        event.preventDefault();
        renderNow();
      } else if (mod && event.altKey && event.key.toLowerCase() === COLLAPSE_SHORTCUT.key) {
        event.preventDefault();
        applyViewMode(config.viewMode === "preview" ? "split" : "preview");
      }
    })
  );

  /* ── 初始化：恢复会话草稿 → 首次渲染 → 应用视图模式 ─────── */

  const restored = draft.loadDraft(TOOL_ID, serial, "input");
  if (restored.text) editorInput.value = restored.text;
  updateEditorStats();
  renderNow();
  applyViewMode(config.viewMode);

  /* ── 清理函数（§9.3：注销全部监听与定时器）──────────────── */

  return function dispose() {
    if (renderTimer) window.clearTimeout(renderTimer);
    if (copiedTimer) window.clearTimeout(copiedTimer);
    if (noticeTimer) window.clearTimeout(noticeTimer);
    disposers.forEach((off) => {
      try {
        off();
      } catch {
        /* 忽略重复解绑 */
      }
    });
    disposers.length = 0;
  };
}
