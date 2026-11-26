/**
 * 《MD 预览》Markdown 解析与安全渲染（附加纯函数模块）
 * ==================================================================
 * 附加纯函数模块（docs/DESIGN.md §9.6、§17）：**无 DOM、无 window、无副作用、永不抛错**。
 * 可脱离 DOM 在 Node 中直接 import 验证。
 *
 * 安全模型（docs/DESIGN.md §17.5）：
 *   - **先转义、后包装**：所有原文片段先经 escapeHtml，再由解析器按语法位置包上
 *     白名单标签；本模块是唯一决定 innerHTML 内容的地方，从不把原文直接注入。
 *   - 链接 href 仅放行 http: / https: / mailto: / #锚点，其余整体降级为纯文本。
 *   - 图片语法**不创建 `<img>`、不发起任何请求（R2）**：渲染为占位 chip + 复制链接按钮。
 *   - 「允许原始 HTML」默认关闭；开启后也仅放行白名单标签与安全属性，其余转义。
 *   - 嵌套（列表 / 引用）超过 maxDepth 拍平为段落并计入 warnings。
 *
 * 代码块语法高亮复用共享能力层 `assets/js/utils/highlight.js`（§9.4），
 * 只消费其 token 输出，着色 span 由本模块用**已转义**文本包装。
 */

import { tokenizeLines, detectLanguage } from "../../assets/js/utils/highlight.js";

/* ────────────────────────────────────────────────────────────────
 * 参数模型（R7：所有行为都是选项，解析完全由参数决定）
 * ──────────────────────────────────────────────────────────────── */

export const DEFAULT_OPTIONS = Object.freeze({
  /** 代码块语法高亮（关闭后代码块为纯文本） */
  syntaxHighlight: true,
  /** 围栏未标注语言时按代码内容自动识别 */
  autoDetectLanguage: true,
  /** 裸 URL 自动成链接 */
  autoLink: true,
  /** 函数名着色（v1.8.3 词法增强：标识符后跟 `(` 染 func 色） */
  funcColoring: true,
  /** 括号着色（v1.8.3 词法增强：()[]{} 染独立 bracket 色） */
  bracketColoring: true,
  /** 允许原始 HTML（仍只放行白名单标签与安全属性） */
  allowRawHtml: false,
  /** 列表 / 引用嵌套深度上限，超过拍平 */
  maxDepth: 16,
  /** 单个代码块着色的字符数上限（超过该块回落纯文本） */
  highlightMaxBlockChars: 20000,
});

/** 合并用户选项（未知键忽略；返回冻结对象） */
export function normalizeOptions(options) {
  const merged = Object.assign({}, DEFAULT_OPTIONS, options || {});
  merged.maxDepth = Math.max(1, Math.min(64, Math.floor(Number(merged.maxDepth) || DEFAULT_OPTIONS.maxDepth)));
  merged.highlightMaxBlockChars = Math.max(
    0,
    Math.floor(Number(merged.highlightMaxBlockChars) || DEFAULT_OPTIONS.highlightMaxBlockChars)
  );
  return Object.freeze(merged);
}

/* ────────────────────────────────────────────────────────────────
 * 基础工具（本模块自含，不依赖 DOM 层的 escapeHtml）
 * ──────────────────────────────────────────────────────────────── */

function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function countCodePoints(text) {
  return Array.from(text).length;
}

