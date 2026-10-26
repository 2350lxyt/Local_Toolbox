/**
 * 《公式计算器》纯函数核心（§16.11）
 * ------------------------------------------------------------------
 * 遵循 §9.6「附加纯函数模块」：**不得**触碰 DOM / `window` / `localStorage`，
 * 顶层只有常量与纯函数，导出对象一律 `Object.freeze`；可脱离浏览器在 Node 中直接断言。
 *
 * 规则以 `docs/DESIGN.md` §16.3（文法与词法）/ §16.4（变量与取值）/
 * §16.5（分步口径）/ §16.6（数值精度）为准：**改代码前先改文档**。
 *
 * 三条硬性规则（最容易写错的地方，改动前请先读 §16.3）：
 *   ① 变量名只由字母（含中文）与下划线组成，**数字不进入变量名**；
 *      紧随名字之后的连续数字（可带 `%`）是**该变量的取值**，不参与乘法。
 *      ⇒ `单价10*数量25` 解析为公式 `单价*数量` + 取值 10 / 25（**不是** `单价*10*数量*25`）。
 *   ② 除上面这一特例，**一律要求显式运算符**，不做任何隐式乘法
 *      （`2(3+4)`、`100 300`、`单价10数量25`、`a1b2` 一律报「缺少运算符」）。
 *   ③ 同名变量被赋予**不同**取值时报错，不猜、不静默取首/末值。
 */

/* ── 常量（附录 B 已登记）────────────────────────────────── */

/** 公式字符数上限：超限报错而非静默截断 */
export const MAX_FORMULA_LEN = 2000;
/** 变量数上限 */
export const MAX_VARIABLES = 40;
/** 分步过程的步骤数上限：超限折叠中间的步骤 */
export const MAX_STEPS = 200;
/** 最多保留的小数位（超出四舍五入并去掉尾随零） */
export const DECIMAL_PLACES = 10;
/** 绝对值超出该区间时改用科学计数法显示 */
export const SCIENTIFIC_HIGH = 1e15;
export const SCIENTIFIC_LOW = 1e-10;
/** 变量配色数量：变量多于该数时按序循环（值需与 `.fc-hue-*` 的类数量一致，见 §16.13） */
export const VAR_HUE_COUNT = 8;
/** 彩虹括号按嵌套深度循环的色数（需与 `.fc-depth-*` 的类数量一致） */
export const BRACKET_HUE_COUNT = 6;

/** 显示层的运算符符号：屏幕上用 `×` / `÷` 更好读（§16.5）；输入层仍同时接受 `*` / `/` 与 `×` / `÷` */
const OPERATOR_SYMBOLS = Object.freeze({ "+": "+", "-": "-", "*": "×", "/": "÷" });

/** 分步文案（UI 直接使用，避免各处硬编码字符串） */
export const STEP_LABELS = Object.freeze({
  substitute: "变量替换",
  percent: "百分号折算",
  negate: "一元负号",
  group: "括号优先",
  ungroup: "去括号",
  multiply: "先乘除",
  add: "后加减",
  omitted: "省略",
});

/** 错误码（UI 据此区分「待填写」与真正的错误） */
export const ERROR_CODES = Object.freeze({
  empty: "EMPTY",
  tooLong: "TOO_LONG",
  unsupportedChar: "UNSUPPORTED_CHAR",
  syntax: "SYNTAX",
  varConflict: "VAR_CONFLICT",
  tooManyVariables: "TOO_MANY_VARIABLES",
  missingValues: "MISSING_VALUES",
  divZero: "DIV_ZERO",
  overflow: "OVERFLOW",
  cellInvalid: "CELL_INVALID",
});

/* ── 内部工具 ───────────────────────────────────────────── */

/** 全角逗号（，）刻意不参与全角折叠：它按「不支持的字符」报错，避免被当成千分位逗号而静默吞掉 */
const FULL_WIDTH_COMMA = 0xff0c;
const FULL_WIDTH_SPACE = 0x3000;
const MINUS_SIGN = 0x2212;
const EN_DASH = 0x2013;

const NUMBER_PATTERN = /^(?:\d+(?:\.\d+)?|\.\d+)/;
/**
 * 「变量名之后紧跟的取值」与独立数值**共用同一套数字文法**（v1.7.13 起支持小数）。
 * 原先单独用 /^[0-9]+/ 只认整数：`单价10.5` 会被切成「取值 10」+ 裸数字 `.5`，
 * 于是报「缺少运算符」（§16.3）。直接复用 NUMBER_PATTERN，杜绝两处文法再次分叉。
 */
const TRAILING_NUMBER_PATTERN = NUMBER_PATTERN;
const LETTER_PATTERN = /\p{L}/u;

function fail(code, error, index) {
  const result = { ok: false, code, error };
  if (Number.isInteger(index)) result.index = index;
  return result;
}

/**
 * 公式里的「空白」：空格 / 制表 / 换行。
 * 公式区是多行文本域（§16.9），换行必须与空格**同等对待** ——
 * 既不参与语义，也不能让 `单价\n10` 这类多行写法失效（§16.3「特例不因空白而失效」）。
 */
