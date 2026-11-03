/**
 * 通用右键菜单（v1.7.35）
 *
 * 为什么单独做一个：工具内部需要「在指针位置弹出、带键盘导航、点外面就关」的菜单。
 * 标签栏的 `.tabmenu` 与它视觉同源（同一套令牌与几何），但那个菜单带着
 * 「批量关闭的待确认态 + `aria-expanded` 绑在触发按钮上」的耦合，抽取它会带来
 * 一整片回归面；因此这里只做**内容无关**的通用件，样式在 tool.css 里与 `.tabmenu` 对齐。
 *
 * 全局单例：同一时刻只允许一个菜单，打开新的会先关掉旧的（模块级 `current`）。
 *
 * 用法：
 *   import * as menu from "./utils/menu.js";
 *   menu.open({
 *     x: event.clientX, y: event.clientY,
 *     label: "变量表操作",
 *     items: [
 *       { label: "复制选区", shortcut: "Ctrl+C", onSelect: fn },
 *       { separator: true },
 *       { label: "复制整表（含表头）", onSelect: fn },
 *       { label: "不可用的项", disabled: true, onSelect: fn },
 *       // 勾选项（v1.7.38）：`checked` 一旦给出就是 menuitemcheckbox。
 *       // `keepOpen: true` 表示「这是选项不是动作」—— 点完不关菜单，
 *       // `onSelect` 返回新 items 则原地重渲染，焦点停在这一项上。
 *       { label: "包含结果列", checked: true, keepOpen: true, onSelect: () => nextItems },
 *     ],
 *   });
 */

import { el } from "./dom.js";

/** @type {HTMLElement|null} */
let deck = null;
/** 关闭后把焦点还给谁 */
let returnFocus = null;
/** 当前菜单是否打开 */
let opened = false;
/** 关闭时的回调（调用方用来同步 `aria-expanded`、复位自身的待确认态） */
let onCloseHook = null;
/** 最近一次打开的位置（`update()` 原地重渲染时要沿用，v1.7.38） */
let lastPosition = { x: 0, y: 0 };

const VIEWPORT_MARGIN = 8;

function ensureDeck() {
  if (deck) return deck;
  deck = el("div", { className: "menu", attrs: { role: "menu", hidden: true, tabindex: "-1" } });
  document.body.appendChild(deck);

  deck.addEventListener("keydown", onKeydown);
  // 捕获阶段关闭：避免点到的元素先响应再被菜单盖住的行为不一致
  document.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("resize", close);
  window.addEventListener("scroll", close, true);

  return deck;
}

function onKeydown(event) {
  const items = focusableItems();
  if (!items.length) return;
  const index = items.indexOf(document.activeElement);

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const next = index < 0 ? (delta > 0 ? 0 : items.length - 1) : (index + delta + items.length) % items.length;
    items[next].focus();
    return;
  }
  if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    (event.key === "Home" ? items[0] : items[items.length - 1]).focus();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close({ restoreFocus: true });
    return;
  }
  if (event.key === "Tab") {
    // 菜单内不循环 Tab：直接关闭并放行，让焦点正常流动
    close();
  }
}

function onPointerDown(event) {
  if (!opened) return;
  if (!(event.target instanceof Element)) return;
  if (deck && deck.contains(event.target)) return;
  close();
}

function focusableItems() {
  if (!deck) return [];
  return Array.from(deck.querySelectorAll('.menu__item:not([aria-disabled="true"])'));
}

function buildItem(spec) {
  if (spec.separator) return el("div", { className: "menu__sep", attrs: { role: "separator" } });

  // `checked` 一旦出现就是勾选项（v1.7.38）：语义是 menuitemcheckbox。
  // 勾选标记位对**每一项**都渲染（非勾选项留空），由 `.menu--check` 统一缩进 ——
  // 只给勾选项加位的话，勾选那一行的文字会比其它项右移一格，看上去像没对齐。
  const isCheckbox = typeof spec.checked === "boolean";
  const node = el("button", {
    className: `menu__item${spec.danger ? " menu__item--danger" : ""}${isCheckbox ? " menu__item--check" : ""}`,
    attrs: {
      type: "button",
      role: isCheckbox ? "menuitemcheckbox" : "menuitem",
      tabindex: "-1",
      "aria-disabled": spec.disabled ? "true" : null,
      "aria-checked": isCheckbox ? String(spec.checked) : null,
    },
  });
  node.appendChild(
    el("span", {
      className: "menu__check",
      text: isCheckbox && spec.checked ? "✓" : "",
      attrs: { "aria-hidden": "true" },
    })
  );
  node.appendChild(el("span", { className: "menu__label", text: spec.label }));
  if (spec.shortcut) node.appendChild(el("span", { className: "menu__shortcut", text: spec.shortcut }));

  node.addEventListener("click", (event) => {
    event.preventDefault();
    if (spec.disabled) return;
    // 选项类项不关菜单：勾完还要接着点上面的复制项，关掉等于逼用户重开一次
    if (spec.keepOpen) {
      const next = typeof spec.onSelect === "function" ? spec.onSelect(event) : null;
      if (Array.isArray(next)) update(next);
      return;
    }
    close();
    if (typeof spec.onSelect === "function") spec.onSelect(event);
  });

  return node;
}