/** 统计行数（末行为空字符串不计入，与共享层 countLines 同口径） */
function countTextLines(text) {
  if (text === "") return 0;
  const lines = text.split("\n");
  return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

/** 链接 href 白名单：http(s) / mailto / 页内锚点；其余返回 null（降级为纯文本） */
function safeHref(url) {
  const value = String(url || "").trim();
  if (/^https?:\/\//i.test(value)) return value;
  if (/^mailto:[^\s]+$/i.test(value)) return value;
  if (/^#[^\s]*$/.test(value)) return value;
  return null;
}

/* 围栏语言别名 → 共享分词器语言 id（不在此表的回落纯文本） */
const LANG_ALIASES = Object.freeze({
  sql: "sql",
  json: "json",
  xml: "xml",
  html: "xml",
  htm: "xml",
  svg: "xml",
  js: "javascript",
  javascript: "javascript",
  jsx: "javascript",
  ts: "typescript",
  typescript: "typescript",
  tsx: "typescript",
  css: "css",
  java: "java",
  python: "python",
  py: "python",
  shell: "shell",
  bash: "shell",
  sh: "shell",
  zsh: "shell",
  yaml: "yaml",
  yml: "yaml",
  markdown: "markdown",
  md: "markdown",
});

function resolveLanguage(rawInfo, blockText, options) {
  const info = String(rawInfo || "").trim().toLowerCase().split(/\s+/)[0] || "";
  if (info) return LANG_ALIASES[info] || "text";
  if (options.autoDetectLanguage) return detectLanguage(blockText, 40);
  return "text";
}

/* ────────────────────────────────────────────────────────────────
 * 行内渲染（先转义后包装；规则按优先级依次尝试）
 * ──────────────────────────────────────────────────────────────── */

/** 原始 HTML 白名单标签（allowRawHtml 开启时也只放行这些） */
const HTML_TAG_WHITELIST = Object.freeze(
  new Set([
    "p", "br", "hr", "strong", "em", "b", "i", "u", "s", "del", "ins", "code", "pre",
    "blockquote", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6",
    "table", "thead", "tbody", "tr", "th", "td", "span", "a", "div", "sup", "sub", "small", "kbd", "mark",
  ])
);

const RE_ESCAPE = /\\([\\`*_{}[\]()#+\-.!~|>])/y;
const RE_IMG = /!\[([^\]]*)\]\(\s*([^)\s]*)(?:\s+"[^"]*")?\s*\)/y;
const RE_LINK = /\[([^\]]*)\]\(\s*([^)\s]*)(?:\s+"[^"]*")?\s*\)/y;
const RE_AUTOLINK = /https?:\/\/[^\s<>")\]}]+/y;
const RE_STRONG_STAR = /\*\*(?=\S)([\s\S]*?\S)\*\*/y;
const RE_STRONG_UNDER = /__(?=\S)([\s\S]*?\S)__/y;
const RE_STRIKE = /~~(?=\S)([\s\S]*?\S)~~/y;
const RE_EM_STAR = /\*(?=\S)([^*\s](?:[^*]*[^*\s])?)\*/y;
const RE_EM_UNDER = /(?<![\w\\])_(?=\S)([^_\s](?:[^_]*[^_\s])?)_(?!\w)/y;
const RE_HTML_TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/y;

/** 处理白名单标签的属性（只放行安全集合），返回重建后的开标签或 null（= 转义原文） */
function sanitizeOpenTag(name, attrText) {
  const safeName = name.toLowerCase();
  const attrs = [];

  if (safeName === "a") {
    const hrefMatch = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrText);
    const href = hrefMatch ? safeHref(hrefMatch[2] ?? hrefMatch[3] ?? hrefMatch[4] ?? "") : null;
    if (!href) return null; // 协议不安全 → 整体转义为纯文本
    attrs.push(`href="${escapeHtml(href)}"`, 'target="_blank"', 'rel="noopener noreferrer"');
  }
  if (safeName === "td" || safeName === "th") {
    const spanRe = /\b(col|row)span\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
    let m;
    while ((m = spanRe.exec(attrText))) {
      const n = parseInt(m[3] ?? m[4] ?? m[5] ?? "", 10);
      if (Number.isFinite(n) && n >= 1 && n <= 1000) attrs.push(`${m[1]}span="${n}"`);
    }
  }
  return `<${safeName}${attrs.length ? " " + attrs.join(" ") : ""}>`;
}

/** 一段原文的行内渲染。noLink：链接内文本不再解析嵌套链接 */
function renderInline(src, options, noLink) {
  let out = "";
  let plain = "";
  let pos = 0;
  const text = String(src === null || src === undefined ? "" : src);

  const flushPlain = () => {
    if (plain) {
      out += escapeHtml(plain);
      plain = "";
    }
  };

  while (pos < text.length) {
    let matched = false;

    // 1. 反斜杠转义
    RE_ESCAPE.lastIndex = pos;
    const esc = RE_ESCAPE.exec(text);
    if (esc) {
      plain += esc[1];
      pos = RE_ESCAPE.lastIndex;
      continue;
    }

    // 2. 行内代码（手动寻找等长反引号闭合，优先级高于其它一切行内语法）
    if (text[pos] === "`") {
      let run = 1;
      while (pos + run < text.length && text[pos + run] === "`") run += 1;
      const closer = text.indexOf("`".repeat(run), pos + run);
      if (closer !== -1) {
        let content = text.slice(pos + run, closer);
        // CommonMark：内容两侧各恰有一个空格且内容非全空格时，各剥掉一个
        if (content.length >= 2 && content.startsWith(" ") && content.endsWith(" ") && content.trim() !== "") {
          content = content.slice(1, -1);
        }
        flushPlain();
        out += `<code class="mv-codespan">${escapeHtml(content)}</code>`;
        pos = closer + run;
        continue;
      }
    }

    // 3. 图片占位（R2：不创建 <img>，渲染为 chip + 复制按钮）
    RE_IMG.lastIndex = pos;
    const img = RE_IMG.exec(text);
    if (img) {
      const end = RE_IMG.lastIndex; // 先固化终点：下游拼接中不得再读共享正则的 lastIndex
      flushPlain();
      const alt = img[1] || "";
      const url = img[2] || "";
      out +=
        `<span class="mv-imgchip"><span class="mv-imgchip__tag">图片</span>` +
        (alt ? `<span class="mv-imgchip__alt">${escapeHtml(alt)}</span>` : "") +
        `<button type="button" class="mv-imgchip__copy" data-mv-copy-url="${escapeHtml(url)}">复制链接</button></span>`;
      pos = end;
      continue;
    }

    // 4. 链接（协议白名单；内层文本不再解析嵌套链接）
    if (!noLink) {
      RE_LINK.lastIndex = pos;
      const link = RE_LINK.exec(text);
      if (link) {
        const end = RE_LINK.lastIndex; // 先固化终点：内层递归会污染共享正则的 lastIndex
        flushPlain();
        const href = safeHref(link[2]);
        const inner = renderInline(link[1], options, true);
        out += href
          ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
          : `<span class="mv-deadlink">${escapeHtml(`[${link[1]}](${link[2]})`)}</span>`;
        pos = end;
        continue;
      }
    }

    // 5. 裸 URL 自动链接（剥掉尾部标点）
    if (options.autoLink && !noLink) {
      RE_AUTOLINK.lastIndex = pos;
      const auto = RE_AUTOLINK.exec(text);
      if (auto) {
        let url = auto[0];
        let trailing = "";
        while (/[.,;:!?)\]}》」』」、。]$/.test(url)) {
          trailing = url.slice(-1) + trailing;
          url = url.slice(0, -1);
        }
        flushPlain();
        out += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`;
        plain += trailing;
        pos = RE_AUTOLINK.lastIndex;
        continue;
      }
    }

    // 6-8. 强调 / 删除线（内层递归渲染）
    const emphasisRules = [
      [RE_STRONG_STAR, "strong"],
      [RE_STRONG_UNDER, "strong"],
      [RE_STRIKE, "del"],
      [RE_EM_STAR, "em"],
      [RE_EM_UNDER, "em"],
    ];
    for (const [regex, tag] of emphasisRules) {
      regex.lastIndex = pos;
      const hit = regex.exec(text);
      if (hit) {
        const end = regex.lastIndex; // 先固化终点：内层递归会污染共享正则的 lastIndex
        flushPlain();
        out += `<${tag}>${renderInline(hit[1], options, noLink)}</${tag}>`;
        pos = end;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // 9. 原始 HTML（默认关闭；开启后仍只放行白名单）
    if (options.allowRawHtml) {
      RE_HTML_TAG.lastIndex = pos;
      const tag = RE_HTML_TAG.exec(text);
      if (tag) {
        const isClose = tag[1] === "/";
        const name = tag[2];
        if (HTML_TAG_WHITELIST.has(name.toLowerCase())) {
          flushPlain();
          if (isClose) out += `</${name.toLowerCase()}>`;
          else out += sanitizeOpenTag(name, tag[3]) || escapeHtml(tag[0]);
          pos = RE_HTML_TAG.lastIndex;
          continue;
        }
      }
    }

    // 10. 普通字符
    plain += text[pos];
    pos += 1;
  }

  flushPlain();
  return out;
}

/* ────────────────────────────────────────────────────────────────
 * 块级解析（产出自描述的 block 对象，便于单测与 UI 复用）
 * ──────────────────────────────────────────────────────────────── */

const RE_FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*(\S*)\s*$/;
const RE_FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const RE_HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RE_HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const RE_QUOTE = /^ {0,3}>/;
const RE_LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/;
const RE_TASK = /^\[([ xX])\]\s+/;
const RE_TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function isBlank(line) {
  return line.trim() === "";
}

function looksLikeBlockStarter(line) {
  return (
    RE_HEADING.test(line) ||
    RE_FENCE_OPEN.test(line) ||
    RE_HR.test(line) ||
    RE_QUOTE.test(line) ||
    RE_LIST_ITEM.test(line) ||
    (line.includes("|") && !line.trim().startsWith("`"))
  );
}

/** 拆表格行：先把转义竖线保护起来再按 | 切 */
function splitTableRow(line) {
  const protectedText = line.trim().replace(/\\\|/g, "\u0000");
  let cells = protectedText.replace(/^\|/, "").replace(/\|$/, "").split("|");
  cells = cells.map((cell) => cell.trim().replace(/\u0000/g, "|"));
  return cells;
}

/** 解析表格（调用处已确认第 line 行含 | 且第 line+1 行是分隔行） */
function parseTable(lines, start) {
  const header = splitTableRow(lines[start]);
  const alignments = splitTableRow(lines[start + 1]).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    return left && right ? "center" : right ? "right" : left ? "left" : "";
  });

  let i = start + 2;
  const rows = [];
  while (i < lines.length && !isBlank(lines[i]) && lines[i].includes("|")) {
    rows.push(splitTableRow(lines[i]));
    i += 1;
  }
  return { block: { type: "table", header, alignments, rows }, next: i };
}

