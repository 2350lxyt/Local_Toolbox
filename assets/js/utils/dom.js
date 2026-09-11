/**
 * 公共 DOM 辅助（纯函数 / 无全局副作用）
 * ------------------------------------------------------------------
 * 供外壳与各工具模块复用。工具之间不共享状态，只共享这里的通用能力。
 */

/** 查询单个元素 */
export function qs(selector, scope = document) {
  return scope ? scope.querySelector(selector) : null;
}

/** 查询多个元素（返回真数组） */
export function qsa(selector, scope = document) {
  return scope ? Array.from(scope.querySelectorAll(selector)) : [];
}

/**
 * 创建元素。
 * @param {string} tag
 * @param {Object} [options]
 * @param {string} [options.className]
 * @param {string} [options.text]     纯文本内容（自动转义）
 * @param {string} [options.html]     受信任的 HTML 片段（仅用于本地内联 SVG）
 * @param {Object} [options.attrs]    属性键值对
 * @param {Object} [options.dataset]  data-* 键值对
 * @param {Object} [options.style]    内联样式键值对
 * @param {Node|Node[]} [options.children]
 * @returns {HTMLElement}
 */
export function el(tag, options = {}) {
  const node = document.createElement(tag);
  const { className, text, html, attrs, dataset, style, children } = options;

  if (className) node.className = className;
  if (typeof text === "string") node.textContent = text;
  if (typeof html === "string") node.innerHTML = html;
  if (attrs) setAttrs(node, attrs);
  if (dataset) {
    Object.keys(dataset).forEach((key) => {
      node.dataset[key] = dataset[key];
    });
  }
  if (style) {
    Object.keys(style).forEach((key) => {
      node.style[key] = style[key];
    });
  }
  append(node, children);

  return node;
}

/** 批量设置属性（值为 null / undefined 时跳过） */
export function setAttrs(node, attrs = {}) {
  Object.keys(attrs).forEach((key) => {
    const value = attrs[key];
    if (value === null || value === undefined || value === false) return;
    node.setAttribute(key, value === true ? "" : String(value));
  });
  return node;
}

/** 追加子节点（支持单个、数组、字符串） */
export function append(parent, children) {
  if (children === null || children === undefined) return parent;
  const list = Array.isArray(children) ? children : [children];
  list.forEach((child) => {
    if (child === null || child === undefined) return;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  });
  return parent;
}

/** 清空子节点 */
export function clear(node) {
  if (!node) return node;
  node.replaceChildren();
  return node;
}

/** 绑定事件，返回解绑函数 */
export function on(target, type, handler, options) {
  if (!target) return () => {};
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

/** 事件委托绑定，返回解绑函数 */
export function delegate(scope, type, selector, handler) {
  if (!scope) return () => {};
  const listener = (event) => {
    const matched = event.target instanceof Element ? event.target.closest(selector) : null;
    if (matched && scope.contains(matched)) handler(event, matched);
  };
  scope.addEventListener(type, listener);
  return () => scope.removeEventListener(type, listener);
}

/** HTML 转义（用于拼接模板字符串时防止标记注入） */
export function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 下一帧执行，返回取消函数 */
export function nextFrame(callback) {
  const id = window.requestAnimationFrame(callback);
  return () => window.cancelAnimationFrame(id);
}
