/**
 * 《文本对比》核心算法
 * ==================================================================
 * 附加纯函数模块（docs/DESIGN.md §9.6、§15.3）：**无 DOM、无副作用、无依赖**，
 * 只导出常量与纯函数，可在 Node 中直接 import 断言。
 *
 * 算法要点：
 *   1. 行归一化（按对比选项）后经 Map 映射为**整数 id 序列**，后续全是整数比较；
 *   2. 先剥离公共前后缀（O(n)），再用 **Myers 贪心**求最短编辑脚本；
 *      trace 会随编辑距离 D 增长（O(D²)），因此设 `MAX_DIFFS` 上限，
 *      超限即**降级为整块替换**并回报 `degraded`（绝不无界计算、绝不 O(N×M) DP 表）；
 *   3. 相邻的删除块与新增块**按顺序配对**成「修改行」，只有配对行才做行内词级细化；
 *   4. 词级细化把行切成 token 序列后复用同一套差分。
 */

/* ────────────────────────────────────────────────────────────────
 * 常量与参数
 * ──────────────────────────────────────────────────────────────── */

/** 全部选项的默认值（§15.2；任何行为差异都必须由这些字段表达，R7） */
export const DEFAULT_CONFIG = Object.freeze({
  view: "auto",
  context: "all",
  softWrap: false,
  fontSize: 14,
  language: "text",
  inlineHighlight: true,
  syncScroll: true,
  ignoreCase: false,
  ignoreTrailingSpace: false,
  ignoreAllSpace: false,
  ignoreBlankLines: false,
  ignoreLineEnding: true,
  searchCaseSensitive: false,
  searchWholeWord: false,
});

export const VIEW_VALUES = Object.freeze(["auto", "side", "unified"]);
/** 上下文行数档位：'all' 为可编辑态，其余为只读折叠视图 */
export const CONTEXT_VALUES = Object.freeze(["all", 10, 3, 1, 0]);

export const FONT_SIZE_MIN = 10;
export const FONT_SIZE_MAX = 24;
export const FONT_SIZE_DEFAULT = 14;

/** 单侧行数上限：超过即降级为粗粒度对比 */
export const MAX_LINES = 20000;
/** Myers 编辑距离上限（同时是差异块数阈值）与内存保护 */
export const MAX_DIFFS = 2000;
/** 行内词级细化的行长上限（字符） */
export const MAX_INLINE_LINE_LEN = 2000;
/** 超过此字符数关闭代码高亮（§13.6 同风格） */
export const MAX_HIGHLIGHT_CHARS = 200000;
/** 折叠视图单次渲染行数上限 */
export const MAX_FOLD_RENDER_ROWS = 3000;
/** `view='auto'` 时并排视图所需的最小可用宽度（px） */
export const AUTO_VIEW_MIN_WIDTH = 900;

const EOL_RE = /\r\n|\r|\n/g;

/* ────────────────────────────────────────────────────────────────
 * 选项归一化
 * ──────────────────────────────────────────────────────────────── */

const bool = (value, fallback) => (typeof value === "boolean" ? value : fallback);

/** 选项归一化：非法值一律回退默认值 */
export function normalizeConfig(partial) {
  const input = partial && typeof partial === "object" ? partial : {};
  const context = CONTEXT_VALUES.includes(input.context) ? input.context : DEFAULT_CONFIG.context;
  const size = Math.trunc(Number(input.fontSize));

  return {
    view: VIEW_VALUES.includes(input.view) ? input.view : DEFAULT_CONFIG.view,
    context,
    softWrap: bool(input.softWrap, DEFAULT_CONFIG.softWrap),
    fontSize:
      Number.isFinite(size) && size >= FONT_SIZE_MIN && size <= FONT_SIZE_MAX ? size : FONT_SIZE_DEFAULT,
    language: typeof input.language === "string" && input.language ? input.language : DEFAULT_CONFIG.language,
    inlineHighlight: bool(input.inlineHighlight, DEFAULT_CONFIG.inlineHighlight),
    syncScroll: bool(input.syncScroll, DEFAULT_CONFIG.syncScroll),
    ignoreCase: bool(input.ignoreCase, DEFAULT_CONFIG.ignoreCase),
    ignoreTrailingSpace: bool(input.ignoreTrailingSpace, DEFAULT_CONFIG.ignoreTrailingSpace),
    ignoreAllSpace: bool(input.ignoreAllSpace, DEFAULT_CONFIG.ignoreAllSpace),
    ignoreBlankLines: bool(input.ignoreBlankLines, DEFAULT_CONFIG.ignoreBlankLines),
    ignoreLineEnding: bool(input.ignoreLineEnding, DEFAULT_CONFIG.ignoreLineEnding),
    searchCaseSensitive: bool(input.searchCaseSensitive, DEFAULT_CONFIG.searchCaseSensitive),
    searchWholeWord: bool(input.searchWholeWord, DEFAULT_CONFIG.searchWholeWord),
  };
}