/**
 * 列表解析：按缩进栈支持嵌套；任务列表 `- [ ]` / `- [x]` 识别为复选项。
 * 返回 { type:"list", ordered, items:[{ html, task, checked, sub: listBlock|null }] }
 */
function parseList(lines, start, options, depth, warnings) {
  const firstMatch = RE_LIST_ITEM.exec(lines[start]);
  const ordered = /\d/.test(firstMatch[2][0]);
  const items = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      // 空行后若仍是同层列表项则继续（宽松列表），否则结束
      if (i + 1 < lines.length && RE_LIST_ITEM.test(lines[i + 1]) && indentOf(lines[i + 1]) <= indentOf(lines[start]) + 1) {
        i += 1;
        continue;
      }
      break;
    }
    const match = RE_LIST_ITEM.exec(line);
    if (!match) break;

    const contentIndent = match[1].length + match[2].length + match[3].length;
    const isNested = match[1].length >= indentOf(lines[start]) + 2 && items.length > 0;

    if (isNested && depth < options.maxDepth) {
      // 归入上一个 item 的子列表：收集到缩进回落为止
      const subLines = [line];
      i += 1;
      while (i < lines.length && !isBlank(lines[i]) && (RE_LIST_ITEM.test(lines[i]) || indentOf(lines[i]) > match[1].length)) {
        subLines.push(lines[i]);
        i += 1;
      }
      const sub = parseList(subLines, 0, options, depth + 1, warnings);
      if (items.length > 0) items[items.length - 1].sub = sub.block;
      continue;
    }

    let content = match[4];
    let task = null;
    const taskMatch = RE_TASK.exec(content);
    if (taskMatch) {
      task = taskMatch[1].toLowerCase() === "x";
      content = content.slice(taskMatch[0].length);
    }

    // 同一项的续行（缩进更深且非新项）：并入该项内容
    let buffer = [content];
    i += 1;
    while (i < lines.length && !isBlank(lines[i]) && !RE_LIST_ITEM.test(lines[i]) && indentOf(lines[i]) >= contentIndent - 1 && !looksLikeBlockStarter(lines[i])) {
      buffer.push(lines[i].trim());
      i += 1;
    }
    items.push({ text: buffer.join("\n"), task, checked: task === true, sub: null });

    if (depth >= options.maxDepth) {
      warnings.push("嵌套层级过深，超出部分已按普通文本展示。");
      break;
    }
  }
  return { block: { type: "list", ordered, items }, next: i };
}