function isWhitespaceChar(char) {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

/** 变量名允许的字符：字母（含中文）与下划线 —— **不含数字**（§16.3 规则 ①） */
function isNameChar(char) {
  return char === "_" || LETTER_PATTERN.test(char);
}

function isNumericNode(node) {
  return Boolean(node) && node.type === "number";
}

/**
 * 归一化并**记录位置映射**：`map[i]` 是归一化后第 i 个字符在原文中的下标。
 * 有了映射，报错时才能给出「原文第 N 个字符」这种用户能对上号的位置。
 */
function normalizeWithMap(input) {
  const source = String(input ?? "");
  let text = "";
  const map = [];
  let index = 0;

  for (const char of source) {
    const code = char.codePointAt(0);
    let out;
    if (char === ",") {
      // 千分位逗号：按噪声删除（宽容策略；本文法中逗号没有别的含义，故不做分组校验）
      out = "";
    } else if (code === FULL_WIDTH_SPACE) {
      out = " ";
    } else if (code >= 0xff01 && code <= 0xff5e && code !== FULL_WIDTH_COMMA) {
      // 全角 ASCII（含数字、＋－＊／％（）、全角字母）→ 半角
      out = String.fromCharCode(code - 0xfee0);
    } else if (char === "×") {
      out = "*";
    } else if (char === "÷") {
      out = "/";
    } else if (code === MINUS_SIGN || code === EN_DASH) {
      out = "-";
    } else {
      out = char;
    }

    if (out) {
      text += out;
      // 每个输出字符都要有映射（含 UTF-16 代理对）：这样 `map.length` 恒等于 `text.length`，
      // 着色时才能按归一化下标稳定回查**原文**下标（否则叠加层与输入框会错位，§16.13）
      for (let offset = 0; offset < out.length; offset += 1) {
        map.push(index + Math.min(offset, char.length - 1));
      }
    }
    index += char.length;
  }

  return { text, map };
}

/** 归一化：全角转半角、同义符号归一、删除千分位逗号（§16.3） */
export function normalizeFormula(input) {
  return normalizeWithMap(input).text;
}

function describeToken(token) {
  if (!token) return "公式末尾";
  switch (token.type) {
    case "number":
      return `数值 ${token.text}`;
    case "var":
      return token.valueText === null ? `变量「${token.name}」` : `变量「${token.name}」（取值 ${token.valueText}）`;
    case "op":
      return `运算符「${token.value}」`;
    case "paren":
      return `括号「${token.value}」`;
    case "percent":
      return "百分号「%」";
    default:
      return "该处";
  }
}

/* ── 词法 ───────────────────────────────────────────────── */

/**
 * 切词（§16.3）。返回 `{ ok, tokens, text }` 或 `{ ok:false, code, error, index }`。
 * token 类型：`number` / `var`（可带 `value` / `valueText`，即「名字后紧跟的数字」= 取值）/
 * `op` / `paren` / `percent`。归一化后的下标会映射回原文下标。
 */
export function tokenize(input, options = {}) {
  const source = String(input ?? "");
  const { text, map } = normalizeWithMap(input);
  if (text.length > MAX_FORMULA_LEN) {
    return fail(ERROR_CODES.tooLong, `公式过长（${text.length} 个字符，上限 ${MAX_FORMULA_LEN} 个字符）`);
  }

  // v1.7.25「变量取值解析」开关（默认开，§16.2/§16.3）：
  // 关闭后变量名后**不吸收任何数字**（正、负都不吸），文法回到纯运算符模式 ——
  // `X-5` 即「X 减 5」、`X5` 报「缺少运算符」（与 `a1b2` 同口径）。
  const extractValues = options.extractValues !== false;

  const tokens = [];
  const at = (position) => (Number.isInteger(map[position]) ? map[position] : position);
  let index = 0;
  let spaceBefore = false;

  while (index < text.length) {
    const char = text[index];

    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      index += 1;
      spaceBefore = true;
      continue;
    }

    const start = at(index);
    const numberMatch = NUMBER_PATTERN.exec(text.slice(index));
    if (numberMatch) {
      const raw = numberMatch[0];
      tokens.push({ type: "number", value: Number(raw), text: raw, start, spaceBefore });
      index += raw.length;
      spaceBefore = false;
      continue;
    }

    if (isNameChar(char)) {
      let cursor = index + 1;
      while (cursor < text.length && isNameChar(text[cursor])) cursor += 1;
      const name = text.slice(index, cursor);

      // 名字之后（**允许空格**，见 §16.3「特例不因空白而失效」）的连续数字是该变量的取值；
      // 数字可再带一个 %，此时取值按 0.01 折算、原样写法记为 `15%`。
      // v1.7.25：**负号紧跟变量名**（其后允许空白）且随后是数字时，负号计入取值
      // （`调价-7.38` → -7.38）；负号与名之间有空格（`调价 - 7.38`）仍按减法解析 ——
      // 「负号是否贴名」就是「取值 / 减法」的判据（§16.3 规则①）。
      let digitsAt = cursor;
      let negative = false;
      if (extractValues && text[cursor] === "-") {
        let probe = cursor + 1;
        while (probe < text.length && isWhitespaceChar(text[probe])) probe += 1;
        if (TRAILING_NUMBER_PATTERN.test(text.slice(probe))) {
          negative = true;
          digitsAt = probe;
        }
      }
      if (!negative) {
        while (digitsAt < text.length && isWhitespaceChar(text[digitsAt])) digitsAt += 1;
      }
      const digits = extractValues ? TRAILING_NUMBER_PATTERN.exec(text.slice(digitsAt)) : null;
      if (digits) {
        let end = digitsAt + digits[0].length;
        let value = Number(digits[0]) * (negative ? -1 : 1);
        if (text[end] === "%") {
          value *= 0.01;
          end += 1;
        }
        // 取值的**原样写法**要从**原文**里切（归一化会删掉千分位逗号）：
        // 这样 `单价1,000` 预填进变量表的是 `1,000` 而不是 `1000`，用户看到的就是自己写的那串（§16.4）；
        // 负数取值从**负号**处起切，预填即 `-7.38`（v1.7.25）。
        const valueText = source.slice(at(negative ? cursor : digitsAt), at(end - 1) + 1) || digits[0];
        tokens.push({ type: "var", name, value, valueText, start, spaceBefore });
        index = end;
      } else {
        tokens.push({ type: "var", name, value: null, valueText: null, start, spaceBefore });
        index = cursor;
      }
      spaceBefore = false;
      continue;
    }

    if (char === "+" || char === "-" || char === "*" || char === "/") {
      tokens.push({ type: "op", value: char, start, spaceBefore });
      index += 1;
      spaceBefore = false;
      continue;
    }

    if (char === "(" || char === ")") {
      tokens.push({ type: "paren", value: char, start, spaceBefore });
      index += 1;
      spaceBefore = false;
      continue;
    }

    if (char === "%") {
      tokens.push({ type: "percent", start, spaceBefore });
      index += 1;
      spaceBefore = false;
      continue;
    }

    return fail(
      ERROR_CODES.unsupportedChar,
      `不支持的字符「${char}」（第 ${start + 1} 个字符）；公式中只能出现数字、变量名、+ - * / ( ) % 与空格`,
      start
    );
  }

  return { ok: true, tokens, text };
}