/** 选项相等比较（用于「是否需要写回存储」） */
export function configEquals(a, b) {
  const left = normalizeConfig(a);
  const right = normalizeConfig(b);
  return Object.keys(DEFAULT_CONFIG).every((key) => left[key] === right[key]);
}

/* ────────────────────────────────────────────────────────────────
 * 文本切分与归一化
 * ──────────────────────────────────────────────────────────────── */

/**
 * 切分为行，并保留每行的行尾符（`ignoreLineEnding=false` 时行尾符参与判定）。
 * 「a\nb\n」→ 2 行（末尾换行符不额外产生空行）；「a\nb」→ 2 行。
 * @param {string} text
 * @returns {{ lines: Array<{ text: string, eol: string }>, hasTrailingNewline: boolean }}
 */
export function splitText(text) {
  const source = typeof text === "string" ? text : "";
  if (source === "") return { lines: [], hasTrailingNewline: false };

  const lines = [];
  let lastIndex = 0;
  EOL_RE.lastIndex = 0;

  let match = EOL_RE.exec(source);
  while (match) {
    lines.push({ text: source.slice(lastIndex, match.index), eol: match[0] });
    lastIndex = match.index + match[0].length;
    match = EOL_RE.exec(source);
  }

  const hasTrailingNewline = lastIndex >= source.length;
  if (!hasTrailingNewline) lines.push({ text: source.slice(lastIndex), eol: "" });

  return { lines, hasTrailingNewline };
}

/** 该行是否为空行（忽略所有空白后为空） */
export function isBlankLine(line) {
  return !line || line.text.trim() === "";
}

/**
 * 按对比选项归一化一行，得到**用于判定相同/不同**的字符串（不改写原文）。
 * @param {{ text: string, eol: string }} line
 */
export function normalizeLine(line, options) {
  if (!line) return "";
  let value = line.text;

  if (options.ignoreAllSpace) value = value.replace(/\s+/g, "");
  else if (options.ignoreTrailingSpace) value = value.trim();

  if (options.ignoreCase) value = value.toLowerCase();
  // 关闭「忽略行尾符」时，行尾符参与判定（CRLF 与 LF 视为不同）
  if (!options.ignoreLineEnding) value += line.eol === "\r\n" ? "\r\n" : line.eol === "\r" ? "\r" : "\n";

  return value;
}

/**
 * 创建**跨两侧共享**的行字典。
 * 必须共享：两侧各自建字典会让「右侧第 2 行」与「左侧第 2 行」拿到同一个 id 而被误判为相同。
 * @returns {{ map: Map<string, number>, dict: string[] }}
 */
export function createDictionary() {
  return { map: new Map(), dict: [] };
}

/**
 * 把行序列映射为整数 id 序列（相同归一化内容 → 同一 id）。
 * `ignoreBlankLines` 时所有空行共用哨兵 id `-1`（空行与空行视为相同，不制造差异）。
 * @param {Array<{text:string,eol:string}>} lines
 * @param {object} options 归一化后的选项
 * @param {{ map: Map<string, number>, dict: string[] }} shared 两侧共享的字典
 * @returns {{ ids: number[], dict: string[] }}
 */
export function hashLines(lines, options, shared) {
  const store = shared && shared.map instanceof Map ? shared : createDictionary();
  const ids = [];
  const useBlankSentinel = Boolean(options.ignoreBlankLines);

  for (let i = 0; i < lines.length; i += 1) {
    if (useBlankSentinel && isBlankLine(lines[i])) {
      ids.push(-1);
      continue;
    }

    const key = normalizeLine(lines[i], options);
    let id = store.map.get(key);
    if (id === undefined) {
      id = store.dict.length;
      store.dict.push(key);
      store.map.set(key, id);
    }
    ids.push(id);
  }

  return { ids, dict: store.dict };
}

/* ────────────────────────────────────────────────────────────────
 * Myers 差分（带 trace 的贪心实现 + 编辑距离上限）
 * ──────────────────────────────────────────────────────────────── */