function indentOf(line) {
  const match = /^[ \t]*/.exec(line);
  let width = 0;
  for (const ch of match[0]) width += ch === "\t" ? 4 : 1;
  return width;
}

/** 主解析器：行数组 → block 数组。永不抛错；深度超限拍平并告警 */
export function parseBlocks(lines, options, depth = 0, warnings = []) {
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) {
      i += 1;
      continue;
    }

    // 围栏代码块
    const fence = RE_FENCE_OPEN.exec(line);
    if (fence) {
      const fenceChar = fence[1][0];
      const fenceLen = fence[1].length;
      const info = fence[2] || "";
      const body = [];
      i += 1;
      let closed = false;
      while (i < lines.length) {
        const closeMatch = RE_FENCE_CLOSE.exec(lines[i]);
        if (closeMatch && closeMatch[1][0] === fenceChar && closeMatch[1].length >= fenceLen) {
          closed = true;
          i += 1;
          break;
        }
        body.push(lines[i]);
        i += 1;
      }
      if (!closed) warnings.push("代码围栏未闭合，其后内容已全部按代码块展示。");
      blocks.push({ type: "code", info, raw: body.join("\n") });
      continue;
    }

    // ATX 标题
    const heading = RE_HEADING.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      i += 1;
      continue;
    }

    // 分隔线
    if (RE_HR.test(line)) {
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }

    // 引用块（递归；深度超限拍平为段落）
    if (RE_QUOTE.test(line)) {
      if (depth >= options.maxDepth) {
        warnings.push("引用嵌套过深，超出部分已按普通文本展示。");
        const para = [];
        while (i < lines.length && !isBlank(lines[i])) {
          para.push(lines[i].replace(/^ {0,3}> ?/, ""));
          i += 1;
        }
        blocks.push({ type: "paragraph", lines: para });
        continue;
      }
      const inner = [];
      while (i < lines.length && !isBlank(lines[i]) && RE_QUOTE.test(lines[i])) {
        inner.push(lines[i].replace(/^ {0,3}> ?/, ""));
        i += 1;
      }
      blocks.push({ type: "quote", children: parseBlocks(inner, options, depth + 1, warnings) });
      continue;
    }

    // 表格（当前行含 | 且下一行是分隔行）
    if (line.includes("|") && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1]) && splitTableRow(line).some((c) => c !== "")) {
      const table = parseTable(lines, i);
      blocks.push(table.block);
      i = table.next;
      continue;
    }

    // 列表
    const listItem = RE_LIST_ITEM.exec(line);
    if (listItem && listItem[1].length <= 3) {
      const list = parseList(lines, i, options, depth, warnings);
      blocks.push(list.block);
      i = list.next;
      continue;
    }

    // 段落（累积到空行或下一个块级起始）
    const para = [line];
    i += 1;
    while (i < lines.length && !isBlank(lines[i]) && !looksLikeBlockStarter(lines[i])) {
      para.push(lines[i]);
      i += 1;
    }
    blocks.push({ type: "paragraph", lines: para });
  }

  return blocks;
}