/**
 * 按**原文**切出着色片段（§16.13），供公式输入框背后的叠加层渲染。
 * - 覆盖原文的**每一个字符**（含被归一化删掉的千分位逗号、空白与不支持的字符），因此
 *   叠加层的字符序列与输入框**逐字符一致**，宽度不会漂移、光标不会错位；
 * - 解析失败（公式暂时写错）时**不报错**，按能识别的片段返回，所以可以边打字边着色；
 * - `varIndex` = 变量在「首次出现顺序」中的序号；**「变量后紧跟的取值数字」也带该变量的 `varIndex`**
 *   （它就是这个变量的取值，同色更易读）；`depth` = 括号嵌套深度（从 1 起）。
 */
export function annotateFormula(input, options = {}) {
  const source = String(input ?? "");
  const { text, map } = normalizeWithMap(input);
  // 与 tokenize 同口径的「变量取值解析」开关（v1.7.25）：着色与切词不得分叉
  const extractValues = options.extractValues !== false;
  const segments = [];
  const variableOrder = new Map();
  const varIndexOf = (name) => {
    if (!variableOrder.has(name)) variableOrder.set(name, variableOrder.size);
    return variableOrder.get(name);
  };

  let lastRawEnd = -1;

  /**
   * 按**原文**区间推入一个片段。
   * 归一化会**删掉**一些原文字符（千分位逗号）；它们若落在数值里就已被片段包住，
   * 若落在其它位置就会形成「空洞」—— 这里顺带把空洞补成 `unknown` 片段，
   * 从而保证 `segments` 拼起来**恒等于原文**（叠加层对齐的前提，§16.13）。
   */
  const push = (rawStart, rawEnd, kind, extra) => {
    if (!Number.isInteger(rawStart) || !Number.isInteger(rawEnd) || rawEnd < rawStart) return;
    if (lastRawEnd + 1 < rawStart) {
      segments.push({ text: source.slice(lastRawEnd + 1, rawStart), kind: "unknown" });
    }
    segments.push({ text: source.slice(rawStart, rawEnd + 1), kind, ...extra });
    lastRawEnd = Math.max(lastRawEnd, rawEnd);
  };

  let index = 0;
  let depth = 0;

  while (index < text.length) {
    const char = text[index];
    const rawStart = map[index];

    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      let end = index;
      while (end + 1 < text.length && /[ \t\n\r]/.test(text[end + 1])) end += 1;
      push(rawStart, map[end], "space");
      index = end + 1;
      continue;
    }

    const numberMatch = NUMBER_PATTERN.exec(text.slice(index));
    if (numberMatch) {
      let end = index + numberMatch[0].length;
      if (text[end] === "%") end += 1;
      push(rawStart, map[end - 1], "number");
      index = end;
      continue;
    }

    if (isNameChar(char)) {
      let cursor = index + 1;
      while (cursor < text.length && isNameChar(text[cursor])) cursor += 1;
      const name = text.slice(index, cursor);
      const varIndex = varIndexOf(name);
      push(rawStart, map[cursor - 1], "var", { varIndex });

      let digitsAt = cursor;
      let negative = false;
      if (extractValues && text[cursor] === "-") {
        let probe = cursor + 1;
        while (probe < text.length && isWhitespaceChar(text[probe])) probe += 1;
        if (TRAILING_NUMBER_PATTERN.test(text.slice(probe))) {
          negative = true;
          digitsAt = probe;
        }
      }
      if (!negative) {
        while (digitsAt < text.length && isWhitespaceChar(text[digitsAt])) digitsAt += 1;
      }
      const digits = extractValues ? TRAILING_NUMBER_PATTERN.exec(text.slice(digitsAt)) : null;
      if (digits) {
        let end = digitsAt + digits[0].length;
        if (text[end] === "%") end += 1;
        if (negative) {
          // 负号贴名（v1.7.25）：从**负号**起并入取值片段，与 tokenize 的 valueText 同口径
          push(map[cursor], map[end - 1], "number", { varIndex });
        } else {
          if (digitsAt > cursor) push(map[cursor], map[digitsAt - 1], "space");
          push(map[digitsAt], map[end - 1], "number", { varIndex });
        }
        index = end;
      } else {
        index = cursor;
      }
      continue;
    }

    if (char === "(") {
      depth += 1;
      push(rawStart, rawStart, "paren", { depth });
      index += 1;
      continue;
    }
    if (char === ")") {
      push(rawStart, rawStart, "paren", { depth: Math.max(depth, 1) });
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }
    if (char === "+" || char === "-" || char === "*" || char === "/" || char === "%") {
      push(rawStart, rawStart, "operator");
      index += 1;
      continue;
    }

    // 其余字符（中文标点、`^`、以及被删掉的千分位逗号所在位置）：按 unknown 单字符输出
    push(rawStart, rawStart, "unknown");
    index += 1;
  }

  // 原文尾部被删除的字符（例如以逗号结尾）
  if (lastRawEnd + 1 < source.length) {
    segments.push({ text: source.slice(lastRawEnd + 1), kind: "unknown" });
  }

  return { ok: true, segments };
}