/**
 * 求两个整数序列的最短编辑脚本。
 * @returns {{ ok: boolean, ops?: Array<{ type: 'equal'|'delete'|'insert', a?: number, b?: number }> }}
 *   `ok === false` 表示编辑距离超过 `max`，调用方需降级。
 */
export function myersDiff(a, b, max) {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(Number.isFinite(max) ? max : MAX_DIFFS, n + m);

  if (n === 0 && m === 0) return { ok: true, ops: [] };
  if (n === 0) return { ok: true, ops: b.map((_, index) => ({ type: "insert", b: index })) };
  if (m === 0) return { ok: true, ops: a.map((_, index) => ({ type: "delete", a: index })) };

  const size = 2 * limit + 1;
  const offset = limit;
  const v = new Int32Array(size);
  const trace = [];

  let found = -1;

  for (let d = 0; d <= limit; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;

      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }

      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }

  if (found < 0) return { ok: false };

  // 回溯编辑脚本
  const ops = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const prev = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1])) prevK = k + 1;
    else prevK = k - 1;

    const prevX = prev[offset + prevK];
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      ops.push({ type: "equal", a: x, b: y });
    }

    if (d > 0) {
      if (x === prevX) {
        y -= 1;
        ops.push({ type: "insert", b: y });
      } else {
        x -= 1;
        ops.push({ type: "delete", a: x });
      }
    }
  }

  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    ops.push({ type: "equal", a: x, b: y });
  }

  ops.reverse();
  return { ok: true, ops };
}

/* ────────────────────────────────────────────────────────────────
 * 行级差分
 * ──────────────────────────────────────────────────────────────── */

/** 把「删除块 + 新增块」按顺序配对为「修改行」 */
function pairRegions(ops) {
  const rows = [];
  let index = 0;

  while (index < ops.length) {
    const op = ops[index];

    if (op.type === "equal") {
      rows.push({ kind: "same", left: op.a, right: op.b });
      index += 1;
      continue;
    }

    // 收集连续的删除与新增
    const deletes = [];
    const inserts = [];
    while (index < ops.length && ops[index].type !== "equal") {
      if (ops[index].type === "delete") deletes.push(ops[index].a);
      else inserts.push(ops[index].b);
      index += 1;
    }

    const pairs = Math.min(deletes.length, inserts.length);
    for (let i = 0; i < pairs; i += 1) rows.push({ kind: "modify", left: deletes[i], right: inserts[i] });
    for (let i = pairs; i < deletes.length; i += 1) rows.push({ kind: "delete", left: deletes[i], right: null });
    for (let i = pairs; i < inserts.length; i += 1) rows.push({ kind: "insert", left: null, right: inserts[i] });
  }

  return rows;
}

/**
 * 行级差分：返回**逐行对齐**的左右行数组、统计与差异块。
 * @param {string} leftText
 * @param {string} rightText
 * @param {object} [options] 归一化后的选项（内部会再 normalize 一次）
 */