/** 统计块数（列表 / 引用整体各算 1 块，与其顶层语义一致） */
export function countBlocks(blocks) {
  return blocks.length;
}

/* ────────────────────────────────────────────────────────────────
 * 块级渲染（block → HTML 字符串）
 * ──────────────────────────────────────────────────────────────── */

/** 彩虹括号的色相数量（v1.8.4，§13.5 同款）：括号按嵌套深度取色，深度 1…6 循环 */
const BRACKET_HUE_COUNT = 6;

function renderCodeBlock(block, options, index) {
  const raw = block.raw;
  const langId = resolveLanguage(block.info, raw, options);
  const canHighlight = options.syntaxHighlight && langId !== "text" && raw.length <= options.highlightMaxBlockChars;

  let codeHtml;
  if (canHighlight) {
    const lines = raw.split("\n");
    const tokens = tokenizeLines(lines, langId, {
      func: Boolean(options.funcColoring),
      bracket: Boolean(options.bracketColoring),
    });
    // v1.8.4 彩虹括号：bracket token 带 depth → mv-bk-N（((depth-1) % 6) + 1，§13.5 同款）
    codeHtml = lines
      .map((line, lineIndex) => {
        const row = tokens[lineIndex] || [];
        if (row.length === 0) return "";
        return row
          .map((token) => {
            const rainbow =
              token.type === "bracket" && Number.isInteger(token.depth)
                ? ` mv-bk-${((token.depth - 1) % BRACKET_HUE_COUNT) + 1}`
                : "";
            return `<span class="mv-tok-${token.type}${rainbow}">${escapeHtml(token.text)}</span>`;
          })
          .join("");
      })
      .join("\n");
  } else {
    codeHtml = escapeHtml(raw);
  }

  const langLabel = String(block.info || "").trim() || (langId !== "text" ? langId : "");
  return (
    `<figure class="mv-code" data-mv-code-index="${index}">` +
    `<figcaption class="mv-code__bar">` +
    `<span class="mv-code__lang">${escapeHtml(langLabel || "代码")}</span>` +
    `<button type="button" class="mv-code__copy" data-mv-code-copy="${index}">复制</button>` +
    `</figcaption>` +
    `<pre class="mv-code__pre"><code>${codeHtml}</code></pre>` +
    `</figure>`
  );
}