/* ── 语法 ───────────────────────────────────────────────── */

/**
 * 递归下降解析（§16.3）。优先级：`%`（后缀）> 一元负号 > `* /` > `+ -`；同级严格从左到右。
 * 返回 `{ ok, ast }` 或 `{ ok:false, code, error, index }`。
 */
function parseTokens(tokens) {
  let position = 0;

  const peek = () => tokens[position] || null;
  const previous = () => tokens[position - 1] || null;

  function parseExpression() {
    let left = parseTerm();
    if (!left.ok) return left;
    for (;;) {
      const token = peek();
      if (!token || token.type !== "op" || (token.value !== "+" && token.value !== "-")) break;
      position += 1;
      const right = parseTerm();
      if (!right.ok) return right;
      left = { ok: true, ast: { type: "binary", op: token.value, left: left.ast, right: right.ast } };
    }
    return left;
  }

  function parseTerm() {
    let left = parseUnary();
    if (!left.ok) return left;
    for (;;) {
      const token = peek();
      if (!token || token.type !== "op" || (token.value !== "*" && token.value !== "/")) break;
      position += 1;
      const right = parseUnary();
      if (!right.ok) return right;
      left = { ok: true, ast: { type: "binary", op: token.value, left: left.ast, right: right.ast } };
    }
    return left;
  }

  function parseUnary() {
    const token = peek();
    if (token && token.type === "op" && token.value === "-") {
      position += 1;
      const operand = parseUnary();
      if (!operand.ok) return operand;
      return { ok: true, ast: { type: "unary", op: "-", operand: operand.ast } };
    }
    if (token && token.type === "op" && token.value === "+") {
      position += 1; // 一元正号：宽容接受，不产生节点
      return parseUnary();
    }
    return parsePostfix();
  }

  function parsePostfix() {
    let node = parsePrimary();
    if (!node.ok) return node;
    for (;;) {
      const token = peek();
      if (!token || token.type !== "percent") break;
      position += 1;
      node = { ok: true, ast: { type: "percent", operand: node.ast } };
    }
    return node;
  }

  function parsePrimary() {
    const token = peek();
    if (!token) return fail(ERROR_CODES.syntax, "公式不完整：末尾缺少运算数");
    if (token.type === "number") {
      position += 1;
      return { ok: true, ast: { type: "number", value: token.value, text: token.text } };
    }
    if (token.type === "var") {
      position += 1;
      return {
        ok: true,
        ast: { type: "var", name: token.name, value: token.value, valueText: token.valueText, start: token.start },
      };
    }
    if (token.type === "paren" && token.value === "(") {
      position += 1;
      const inner = parseExpression();
      if (!inner.ok) return inner;
      const closing = peek();
      if (!closing || closing.type !== "paren" || closing.value !== ")") {
        return fail(ERROR_CODES.syntax, "括号不配对：缺少右括号「)」", token.start);
      }
      position += 1;
      return { ok: true, ast: { type: "group", expr: inner.ast } };
    }
    if (token.type === "paren") return fail(ERROR_CODES.syntax, "多余的右括号「)」", token.start);
    if (token.type === "percent") return fail(ERROR_CODES.syntax, "百分号「%」缺少左侧的值", token.start);
    if (token.type === "op") return fail(ERROR_CODES.syntax, `运算符「${token.value}」缺少左侧的运算数`, token.start);
    return fail(ERROR_CODES.syntax, "无法解析该处内容", token.start);
  }

  const parsed = parseExpression();
  if (!parsed.ok) return parsed;

  const leftover = peek();
  if (leftover) {
    if (leftover.type === "paren" && leftover.value === ")") {
      return fail(ERROR_CODES.syntax, "多余的右括号「)」", leftover.start);
    }
    // 两个运算数直接相邻：本项目**不做隐式乘法**（§16.3 规则 ②）
    const hint =
      leftover.type === "var" && leftover.valueText !== null
        ? `；若该数字是想表示前面那个变量的取值，请确认变量名里不含数字（可改用下划线，如 单价_甲）`
        : "；若想表示相乘请显式写 *";
    return fail(
      ERROR_CODES.syntax,
      `缺少运算符：${describeToken(previous())} 与 ${describeToken(leftover)} 之间缺少运算符${hint}`,
      leftover.start
    );
  }

  return { ok: true, ast: parsed.ast };
}

/** 解析公式（§16.11）。返回 `{ ok, ast }` 或 `{ ok:false, code, error, index }` */
export function parseFormula(input, options = {}) {
  const tokenized = tokenize(input, options);
  if (!tokenized.ok) return tokenized;
  if (tokenized.tokens.length === 0) return fail(ERROR_CODES.empty, "公式为空");
  return parseTokens(tokenized.tokens);
}