export function diffLines(leftText, rightText, options) {
  const opts = normalizeConfig(options);
  const left = splitText(leftText);
  const right = splitText(rightText);
  // 两侧必须共享同一份行字典，否则跨侧 id 会冲突（见 hashLines 注释）
  const shared = createDictionary();
  const leftHash = hashLines(left.lines, opts, shared);
  const rightHash = hashLines(right.lines, opts, shared);

  const overLimit = left.lines.length > MAX_LINES || right.lines.length > MAX_LINES;
  let ops;
  let degraded = false;
  let reason = "";

  if (overLimit) {
    degraded = true;
    reason = `行数超过上限（${MAX_LINES} 行），已降级为整块替换对比`;
    ops = [
      ...left.lines.map((_, i) => ({ type: "delete", a: i })),
      ...right.lines.map((_, i) => ({ type: "insert", b: i })),
    ];
  } else {
    // 先剥离公共前后缀，缩短 Myers 的输入（O(n)，对所有输入都有益）
    const prefix = [];
    let head = 0;
    while (head < leftHash.ids.length && head < rightHash.ids.length && leftHash.ids[head] === rightHash.ids[head]) {
      prefix.push({ type: "equal", a: head, b: head });
      head += 1;
    }
    let tail = 0;
    while (
      tail < leftHash.ids.length - head &&
      tail < rightHash.ids.length - head &&
      leftHash.ids[leftHash.ids.length - 1 - tail] === rightHash.ids[rightHash.ids.length - 1 - tail]
    ) {
      tail += 1;
    }

    const middleA = leftHash.ids.slice(head, leftHash.ids.length - tail);
    const middleB = rightHash.ids.slice(head, rightHash.ids.length - tail);
    const result = myersDiff(middleA, middleB, MAX_DIFFS);

    if (!result.ok) {
      degraded = true;
      reason = `差异过多（编辑距离超过 ${MAX_DIFFS}），已降级为整块替换对比`;
      ops = [
        ...left.lines.map((_, i) => ({ type: "delete", a: i })),
        ...right.lines.map((_, i) => ({ type: "insert", b: i })),
      ];
    } else {
      ops = prefix.concat(
        result.ops.map((op) => {
          if (op.type === "equal") return { type: "equal", a: op.a + head, b: op.b + head };
          if (op.type === "delete") return { type: "delete", a: op.a + head };
          return { type: "insert", b: op.b + head };
        })
      );
      // 尾部公共行
      for (let i = 0; i < tail; i += 1) {
        ops.push({
          type: "equal",
          a: leftHash.ids.length - tail + i,
          b: rightHash.ids.length - tail + i,
        });
      }
    }
  }

  let rawRows = pairRegions(ops);

  // 忽略空行：空行自身不制造差异（等价于「空行与空行视为相同」）
  if (opts.ignoreBlankLines) {
    rawRows = rawRows.map((row) => {
      if (row.kind === "same") return row;
      const line = row.kind === "delete" ? left.lines[row.left] : right.lines[row.right];
      return isBlankLine(line) ? { ...row, kind: "same" } : row;
    });
  }

  const rows = rawRows.map((row) => ({
    kind: row.kind,
    left: row.left,
    right: row.right,
    leftNo: row.left === null ? null : row.left + 1,
    rightNo: row.right === null ? null : row.right + 1,
  }));

  // 统计
  const stats = { insert: 0, delete: 0, modify: 0, same: 0 };
  rows.forEach((row) => {
    stats[row.kind] += 1;
  });
  const base = Math.max(left.lines.length, right.lines.length);
  stats.base = base;
  stats.similarity = base === 0 ? 1 : stats.same / base;

  // 差异块（连续的非 same 行为一块）
  const blocks = [];
  let current = null;
  rows.forEach((row, rowIndex) => {
    if (row.kind === "same") {
      current = null;
      return;
    }
    if (!current) {
      current = { index: blocks.length, rowStart: rowIndex, rowEnd: rowIndex, kind: row.kind };
      blocks.push(current);
    } else {
      current.rowEnd = rowIndex;
      if (row.kind === "modify") current.kind = "modify";
    }
  });

  return { rows, stats, blocks, degraded, reason };
}

/* ────────────────────────────────────────────────────────────────
 * 行内词级差分
 * ──────────────────────────────────────────────────────────────── */

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/;
const WORD_RE = /[A-Za-z0-9_]/;

/**
 * 把一行切成 token（词 / CJK 单字 / 空白 / 单个标点），供行内细化使用。
 * @returns {string[]}
 */
export function tokenizeWords(line) {
  const text = typeof line === "string" ? line : "";
  const tokens = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (/\s/.test(char)) {
      let end = index;
      while (end < text.length && /\s/.test(text[end])) end += 1;
      tokens.push(text.slice(index, end));
      index = end;
      continue;
    }

    if (CJK_RE.test(char)) {
      tokens.push(char);
      index += 1;
      continue;
    }

    if (WORD_RE.test(char)) {
      let end = index;
      while (end < text.length && WORD_RE.test(text[end])) end += 1;
      tokens.push(text.slice(index, end));
      index = end;
      continue;
    }

    tokens.push(char);
    index += 1;
  }

  return tokens;
}

/**
 * 行内词级差分：只对配对的「修改行」调用。
 * @returns {{ left: Array<{text:string, changed:boolean}>, right: Array<{text:string, changed:boolean}> }|null}
 *   行过长或差异过大时返回 `null`（调用方退化为整行高亮）。
 */