function renderBlocksToHtml(blocks, options, state) {
  let html = "";
  blocks.forEach((block) => {
    switch (block.type) {
      case "heading":
        html += `<h${block.level}>${renderInline(block.text, options, false)}</h${block.level}>`;
        break;
      case "paragraph":
        html += `<p>${block.lines.map((line) => renderInline(line, options, false)).join("<br>")}</p>`;
        break;
      case "hr":
        html += "<hr>";
        break;
      case "code":
        html += renderCodeBlock(block, options, state.codeIndex++);
        state.codeBlocks.push(block.raw);
        break;
      case "quote":
        html += `<blockquote>${renderBlocksToHtml(block.children, options, state)}</blockquote>`;
        break;
      case "list": {
        const tag = block.ordered ? "ol" : "ul";
        const itemsHtml = block.items
          .map((item) => {
            const sub = item.sub ? renderListBlock(item.sub, options, state) : "";
            if (item.task !== null) {
              const checked = item.checked ? " checked" : "";
              return `<li class="mv-task"><input type="checkbox" disabled${checked}><span>${renderInline(item.text, options, false)}</span>${sub}</li>`;
            }
            return `<li><span>${renderInline(item.text, options, false)}</span>${sub}</li>`;
          })
          .join("");
        html += `<${tag}>${itemsHtml}</${tag}>`;
        break;
      }
      case "table": {
        const alignAttr = (index) => (block.alignments[index] ? ` style="text-align:${block.alignments[index]}"` : "");
        const head = block.header
          .map((cell, index) => `<th${alignAttr(index)}>${renderInline(cell, options, false)}</th>`)
          .join("");
        const body = block.rows
          .map(
            (row) =>
              `<tr>${block.header
                .map((_, index) => `<td${alignAttr(index)}>${renderInline(row[index] ?? "", options, false)}</td>`)
                .join("")}</tr>`
          )
          .join("");
        html += `<div class="mv-tablewrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
        break;
      }
      default:
        break;
    }
  });
  return html;
}

function renderListBlock(block, options, state) {
  const tag = block.ordered ? "ol" : "ul";
  const itemsHtml = block.items
    .map((item) => {
      const sub = item.sub ? renderListBlock(item.sub, options, state) : "";
      if (item.task !== null) {
        return `<li class="mv-task"><input type="checkbox" disabled${item.checked ? " checked" : ""}><span>${renderInline(item.text, options, false)}</span>${sub}</li>`;
      }
      return `<li><span>${renderInline(item.text, options, false)}</span>${sub}</li>`;
    })
    .join("");
  return `<${tag}>${itemsHtml}</${tag}>`;
}

/* ────────────────────────────────────────────────────────────────
 * 对外主入口
 * ──────────────────────────────────────────────────────────────── */

/**
 * Markdown 文本 → 安全 HTML。
 * @param {string} text 原始 Markdown（内部先统一 CRLF 为 LF）
 * @param {object} [options] 见 DEFAULT_OPTIONS
 * @returns {{ html: string, stats: { chars: number, lines: number, blocks: number },
 *            warnings: string[], codeBlocks: string[] }}
 *   codeBlocks 与 HTML 中 data-mv-code-copy 索引一一对应，供「复制」按钮取原始文本。
 */
export function renderMarkdown(text, options) {
  const opts = normalizeOptions(options);
  const source = String(text === null || text === undefined ? "" : text).replace(/\r\n?/g, "\n");

  const warnings = [];
  let html = "";
  let stats = { chars: countCodePoints(source), lines: countTextLines(source), blocks: 0 };
  let codeBlocks = [];

  try {
    const blocks = parseBlocks(source.split("\n"), opts, 0, warnings);
    const state = { codeIndex: 0, codeBlocks };
    html = renderBlocksToHtml(blocks, opts, state);
    stats = {
      chars: countCodePoints(source),
      lines: countTextLines(source),
      blocks: countBlocks(blocks),
    };
  } catch (error) {
    // 防御性兜底：解析器自身异常时降级为转义后的纯文本，绝不抛出（§9.3 关键失败给可读提示）
    warnings.push("本次渲染遇到意外问题，已按纯文本展示。");
    html = `<p>${escapeHtml(source)}</p>`;
    codeBlocks = [];
    stats = { chars: countCodePoints(source), lines: countTextLines(source), blocks: source.trim() ? 1 : 0 };
  }

  return { html, stats, warnings, codeBlocks };
}
