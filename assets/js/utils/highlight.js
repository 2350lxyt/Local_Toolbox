/**
 * 代码高亮语言注册表与分词器（共享能力层）
 * ==================================================================
 * 纯函数模块（docs/DESIGN.md §9.4 能力层）：**无 DOM、无副作用、无外部依赖**。
 * v1.8.0 起从 tools/text-diff/ 上移至 assets/js/utils/ —— 《文本对比》与
 * 《MD 预览》两个工具共用，符合 §9.6「跨工具可复用能力必须上移共享层」。
 *
 * 设计原则（R7：预设只是一组参数取值，不得有专属逻辑分支）：
 *   **一种语言 = 一组配置**。新增语言只需在 LANGUAGES 里加一条配置，
 *   不改分词器、不改渲染层。分词器是通用的单遍扫描器，只做词法着色，不做语法分析。
 *
 * token 类型：comment / string / number / keyword / literal / func / bracket / punct / plain
 * v1.8.3 词法增强（第三参 colorize 开启时）："func" = 标识符后跟 `(`（启发式，无语义分析）；
 * "bracket" = ()[]{} 拆出独立色，且 **token 携带 `depth`（嵌套深度，从 1 起）**——
 * 彩虹括号的取色依据（《SQL 格式化》§13.5 同款逻辑）：开括号记「进入后的层级」，闭括号记
 * 「它配对的那个开括号的层级」⇒ 同一对括号必然同深度同色；深度跨行携带（同一次 tokenizeLines 调用内）。
 * 不传 colorize = 旧行为（《文本对比》零回归）。
 */

/** 分词状态下需要跨行携带的字段（块注释、Markdown 代码围栏） */
const INITIAL_STATE = Object.freeze({ block: null, fence: false, fenceToken: "" });

/* ────────────────────────────────────────────────────────────────
 * 语言注册表
 * ──────────────────────────────────────────────────────────────── */

const SQL_KEYWORDS =
  "select from where group by having order limit offset insert into values update set delete create alter drop table view index " +
  "join left right inner outer full cross on as and or not null is in between like exists distinct union all case when then else end " +
  "primary key foreign references default constraint unique check cascade begin commit rollback transaction with recursive over partition " +
  "returning using natural asc desc if exists truncate explain analyze grant revoke";

const JS_KEYWORDS =
  "const let var function return if else for while do switch case break continue new class extends super this typeof instanceof in of " +
  "try catch finally throw async await yield import export from default delete void null undefined true false static get set";

const JAVA_KEYWORDS =
  "public private protected class interface enum extends implements new return if else for while do switch case break continue try catch finally throw " +
  "throws import package static final void int long short byte char boolean float double String var this super instanceof null true false " +
  "abstract synchronized volatile transient native assert record sealed permits";

const PY_KEYWORDS =
  "def class return if elif else for while break continue import from as try except finally raise with as lambda pass global nonlocal " +
  "yield assert del in is not and or None True False async await match case self";

const SHELL_KEYWORDS = "if then else elif fi for while do done case esac function return export local readonly source echo exit set unset trap";

const CSS_KEYWORDS = "important from to media supports keyframes import charset font-face";