/* ── 变量 ───────────────────────────────────────────────── */

function visitNodes(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  switch (node.type) {
    case "binary":
      visitNodes(node.left, visit);
      visitNodes(node.right, visit);
      break;
    case "unary":
    case "percent":
      visitNodes(node.operand, visit);
      break;
    case "group":
      visitNodes(node.expr, visit);
      break;
    default:
      break;
  }
}

/** 收集变量：**按首次出现顺序**，同名合并；同时检测「同名不同取值」的冲突（§16.3 规则 ③） */
function collectVariables(ast) {
  const variables = [];
  const indexByName = new Map();
  let conflict = null;

  visitNodes(ast, (node) => {
    if (node.type !== "var") return;
    let entry = indexByName.get(node.name);
    if (!entry) {
      entry = { name: node.name, count: 0, prefill: null, prefillRaw: null };
      indexByName.set(node.name, entry);
      variables.push(entry);
    }
    entry.count += 1;
    if (node.value === null) return;
    if (entry.prefill === null) {
      entry.prefill = node.value;
      entry.prefillRaw = node.valueText;
    } else if (entry.prefill !== node.value) {
      conflict = {
        name: node.name,
        first: entry.prefill,
        firstRaw: entry.prefillRaw,
        second: node.value,
        secondRaw: node.valueText,
      };
    }
  });

  return { variables, conflict };
}

/**
 * 一次拿齐「语法 + 变量」：UI 与其余导出函数都以它为基础，避免重复解析。
 * 返回 `{ ok, ast, variables, formula }` 或 `{ ok:false, code, error, index }`。
 */
export function analyzeFormula(input, options = {}) {
  const parsed = parseFormula(input, options);
  if (!parsed.ok) return parsed;

  const { variables, conflict } = collectVariables(parsed.ast);
  if (conflict) {
    return fail(
      ERROR_CODES.varConflict,
      `变量「${conflict.name}」在同一公式里出现了两个不同的取值（${conflict.firstRaw ?? formatNumber(conflict.first)} 与 ${
        conflict.secondRaw ?? formatNumber(conflict.second)
      }），请统一后再计算`
    );
  }
  if (variables.length > MAX_VARIABLES) {
    return fail(
      ERROR_CODES.tooManyVariables,
      `变量过多（${variables.length} 个，上限 ${MAX_VARIABLES} 个）；请拆成多个公式分别计算`
    );
  }

  return {
    ok: true,
    ast: parsed.ast,
    variables,
    formula: normalizeFormula(input),
    // 「过滤取值后的变量形式公式」（`单价10*数量25` → `单价 × 数量`）的着色片段：
    // 解析成功即可用，与是否填了取值无关（§16.5 要求它先于计算过程展示）
    formulaSegments: segmentsOf(parsed.ast, variables.map((variable) => variable.name)),
  };
}

/** 提取变量（§16.4）：按首次出现顺序去重，带上公式里给出的取值（`prefill` / `prefillRaw`） */
export function extractVariables(input, options = {}) {
  const analysis = analyzeFormula(input, options);
  if (!analysis.ok) return analysis;
  return { ok: true, variables: analysis.variables };
}

/**
 * 去取值的「变量形式」公式纯文本（v1.7.25，§16.8）。
 * `基准价295+调价-7.38` → `基准价 + 调价`：供 UI「替换输入公式」按钮把输入直接还原为变量式
 * （与展示层 `formulaSegments` 同口径：变量名 + 运算符，二元运算符两侧留一个空格）。
 * **解析失败或关闭取值解析时原样返回**，不做任何猜测性改写。
 * @param {string} input 原公式
 * @param {{ extractValues?: boolean }} [options]
 * @returns {string}
 */
export function stripEmbeddedValues(input, options = {}) {
  const source = String(input ?? "");
  if (options.extractValues === false) return source;
  const tokenized = tokenize(source, options);
  if (!tokenized.ok) return source;

  let out = "";
  let previous = "start"; // start | operand | operator | open
  tokenized.tokens.forEach((token) => {
    if (token.type === "var") {
      if (previous === "operand") out += " ";
      out += token.name;
      previous = "operand";
      return;
    }
    if (token.type === "number") {
      if (previous === "operand") out += " ";
      out += token.text;
      previous = "operand";
      return;
    }
    if (token.type === "percent") {
      out += "%";
      previous = "operand";
      return;
    }
    if (token.type === "paren") {
      if (token.value === "(") {
        if (previous === "operand") out += " ";
        out += "(";
        previous = "open";
      } else {
        out += ")";
        previous = "operand";
      }
      return;
    }
    // operator：一元位置（开头 / 运算符后 / 左括号后）紧贴操作数，二元位置两侧各一个空格
    const unary = previous === "start" || previous === "operator" || previous === "open";
    out += unary ? token.value : ` ${token.value} `;
    previous = "operator";
  });
  return out.trim();
}

/* ── 求值 ───────────────────────────────────────────────── */

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(numeric) ? numeric : null;
}

