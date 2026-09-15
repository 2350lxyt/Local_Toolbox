/**
 * 工具独立页 → 标签工作台的重定向引导
 * ------------------------------------------------------------------
 * 目的：统一工具入口体验 —— 脚本可用时跳到 `index.html#/<工具 id>`，由标签工作台打开该工具
 * （docs/DESIGN.md §2.5 / §9.1）。
 *
 * 约定：
 *   1. 本脚本是无脚本兜底入口的一部分：脚本不可用时工具独立页必须仍然完整可读，
 *      因此**禁止**改成 `<meta http-equiv="refresh">`。
 *   2. 放在 `</body>` 之前（晚于 `body[data-tool]`，早于 `type="module"` 的 `shell.js`），
 *      此时 `document.body` 已可用。
 *   3. 置 `window.__toolboxRedirecting = true`，外壳据此跳过独立页渲染，避免跳转前的闪烁。
 *   4. 只用相对路径解析：兼容根路径部署与子路径部署（§2.4）。
 */
(function redirectToolPageToTabs() {
  const toolId = document.body ? document.body.dataset.tool : "";
  if (!toolId) return;

  try {
    const script = document.currentScript;
    const base = script && script.src ? script.src : window.location.href;
    const target = new URL("../../index.html", base);
    target.hash = `/${encodeURIComponent(toolId)}`;
    window.__toolboxRedirecting = true;
    window.location.replace(target.href);
  } catch (error) {
    // 重定向失败时不做任何标记，独立页按原有方式继续渲染
    window.__toolboxRedirecting = false;
  }
})();