export function diffWords(leftLine, rightLine, options) {
  const opts = normalizeConfig(options);
  const leftText = typeof leftLine === "string" ? leftLine : "";
  const rightText = typeof rightLine === "string" ? rightLine : "";

  if (!opts.inlineHighlight) return null;
  if (leftText.length > MAX_INLINE_LINE_LEN || rightText.length > MAX_INLINE_LINE_LEN) return null;

  const leftTokens = tokenizeWords(leftText);
  const rightTokens = tokenizeWords(rightText);
  if (leftTokens.length === 0 && rightTokens.length === 0) return null;

  const keyOf = (token) => (opts.ignoreCase ? token.toLowerCase() : token);
  const leftIds = [];
  const rightIds = [];
  const dict = new Map();
  const idOf = (token) => {
    const key = keyOf(token);
    let id = dict.get(key);
    if (id === undefined) {
      id = dict.size;
      dict.set(key, id);
    }
    return id;
  };
  leftTokens.forEach((token) => leftIds.push(idOf(token)));
  rightTokens.forEach((token) => rightIds.push(idOf(token)));

  const result = myersDiff(leftIds, rightIds, Math.max(200, Math.min(MAX_DIFFS, leftIds.length + rightIds.length)));
  if (!result.ok) return null;

  const left = leftTokens.map((text) => ({ text, changed: false }));
  const right = rightTokens.map((text) => ({ text, changed: false }));

  result.ops.forEach((op) => {
    if (op.type === "equal") return;
    if (op.type === "delete") left[op.a].changed = true;
    if (op.type === "insert") right[op.b].changed = true;
  });

  return { left, right };
}

/* ────────────────────────────────────────────────────────────────
 * 折叠区间
 * ──────────────────────────────────────────────────────────────── */

/**
 * 按上下文行数把相同行合并为折叠段。
 * @param {Array} rows `diffLines` 的行数组
 * @param {'all'|number} context
 * @param {Set<string>} [expandedKeys] 已展开的折叠段 key 集合
 * @returns {Array<{type:'rows',rows:Array}|{type:'gap',count:number,key:string,rows:Array}>}
 */
export function foldRows(rows, context, expandedKeys) {
  const list = Array.isArray(rows) ? rows : [];
  if (context === "all") return [{ type: "rows", rows: list }];

  const keep = Math.max(0, Math.trunc(Number(context) || 0));
  const expanded = expandedKeys instanceof Set ? expandedKeys : new Set();
  const segments = [];
  let index = 0;

  while (index < list.length) {
    const row = list[index];

    if (row.kind !== "same") {
      let end = index;
      while (end < list.length && list[end].kind !== "same") end += 1;
      segments.push({ type: "rows", rows: list.slice(index, end) });
      index = end;
      continue;
    }

    // 连续的相同行
    let end = index;
    while (end < list.length && list[end].kind === "same") end += 1;
    const run = list.slice(index, end);

    if (run.length <= keep * 2 + 1) {
      segments.push({ type: "rows", rows: run });
    } else {
      const head = run.slice(0, keep);
      const tail = run.slice(run.length - keep);
      const middle = run.slice(keep, run.length - keep);
      const key = `gap-${index}-${middle.length}`;

      if (head.length) segments.push({ type: "rows", rows: head });
      if (expanded.has(key)) segments.push({ type: "rows", rows: middle });
      else segments.push({ type: "gap", count: middle.length, key, rows: middle });
      if (tail.length) segments.push({ type: "rows", rows: tail });
    }

    index = end;
  }

  return segments;
}

/* ────────────────────────────────────────────────────────────────
 * 搜索
 * ──────────────────────────────────────────────────────────────── */

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 在文本中查找全部命中（按行返回行列位置，供滚动定位）。
 * @param {string} text
 * @param {string} query
 * @param {{ searchCaseSensitive?: boolean, searchWholeWord?: boolean }} [options]
 * @returns {Array<{ line: number, start: number, end: number, index: number }>}
 */
export function findMatches(text, query, options) {
  const opts = normalizeConfig(options);
  const source = typeof text === "string" ? text : "";
  const needle = typeof query === "string" ? query : "";
  if (needle === "" || source === "") return [];

  const flags = opts.searchCaseSensitive ? "g" : "gi";
  const word = opts.searchWholeWord ? "\\b" : "";
  let regex;
  try {
    regex = new RegExp(`${word}${escapeRegExp(needle)}${word}`, flags);
  } catch (error) {
    return [];
  }

  const { lines } = splitText(source);
  const matches = [];
  let length = 0;

  lines.forEach((line, lineIndex) => {
    regex.lastIndex = 0;
    let hit = regex.exec(line.text);
    while (hit) {
      matches.push({ line: lineIndex, start: hit.index, end: hit.index + hit[0].length, index: length });
      length += 1;
      if (hit[0].length === 0) break;
      hit = regex.exec(line.text);
    }
  });

  return matches;
}

/** 文本的行数与字符数（统计与降级判定共用） */
export function textMetrics(text) {
  const source = typeof text === "string" ? text : "";
  const { lines } = splitText(source);
  return { lines: lines.length, chars: source.length };
}