function evaluateNode(node, values, missing) {
  switch (node.type) {
    case "number":
      return { ok: true, value: node.value };
    case "var": {
      const numeric = toFiniteNumber(values ? values[node.name] : null);
      if (numeric === null) {
        if (missing && !missing.includes(node.name)) missing.push(node.name);
        return { ok: false, code: ERROR_CODES.missingValues, missing: missing ? [...missing] : [node.name] };
      }
      return { ok: true, value: numeric };
    }
    case "group":
      return evaluateNode(node.expr, values, missing);
    case "percent": {
      const inner = evaluateNode(node.operand, values, missing);
      if (!inner.ok) return inner;
      return { ok: true, value: inner.value * 0.01 };
    }
    case "unary": {
      const inner = evaluateNode(node.operand, values, missing);
      if (!inner.ok) return inner;
      return { ok: true, value: -inner.value };
    }
    case "binary": {
      const left = evaluateNode(node.left, values, missing);
      if (!left.ok) return left;
      const right = evaluateNode(node.right, values, missing);
      if (!right.ok) return right;
      let value;
      if (node.op === "+") value = left.value + right.value;
      else if (node.op === "-") value = left.value - right.value;
      else if (node.op === "*") value = left.value * right.value;
      else if (node.op === "/") {
        if (right.value === 0) {
          return {
            ok: false,
            code: ERROR_CODES.divZero,
            error: `除数为零（${formatNumber(left.value)} ÷ 0）`,
          };
        }
        value = left.value / right.value;
      } else {
        return { ok: false, code: ERROR_CODES.syntax, error: `不支持的运算符「${node.op}」` };
      }
      if (!Number.isFinite(value)) {
        return { ok: false, code: ERROR_CODES.overflow, error: "结果超出可表示范围" };
      }
      return { ok: true, value };
    }
    default:
      return { ok: false, code: ERROR_CODES.syntax, error: "算式结构不完整" };
  }
}

/**
 * 求值（§16.11）。`values` 是 `{ 变量名: 数值 }`（数值或可转数值的字符串均可）。
 * 返回 `{ ok:true, value }` / `{ ok:false, code:'MISSING_VALUES', missing }` / 其它错误。
 */
export function evaluateFormula(input, values, options = {}) {
  const analysis = analyzeFormula(input, options);
  if (!analysis.ok) return analysis;
  return evaluateNode(analysis.ast, values || {}, []);
}

/* ── 数值显示 ───────────────────────────────────────────── */

/**
 * 精简显示（§16.6）：整除显示整数；最多 `DECIMAL_PLACES` 位小数并去掉尾随零；
 * 规避 `0.1 + 0.2` 这类浮点噪声；`-0` 归一为 `0`；极大/极小值退化为科学计数法。
 */
export function formatNumber(value) {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return "NaN";
  if (!Number.isFinite(numeric)) return numeric > 0 ? "∞" : "-∞";
  if (numeric === 0) return "0";

  const magnitude = Math.abs(numeric);
  if (magnitude >= SCIENTIFIC_HIGH || magnitude < SCIENTIFIC_LOW) {
    return numeric
      .toExponential(DECIMAL_PLACES)
      .replace(/\.?0+e/, "e")
      .replace("e+", "e");
  }

  // 必须**用字符串**去掉尾随零，不能走 `String(Number(...))`：
  // JS 对绝对值小于 1e-6 的数字会自行改用科学计数法（`String(1e-10)` 是 `"1e-10"`），
  // 那样「1e-10 以上仍按小数显示」这条约定就会被破坏。
  const fixed = numeric.toFixed(DECIMAL_PLACES);
  if (!fixed.includes(".")) return fixed;
  const trimmed = fixed.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "" || trimmed === "-" ? "0" : trimmed;
}

/** 单元格写法解析（§16.4）：接受数值 / 千分位数值 / 百分号数值，返回折算值与**原样写法** */
export function parseCellValue(input) {
  const source = String(input ?? "");
  const trimmed = source.trim();
  if (trimmed === "") return { ok: true, value: null, raw: "", empty: true };

  const normalized = normalizeFormula(trimmed).replace(/\s+/g, "");
  const match = /^([+-]?)(\d+(?:\.\d+)?|\.\d+)(%?)$/.exec(normalized);
  if (!match) {
    return fail(
      ERROR_CODES.cellInvalid,
      `「${trimmed}」不是有效数值（可填：12、1,000、15%、-3.5）`
    );
  }

  const numeric = Number(`${match[1]}${match[2]}`) * (match[3] ? 0.01 : 1);
  if (!Number.isFinite(numeric)) {
    return fail(ERROR_CODES.cellInvalid, `「${trimmed}」超出可表示范围`);
  }
  return { ok: true, value: numeric, raw: trimmed, empty: false };
}

/* ── 分步化简（§16.5）───────────────────────────────────── */

function cloneTree(node) {
  switch (node.type) {
    case "binary":
      return { ...node, left: cloneTree(node.left), right: cloneTree(node.right) };
    case "unary":
    case "percent":
      return { ...node, operand: cloneTree(node.operand) };
    case "group":
      return { ...node, expr: cloneTree(node.expr) };
    default:
      return { ...node };
  }
}

/**
 * 渲染展示树为**着色片段**（§16.13）：UI 直接按片段上色，**不再自己解析一遍公式**。
 * - `variableNames` 给出变量顺序时，变量会带 `varIndex`（配色用）；
 * - 由变量替换而来的数字（`node.varIndex`）也带来源变量的 `varIndex`，从而「沿用对应变量的颜色」；
 * - 括号带 `depth`（从 1 起），供彩虹括号按嵌套深度取色。
 */