/** 数字字面量（十进制/浮点/科学计数/十六进制） */
const NUMBER_RE = /^(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/;

/** 词字符（含 `$`、`@`、`#` 以覆盖 shell / css / yaml 的常见写法） */
const WORD_RE = /^[A-Za-z0-9_$@-]/;

export const LANGUAGES = Object.freeze({
  text: Object.freeze({ id: "text", label: "纯文本", strings: [], keywords: "", literals: "" }),

  sql: Object.freeze({
    id: "sql",
    label: "SQL",
    lineComment: ["--"],
    blockComment: [["/*", "*/"]],
    strings: [["'", "'"], ['"', '"']],
    keywords: SQL_KEYWORDS,
    caseInsensitive: true,
  }),

  json: Object.freeze({
    id: "json",
    label: "JSON",
    strings: [['"', '"']],
    literals: "true false null",
    stringsOnly: true,
  }),

  xml: Object.freeze({
    id: "xml",
    label: "XML / HTML",
    blockComment: [["<!--", "-->"]],
    strings: [['"', '"'], ["'", "'"]],
    markupTag: true,
  }),

  javascript: Object.freeze({
    id: "javascript",
    label: "JavaScript",
    lineComment: ["//"],
    blockComment: [["/*", "*/"]],
    strings: [["'", "'"], ['"', '"'], ["`", "`"]],
    keywords: JS_KEYWORDS,
    literals: "true false null undefined NaN Infinity",
  }),

  typescript: Object.freeze({
    id: "typescript",
    label: "TypeScript",
    lineComment: ["//"],
    blockComment: [["/*", "*/"]],
    strings: [["'", "'"], ['"', '"'], ["`", "`"]],
    keywords: `${JS_KEYWORDS} interface type enum implements declare namespace readonly abstract public private protected satisfies keyof infer`,
    literals: "true false null undefined never unknown any string number boolean void object",
  }),

  css: Object.freeze({
    id: "css",
    label: "CSS",
    blockComment: [["/*", "*/"]],
    strings: [['"', '"'], ["'", "'"]],
    keywords: CSS_KEYWORDS,
    literals: "#",
    lineRules: [{ pattern: /(^|\s)([.#][A-Za-z0-9_-]+)/g, group: 2, type: "keyword" }],
  }),

  java: Object.freeze({
    id: "java",
    label: "Java",
    lineComment: ["//"],
    blockComment: [["/*", "*/"]],
    strings: [['"', '"'], ["'", "'"]],
    keywords: JAVA_KEYWORDS,
    literals: "true false null",
    annotations: true,
  }),

  python: Object.freeze({
    id: "python",
    label: "Python",
    lineComment: ["#"],
    strings: [['"""', '"""'], ["'''", "'''"], ['"', '"'], ["'", "'"]],
    keywords: PY_KEYWORDS,
    literals: "self None True False",
    annotations: true,
  }),

  shell: Object.freeze({
    id: "shell",
    label: "Shell",
    lineComment: ["#"],
    strings: [['"', '"'], ["'", "'"]],
    keywords: SHELL_KEYWORDS,
    variables: true,
  }),

  yaml: Object.freeze({
    id: "yaml",
    label: "YAML",
    lineComment: ["#"],
    strings: [['"', '"'], ["'", "'"]],
    literals: "true false null yes no on off ~",
    lineRules: [{ pattern: /^(\s*)([A-Za-z0-9_.-]+)(\s*:)/g, group: 2, type: "keyword" }],
  }),

  markdown: Object.freeze({
    id: "markdown",
    label: "Markdown",
    fenceToken: "```",
    lineRules: [
      { pattern: /^#{1,6}\s.*$/g, type: "keyword" },
      { pattern: /`[^`\n]*`/g, type: "string" },
      { pattern: /\*\*[^*\n]+\*\*/g, type: "literal" },
      { pattern: /^\s*[-*+]\s/g, type: "punct" },
    ],
  }),
});

/** 供界面选择框渲染（纯文本与自动识别固定在前） */
export const LANGUAGE_LIST = Object.freeze([
  { id: "text", label: "纯文本" },
  { id: "auto", label: "自动识别" },
  ...Object.keys(LANGUAGES)
    .filter((id) => id !== "text")
    .map((id) => ({ id, label: LANGUAGES[id].label })),
]);

function keywordSet(language) {
  if (!language.keywords) return new Set();
  const words = String(language.keywords).trim().split(/\s+/);
  return new Set(language.caseInsensitive ? words.map((w) => w.toLowerCase()) : words);
}

/* ────────────────────────────────────────────────────────────────
 * 分词器（通用单遍扫描）
 * ──────────────────────────────────────────────────────────────── */

/** 收集行内规则的匹配区间（这些区间优先于通用扫描） */
function collectRuleSpans(line, language) {
  const spans = [];
  const rules = language.lineRules || [];

  rules.forEach((rule) => {
    const regex = new RegExp(rule.pattern.source, rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`);
    let hit = regex.exec(line);
    while (hit) {
      const text = rule.group ? hit[rule.group] : hit[0];
      if (text) {
        const offset = rule.group ? hit[0].indexOf(text) : 0;
        spans.push({ start: hit.index + offset, end: hit.index + offset + text.length, type: rule.type });
      }
      if (hit[0].length === 0) break;
      hit = regex.exec(line);
    }
  });

  return spans.sort((a, b) => a.start - b.start);
}

function spanAt(spans, index) {
  for (let i = 0; i < spans.length; i += 1) {
    if (index >= spans[i].start && index < spans[i].end) return spans[i];
  }
  return null;
}

/**
 * 对多行文本分词（跨行携带块注释 / 代码围栏状态）。
 * @param {string[]} lines
 * @param {string} languageId
 * @param {{ func?: boolean, bracket?: boolean }} [colorize] v1.8.3 词法增强开关；
 *   func = 标识符后跟 `(` 染 "func"；bracket = ()[]{} 染 "bracket"。**不传 = 旧行为**。
 * @returns {Array<Array<{ text: string, type: string }>>} 与输入等长的 token 行数组
 */
export function tokenizeLines(lines, languageId, colorize) {
  const funcColoring = Boolean(colorize && colorize.func);
  const bracketColoring = Boolean(colorize && colorize.bracket);
  const language = LANGUAGES[languageId] || LANGUAGES.text;
  const identifiers = keywordSet(language);
  const literals = language.literals
    ? new Set(String(language.literals).trim().split(/\s+/).map((w) => (language.caseInsensitive ? w.toLowerCase() : w)))
    : new Set();
  const state = { ...INITIAL_STATE };
  let bracketDepth = 0; // v1.8.4 彩虹括号：嵌套深度（跨行携带，字符串/注释内的括号不进入此路径）
  const output = [];

  (Array.isArray(lines) ? lines : []).forEach((rawLine) => {
    const line = typeof rawLine === "string" ? rawLine : "";
    const tokens = [];
    const push = (text, type, depth) => {
      if (!text) return;
      const last = tokens[tokens.length - 1];
      if (last && last.type === type && last.depth === depth) last.text += text;
      else tokens.push(depth === undefined ? { text, type } : { text, type, depth });
    };

    // Markdown 代码围栏：围栏之间的整行按字符串着色
    if (language.fenceToken) {
      if (state.fence) {
        if (line.trim().startsWith(language.fenceToken)) {
          state.fence = false;
          push(line, "punct");
        } else {
          push(line, "string");
        }
        output.push(tokens);
        return;
      }
      if (line.trim().startsWith(language.fenceToken)) {
        state.fence = true;
        push(line, "punct");
        output.push(tokens);
        return;
      }
    }

    const spans = collectRuleSpans(line, language);
    let index = 0;

    while (index < line.length) {
      // 1) 块注释续行
      if (state.block) {
        const end = line.indexOf(state.block, index);
        if (end < 0) {
          push(line.slice(index), "comment");
          index = line.length;
          continue;
        }
        push(line.slice(index, end + state.block.length), "comment");
        index = end + state.block.length;
        state.block = null;
        continue;
      }

      const span = spanAt(spans, index);
      if (span) {
        push(line.slice(index, span.end), span.type);
        index = span.end;
        continue;
      }

      // 2) 行注释
      const lineComment = (language.lineComment || []).find((token) => line.startsWith(token, index));
      if (lineComment) {
        push(line.slice(index), "comment");
        index = line.length;
        continue;
      }

      // 3) 块注释起始
      const blockStart = (language.blockComment || []).find((pair) => line.startsWith(pair[0], index));
      if (blockStart) {
        const end = line.indexOf(blockStart[1], index + blockStart[0].length);
        if (end < 0) {
          push(line.slice(index), "comment");
          state.block = blockStart[1];
          index = line.length;
        } else {
          push(line.slice(index, end + blockStart[1].length), "comment");
          index = end + blockStart[1].length;
        }
        continue;
      }

      // 4) 字符串
      const quote = (language.strings || []).find((pair) => line.startsWith(pair[0], index));
      if (quote) {
        const [open, close] = quote;
        let cursor = index + open.length;
        let closed = false;
        while (cursor < line.length) {
          if (line[cursor] === "\\" && open !== "'") {
            cursor += 2;
            continue;
          }
          if (line.startsWith(close, cursor)) {
            cursor += close.length;
            closed = true;
            break;
          }
          cursor += 1;
        }
        push(line.slice(index, closed ? cursor : line.length), "string");
        index = closed ? cursor : line.length;
        continue;
      }

      // 5) 标记语言的标签（<tag ...>）
      if (language.markupTag && line[index] === "<") {
        const end = line.indexOf(">", index);
        const stop = end < 0 ? line.length : end + 1;
        push(line.slice(index, stop), "keyword");
        index = stop;
        continue;
      }

      // 6) 注解 / 变量
      if ((language.annotations || language.variables) && (line[index] === "@" || (language.variables && line[index] === "$"))) {
        let cursor = index + 1;
        while (cursor < line.length && WORD_RE.test(line[cursor])) cursor += 1;
        if (cursor > index + 1) {
          push(line.slice(index, cursor), "literal");
          index = cursor;
          continue;
        }
      }

      const char = line[index];

      // 7) 数字
      if (/\d/.test(char)) {
        const hit = NUMBER_RE.exec(line.slice(index));
        if (hit) {
          push(hit[0], "number");
          index += hit[0].length;
          continue;
        }
      }

      // 8) 标识符 → 关键字 / 字面量 / 函数调用（启发式）/ 普通
      if (/[A-Za-z_]/.test(char)) {
        let cursor = index;
        while (cursor < line.length && WORD_RE.test(line[cursor])) cursor += 1;
        const word = line.slice(index, cursor);
        const probe = language.caseInsensitive ? word.toLowerCase() : word;
        if (identifiers.has(probe)) push(word, "keyword");
        else if (literals.has(probe)) push(word, "literal");
        else if (funcColoring && isCallAhead(line, cursor)) push(word, "func");
        else push(word, "plain");
        index = cursor;
        continue;
      }

      // 9) 标点 / 空白（v1.8.3：括号可拆独立色，便于与一般标点区分）
      if (/\s/.test(char)) {
        let cursor = index;
        while (cursor < line.length && /\s/.test(line[cursor])) cursor += 1;
        push(line.slice(index, cursor), "plain");
        index = cursor;
        continue;
      }

      if (bracketColoring && (char === "(" || char === ")" || char === "[" || char === "]" || char === "{" || char === "}")) {
        const isOpen = char === "(" || char === "[" || char === "{";
        if (isOpen) {
          bracketDepth += 1;
          push(char, "bracket", bracketDepth);
        } else {
          // 闭括号记「配对开括号的层级」⇒ 同一对括号同深度同色；未配对按当前层级取色
          push(char, "bracket", Math.max(1, bracketDepth));
          bracketDepth = Math.max(0, bracketDepth - 1);
        }
        index += 1;
        continue;
      }

      push(char, "punct");
      index += 1;
    }

    output.push(tokens);
  });

  return output;
}

/**
 * 启发式：标识符结束后越过空白，下一个字符是否为 `(`（函数调用样式的近似判定）。
 * 不做语义分析；关键字 / 字面量在调用方已优先判定，不会进入本函数。
 */
function isCallAhead(line, cursor) {
  let i = cursor;
  while (i < line.length && /\s/.test(line[i])) i += 1;
  return line[i] === "(";
}

/**
 * 单行分词（无跨行状态，便于独立断言与简单场景）。
 * @returns {Array<{ text: string, type: string }>}
 */
export function tokenizeLine(line, languageId, colorize) {
  const [tokens] = tokenizeLines([line], languageId, colorize);
  return tokens || [];
}

/**
 * 把「语法着色」与「行内词级差异段」合并成最终渲染片段：
 * 语法只决定**前景色**（type），词级差异只决定**是否加底纹**（changed）。
 * 两套切分按边界取交集，保证互不覆盖。
 *
 * 界面应按**整侧**先调用 `tokenizeLines`（保留跨行块注释状态）再逐行调用本函数，
 * 避免逐行分词丢失跨行状态。
 * @param {Array<{ text: string, type: string }>} syntax 该行的语法 token
 * @param {Array<{ text: string, changed: boolean }>|null} wordSegments `diffWords` 的单侧结果
 * @returns {Array<{ text: string, type: string, changed: boolean }>}
 */
export function mergeSegments(syntax, wordSegments) {
  const tokens = Array.isArray(syntax) ? syntax : [];
  if (!wordSegments || wordSegments.length === 0) {
    return tokens.map((token) => ({ text: token.text, type: token.type, changed: false }));
  }

  const merged = [];
  let syntaxIndex = 0;
  let syntaxOffset = 0;
  let wordIndex = 0;
  let wordOffset = 0;
  const text = tokens.map((t) => t.text).join("");

  const push = (chunk, type, changed) => {
    if (!chunk) return;
    const last = merged[merged.length - 1];
    if (last && last.type === type && last.changed === changed) last.text += chunk;
    else merged.push({ text: chunk, type, changed });
  };

  let position = 0;
  while (position < text.length) {
    // 当前语法片段与词级片段的边界（取较小者切分）
    const syntaxToken = tokens[syntaxIndex];
    if (!syntaxToken) break;
    if (syntaxOffset >= syntaxToken.text.length) {
      syntaxIndex += 1;
      syntaxOffset = 0;
      continue;
    }

    const wordSegment = wordSegments[wordIndex];
    if (!wordSegment) {
      // 词级片段已用完：剩余全部按语法着色
      push(syntaxToken.text.slice(syntaxOffset), syntaxToken.type, false);
      syntaxOffset = syntaxToken.text.length;
      continue;
    }
    if (wordOffset >= wordSegment.text.length) {
      wordIndex += 1;
      wordOffset = 0;
      continue;
    }

    const take = Math.min(
      syntaxToken.text.length - syntaxOffset,
      wordSegment.text.length - wordOffset
    );

    push(syntaxToken.text.slice(syntaxOffset, syntaxOffset + take), syntaxToken.type, Boolean(wordSegment.changed));
    syntaxOffset += take;
    wordOffset += take;
    position += take;
  }

  return merged;
}

/**
 * 单行便捷入口：先单行分词再合并（**不携带跨行注释状态**，整侧渲染请用 `tokenizeLines` + `mergeSegments`）。
 * @returns {Array<{ text: string, type: string, changed: boolean }>}
 */
export function highlightLine(line, languageId, wordSegments) {
  return mergeSegments(tokenizeLine(line, languageId), wordSegments);
}

/* ────────────────────────────────────────────────────────────────
 * 自动识别（启发式，结果需在界面显示，不得静默）
 * ──────────────────────────────────────────────────────────────── */

const DETECT_RULES = [
  { id: "json", test: (head) => /^[\s\r\n]*[[{]/.test(head) && /"\s*:/.test(head) },
  { id: "xml", test: (head) => /<\?xml|<!--|<\/[A-Za-z]|<[A-Za-z][A-Za-z0-9-]*[\s>/]/.test(head) },
  { id: "shell", test: (head) => /^#!.*\b(sh|bash|zsh)\b/.test(head) },
  { id: "sql", test: (head) => /\b(select|insert\s+into|update\s+\w+\s+set|create\s+table|delete\s+from|alter\s+table)\b/i.test(head) },
  { id: "markdown", test: (head) => /^#{1,6}\s/m.test(head) || /```/.test(head) },
  { id: "yaml", test: (head) => /^---/m.test(head) || /^[A-Za-z0-9_.-]+\s*:\s*\S/m.test(head) },
  { id: "css", test: (head) => /[.#][A-Za-z0-9_-]+\s*\{|@media\b|:\s*(var\(|#[0-9a-f]{3,8})/i.test(head) },
  { id: "python", test: (head) => /^\s*(def|class|import|from)\s+\w+/m.test(head) && /:\s*$/m.test(head) },
  { id: "typescript", test: (head) => /\b(interface|type)\s+\w+\s*[={]|\bas\s+\w+|:\s*(string|number|boolean)\b/.test(head) },
  { id: "javascript", test: (head) => /\b(const|let|var|function|=>|class)\b/.test(head) },
  { id: "java", test: (head) => /\b(public|private|protected)\s+(static\s+)?(void|class|final)\b/.test(head) },
];

/**
 * 按内容特征猜测语言（只看前若干行，避免大文件全量扫描）。
 * @returns {string} 语言 id（无法判定时为 'text'）
 */
export function detectLanguage(text, sampleLines) {
  const source = typeof text === "string" ? text : "";
  if (!source.trim()) return "text";
  const limit = Number.isFinite(sampleLines) ? sampleLines : 40;
  const head = source.split(/\r\n|\r|\n/).slice(0, limit).join("\n");

  for (let i = 0; i < DETECT_RULES.length; i += 1) {
    try {
      if (DETECT_RULES[i].test(head)) return DETECT_RULES[i].id;
    } catch (error) {
      /* 单条规则异常不影响其它规则 */
    }
  }
  return "text";
}