/** 按视口夹回后落位（`open` 与 `update` 共用，v1.7.38） */
function place(x, y) {
  const node = deck;
  if (!node) return;
  const rect = node.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - VIEWPORT_MARGIN;
  const maxY = window.innerHeight - rect.height - VIEWPORT_MARGIN;
  node.style.left = `${Math.round(Math.max(VIEWPORT_MARGIN, Math.min(x, maxX)))}px`;
  node.style.top = `${Math.round(Math.max(VIEWPORT_MARGIN, Math.min(y, maxY)))}px`;
}

/** 渲染一组项；菜单里只要有一个勾选项，就给整份菜单开启「勾选列缩进」模式 */
function render(items) {
  if (!deck) return;
  deck.replaceChildren(...items.map(buildItem));
  deck.classList.toggle("menu--check", items.some((item) => item && typeof item.checked === "boolean"));
}

/**
 * 在指针位置打开菜单。
 * @param {{x:number,y:number,items:Array,label?:string,onClose?:Function,initialFocus?:'first'|'last'}} options
 */
export function open(options) {
  const {
    x = 0,
    y = 0,
    items = [],
    label,
    onClose: onCloseOption,
    initialFocus = "first",
  } = options || {};
  if (!items.length) return;

  close();
  const node = ensureDeck();
  render(items);
  if (label) node.setAttribute("aria-label", label);
  else node.removeAttribute("aria-label");

  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  opened = true;
  lastPosition = { x, y };
  // 必须在 close() 之后赋值：close() 会把上一个菜单的回调清掉
  onCloseHook = typeof onCloseOption === "function" ? onCloseOption : null;

  // 先显示再量宽高，才能按视口翻转
  node.hidden = false;
  node.style.left = "0px";
  node.style.top = "0px";
  place(x, y);

  const focusables = focusableItems();
  const target = initialFocus === "last" ? focusables[focusables.length - 1] : focusables[0];
  if (target) target.focus();
}

/**
 * 原地重渲染菜单内容（v1.7.38）。
 * 给「勾选项」用：切换后保持菜单位置与焦点项，用户接着点上面的动作项即可。
 * 位置沿用最近一次 `open()` 的坐标，并按新内容的高度重新夹回视口。
 * @param {Array} items
 */
export function update(items) {
  if (!opened || !deck || !Array.isArray(items) || !items.length) return;
  const current = document.activeElement;
  const index = focusableItems().indexOf(current);

  render(items);
  place(lastPosition.x, lastPosition.y);
  const focusables = focusableItems();
  if (!focusables.length) return;
  const target = focusables[index >= 0 ? Math.min(index, focusables.length - 1) : 0];
  if (target) target.focus();
}

/** @param {{restoreFocus?:boolean}} [options] */
export function close(options) {
  if (!opened) return;
  opened = false;
  if (deck) {
    deck.hidden = true;
    deck.replaceChildren();
  }
  const target = (options && options.restoreFocus) ? returnFocus : null;
  returnFocus = null;
  if (target && document.contains(target)) {
    try {
      target.focus();
    } catch (error) {
      /* 目标已不可聚焦，忽略 */
    }
  }
  // 回调最后调用：调用方此时读到的 isOpen() 已是 false
  const hook = onCloseHook;
  onCloseHook = null;
  if (hook) {
    try {
      hook();
    } catch (error) {
      /* 回调异常不得阻断关闭流程 */
    }
  }
}

/** 当前是否有菜单打开（工具内 `Escape` 优先级判定要用） */
export function isOpen() {
  return opened;
}

/** 卸载时调用：移除全局监听，避免多实例残留 */
export function destroy() {
  close();
  if (deck) {
    deck.removeEventListener("keydown", onKeydown);
    if (deck.parentNode) deck.parentNode.removeChild(deck);
    deck = null;
  }
  document.removeEventListener("pointerdown", onPointerDown, true);
  window.removeEventListener("resize", close);
  window.removeEventListener("scroll", close, true);
}