function renderSegments(node, depth, out, variableNames) {
  switch (node.type) {
    case "number": {
      const segment = { text: node.text ?? formatNumber(node.value), kind: "number" };
      if (Number.isInteger(node.varIndex)) segment.varIndex = node.varIndex;
      out.push(segment);
      return;
    }
    case "var": {
      const segment = { text: node.name, kind: "var" };
      if (variableNames) segment.varIndex = Math.max(0, variableNames.indexOf(node.name));
      out.push(segment);
      return;
    }
    case "group":
      out.push({ text: "(", kind: "paren", depth });
      renderSegments(node.expr, depth + 1, out, variableNames);
      out.push({ text: ")", kind: "paren", depth });
      return;
    case "unary":
      out.push({ text: "-", kind: "operator" });
      renderSegments(node.operand, depth, out, variableNames);
      return;
    case "percent":
      renderSegments(node.operand, depth, out, variableNames);
      out.push({ text: "%", kind: "operator" });
      return;
    case "binary":
      renderSegments(node.left, depth, out, variableNames);
      out.push({ text: " ", kind: "space" });
      out.push({ text: OPERATOR_SYMBOLS[node.op] || node.op, kind: "operator" });
      out.push({ text: " ", kind: "space" });
      renderSegments(node.right, depth, out, variableNames);
      return;
    default:
      return;
  }
}

/** 取展示树的着色片段 */
function segmentsOf(node, variableNames) {
  const out = [];
  renderSegments(node, 1, out, variableNames);
  return out;
}

/**
 * 渲染展示树为算式字符串。与 `segmentsOf` **同源**，保证「彩色渲染」与「字符串」永不漂移；
 * 屏幕上用 `×` / `÷`（§16.5），它们回读时会被归一化回 `*` / `/`，因此既有断言仍可复用。
 */
function renderTree(node) {
  return segmentsOf(node, null)
    .map((segment) => segment.text)
    .join("");
}

/** 变量替换：把变量节点换成数值节点（**合并为一步**，§16.5），并记下来源变量以沿用其配色（§16.13） */
function substituteVariables(node, values, missing, variableNames) {
  switch (node.type) {
    case "var": {
      const numeric = toFiniteNumber(values ? values[node.name] : null);
      if (numeric === null) {
        if (!missing.includes(node.name)) missing.push(node.name);
        return { ...node };
      }
      return {
        type: "number",
        value: numeric,
        text: formatNumber(numeric),
        varIndex: Math.max(0, variableNames.indexOf(node.name)),
      };
    }
    case "binary":
      return {
        ...node,
        left: substituteVariables(node.left, values, missing, variableNames),
        right: substituteVariables(node.right, values, missing, variableNames),
      };
    case "unary":
    case "percent":
      return { ...node, operand: substituteVariables(node.operand, values, missing, variableNames) };
    case "group":
      return { ...node, expr: substituteVariables(node.expr, values, missing, variableNames) };
    default:
      return { ...node };
  }
}

/** 找出「当前可求值的最内层且最高优先级」的节点（同级从左到右） */
function findReducible(root) {
  let best = null;
  let order = 0;

  const visit = (node, parent, key, ancestors, depth, insideGroup) => {
    if (!node || typeof node !== "object") return;
    order += 1;
    const selfOrder = order;

    let rank = -1;
    if (node.type === "percent" && isNumericNode(node.operand)) rank = 0;
    else if (node.type === "unary" && isNumericNode(node.operand)) rank = 1;
    else if (node.type === "binary" && isNumericNode(node.left) && isNumericNode(node.right)) {
      rank = node.op === "*" || node.op === "/" ? 2 : 3;
    } else if (node.type === "group" && isNumericNode(node.expr)) rank = 4;

    if (rank >= 0) {
      const candidate = { node, parent, key, ancestors, depth, insideGroup, rank, order: selfOrder };
      const better =
        !best ||
        candidate.depth > best.depth ||
        (candidate.depth === best.depth && candidate.rank < best.rank) ||
        (candidate.depth === best.depth && candidate.rank === best.rank && candidate.order < best.order);
      if (better) best = candidate;
    }

    const nextAncestors = [...ancestors, node];
    switch (node.type) {
      case "binary":
        visit(node.left, node, "left", nextAncestors, depth + 1, insideGroup);
        visit(node.right, node, "right", nextAncestors, depth + 1, insideGroup);
        break;
      case "unary":
      case "percent":
        visit(node.operand, node, "operand", nextAncestors, depth + 1, insideGroup);
        break;
      case "group":
        visit(node.expr, node, "expr", nextAncestors, depth + 1, true);
        break;
      default:
        break;
    }
  };

  visit(root, null, null, [], 0, false);
  return best;
}

function stepLabel(node, insideGroup) {
  if (node.type === "percent") return STEP_LABELS.percent;
  if (node.type === "unary") return STEP_LABELS.negate;
  if (node.type === "group") return STEP_LABELS.ungroup;
  if (insideGroup) return STEP_LABELS.group;
  return node.op === "*" || node.op === "/" ? STEP_LABELS.multiply : STEP_LABELS.add;
}

/** 步骤过多时折叠中间部分（§16.5），并插入一行说明 */
function capSteps(steps) {
  if (steps.length <= MAX_STEPS) return steps;
  const headCount = Math.ceil(MAX_STEPS / 2);
  const head = steps.slice(0, headCount);
  const tail = steps.slice(steps.length - (MAX_STEPS - headCount));
  const omitted = steps.length - MAX_STEPS;
  return [
    ...head,
    {
      index: head.length + 1,
      label: STEP_LABELS.omitted,
      expr: "…",
      detail: `步骤过多，已省略中间的 ${omitted} 步`,
      omitted,
    },
    ...tail.map((step, offset) => ({ ...step, index: head.length + 2 + offset })),
  ];
}

/**
 * 分步计算过程（§16.5）。返回 `{ ok, steps, result, resultText }` 或错误。
 * 每个步骤含 `{ index, label, expr, detail }`，`expr` 是**化简后的整条算式**；
 * 不变式：任一中间步骤的算式重新求值都必须等于最终结果（验证脚本据此断言）。
 */
export function explainSteps(input, values, options = {}) {
  const analysis = analyzeFormula(input, options);
  if (!analysis.ok) return analysis;
  const variableNames = analysis.variables.map((variable) => variable.name);
  if (analysis.variables.length === 0 && analysis.ast.type === "number") {
    return {
      ok: true,
      steps: [],
      formulaSegments: segmentsOf(analysis.ast, null),
      result: analysis.ast.value,
      resultText: formatNumber(analysis.ast.value),
    };
  }

  const steps = [];
  let tree = cloneTree(analysis.ast);

  if (analysis.variables.length > 0) {
    const missing = [];
    tree = substituteVariables(tree, values || {}, missing, variableNames);
    if (missing.length > 0) {
      return {
        ok: false,
        code: ERROR_CODES.missingValues,
        missing,
        error: `变量 ${missing.join("、")} 还没有填写取值`,
      };
    }
    const detail = analysis.variables
      .map((variable) => {
        const numeric = toFiniteNumber(values ? values[variable.name] : null);
        const text = formatNumber(numeric);
        const raw = String(values && values[`${variable.name}::raw`] ? values[`${variable.name}::raw`] : "");
        return raw && raw !== text ? `${variable.name} = ${raw}（${text}）` : `${variable.name} = ${text}`;
      })
      .join("、");
    steps.push({
      index: 1,
      label: STEP_LABELS.substitute,
      expr: renderTree(tree),
      // 替换后的数字带**来源变量**的 varIndex ⇒ 界面沿用该变量的颜色（§16.13）
      segments: segmentsOf(tree, null),
      detail: detail || "把变量替换为各自填写的取值",
    });
  }

  // 每轮化简一个节点，节点数受 MAX_FORMULA_LEN 约束；`guard` 只是防御性的兜底，
  // 真正的「步骤过多」由 capSteps 在返回前折叠（§16.5）。
  const guardLimit = MAX_STEPS * 8;
  for (let guard = 0; guard <= guardLimit; guard += 1) {
    const target = findReducible(tree);
    if (!target) break;

    let replacement;
    let label;
    let detail;

    if (target.node.type === "group") {
      const inner = target.node.expr;
      label = STEP_LABELS.ungroup;
      detail = `${renderTree(target.node)} 括号内已是一个数值，可以直接去掉括号`;
      replacement = { type: "number", value: inner.value, text: formatNumber(inner.value) };
    } else {
      const evaluated = evaluateNode(target.node, {}, []);
      if (!evaluated.ok) return evaluated;
      label = stepLabel(target.node, target.insideGroup);
      detail = `${renderTree(target.node)} = ${formatNumber(evaluated.value)}`;
      replacement = { type: "number", value: evaluated.value, text: formatNumber(evaluated.value) };
    }

    const before = renderTree(tree);
    if (target.parent) target.parent[target.key] = replacement;
    else tree = replacement;

    // 同一层括号内已全为数值 → **本步内**顺手去括号，避免多出 `(400) * 2` 这样的中间态
    for (let level = target.ancestors.length - 1; level >= 0; level -= 1) {
      const group = target.ancestors[level];
      if (group.type !== "group" || !isNumericNode(group.expr)) continue;
      const collapsed = { type: "number", value: group.expr.value, text: formatNumber(group.expr.value) };
      const holder = level > 0 ? target.ancestors[level - 1] : null;
      if (!holder) tree = collapsed;
      else if (holder.left === group) holder.left = collapsed;
      else if (holder.right === group) holder.right = collapsed;
      else if (holder.operand === group) holder.operand = collapsed;
      else if (holder.expr === group) holder.expr = collapsed;
    }

    const after = renderTree(tree);
    // 化简后算式**没有任何可见变化**时（例如 `-3` 化简为数值 `-3`）不产生步骤：
    // 否则读者会看到两行一模一样的算式。化简本身照做，只是不占用一行（§16.5）。
    if (after !== before) {
      steps.push({ index: steps.length + 1, label, expr: after, segments: segmentsOf(tree, null), detail });
    }
  }

  const finalValue = isNumericNode(tree) ? tree.value : null;
  if (finalValue === null) {
    return fail(ERROR_CODES.syntax, "无法完成化简：公式结构异常");
  }

  return {
    ok: true,
    steps: capSteps(steps),
    // 「过滤取值后的变量形式公式」（`单价10*数量25` → `单价 × 数量`）：§16.5 要求它在过程之前先行展示
    formulaSegments: segmentsOf(analysis.ast, variableNames),
    result: finalValue,
    resultText: formatNumber(finalValue),
  };
}

export default Object.freeze({
  normalizeFormula,
  tokenize,
  parseFormula,
  analyzeFormula,
  extractVariables,
  evaluateFormula,
  explainSteps,
  annotateFormula,
  formatNumber,
  parseCellValue,
  MAX_FORMULA_LEN,
  MAX_VARIABLES,
  MAX_STEPS,
  DECIMAL_PLACES,
  SCIENTIFIC_HIGH,
  SCIENTIFIC_LOW,
  VAR_HUE_COUNT,
  BRACKET_HUE_COUNT,
  STEP_LABELS,
  ERROR_CODES,
});
