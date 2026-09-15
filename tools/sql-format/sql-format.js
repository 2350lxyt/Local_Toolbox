/**
 * 工具：《SQL 格式化》—— 独立处理模块
 * ------------------------------------------------------------------
 * 契约：本模块只导出 init(ctx)，由 assets/js/shell.js 在加载
 *      tools/sql-format/index.html 后动态 import 并调用。
 *
 * 解耦约定：
 *   - 不导入其它工具的代码，不读写跨工具的全局状态；
 *   - 与外壳之间只通过 ctx（容器、注册表记录、公共工具函数）交互；
 *   - 通用能力复用 ctx.utils（剪贴板 / 文本 / DOM）。
 *
 * 分层：
 *   1. 纯函数核心  DEFAULT_CONFIG / normalizeConfig / configEquals /
 *                  tokenize / buildBracketPairs / findMatches / formatSql /
 *                  renderHighlight / BUILTIN_PRESETS / serializePresets /
 *                  parseImportPayload        ← 顶层不触碰 DOM，可 import 到 Node 验证
 *   2. 存储适配层  loadCustomPresets / saveCustomPresets / loadSession / saveSession
 *   3. UI 编排层   init(ctx)
 *
 * 隐私：全部计算在本机完成；仅「参数配置」与「自定义预设」写入 localStorage，
 *      绝不持久化 SQL 文本，也不发起任何网络请求。
 */

/* ================================================================== 常量 */

const STORAGE_PREFIX = "toolbox:sql-format";
const PRESETS_KEY = `${STORAGE_PREFIX}:presets`;
const SESSION_KEY = `${STORAGE_PREFIX}:config`;

const EXPORT_VERSION = 1;
const EXPORT_APP = "local-toolbox";
const EXPORT_TOOL = "sql-format";

const MAX_PRESETS = 200;
const MAX_NAME_LENGTH = 40;
const FEEDBACK_MS = 2000;
const COPY_FEEDBACK_MS = 1500;
const REMOVE_CONFIRM_MS = 3000;
/** 超过该字符数即关闭语法高亮与搜索高亮，仅保留纯文本编辑（见 DESIGN.md §13.6） */
const MAX_HIGHLIGHT_CHARS = 300000;
const MAX_MATCHES = 5000;
const MAX_SAME_SELECTION = 64;

/** 预设下拉中代表「已手动改动、尚未保存」的哨兵值 */
const CUSTOM_ID = "__custom__";

/* ============================================================== 方言词表 */

export const DIALECTS = ["oracle", "postgres"];

/** 两方言共用的标准 SQL 保留字基集 */
const BASE_KEYWORDS = [
  "ADD", "ALL", "ALTER", "AND", "ANY", "AS", "ASC", "BEGIN", "BETWEEN", "BY",
  "CALL", "CASE", "CAST", "CHECK", "COLUMN", "COMMENT", "COMMIT", "CONSTRAINT",
  "CREATE", "CROSS", "CURSOR", "DATABASE", "DECLARE", "DEFAULT", "DELETE",
  "DESC", "DISTINCT", "DROP", "ELSE", "END", "EXCEPT", "EXCEPTION", "EXECUTE",
  "EXISTS", "EXPLAIN", "FALSE", "FETCH", "FIRST", "FOLLOWING", "FOR", "FOREIGN",
  "FROM", "FULL", "FUNCTION", "GRANT", "GROUP", "HAVING", "IF", "IN", "INDEX",
  "INNER", "INSERT", "INTERSECT", "INTO", "IS", "JOIN", "KEY", "LATERAL",
  "LEFT", "LIKE", "LIMIT", "LOOP", "MERGE", "NATURAL", "NEXT", "NOT", "NULL",
  "NULLS", "OF", "OFFSET", "ON", "ONLY", "OR", "ORDER", "OUTER", "OVER",
  "PARTITION", "PRECEDING", "PRIMARY", "PROCEDURE", "RANGE", "RECURSIVE",
  "REFERENCES", "RENAME", "REPLACE", "RETURNING", "RETURN", "REVOKE", "RIGHT",
  "ROLLBACK", "ROW", "ROWS", "SCHEMA", "SELECT", "SEQUENCE", "SET", "SHOW",
  "SOME", "TABLE", "THEN", "TO", "TRANSACTION", "TRIGGER", "TRUE", "TRUNCATE",
  "UNBOUNDED", "UNION", "UNIQUE", "UPDATE", "USING", "VALUES", "VIEW", "WHEN",
  "WHERE", "WHILE", "WINDOW", "WITH", "ZONE", "LOCAL", "WITHOUT", "PRECISION",
  "VARYING", "ANALYZE", "VACUUM", "REINDEX", "SAVEPOINT", "ISOLATION", "LEVEL",
  "READ", "WRITE", "WORK", "CASCADE", "RESTRICT", "IF", "ELSEIF", "ELSIF",
];

const ORACLE_KEYWORDS = [
  "MINUS", "START", "CONNECT", "PRIOR", "ROWNUM", "ROWID", "DUAL", "LEVEL",
  "NOLOGGING", "PCTFREE", "INITRANS", "TABLESPACE", "SYNONYM", "PUBLIC",
  "PACKAGE", "BODY", "PRAGMA", "BULK", "COLLECT", "PIPELINED", "NOCOPY",
  "AUTONOMOUS_TRANSACTION", "FLASHBACK", "PURGE", "PERSISTABLE",
  "ORGANIZATION", "SEGMENT", "MONITORING", "PARALLEL", "EXTERNAL", "GLOBAL",
  "TEMPORARY", "MATERIALIZED", "NOCACHE", "CACHE", "NOCYCLE", "CYCLE",
  "NOMAXVALUE", "MINVALUE", "MAXVALUE", "INCREMENT", "NOORDER", "ORDER",
  "EXCEPTION", "INITIALLY", "IMMEDIATE", "DEFERRED", "ENABLE", "DISABLE",
  "VALIDATE", "NOVALIDATE", "SYS", "SYSTEM",
];

const POSTGRES_KEYWORDS = [
  "ILIKE", "CONFLICT", "RETURNING", "MATERIALIZED", "SERIAL", "BIGSERIAL",
  "SMALLSERIAL", "ARRAY", "VARIADIC", "CONCURRENTLY", "EXTENSION", "OWNED",
  "TABLESPACE", "INHERITS", "UNLOGGED", "CLUSTER", "FREEZE", "ANALYSE",
  "DETACH", "ATTACH", "STORED", "GENERATED", "ALWAYS", "IDENTITY", "OVERRIDING",
  "WINDOW", "FILTER", "WITHIN", "EXCLUDE", "CURRENT", "CUBE", "ROLLUP",
  "GROUPING", "SETS", "TABLESAMPLE", "REPEATABLE", "FOR", "SHARE", "NO",
  "SKIP", "LOCKED", "NOWAIT", "PLACING", "OVERLAPS", "SIMILAR", "ESCAPE",
];

const DIALECT_EXTRA_KEYWORDS = {
  oracle: ORACLE_KEYWORDS,
  postgres: POSTGRES_KEYWORDS,
};

/** 数据类型（按关键字大小写规则着色与改写） */
const BASE_TYPES = [
  "BOOLEAN", "BOOL", "INT", "INTEGER", "SMALLINT", "BIGINT", "DECIMAL",
  "NUMERIC", "REAL", "DOUBLE", "FLOAT", "CHAR", "NCHAR", "VARCHAR", "NVARCHAR",
  "TEXT", "DATE", "TIME", "DATETIME", "TIMESTAMP", "INTERVAL", "JSON", "XML",
  "UUID", "ENUM", "ARRAY", "MONEY", "BINARY", "VARBINARY",
];

const ORACLE_TYPES = [
  "VARCHAR2", "NVARCHAR2", "NUMBER", "CLOB", "NCLOB", "BLOB", "BFILE", "RAW",
  "LONG", "UROWID", "XMLTYPE", "BINARY_FLOAT", "BINARY_DOUBLE",
  "TIMESTAMP", "INTERVAL",
];

const POSTGRES_TYPES = [
  "BYTEA", "JSONB", "SERIAL", "BIGSERIAL", "SMALLSERIAL", "TIMESTAMPTZ",
  "TEXT", "CIDR", "INET", "MACADDR", "TSVECTOR", "POINT",
];

const DIALECT_EXTRA_TYPES = {
  oracle: ORACLE_TYPES,
  postgres: POSTGRES_TYPES,
};

/** 内置函数（按函数名大小写规则着色与改写） */
const BASE_FUNCTIONS = [
  "ABS", "AVG", "CAST", "CEIL", "CEILING", "COALESCE", "CONCAT", "COUNT",
  "CURRENT_DATE", "CURRENT_TIME", "CURRENT_TIMESTAMP", "CURRENT_USER",
  "DENSE_RANK", "EXTRACT", "FLOOR", "GREATEST", "LAG", "LEAD", "LEAST",
  "LENGTH", "LOWER", "MAX", "MIN", "MOD", "NULLIF", "POSITION", "RANK",
  "REPLACE", "ROUND", "ROW_NUMBER", "SESSION_USER", "SIGN", "SQRT", "SUBSTRING",
  "SUM", "TRIM", "UPPER", "USER", "ROW", "GROUPING",
];

const ORACLE_FUNCTIONS = [
  "DECODE", "NVL", "NVL2", "INSTR", "SUBSTR", "LTRIM", "RTRIM", "LPAD",
  "RPAD", "TO_CHAR", "TO_DATE", "TO_NUMBER", "TO_TIMESTAMP", "TRUNC",
  "SYSDATE", "SYSTIMESTAMP", "SYS_GUID", "LISTAGG", "WM_CONCAT", "REGEXP_LIKE",
  "REGEXP_REPLACE", "REGEXP_SUBSTR", "REGEXP_INSTR", "REGEXP_COUNT", "ADD_MONTHS",
  "LAST_DAY", "MONTHS_BETWEEN", "NEXT_DAY", "BITAND", "ASCII", "CHR", "DUMP",
  "INITCAP", "TRANSLATE", "RAWTOHEX", "HEXTORAW", "SYS_CONTEXT", "XMLAGG",
];

const POSTGRES_FUNCTIONS = [
  "NOW", "DATE_TRUNC", "DATE_PART", "STRING_AGG", "ARRAY_AGG", "JSON_AGG",
  "JSONB_AGG", "JSON_BUILD_OBJECT", "JSONB_BUILD_OBJECT", "GENERATE_SERIES",
  "GEN_RANDOM_UUID", "SPLIT_PART", "REGEXP_MATCHES", "TO_CHAR", "TO_DATE",
  "TO_NUMBER", "AGE", "JUSTIFY_DAYS", "LEFT", "RIGHT", "BTRIM", "CONCAT_WS",
  "PG_TYPEOF", "CURRENT_SETTING", "SET_CONFIG", "UNNEST", "COALESCE",
];

const DIALECT_EXTRA_FUNCTIONS = {
  oracle: ORACLE_FUNCTIONS,
  postgres: POSTGRES_FUNCTIONS,
};

function toSet(list) {
  const set = new Set();
  list.forEach((word) => set.add(word.toUpperCase()));
  return set;
}

const KEYWORDS = {};
const TYPES = {};
const FUNCTIONS = {};

DIALECTS.forEach((dialect) => {
  KEYWORDS[dialect] = toSet([...BASE_KEYWORDS, ...DIALECT_EXTRA_KEYWORDS[dialect]]);
  TYPES[dialect] = toSet([...BASE_TYPES, ...DIALECT_EXTRA_TYPES[dialect]]);
  FUNCTIONS[dialect] = toSet([...BASE_FUNCTIONS, ...DIALECT_EXTRA_FUNCTIONS[dialect]]);
});

/* ======================================================= 字符与词法工具 */

const WS_RE = /\s/;
const IDENT_START_RE = /[A-Za-z_\u0080-\uffff]/;
const IDENT_PART_RE = /[A-Za-z0-9_$\u0080-\uffff]/;
const DIGIT_RE = /[0-9]/;

const MULTI_OPERATORS = [
  "#>>", "->>", "!~*", "::", "||", "->", "#>", "~*", "!~", "<=", ">=", "<>",
  "!=", "<<", ">>", "@>", "<@", ":=", "=>",
];

const SINGLE_OPERATORS = "=<>+-*/%^|&#~!@";

const BRACKET_PAIRS = { "(": ")", "[": "]", "{": "}" };
const BRACKET_CLOSERS = { ")": "(", "]": "[", "}": "{" };

/** token 类型 → 高亮层 CSS 类（ws / ident 不着色，使用默认文字色） */
const TOKEN_CLASS = {
  kw: "sf-tok--kw",
  type: "sf-tok--type",
  func: "sf-tok--func",
  str: "sf-tok--str",
  num: "sf-tok--num",
  com: "sf-tok--com",
  op: "sf-tok--op",
  punct: "sf-tok--punct",
  qident: "sf-tok--qident",
  bind: "sf-tok--bind",
};

function isIdentStart(ch) {
  return ch !== undefined && IDENT_START_RE.test(ch);
}

function isIdentPart(ch) {
  return ch !== undefined && IDENT_PART_RE.test(ch);
}

/** 读取单引号字符串，返回结束下标（不含）；支持 '' 双写与可选的 \\ 转义 */
function scanSingleQuoted(text, quoteIndex, backslash) {
  const n = text.length;
  let i = quoteIndex + 1;
  while (i < n) {
    const ch = text[i];
    if (backslash && ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "'") {
      if (text[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return n;
}

/** 读取双引号标识符，返回结束下标（不含）；支持 "" 双写 */
function scanDoubleQuoted(text, quoteIndex) {
  const n = text.length;
  let i = quoteIndex + 1;
  while (i < n) {
    if (text[i] === '"') {
      if (text[i + 1] === '"') {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return n;
}

/** 读取 Oracle q'X … X' 字面量，返回结束下标（不含） */
function scanOracleQuoted(text, start) {
  const n = text.length;
  const open = text[start + 2];
  if (open === undefined) return n;
  const closeMap = { "[": "]", "{": "}", "(": ")", "<": ">" };
  const closeChar = closeMap[open] || open;
  const index = text.indexOf(`${closeChar}'`, start + 3);
  return index === -1 ? n : index + 2;
}

/** 读取 PostgreSQL 美元引用 $tag$ … $tag$，返回结束下标（不含） */
function scanDollarQuoted(text, start, tag) {
  const n = text.length;
  const index = text.indexOf(tag, start + tag.length);
  return index === -1 ? n : index + tag.length;
}

/* ========================================================== 词法分析 */

/**
 * 单遍扫描，产出覆盖全部字符的 token 流（无空隙，便于高亮层逐字还原）。
 * @param {string} sql
 * @param {string} dialect 'oracle' | 'postgres'
 * @returns {Array<{ type: string, value: string, start: number, end: number }>}
 */
export function tokenize(sql, dialect) {
  const text = String(sql === null || sql === undefined ? "" : sql);
  const dia = DIALECTS.includes(dialect) ? dialect : DEFAULT_CONFIG.dialect;
  const keywordSet = KEYWORDS[dia];
  const typeSet = TYPES[dia];
  const functionSet = FUNCTIONS[dia];

  const tokens = [];
  const n = text.length;
  let i = 0;

  const push = (type, start, end) => {
    tokens.push({ type, value: text.slice(start, end), start, end });
  };

  while (i < n) {
    const ch = text[i];

    /* 空白 */
    if (WS_RE.test(ch)) {
      const start = i;
      while (i < n && WS_RE.test(text[i])) i += 1;
      push("ws", start, i);
      continue;
    }

    /* 行注释 -- */
    if (ch === "-" && text[i + 1] === "-") {
      const start = i;
      i += 2;
      while (i < n && text[i] !== "\n") i += 1;
      push("com", start, i);
      continue;
    }

    /* 块注释 */
    if (ch === "/" && text[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i = Math.min(n, i + 2);
      push("com", start, i);
      continue;
    }

    /* PostgreSQL 美元引用（$n 位置参数不在此列） */
    if (ch === "$" && !DIGIT_RE.test(text[i + 1] || "")) {
      const match = /^\$([A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/.exec(
        text.slice(i)
      );
      if (match) {
        const start = i;
        const end = scanDollarQuoted(text, start, match[0]);
        push("str", start, end);
        i = end;
        continue;
      }
    }

    /* PostgreSQL 位置参数 $1 */
    if (ch === "$" && DIGIT_RE.test(text[i + 1] || "")) {
      const start = i;
      i += 2;
      while (i < n && DIGIT_RE.test(text[i])) i += 1;
      push("bind", start, i);
      continue;
    }

    /* Oracle q'[...]' 字面量（必须先于标识符扫描） */
    if ((ch === "q" || ch === "Q") && text[i + 1] === "'") {
      const start = i;
      const end = scanOracleQuoted(text, start);
      push("str", start, end);
      i = end;
      continue;
    }

    /* 单引号字符串 */
    if (ch === "'") {
      const start = i;
      const end = scanSingleQuoted(text, i, false);
      push("str", start, end);
      i = end;
      continue;
    }

    /* 带前缀的字符串：E'' / N'' / B'' / X'' */
    if (
      (ch === "E" || ch === "e" || ch === "N" || ch === "n" || ch === "B" ||
        ch === "b" || ch === "X" || ch === "x") &&
      text[i + 1] === "'"
    ) {
      const start = i;
      const backslash = ch === "E" || ch === "e";
      const end = scanSingleQuoted(text, i + 1, backslash);
      push("str", start, end);
      i = end;
      continue;
    }

    /* 双引号标识符 */
    if (ch === '"') {
      const start = i;
      const end = scanDoubleQuoted(text, i);
      push("qident", start, end);
      i = end;
      continue;
    }

    /* 数字（含 0x 十六进制与指数） */
    if (DIGIT_RE.test(ch)) {
      const start = i;
      if (ch === "0" && (text[i + 1] === "x" || text[i + 1] === "X")) {
        i += 2;
        while (i < n && /[0-9a-fA-F]/.test(text[i])) i += 1;
      } else {
        while (i < n && DIGIT_RE.test(text[i])) i += 1;
        if (text[i] === "." && DIGIT_RE.test(text[i + 1] || "")) {
          i += 1;
          while (i < n && DIGIT_RE.test(text[i])) i += 1;
        }
        if (text[i] === "e" || text[i] === "E") {
          const save = i;
          i += 1;
          if (text[i] === "+" || text[i] === "-") i += 1;
          if (DIGIT_RE.test(text[i] || "")) {
            while (i < n && DIGIT_RE.test(text[i])) i += 1;
          } else {
            i = save;
          }
        }
      }
      push("num", start, i);
      continue;
    }

    /* 绑定变量 :name / :1 */
    if (ch === ":") {
      if (text[i + 1] === ":") {
        push("op", i, i + 2);
        i += 2;
        continue;
      }
      if (isIdentStart(text[i + 1]) || DIGIT_RE.test(text[i + 1] || "")) {
        const start = i;
        i += 1;
        while (i < n && isIdentPart(text[i])) i += 1;
        push("bind", start, i);
        continue;
      }
      push("punct", i, i + 1);
      i += 1;
      continue;
    }

    /* 占位符 ? */
    if (ch === "?") {
      push("punct", i, i + 1);
      i += 1;
      continue;
    }

    /* 词（保留字 / 数据类型 / 内置函数 / 标识符） */
    if (isIdentStart(ch)) {
      const start = i;
      i += 1;
      while (i < n && isIdentPart(text[i])) i += 1;
      const value = text.slice(start, i);
      const upper = value.toUpperCase();
      // 紧跟左括号的内置函数名优先判定为函数（CAST / COUNT 等与保留字重名）
      let lookahead = i;
      while (lookahead < n && WS_RE.test(text[lookahead])) lookahead += 1;
      const callLike = text[lookahead] === "(" && functionSet.has(upper);
      let type = "ident";
      if (callLike) type = "func";
      else if (keywordSet.has(upper)) type = "kw";
      else if (typeSet.has(upper)) type = "type";
      else if (functionSet.has(upper)) type = "func";
      push(type, start, i);
      continue;
    }

    /* 括号与标点 */
    if (BRACKET_PAIRS[ch] || BRACKET_CLOSERS[ch] || ch === "," || ch === ";" || ch === ".") {
      push("punct", i, i + 1);
      i += 1;
      continue;
    }

    /* 运算符（先长后短） */
    {
      const three = text.slice(i, i + 3);
      const two = text.slice(i, i + 2);
      if (MULTI_OPERATORS.includes(three)) {
        push("op", i, i + 3);
        i += 3;
        continue;
      }
      if (MULTI_OPERATORS.includes(two)) {
        push("op", i, i + 2);
        i += 2;
        continue;
      }
      if (SINGLE_OPERATORS.includes(ch)) {
        push("op", i, i + 1);
        i += 1;
        continue;
      }
    }

    /* 兜底：未知字符按标点原样保留 */
    push("punct", i, i + 1);
    i += 1;
  }

  return tokens;
}

/**
 * 基于 token 流预计算括号配对关系（忽略字符串/注释内部的括号）。
 * @param {Array} tokens
 * @returns {{ pairs: Map<number, number>, unmatched: Set<number> }}
 *          键与值均为括号字符的字符下标
 */
export function buildBracketPairs(tokens) {
  const pairs = new Map();
  const unmatched = new Set();
  const stack = [];

  (Array.isArray(tokens) ? tokens : []).forEach((token) => {
    if (token.type !== "punct") return;
    if (BRACKET_PAIRS[token.value]) {
      stack.push(token);
      return;
    }
    if (!BRACKET_CLOSERS[token.value]) return;

    const index = stack.length - 1;
    if (index >= 0 && stack[index].value === BRACKET_CLOSERS[token.value]) {
      const open = stack.pop();
      pairs.set(open.start, token.start);
      pairs.set(token.start, open.start);
      return;
    }
    unmatched.add(token.start);
  });

  stack.forEach((token) => unmatched.add(token.start));
  return { pairs, unmatched };
}

/* ========================================================== 搜索匹配 */

/** 全词匹配的词边界判定字符集 */
function isWordChar(ch) {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

/**
 * 在纯文本中查找全部匹配区间（不依赖 DOM，可脱离浏览器验证）。
 * @param {string} text
 * @param {string} query
 * @param {{ caseSensitive?: boolean, wholeWord?: boolean, limit?: number }} [options]
 * @returns {Array<{ start: number, end: number }>}
 */
export function findMatches(text, query, options) {
  const source = String(text === null || text === undefined ? "" : text);
  const needleRaw = String(query === null || query === undefined ? "" : query);
  const opts = options && typeof options === "object" ? options : {};
  const caseSensitive = opts.caseSensitive === true;
  const wholeWord = opts.wholeWord === true;
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : MAX_MATCHES;

  const result = [];
  if (needleRaw === "" || source.length < needleRaw.length) return result;

  const needle = caseSensitive ? needleRaw : needleRaw.toLowerCase();
  const haystackLower = caseSensitive ? source : source.toLowerCase();
  // toLowerCase 可能改变长度（极少数 Unicode 字符），此时退化为逐段比较
  const fastPath = caseSensitive || haystackLower.length === source.length;

  let from = 0;
  while (from <= source.length - needleRaw.length) {
    let hit = -1;
    if (fastPath) {
      hit = haystackLower.indexOf(needle, from);
    } else {
      for (let k = from; k <= source.length - needleRaw.length; k += 1) {
        if (source.slice(k, k + needleRaw.length).toLowerCase() === needle) {
          hit = k;
          break;
        }
      }
    }
    if (hit === -1) break;

    const end = hit + needleRaw.length;
    const boundaryOk =
      !wholeWord ||
      (!isWordChar(source[hit - 1]) && !isWordChar(source[end]));

    if (boundaryOk) {
      result.push({ start: hit, end });
      if (result.length >= limit) break;
    }
    from = hit + 1;
  }

  return result;
}

/* ============================================== 高亮层 HTML（纯字符串） */

/**
 * 把 token 与标记渲染为高亮层 HTML。
 * 实现要点：
 *   1. 收集全部 token 与标记的边界作为断点；
 *   2. 逐段解析出该段所属的 token 与标记；
 *   3. 合并「同一标记」的连续段，使一个跨多个 token 的命中只产生
 *      **一个** `<mark>`——否则命中会被 token 边界切成多块，圆角与当前项描边断裂；
 *      合并后的内部仍按 token 分别着色。
 * 整层一次字符串拼接完成，不逐 token 建 DOM。
 * @param {string} text 原始文本
 * @param {Array} tokens tokenize 的结果
 * @param {Array<{ start: number, end: number, className: string }>} marks 覆盖标记
 * @param {(value: string) => string} escape 转义函数（复用 ctx.utils.dom.escapeHtml）
 * @returns {string}
 */
export function renderHighlight(text, tokens, marks, escape) {
  const source = String(text === null || text === undefined ? "" : text);
  const escapeFn = typeof escape === "function" ? escape : (value) => value;
  const tokenList = (Array.isArray(tokens) ? tokens : []).filter(
    (token) => token.end > token.start && TOKEN_CLASS[token.type]
  );
  const markList = (Array.isArray(marks) ? marks : [])
    .filter((mark) => mark && mark.end > mark.start && mark.className)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const breaks = new Set([0, source.length]);
  tokenList.forEach((token) => {
    breaks.add(token.start);
    breaks.add(token.end);
  });
  markList.forEach((mark) => {
    breaks.add(mark.start);
    breaks.add(mark.end);
  });

  const points = Array.from(breaks)
    .filter((value) => value >= 0 && value <= source.length)
    .sort((a, b) => a - b);

  let tokenCursor = 0;
  let markCursor = 0;
  const pieces = [];

  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (end <= start) continue;

    while (tokenCursor < tokenList.length && tokenList[tokenCursor].end <= start) {
      tokenCursor += 1;
    }
    while (markCursor < markList.length && markList[markCursor].end <= start) {
      markCursor += 1;
    }

    const activeToken = tokenList[tokenCursor];
    const activeMark = markList[markCursor];

    pieces.push({
      text: escapeFn(source.slice(start, end)),
      token:
        activeToken && activeToken.start <= start && activeToken.end >= end ? activeToken : null,
      mark: activeMark && activeMark.start <= start && activeMark.end >= end ? activeMark : null,
    });
  }

  let html = "";
  let cursor = 0;
  while (cursor < pieces.length) {
    // 同一标记覆盖的连续段合并为一个 <mark>，内部保留逐 token 着色
    const { mark } = pieces[cursor];
    let inner = "";
    let next = cursor;
    while (next < pieces.length && pieces[next].mark === mark) {
      const piece = pieces[next];
      inner += piece.token
        ? `<span class="${TOKEN_CLASS[piece.token.type]}">${piece.text}</span>`
        : piece.text;
      next += 1;
    }
    html += mark ? `<mark class="${mark.className}">${inner}</mark>` : inner;
    cursor = next;
  }

  return html;
}

/**
 * 按逻辑行分块渲染高亮层：每个逻辑行一个 HTML 片段，
 * 由调用方包裹为块级 .sf-line，从而让行号槽能按实际软换行高度精确对齐
 * （见 DESIGN.md §13.5）。跨行 token（块注释、多行字符串）按行裁剪后分段着色，
 * 视觉结果一致，且不会产生断裂的标签。
 * @param {string} text 原始文本
 * @param {Array} tokens tokenize 的结果
 * @param {Array<{ start: number, end: number, className: string }>} marks 覆盖标记
 * @param {(value: string) => string} escape 转义函数
 * @returns {string[]} 每逻辑行一段 HTML（长度与文本行数一致）
 */
export function renderHighlightLines(text, tokens, marks, escape) {
  const source = String(text === null || text === undefined ? "" : text);
  const escapeFn = typeof escape === "function" ? escape : (value) => value;
  const tokenList = Array.isArray(tokens) ? tokens : [];
  const markList = Array.isArray(marks) ? marks : [];

  const shift = (item, lineStart, lineEnd) => ({
    ...item,
    start: Math.max(item.start, lineStart) - lineStart,
    end: Math.min(item.end, lineEnd) - lineStart,
  });

  const lines = [];
  let lineStart = 0;
  let tokenCursor = 0;
  let markCursor = 0;

  for (let index = 0; index <= source.length; index += 1) {
    if (index !== source.length && source[index] !== "\n") continue;
    const lineEnd = index;

    while (tokenCursor < tokenList.length && tokenList[tokenCursor].end <= lineStart) {
      tokenCursor += 1;
    }
    while (markCursor < markList.length && markList[markCursor].end <= lineStart) {
      markCursor += 1;
    }

    const lineTokens = [];
    for (let k = tokenCursor; k < tokenList.length && tokenList[k].start < lineEnd; k += 1) {
      lineTokens.push(shift(tokenList[k], lineStart, lineEnd));
    }

    const lineMarks = [];
    for (let k = markCursor; k < markList.length && markList[k].start < lineEnd; k += 1) {
      lineMarks.push(shift(markList[k], lineStart, lineEnd));
    }

    lines.push(
      renderHighlight(source.slice(lineStart, lineEnd), lineTokens, lineMarks, escapeFn)
    );
    lineStart = index + 1;
  }

  return lines;
}

/* ====================================================== 配置模型（R7） */

export const DIALECT_LABEL = { oracle: "Oracle", postgres: "PostgreSQL" };

/** 默认参数：即「标准」预设 */
export const DEFAULT_CONFIG = Object.freeze({
  dialect: "oracle",
  indentStyle: "space",
  indentWidth: 2,
  keywordCase: "upper",
  functionCase: "lower",
  identifierCase: "preserve",
  commaPosition: "trailing",
  clauseNewline: true,
  selectListNewline: "auto",
  lineWidth: 100,
  parenNewline: false,
  logicalIndent: true,
  blankLines: "collapse",
});

const INDENT_STYLES = ["space", "tab"];
const INDENT_WIDTHS = [2, 4, 8];
const CASE_MODES = ["upper", "lower", "preserve"];
const COMMA_POSITIONS = ["trailing", "leading"];
const SELECT_LIST_MODES = ["always", "auto", "never"];
const LINE_WIDTHS = [0, 80, 100, 120];
const BLANK_LINE_MODES = ["preserve", "collapse"];

/** 全部配置字段，用于归一化与等价比较 */
const CONFIG_KEYS = [
  "dialect",
  "indentStyle",
  "indentWidth",
  "keywordCase",
  "functionCase",
  "identifierCase",
  "commaPosition",
  "clauseNewline",
  "selectListNewline",
  "lineWidth",
  "parenNewline",
  "logicalIndent",
  "blankLines",
];

function pickEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function pickBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function pickNumber(value, allowed, fallback) {
  return typeof value === "number" && allowed.includes(value) ? value : fallback;
}

/**
 * 把任意输入归一化为合法配置：缺失补默认、类型/取值不符回退、未知字段丢弃。
 * @param {Object} [partial]
 * @returns {typeof DEFAULT_CONFIG}
 */
export function normalizeConfig(partial) {
  const source = partial && typeof partial === "object" && !Array.isArray(partial) ? partial : {};
  return {
    dialect: pickEnum(source.dialect, DIALECTS, DEFAULT_CONFIG.dialect),
    indentStyle: pickEnum(source.indentStyle, INDENT_STYLES, DEFAULT_CONFIG.indentStyle),
    indentWidth: pickNumber(source.indentWidth, INDENT_WIDTHS, DEFAULT_CONFIG.indentWidth),
    keywordCase: pickEnum(source.keywordCase, CASE_MODES, DEFAULT_CONFIG.keywordCase),
    functionCase: pickEnum(source.functionCase, CASE_MODES, DEFAULT_CONFIG.functionCase),
    identifierCase: pickEnum(source.identifierCase, CASE_MODES, DEFAULT_CONFIG.identifierCase),
    commaPosition: pickEnum(source.commaPosition, COMMA_POSITIONS, DEFAULT_CONFIG.commaPosition),
    clauseNewline: pickBoolean(source.clauseNewline, DEFAULT_CONFIG.clauseNewline),
    selectListNewline: pickEnum(
      source.selectListNewline,
      SELECT_LIST_MODES,
      DEFAULT_CONFIG.selectListNewline
    ),
    lineWidth: pickNumber(source.lineWidth, LINE_WIDTHS, DEFAULT_CONFIG.lineWidth),
    parenNewline: pickBoolean(source.parenNewline, DEFAULT_CONFIG.parenNewline),
    logicalIndent: pickBoolean(source.logicalIndent, DEFAULT_CONFIG.logicalIndent),
    blankLines: pickEnum(source.blankLines, BLANK_LINE_MODES, DEFAULT_CONFIG.blankLines),
  };
}

/** 两份配置是否等价（用于判断当前参数是否仍与所选预设一致） */
export function configEquals(a, b) {
  const left = normalizeConfig(a);
  const right = normalizeConfig(b);
  return CONFIG_KEYS.every((key) => left[key] === right[key]);
}

/* ==================================================== 格式化引擎（纯函数） */

/** 主子句：另起一行，缩进为当前括号深度 */
const TOP_CLAUSES = new Set([
  "SELECT", "FROM", "WHERE", "GROUP", "HAVING", "ORDER", "WINDOW", "LIMIT",
  "OFFSET", "FETCH", "RETURNING", "VALUES", "SET", "UNION", "INTERSECT",
  "EXCEPT", "MINUS", "WITH", "INSERT", "INTO", "UPDATE", "DELETE", "MERGE",
  "CREATE", "ALTER", "DROP", "TRUNCATE", "GRANT", "REVOKE", "EXPLAIN",
  "ANALYZE", "CALL", "COMMIT", "ROLLBACK", "SAVEPOINT", "DECLARE", "BEGIN",
  "EXCEPTION", "OVER",
]);

/** 子子句：另起一行并比主子句多缩进一级 */
const SUB_CLAUSES = new Set([
  "JOIN", "ON", "USING", "AND", "OR", "WHEN", "THEN", "ELSE", "END", "CONNECT",
  "START",
]);

/**
 * 需要抑制换行的关键字组合（前一个保留字 → 不能在其后断行的保留字）。
 * 例：INSERT INTO、DELETE FROM、GROUP BY、UNION ALL、ON CONFLICT。
 */
const SUPPRESS_BREAK = {
  INSERT: ["INTO", "OVERWRITE"],
  REPLACE: ["INTO"],
  DELETE: ["FROM"],
  MERGE: ["INTO"],
  CREATE: [
    "TABLE", "VIEW", "INDEX", "UNIQUE", "SEQUENCE", "FUNCTION", "PROCEDURE",
    "PACKAGE", "TRIGGER", "MATERIALIZED", "TEMPORARY", "GLOBAL", "LOCAL", "OR",
    "PUBLIC", "SYNONYM", "TYPE", "SCHEMA", "DATABASE", "USER", "TABLESPACE",
  ],
  ALTER: [
    "TABLE", "VIEW", "INDEX", "SEQUENCE", "FUNCTION", "PROCEDURE", "PACKAGE",
    "TRIGGER", "TYPE", "SCHEMA", "DATABASE", "USER", "TABLESPACE", "SESSION",
    "SYSTEM",
  ],
  DROP: [
    "TABLE", "VIEW", "INDEX", "SEQUENCE", "FUNCTION", "PROCEDURE", "PACKAGE",
    "TRIGGER", "TYPE", "SCHEMA", "DATABASE", "USER", "TABLESPACE",
    "MATERIALIZED",
  ],
  TRUNCATE: ["TABLE"],
  UNION: ["ALL", "DISTINCT"],
  INTERSECT: ["ALL", "DISTINCT"],
  EXCEPT: ["ALL", "DISTINCT"],
  MINUS: ["ALL", "DISTINCT"],
  ORDER: ["BY"],
  GROUP: ["BY"],
  PARTITION: ["BY"],
  CONNECT: ["BY"],
  START: ["WITH"],
  ON: ["CONFLICT", "DELETE", "UPDATE", "INSERT", "DUPLICATE"],
  FETCH: ["FIRST", "NEXT"],
  IS: ["NOT", "NULL", "TRUE", "FALSE", "UNKNOWN", "DISTINCT"],
  NOT: ["IN", "LIKE", "ILIKE", "EXISTS", "BETWEEN", "NULL", "SIMILAR"],
  FOR: ["UPDATE", "SHARE", "NO", "KEY"],
  DO: ["NOTHING", "UPDATE"],
  END: ["IF", "LOOP", "CASE"],
  LEFT: ["OUTER", "JOIN"],
  RIGHT: ["OUTER", "JOIN"],
  FULL: ["OUTER", "JOIN"],
  INNER: ["JOIN"],
  CROSS: ["JOIN"],
  OUTER: ["JOIN"],
  NATURAL: ["JOIN", "LEFT", "RIGHT", "FULL", "INNER", "OUTER"],
};

/** 数据类型后紧接这些词时不换行（如 TIMESTAMP WITH TIME ZONE） */
const TYPE_CONTINUATIONS = new Set(["WITH", "WITHOUT", "LOCAL", "PRECISION", "VARYING", "ZONE"]);

/** 一元正负号的前置语境 */
const UNARY_PRECEDERS = new Set([
  "SELECT", "WHERE", "AND", "OR", "NOT", "WHEN", "THEN", "ELSE", "ON", "SET",
  "VALUES", "RETURNING", "IN", "BY", "AS", "HAVING", "LIMIT", "OFFSET",
]);

function isSuppressed(prev, upper) {
  if (!prev) return false;
  if (prev.type === "type" && TYPE_CONTINUATIONS.has(upper)) return true;
  const prevUpper = prev.type === "kw" || prev.type === "type" ? prev.value.toUpperCase() : "";
  const list = SUPPRESS_BREAK[prevUpper];
  return Array.isArray(list) && list.includes(upper);
}

function applyCase(value, mode) {
  if (mode === "upper") return value.toUpperCase();
  if (mode === "lower") return value.toLowerCase();
  return value;
}

/** 两个 token 之间是否需要空格 */
function needsSpace(prev, cur, afterUnary) {
  if (!prev || afterUnary) return false;
  const prevValue = prev.value;
  const curValue = cur.value;
  if (prevValue === "(" || prevValue === "[" || prevValue === "." || prevValue === "::") return false;
  if (curValue === ")" || curValue === "]" || curValue === "," || curValue === ";" || curValue === ".") {
    return false;
  }
  if (curValue === "::") return false;
  // 函数调用与类型修饰（VARCHAR2(20)、NUMBER(10)）后不留空格
  if (curValue === "(") return prev.type !== "func" && prev.type !== "type";
  return true;
}

function isUnarySign(prev, cur) {
  if (cur.type !== "op" || (cur.value !== "-" && cur.value !== "+")) return false;
  if (!prev) return true;
  if (prev.value === "(" || prev.value === "[" || prev.value === "," || prev.type === "op") return true;
  if (prev.type === "kw" && UNARY_PRECEDERS.has(prev.value.toUpperCase())) return true;
  return false;
}

/**
 * 该左括号是否值得展开换行：内部存在顶层逗号（参数/IN 列表），
 * 或包含一个子查询（顶层 SELECT）。单值括号（如 count(*)）不展开。
 */
function shouldBreakParen(tokens, openIndex) {
  let level = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "punct") {
      if (BRACKET_PAIRS[token.value]) {
        level += 1;
      } else if (BRACKET_CLOSERS[token.value]) {
        level -= 1;
        if (level <= 0) return false;
      } else if (token.value === "," && level === 1) {
        return true;
      }
      continue;
    }
    if (level === 1 && token.type === "kw" && token.value.toUpperCase() === "SELECT") return true;
  }
  return false;
}

/** JOIN 修饰词：LEFT / RIGHT / FULL / INNER / CROSS / NATURAL / OUTER */
const JOIN_MODIFIERS = new Set(["LEFT", "RIGHT", "FULL", "INNER", "CROSS", "NATURAL", "OUTER"]);

/**
 * 修饰词之后是否确实跟到 JOIN。只有确定是连接子句时，
 * 才在修饰词处断行，从而输出「LEFT JOIN」整体起一行而非「LEFT\n  JOIN」。
 */
function joinModifierBreaks(tokens, index) {
  for (let k = index + 1; k < tokens.length && k <= index + 3; k += 1) {
    const upper = tokens[k].type === "kw" ? tokens[k].value.toUpperCase() : "";
    if (upper === "JOIN") return true;
    if (!JOIN_MODIFIERS.has(upper)) return false;
  }
  return false;
}

/** 估算从 startIndex 到下一个同级主子句之间的文本长度（用于 auto 折行判定） */
function measureClauseLength(tokens, startIndex, depth) {
  let level = depth;
  let length = 0;
  for (let index = startIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "punct") {
      if (BRACKET_PAIRS[token.value]) {
        level += 1;
      } else if (BRACKET_CLOSERS[token.value]) {
        level -= 1;
        if (level < depth) break;
      }
    }
    if (level === depth && token.type === "kw") {
      const upper = token.value.toUpperCase();
      if (!SUB_CLAUSES.has(upper) && TOP_CLAUSES.has(upper)) {
        if (!isSuppressed(tokens[index - 1], upper)) break;
      }
    }
    length += token.value.length + 1;
  }
  return length;
}

function decideSelectListBreak(tokens, selectIndex, depth, cfg) {
  if (cfg.selectListNewline === "always") return true;
  if (cfg.selectListNewline === "never") return false;
  if (!cfg.lineWidth) return false;
  return measureClauseLength(tokens, selectIndex + 1, depth) > cfg.lineWidth;
}

/**
 * 格式化 SQL。
 * 基于 token 流做「子句感知」的折行与缩进，字符串/注释内容永远不会被改写，
 * 因此不会破坏字面量。
 * @param {string} sql
 * @param {Object} config
 * @returns {string}
 */
export function formatSql(sql, config) {
  const cfg = normalizeConfig(config);
  const rawTokens = tokenize(sql, cfg.dialect);

  /* 过滤空白，同时记录「前面有 2 个以上换行」以便 blankLines: preserve */
  const tokens = [];
  const blankBefore = [];
  let pendingNewlines = 0;

  rawTokens.forEach((token) => {
    if (token.type === "ws") {
      let count = 0;
      for (const ch of token.value) {
        if (ch === "\n") count += 1;
      }
      pendingNewlines += count;
      return;
    }
    tokens.push(token);
    blankBefore.push(pendingNewlines);
    pendingNewlines = 0;
  });

  if (tokens.length === 0) return "";

  const indentUnit = cfg.indentStyle === "tab" ? "\t" : " ".repeat(cfg.indentWidth);

  const out = [];
  const parenStack = [];
  let buffer = "";
  let indent = 0;
  let depth = 0;
  let lastEmitted = null;
  let afterUnary = false;

  /* SELECT 列表状态 */
  let inSelectList = false;
  let selectListDepth = -1;
  let selectListBreak = false;
  let logicalDepth = 0;
  /* 取值 >= 0 表示当前 token 输出完毕后需立即换行到该缩进层级 */
  let breakAfter = -1;

  const flushLine = () => {
    const text = buffer.replace(/[ \t]+$/, "");
    if (text !== "") out.push(indentUnit.repeat(Math.max(0, indent)) + text);
    buffer = "";
  };

  const breakLine = (nextIndent, blank) => {
    flushLine();
    if (blank && cfg.blankLines === "preserve" && out.length > 0) out.push("");
    indent = Math.max(0, nextIndent);
  };

  const wantsBlank = (index) =>
    cfg.blankLines === "preserve" && blankBefore[index] >= 2;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const prev = tokens[index - 1] || null;
    const upper =
      token.type === "kw" || token.type === "type" ? token.value.toUpperCase() : "";

    /* ---------------------------------------------------------- 注释 */
    if (token.type === "com") {
      // buffer 为空表示该 token 位于行首，不可再补前导空格
      if (buffer !== "" && needsSpace(lastEmitted, token, false)) buffer += " ";
      buffer += token.value;
      lastEmitted = token;
      afterUnary = false;
      if (token.value.startsWith("--")) breakLine(indent, false);
      continue;
    }

    /* -------------------------------------------------- 分号：语句结束 */
    if (token.value === ";") {
      buffer += ";";
      flushLine();
      indent = 0;
      depth = 0;
      parenStack.length = 0;
      inSelectList = false;
      selectListDepth = -1;
      logicalDepth = 0;
      lastEmitted = token;
      afterUnary = false;
      continue;
    }

    /* ------------------------------------------------------ 右括号 */
    if (token.value === ")" || token.value === "]" || token.value === "}") {
      if (token.value === ")") {
        const ctx = parenStack.pop();
        depth = Math.max(0, depth - 1);
        if (ctx) {
          inSelectList = ctx.inSelectList;
          selectListDepth = ctx.selectListDepth;
          selectListBreak = ctx.selectListBreak;
          logicalDepth = ctx.logicalDepth;
          if (ctx.breakInside) {
            breakLine(ctx.openIndent, false);
          }
        }
      }
      buffer += token.value;
      lastEmitted = token;
      afterUnary = false;
      continue;
    }

    /* ------------------------------------------------------ 左括号 */
    if (token.value === "(" || token.value === "[" || token.value === "{") {
      const isParen = token.value === "(";
      const breakInside = isParen && cfg.parenNewline && shouldBreakParen(tokens, index);
      const openIndent = indent;
      if (buffer !== "" && needsSpace(lastEmitted, token, false)) buffer += " ";
      buffer += token.value;
      lastEmitted = token;
      afterUnary = false;
      if (isParen) {
        parenStack.push({
          breakInside,
          openIndent,
          inSelectList,
          selectListDepth,
          selectListBreak,
          logicalDepth,
        });
        depth += 1;
        inSelectList = false;
        selectListDepth = -1;
        selectListBreak = false;
        // 未展开的括号内部不做 AND/OR 折行，避免「AND (a > 1\n OR b)」这类割裂
        logicalDepth = breakInside ? depth : logicalDepth;
        if (breakInside) breakLine(openIndent + 1, false);
      }
      continue;
    }

    /* ---------------------------------------------------------- 逗号 */
    if (token.value === ",") {
      const parenCtx = parenStack[parenStack.length - 1];
      const inSelect = inSelectList && depth === selectListDepth;
      const breakComma =
        (inSelect && selectListBreak) || Boolean(parenCtx && parenCtx.breakInside);

      if (breakComma) {
        const listIndent = parenCtx && !inSelect ? parenCtx.openIndent + 1 : selectListDepth + 1;
        if (cfg.commaPosition === "leading") {
          breakLine(listIndent, false);
          buffer = ",";
        } else {
          buffer += ",";
          breakLine(listIndent, false);
        }
      } else {
        buffer += ",";
      }
      lastEmitted = token;
      afterUnary = false;
      continue;
    }

    /* -------------------------------------------------------- 子句换行 */
    if (
      token.type === "kw" &&
      (TOP_CLAUSES.has(upper) || SUB_CLAUSES.has(upper) || JOIN_MODIFIERS.has(upper))
    ) {
      const suppressed = isSuppressed(prev, upper);
      if (!suppressed && JOIN_MODIFIERS.has(upper)) {
        if (joinModifierBreaks(tokens, index)) {
          logicalDepth = depth;
          breakLine(depth + 1, wantsBlank(index));
        }
      } else if (!suppressed) {
        if (SUB_CLAUSES.has(upper)) {
          const isLogical = upper === "AND" || upper === "OR";
          if (isLogical) {
            if (cfg.logicalIndent && depth === logicalDepth) {
              breakLine(depth + 1, wantsBlank(index));
            }
          } else {
            logicalDepth = depth;
            breakLine(depth + 1, wantsBlank(index));
          }
        } else if (cfg.clauseNewline) {
          breakLine(depth, wantsBlank(index));
          logicalDepth = depth;
          inSelectList = upper === "SELECT";
          selectListDepth = inSelectList ? depth : -1;
          selectListBreak = inSelectList
            ? decideSelectListBreak(tokens, index, depth, cfg)
            : false;
          // 逐列换行时，SELECT 之后立刻换行，使首列与其余列一样独占一行
          if (selectListBreak) breakAfter = depth + 1;
        }
      }
    }

    /* ------------------------------------------------------ 普通 token */
    const unary = isUnarySign(prev, token);
    if (unary) {
      buffer += token.value;
      lastEmitted = token;
      afterUnary = true;
      continue;
    }
    if (buffer !== "" && needsSpace(lastEmitted, token, afterUnary)) buffer += " ";

    if (token.type === "kw" || token.type === "type") {
      buffer += applyCase(token.value, cfg.keywordCase);
    } else if (token.type === "func") {
      buffer += applyCase(token.value, cfg.functionCase);
    } else if (token.type === "ident") {
      buffer += applyCase(token.value, cfg.identifierCase);
    } else {
      buffer += token.value;
    }

    lastEmitted = token;
    afterUnary = false;

    if (breakAfter >= 0) {
      const target = breakAfter;
      breakAfter = -1;
      if (buffer !== "") breakLine(target);
    }
  }

  flushLine();
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  return out.join("\n");
}

/* ==================================================== 预设与导入导出 */

/** 生成一个可读、低碰撞的本地 id */
function createPresetId() {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 内置预设：与自定义预设共用同一结构，仅是一组参数取值。
 * 新增预设只需追加数据，禁止编写分支代码（R7，见 DESIGN.md §13.4）。
 */
export const BUILTIN_PRESETS = [
  {
    id: "standard",
    name: "标准",
    description: "Oracle、2 空格缩进、关键字大写、每子句换行",
    config: normalizeConfig({}),
  },
  {
    id: "compact",
    name: "紧凑风格",
    description: "子句不换行、选择列表单行，适合简短语句",
    config: normalizeConfig({
      clauseNewline: false,
      selectListNewline: "never",
      logicalIndent: false,
    }),
  },
  {
    id: "expanded",
    name: "展开风格",
    description: "选择列表逐列换行，括号内换行，逻辑条件缩进",
    config: normalizeConfig({
      selectListNewline: "always",
      parenNewline: true,
      logicalIndent: true,
    }),
  },
  {
    id: "leading-comma",
    name: "前导逗号",
    description: "逗号置于新行行首",
    config: normalizeConfig({ commaPosition: "leading" }),
  },
  {
    id: "lowercase",
    name: "关键字小写",
    description: "保留字与内置函数名改为小写",
    config: normalizeConfig({ keywordCase: "lower", functionCase: "lower" }),
  },
  {
    id: "indent-4",
    name: "四空格缩进",
    description: "以 4 个空格作为缩进单位",
    config: normalizeConfig({ indentWidth: 4 }),
  },
  {
    id: "tab-indent",
    name: "Tab 缩进",
    description: "以制表符作为缩进单位",
    config: normalizeConfig({ indentStyle: "tab" }),
  },
  {
    id: "postgres",
    name: "PostgreSQL 惯例",
    description: "方言切换为 PostgreSQL",
    config: normalizeConfig({ dialect: "postgres" }),
  },
  {
    id: "oracle",
    name: "Oracle 惯例",
    description: "方言切换为 Oracle",
    config: normalizeConfig({ dialect: "oracle" }),
  },
].map((preset) => ({ ...preset, builtin: true }));

/**
 * 生成导出用的数据对象（带版本号，便于将来演进）。
 * @param {Array} presets 自定义预设
 * @param {Object} currentConfig 当前参数（仅作备份参考，导入时不会自动应用）
 */
export function serializePresets(presets, currentConfig) {
  return {
    app: EXPORT_APP,
    tool: EXPORT_TOOL,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    config: normalizeConfig(currentConfig),
    presets: (Array.isArray(presets) ? presets : []).map((preset) => ({
      name: preset.name,
      config: normalizeConfig(preset.config),
    })),
  };
}

/**
 * 解析并校验导入内容。校验失败整体抛错，绝不部分写入。
 * @param {string|Object} raw JSON 文本或已解析对象
 * @returns {{ presets: Array, stats: { total: number, valid: number, skipped: number } }}
 */
export function parseImportPayload(raw) {
  let data = raw;

  if (typeof raw === "string") {
    const text = raw.trim();
    if (text === "") {
      throw new Error("导入内容为空，请粘贴 JSON 文本或选择 JSON 文件。");
    }
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new Error("JSON 解析失败，请确认内容是合法的 JSON。");
    }
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("JSON 结构不正确：顶层应为一个对象。");
  }
  if (data.app !== undefined && data.app !== EXPORT_APP) {
    throw new Error(`该文件并非本工具的导出结果（app = ${String(data.app)}）。`);
  }
  if (data.tool !== undefined && data.tool !== EXPORT_TOOL) {
    throw new Error(`该文件属于其它工具（tool = ${String(data.tool)}），无法导入。`);
  }
  if (data.version !== undefined && data.version !== EXPORT_VERSION) {
    throw new Error(`不支持的版本号 ${String(data.version)}，当前仅支持 ${EXPORT_VERSION}。`);
  }
  if (!Array.isArray(data.presets)) {
    throw new Error("JSON 结构不正确：缺少 presets 数组。");
  }

  const source = data.presets;
  const presets = [];
  let skipped = 0;

  source.forEach((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      skipped += 1;
      return;
    }
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (name === "" || !item.config || typeof item.config !== "object") {
      skipped += 1;
      return;
    }
    presets.push({
      name: name.slice(0, MAX_NAME_LENGTH),
      config: normalizeConfig(item.config),
    });
  });

  if (presets.length === 0) {
    throw new Error("未解析到任何有效的预设记录。");
  }

  return {
    presets,
    stats: { total: source.length, valid: presets.length, skipped },
  };
}

/* ======================================================== 存储适配层 */

function readJson(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw);
  } catch (error) {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    return false;
  }
}

/** 归一化一条自定义预设记录，非法时返回 null */
function normalizePresetRecord(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const name = typeof item.name === "string" ? item.name.trim().slice(0, MAX_NAME_LENGTH) : "";
  if (name === "") return null;
  return {
    id: typeof item.id === "string" && item.id !== "" ? item.id : createPresetId(),
    name,
    config: normalizeConfig(item.config),
    createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
    builtin: false,
  };
}

/** 读取自定义预设列表（存储不可用或数据损坏时返回空数组） */
export function loadCustomPresets() {
  const raw = readJson(PRESETS_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizePresetRecord).filter(Boolean).slice(0, MAX_PRESETS);
}

/** 写入自定义预设列表，返回是否成功 */
export function saveCustomPresets(presets) {
  return writeJson(PRESETS_KEY, presets);
}

/**
 * 实例级配置键（docs/DESIGN.md §8.1 / §9.3）：
 * `serial <= 1`（含工具独立页）沿用既有键，保持零迁移零回归；
 * 同一工具的第 2 个及以后实例各用独立键，避免多个实例互相覆盖参数。
 * 自定义预设列表（`PRESETS_KEY`）**不分区**，跨实例共享。
 */
export function instanceSessionKey(instance) {
  const serial = instance && Number.isInteger(instance.serial) ? instance.serial : 1;
  return serial > 1 ? `${SESSION_KEY}:${serial}` : SESSION_KEY;
}

/** 读取上次使用的参数与预设选择（省略 storageKey 时读默认键） */
export function loadSession(storageKey = SESSION_KEY) {
  const raw = readJson(storageKey, null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return {
    config: normalizeConfig(raw.config),
    presetId: typeof raw.presetId === "string" ? raw.presetId : "",
  };
}

/** 写入上次使用的参数与预设选择（省略 storageKey 时写默认键） */
export function saveSession(config, presetId, storageKey = SESSION_KEY) {
  return writeJson(storageKey, { config: normalizeConfig(config), presetId });
}

/* ============================================================ 界面模板 */

const TEMPLATE = `
<div class="sf-toolbar">
  <div class="sf-toolbar__group">
    <label class="meta-label" for="sf-dialect">方言</label>
    <select class="select sf-select" id="sf-dialect">
      <option value="oracle">Oracle</option>
      <option value="postgres">PostgreSQL</option>
    </select>
    <button class="btn btn--primary" type="button" data-action="format">__I_FORMAT__ 格式化</button>
    <button class="icon-btn" type="button" data-action="find" title="关键词搜索（Ctrl/Cmd + F）"
            aria-label="关键词搜索">__I_SEARCH__</button>
  </div>
  <div class="sf-toolbar__actions">
    <label class="meta-label" for="sf-preset">预设</label>
    <select class="select sf-preset" id="sf-preset"></select>
    <button class="btn" type="button" data-action="save-preset">__I_SAVE__ 另存为</button>
    <button class="btn" type="button" data-action="delete-preset">__I_TRASH__ 删除</button>
    <button class="icon-btn" type="button" data-action="reset-config" title="恢复默认预设"
            aria-label="恢复默认预设">__I_REFRESH__</button>
    <button class="icon-btn" type="button" data-action="copy-json" title="复制预设 JSON"
            aria-label="复制预设 JSON">__I_JSON__</button>
    <button class="btn" type="button" data-action="export-presets">__I_DOWNLOAD__ 导出</button>
    <button class="btn" type="button" data-action="import-presets">__I_UPLOAD__ 导入</button>
  </div>
</div>

<p class="sf-status" id="sf-status" role="status" aria-live="polite"></p>

<form class="sf-inline" data-save-form hidden>
  <label class="sr-only" for="sf-preset-name">预设名称</label>
  <input class="input" id="sf-preset-name" type="text" maxlength="40" autocomplete="off"
         placeholder="输入预设名称，例如：Oracle 四空格缩进" />
  <button class="btn btn--primary" type="submit">保存</button>
  <button class="btn btn--ghost" type="button" data-action="cancel-save">取消</button>
</form>

<div class="sf-migrate" data-import-panel hidden>
  <div class="sf-migrate__head">
    <h3 class="sf-migrate__title">导入预设</h3>
    <button class="icon-btn" type="button" data-action="close-import" title="关闭"
            aria-label="关闭导入面板">__I_CLOSE__</button>
  </div>
  <p class="sf-migrate__note">
    JSON 在本机浏览器内解析，不会上传。同名预设将以导入内容为准覆盖，且不会改动你当前编辑的 SQL 与参数。
  </p>
  <div class="sf-migrate__row">
    <label class="btn" for="sf-import-file">__I_UPLOAD__ 选择 JSON 文件</label>
    <input class="sr-only" type="file" id="sf-import-file" accept=".json,application/json" />
    <span class="sf-migrate__file mono" data-import-filename>未选择文件</span>
  </div>
  <div class="field">
    <label class="field__label" for="sf-import-text">
      <span>或直接粘贴 JSON</span>
      <span class="field__hint">与「导出 / 复制 JSON」的内容格式一致</span>
    </label>
    <textarea class="textarea textarea--compact" id="sf-import-text" spellcheck="false"
              placeholder='{"app":"local-toolbox","tool":"sql-format","version":1,"presets":[…] }'></textarea>
  </div>
  <div class="sf-migrate__actions">
    <button class="btn btn--primary" type="button" data-action="confirm-import">导入预设</button>
    <button class="btn btn--ghost" type="button" data-action="close-import">取消</button>
  </div>
</div>

<div class="notice notice--danger" data-error hidden>
  <span class="notice__icon" aria-hidden="true">__I_ALERT__</span>
  <div class="notice__body">
    <p class="notice__title">操作失败</p>
    <p class="notice__text" data-error-text></p>
  </div>
</div>

<div class="sf-find" data-find hidden>
  <label class="sr-only" for="sf-find-input">搜索关键词</label>
  <input class="input" id="sf-find-input" type="text" autocomplete="off" spellcheck="false"
         placeholder="搜索关键词…" />
  <span class="sf-find__count" data-find-count></span>
  <button class="icon-btn" type="button" data-action="find-prev"
          title="上一个匹配（Shift + Enter）" aria-label="上一个匹配">__I_UP__</button>
  <button class="icon-btn" type="button" data-action="find-next"
          title="下一个匹配（Enter）" aria-label="下一个匹配">__I_DOWN__</button>
  <label class="sf-find__check">
    <input type="checkbox" data-find-case /><span>区分大小写</span>
  </label>
  <label class="sf-find__check">
    <input type="checkbox" data-find-word /><span>全词匹配</span>
  </label>
  <span class="sf-find__spacer"></span>
  <button class="icon-btn" type="button" data-action="find-close" title="关闭搜索（Esc）"
          aria-label="关闭搜索">__I_CLOSE__</button>
</div>

<div class="sf-layout">
  <section class="panel" aria-labelledby="sf-panel-editor">
    <div class="panel__head">
      <h2 class="panel__title" id="sf-panel-editor">__I_DB__ SQL 编辑器</h2>
      <span class="panel__hint mono" data-editor-meta>0 行 · 0 字符</span>
    </div>
    <div class="panel__body sf-editor-host">
      <div class="sf-editor" data-editor>
        <div class="sf-gutter" aria-hidden="true"><div class="sf-gutter__inner" data-gutter></div></div>
        <div class="sf-code">
          <div class="sf-scroll" data-highlight-wrap>
            <pre class="sf-highlight" data-highlight aria-hidden="true"></pre>
          </div>
          <textarea class="sf-input" data-input spellcheck="false" wrap="soft"
                    aria-label="SQL 编辑区" aria-describedby="sf-editor-note"
                    placeholder="在此粘贴或输入 SQL…"></textarea>
        </div>
      </div>
    </div>
    <div class="panel__foot">
      <button class="btn" type="button" data-action="copy">__I_COPY__ 复制全部</button>
      <button class="btn" type="button" data-action="download">__I_DOWNLOAD__ 下载为 .sql</button>
      <button class="btn btn--ghost" type="button" data-action="clear">__I_TRASH__ 清空</button>
      <span class="panel__spacer"></span>
      <span class="panel__hint" id="sf-editor-note">零网络请求 · 零数据上传</span>
    </div>
  </section>

  <div class="sf-side">
    <section class="panel" aria-labelledby="sf-panel-options">
      <div class="panel__head">
        <h2 class="panel__title" id="sf-panel-options">__I_FORMAT__ 格式化选项</h2>
        <span class="panel__hint">点「格式化」后生效</span>
      </div>
      <div class="panel__body sf-options">
        <div class="field">
          <span class="field__label"><span>缩进</span></span>
          <div class="sf-inline-row">
            <select class="select" id="sf-indent-style" aria-label="缩进方式">
              <option value="space">空格</option>
              <option value="tab">Tab</option>
            </select>
            <select class="select" id="sf-indent-width" aria-label="缩进宽度">
              <option value="2">2</option>
              <option value="4">4</option>
              <option value="8">8</option>
            </select>
          </div>
          <p class="field__hint">选择 Tab 时忽略宽度</p>
        </div>

        <div class="field">
          <label class="field__label" for="sf-keyword-case">
            <span>关键字大小写</span>
            <span class="field__hint">保留字</span>
          </label>
          <select class="select" id="sf-keyword-case">
            <option value="upper">大写 SELECT</option>
            <option value="lower">小写 select</option>
            <option value="preserve">保持原样</option>
          </select>
        </div>

        <div class="field">
          <label class="field__label" for="sf-function-case">
            <span>函数名大小写</span>
            <span class="field__hint">如 count / COUNT</span>
          </label>
          <select class="select" id="sf-function-case">
            <option value="lower">小写</option>
            <option value="upper">大写</option>
            <option value="preserve">保持原样</option>
          </select>
        </div>

        <div class="field">
          <label class="field__label" for="sf-identifier-case">
            <span>标识符大小写</span>
            <span class="field__hint">双引号标识符不改写</span>
          </label>
          <select class="select" id="sf-identifier-case">
            <option value="preserve">保持原样</option>
            <option value="lower">小写</option>
            <option value="upper">大写</option>
          </select>
        </div>

        <div class="sf-options__group">
          <div class="field">
            <label class="field__label" for="sf-select-list">
              <span>选择列表换行</span>
              <span class="field__hint">SELECT 各列</span>
            </label>
            <select class="select" id="sf-select-list">
              <option value="auto">自动（超出行宽才换行）</option>
              <option value="always">每列一行</option>
              <option value="never">不换行</option>
            </select>
          </div>

          <div class="field">
            <label class="field__label" for="sf-line-width">
              <span>软性行宽</span>
              <span class="field__hint">0 表示不限制</span>
            </label>
            <select class="select" id="sf-line-width">
              <option value="0">不限制</option>
              <option value="80">80 字符</option>
              <option value="100">100 字符</option>
              <option value="120">120 字符</option>
            </select>
          </div>

          <div class="field">
            <span class="field__label">换行规则</span>
            <label class="checkbox">
              <input type="checkbox" id="sf-clause-newline" />
              <span>主子句各起一行（SELECT / FROM / WHERE…）</span>
            </label>
            <label class="checkbox">
              <input type="checkbox" id="sf-paren-newline" />
              <span>括号内换行（参数、IN 列表等）</span>
            </label>
            <label class="checkbox">
              <input type="checkbox" id="sf-logical-indent" />
              <span>AND / OR 换行并缩进</span>
            </label>
          </div>
        </div>

        <div class="sf-options__group">
          <div class="field">
            <label class="field__label" for="sf-comma-position">
              <span>逗号位置</span>
              <span class="field__hint">折行时</span>
            </label>
            <select class="select" id="sf-comma-position">
              <option value="trailing">行尾 a,</option>
              <option value="leading">行首 , a</option>
            </select>
          </div>

          <div class="field">
            <label class="field__label" for="sf-blank-lines">
              <span>空行处理</span>
              <span class="field__hint">原有多余空行</span>
            </label>
            <select class="select" id="sf-blank-lines">
              <option value="collapse">压缩为单行</option>
              <option value="preserve">保留</option>
            </select>
          </div>
        </div>
      </div>
    </section>

    <section class="panel" aria-labelledby="sf-panel-stats">
      <div class="panel__head">
        <h2 class="panel__title" id="sf-panel-stats">统计</h2>
      </div>
      <div class="panel__body">
        <div class="stats">
          <div class="stat">
            <div class="stat__value" data-stat="lines">0</div>
            <div class="stat__label">行数</div>
          </div>
          <div class="stat">
            <div class="stat__value" data-stat="chars">0</div>
            <div class="stat__label">字符数</div>
          </div>
          <div class="stat">
            <div class="stat__value" data-stat="cursor">1:1</div>
            <div class="stat__label">光标</div>
          </div>
        </div>
        <p class="sf-option-hint" data-too-large hidden>
          文本过大，已关闭语法高亮与搜索高亮以保证输入流畅。
        </p>
      </div>
    </section>
  </div>
</div>
`;

const ICON_TOKENS = {
  __I_DB__: ["database", 16],
  __I_FORMAT__: ["alignLeft", 15],
  __I_SEARCH__: ["search", 15],
  __I_UP__: ["chevronUp", 15],
  __I_DOWN__: ["chevronDown", 15],
  __I_SAVE__: ["save", 15],
  __I_TRASH__: ["trash", 15],
  __I_REFRESH__: ["refresh", 15],
  __I_JSON__: ["fileJson", 15],
  __I_DOWNLOAD__: ["download", 15],
  __I_UPLOAD__: ["upload", 15],
  __I_CLOSE__: ["close", 15],
  __I_ALERT__: ["alert", 18],
  __I_COPY__: ["copy", 15],
};

/* ========================================================== 通用小工具 */

/** 触发本地文件下载（Blob + 对象 URL，用完即释放） */
function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 以 UTF-8 读取本地文件（FileReader 本地解析，不上传） */
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result === null ? "" : reader.result));
    reader.onerror = () => reject(new Error("文件读取失败，请重试。"));
    reader.readAsText(file, "utf-8");
  });
}

/** 生成下载文件名用的日期串：20260913 */
function dateStamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

/* ============================================================== 入口 */

/**
 * 工具入口。
 * @param {Object} ctx
 * @param {HTMLElement} ctx.root      工具页内容区（main.workspace）
 * @param {Object} ctx.tool           注册表中的工具记录
 * @param {Object} ctx.utils          公共工具函数集合 { dom, clipboard, text }
 * @param {Object} ctx.icons          { icon(name, size) }
 * @param {string} ctx.site           站点元信息
 * @returns {() => void} 清理函数
 */
export function init(ctx) {
  const { root, tool, utils, icons } = ctx;
  // 宿主解析：标签面板内为 [data-tool-body]，工具独立页为 #tool-body（docs/DESIGN.md §9.3）
  const host = root.querySelector("[data-tool-body]") || root.querySelector("#tool-body");
  if (!host) return () => {};

  const { dom, clipboard, text: textUtils } = utils;
  const escapeHtml = dom.escapeHtml;

  // 实例级配置键：同一工具可开多个实例，各自记住自己的参数（docs/DESIGN.md §9.3）
  const sessionKey = instanceSessionKey(ctx.instance);
  const readSession = () => loadSession(sessionKey);
  const writeSession = (config, presetId) => saveSession(config, presetId, sessionKey);

  /* ------------------------------------------------------ 渲染模板 */
  host.innerHTML = TEMPLATE.replace(/__I_\w+__/g, (token) => {
    const entry = ICON_TOKENS[token];
    return entry ? icons.icon(entry[0], entry[1]) : "";
  });

  /* ------------------------------------------------------ 节点引用 */
  const el = (selector) => host.querySelector(selector);
  const nodes = {
    dialect: el("#sf-dialect"),
    preset: el("#sf-preset"),
    status: el("#sf-status"),
    saveForm: el("[data-save-form]"),
    presetName: el("#sf-preset-name"),
    importPanel: el("[data-import-panel]"),
    importFile: el("#sf-import-file"),
    importFileName: el("[data-import-filename]"),
    importText: el("#sf-import-text"),
    error: el("[data-error]"),
    errorText: el("[data-error-text]"),
    find: el("[data-find]"),
    findInput: el("#sf-find-input"),
    findCount: el("[data-find-count]"),
    findCase: el("[data-find-case]"),
    findWord: el("[data-find-word]"),
    editor: el("[data-editor]"),
    input: el("[data-input]"),
    highlight: el("[data-highlight]"),
    scroll: el("[data-highlight-wrap]"),
    gutterWrap: el("[data-gutter]"),
    editorMeta: el("[data-editor-meta]"),
    tooLarge: el("[data-too-large]"),
    statLines: el('[data-stat="lines"]'),
    statChars: el('[data-stat="chars"]'),
    statCursor: el('[data-stat="cursor"]'),
    indentStyle: el("#sf-indent-style"),
    indentWidth: el("#sf-indent-width"),
    keywordCase: el("#sf-keyword-case"),
    functionCase: el("#sf-function-case"),
    identifierCase: el("#sf-identifier-case"),
    selectList: el("#sf-select-list"),
    lineWidth: el("#sf-line-width"),
    clauseNewline: el("#sf-clause-newline"),
    parenNewline: el("#sf-paren-newline"),
    logicalIndent: el("#sf-logical-indent"),
    commaPosition: el("#sf-comma-position"),
    blankLines: el("#sf-blank-lines"),
    actions: {
      format: el('[data-action="format"]'),
      find: el('[data-action="find"]'),
      findPrev: el('[data-action="find-prev"]'),
      findNext: el('[data-action="find-next"]'),
      findClose: el('[data-action="find-close"]'),
      save: el('[data-action="save-preset"]'),
      remove: el('[data-action="delete-preset"]'),
      reset: el('[data-action="reset-config"]'),
      copyJson: el('[data-action="copy-json"]'),
      exportJson: el('[data-action="export-presets"]'),
      importJson: el('[data-action="import-presets"]'),
      copy: el('[data-action="copy"]'),
      download: el('[data-action="download"]'),
      clear: el('[data-action="clear"]'),
      cancelSave: el('[data-action="cancel-save"]'),
      confirmImport: el('[data-action="confirm-import"]'),
    },
  };

  if (!nodes.input || !nodes.highlight || !nodes.gutterWrap) return () => {};

  /* ------------------------------------------------------ 运行状态 */
  const state = {
    customPresets: loadCustomPresets(),
    presetId: "standard",
    tokens: [],
    bracketPairs: new Map(),
    bracketTokens: [],
    matches: [],
    matchIndex: -1,
    sameText: "",
    sameMatches: [],
    lineStarts: [0],
    gutterLines: 0,
    highlightDisabled: false,
    syncing: false,
    removeArmed: false,
  };

  const timers = { status: 0, remove: 0, copy: 0 };
  const disposers = [];
  let renderRaf = 0;
  let scrollRaf = 0;
  let selectionRaf = 0;

  const bind = (target, type, handler, options) => {
    disposers.push(dom.on(target, type, handler, options));
  };

  const clearTimer = (key) => {
    if (timers[key]) {
      window.clearTimeout(timers[key]);
      timers[key] = 0;
    }
  };

  /* ------------------------------------------------------ 状态提示 */

  function setStatus(message, tone) {
    if (!nodes.status) return;
    clearTimer("status");
    nodes.status.textContent = message;
    nodes.status.dataset.tone = tone || "info";
    if (message) {
      timers.status = window.setTimeout(() => {
        nodes.status.textContent = "";
        delete nodes.status.dataset.tone;
      }, FEEDBACK_MS * 2);
    }
  }

  function showError(message) {
    if (!nodes.error) return;
    nodes.errorText.textContent = message;
    nodes.error.hidden = false;
  }

  function clearError() {
    if (!nodes.error) return;
    nodes.error.hidden = true;
    nodes.errorText.textContent = "";
  }

  /* -------------------------------------------------- 表单读写同步 */

  function readForm() {
    return normalizeConfig({
      dialect: nodes.dialect.value,
      indentStyle: nodes.indentStyle.value,
      indentWidth: Number(nodes.indentWidth.value),
      keywordCase: nodes.keywordCase.value,
      functionCase: nodes.functionCase.value,
      identifierCase: nodes.identifierCase.value,
      commaPosition: nodes.commaPosition.value,
      clauseNewline: nodes.clauseNewline.checked,
      selectListNewline: nodes.selectList.value,
      lineWidth: Number(nodes.lineWidth.value),
      parenNewline: nodes.parenNewline.checked,
      logicalIndent: nodes.logicalIndent.checked,
      blankLines: nodes.blankLines.value,
    });
  }

  function writeForm(config) {
    const cfg = normalizeConfig(config);
    state.syncing = true;
    nodes.dialect.value = cfg.dialect;
    nodes.indentStyle.value = cfg.indentStyle;
    nodes.indentWidth.value = String(cfg.indentWidth);
    nodes.keywordCase.value = cfg.keywordCase;
    nodes.functionCase.value = cfg.functionCase;
    nodes.identifierCase.value = cfg.identifierCase;
    nodes.commaPosition.value = cfg.commaPosition;
    nodes.clauseNewline.checked = cfg.clauseNewline;
    nodes.selectList.value = cfg.selectListNewline;
    nodes.lineWidth.value = String(cfg.lineWidth);
    nodes.parenNewline.checked = cfg.parenNewline;
    nodes.logicalIndent.checked = cfg.logicalIndent;
    nodes.blankLines.value = cfg.blankLines;
    state.syncing = false;
  }

  /* ==================================================== 编辑器控制器 */

  const indentUnitText = () => {
    const cfg = readForm();
    return cfg.indentStyle === "tab" ? "\t" : " ".repeat(cfg.indentWidth);
  };

  /**
   * 用 value 替换当前选区（无选区时即插入），优先走 execCommand 以保留原生撤销栈。
   * execCommand 只在编辑区**持有焦点**时生效：焦点在按钮等元素上时它会静默失败
   * 或把文本插到旧光标处，因此这里必须校验实际结果，未生效则退化为 setRangeText。
   */
  function insertText(value) {
    const input = nodes.input;
    const before = input.value;
    let inserted = false;
    try {
      inserted = document.execCommand && document.execCommand("insertText", false, value);
    } catch (error) {
      inserted = false;
    }
    if (!inserted || input.value === before) {
      input.setRangeText(value, input.selectionStart, input.selectionEnd, "end");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return false;
    }
    return true;
  }

  /** 行号（基于预计算的行首偏移做二分查找） */
  function lineIndexOf(offset) {
    const starts = state.lineStarts;
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low;
  }

  function updateCursorStat() {
    const input = nodes.input;
    const offset = input.selectionStart;
    const line = lineIndexOf(offset);
    nodes.statCursor.textContent = `${line + 1}:${offset - state.lineStarts[line] + 1}`;
  }

  /** 行号槽高度与高亮层逐行对齐（软换行时行号仍与逻辑行对齐） */
  function alignGutter() {
    const lineElements = nodes.highlight.children;
    const numberElements = nodes.gutterWrap.children;
    const count = Math.min(lineElements.length, numberElements.length);
    if (count === 0) return;

    const heights = new Array(count);
    for (let index = 0; index < count; index += 1) {
      heights[index] = lineElements[index].offsetHeight;
    }
    for (let index = 0; index < count; index += 1) {
      const next = `${heights[index]}px`;
      if (numberElements[index].style.height !== next) numberElements[index].style.height = next;
    }
  }

  /** 括号匹配标记：仅高亮光标邻近的括号与其配对括号 */
  function computeBracketMarks() {
    if (state.highlightDisabled || state.bracketTokens.length === 0) return [];
    const input = nodes.input;
    if (input.selectionStart !== input.selectionEnd) return [];

    const caret = input.selectionStart;
    let target = null;
    for (const token of state.bracketTokens) {
      if (token.start === caret) {
        target = token;
        break;
      }
      if (token.end === caret) target = token;
    }
    if (!target) return [];

    const pairStart = state.bracketPairs.get(target.start);
    if (pairStart === undefined) {
      return [{ start: target.start, end: target.end, className: "sf-bracket--error" }];
    }
    return [
      { start: target.start, end: target.end, className: "sf-bracket" },
      { start: pairStart, end: pairStart + 1, className: "sf-bracket" },
    ];
  }

  /** 组合三类覆盖标记：搜索命中（优先）→ 选中相同文本 → 括号匹配 */
  function composeMarks() {
    const marks = [];
    state.matches.forEach((match, index) => {
      marks.push({
        start: match.start,
        end: match.end,
        className: index === state.matchIndex ? "sf-hit sf-hit--current" : "sf-hit",
      });
    });
    state.sameMatches.forEach((match) => {
      const clash = state.matches.some((hit) => hit.start < match.end && match.start < hit.end);
      if (!clash) marks.push({ start: match.start, end: match.end, className: "sf-same" });
    });
    computeBracketMarks().forEach((mark) => marks.push(mark));
    return marks;
  }

  function updateFindCount(query) {
    if (!nodes.findCount) return;
    const total = state.matches.length;
    if (total === 0) {
      const empty = query === "";
      nodes.findCount.textContent = empty ? "" : "无匹配";
      if (empty) delete nodes.findCount.dataset.tone;
      else nodes.findCount.dataset.tone = "warn";
      return;
    }
    delete nodes.findCount.dataset.tone;
    nodes.findCount.textContent = `${state.matchIndex + 1}/${total}`;
  }

  function render() {
    const input = nodes.input;
    const value = input.value;
    const cfg = readForm();

    /* 统计 */
    const lineCount = textUtils.countLines(value);
    const charCount = textUtils.countChars(value);
    nodes.statLines.textContent = String(lineCount);
    nodes.statChars.textContent = String(charCount);
    nodes.editorMeta.textContent = `${lineCount} 行 · ${charCount} 字符`;

    /* 行首偏移表：供光标定位与滚动定位使用 */
    const lineStarts = [0];
    for (let index = 0; index < value.length; index += 1) {
      if (value.charCodeAt(index) === 10) lineStarts.push(index + 1);
    }
    state.lineStarts = lineStarts.length > 0 ? lineStarts : [0];

    /* 高亮开关 */
    const disabled = value.length > MAX_HIGHLIGHT_CHARS;
    state.highlightDisabled = disabled;
    nodes.tooLarge.hidden = !disabled;

    /* 词法与标记 */
    const findQuery = nodes.find.hidden ? "" : nodes.findInput.value;
    if (disabled) {
      state.tokens = [];
      state.bracketTokens = [];
      state.bracketPairs = new Map();
      state.matches = [];
      state.matchIndex = -1;
      state.sameMatches = [];
    } else {
      state.tokens = tokenize(value, cfg.dialect);
      const bracketInfo = buildBracketPairs(state.tokens);
      state.bracketPairs = bracketInfo.pairs;
      state.bracketTokens = state.tokens.filter(
        (token) =>
          token.type === "punct" && (BRACKET_PAIRS[token.value] || BRACKET_CLOSERS[token.value])
      );
      state.matches = findMatches(value, findQuery, {
        caseSensitive: nodes.findCase.checked,
        wholeWord: nodes.findWord.checked,
      });
      if (state.matchIndex >= state.matches.length) state.matchIndex = state.matches.length - 1;
      if (state.matchIndex < 0 && state.matches.length > 0) state.matchIndex = 0;
    }
    updateFindCount(findQuery);

    /* 高亮层：整层一次赋值，逐逻辑行分块 */
    const lineHtml = disabled
      ? value.split("\n").map((line) => escapeHtml(line))
      : renderHighlightLines(value, state.tokens, composeMarks(), escapeHtml);

    let html = "";
    for (let index = 0; index < lineHtml.length; index += 1) {
      html += `<span class="sf-line">${lineHtml[index]}</span>`;
    }
    nodes.highlight.innerHTML = html;

    /* 行号槽：仅在行数变化时重建 DOM，高度每次重新对齐 */
    if (state.gutterLines !== lineHtml.length) {
      let numbers = "";
      for (let index = 0; index < lineHtml.length; index += 1) {
        numbers += `<span class="sf-ln">${index + 1}</span>`;
      }
      nodes.gutterWrap.innerHTML = numbers;
      state.gutterLines = lineHtml.length;
    }
    alignGutter();
    updateCursorStat();
    syncScroll();
  }

  function scheduleRender() {
    if (renderRaf) return;
    renderRaf = window.requestAnimationFrame(() => {
      renderRaf = 0;
      render();
    });
  }

  /** 结算尚未执行的合并渲染（复制、下载、格式化等即时操作前调用） */
  function flushRender() {
    if (renderRaf) {
      window.cancelAnimationFrame(renderRaf);
      renderRaf = 0;
      render();
    }
  }

  function syncScroll() {
    const top = nodes.input.scrollTop;
    nodes.scroll.style.transform = `translateY(${-top}px)`;
    nodes.gutterWrap.style.transform = `translateY(${-top}px)`;
  }

  function onScroll() {
    if (scrollRaf) return;
    scrollRaf = window.requestAnimationFrame(() => {
      scrollRaf = 0;
      syncScroll();
    });
  }

  /** 选中相同文本全部高亮（限制：非空、单行、长度不超过阈值） */
  function refreshSameSelection() {
    const input = nodes.input;
    const value = input.value;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const selected = value.slice(start, end);

    if (
      state.highlightDisabled ||
      selected === "" ||
      selected === state.sameText ||
      selected.length > MAX_SAME_SELECTION ||
      selected.includes("\n")
    ) {
      if (selected === "" || selected.length > MAX_SAME_SELECTION || selected.includes("\n")) {
        state.sameText = "";
        state.sameMatches = [];
        scheduleRender();
      }
      return;
    }

    state.sameText = selected;
    state.sameMatches = findMatches(value, selected, { caseSensitive: true });
    scheduleRender();
  }

  function scheduleSelection() {
    if (selectionRaf) return;
    selectionRaf = window.requestAnimationFrame(() => {
      selectionRaf = 0;
      refreshSameSelection();
      updateCursorStat();
      scheduleRender();
    });
  }

  /** 把某个偏移滚动到可视区（底部留 24px 余量） */
  function scrollOffsetIntoView(offset) {
    const lines = nodes.highlight.children;
    if (lines.length === 0) return;
    const target = lines[Math.min(lineIndexOf(offset), lines.length - 1)];
    if (!target) return;

    const margin = 24;
    const top = target.offsetTop;
    const bottom = top + target.offsetHeight;
    const input = nodes.input;
    const viewTop = input.scrollTop;
    const viewBottom = viewTop + input.clientHeight;

    if (top < viewTop + margin) input.scrollTop = Math.max(0, top - margin);
    else if (bottom > viewBottom - margin) {
      input.scrollTop = bottom - input.clientHeight + margin;
    }
    syncScroll();
  }

  /** 搜索定位：delta 为 +1 / -1，循环跳转 */
  function gotoMatch(delta) {
    if (state.matches.length === 0) {
      setStatus("未找到匹配项。", "warn");
      nodes.findInput.focus();
      return;
    }
    const total = state.matches.length;
    state.matchIndex = (state.matchIndex + delta + total) % total;
    const match = state.matches[state.matchIndex];
    nodes.input.focus();
    nodes.input.setSelectionRange(match.start, match.end);
    scrollOffsetIntoView(match.start);
    render();
  }

  /** Tab / Shift + Tab：单行插入缩进，多行选区整体缩进或反缩进 */
  function handleTab(shift) {
    const input = nodes.input;
    const unit = indentUnitText();
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const value = input.value;

    if (!shift && !value.slice(start, end).includes("\n")) {
      insertText(unit);
      return;
    }

    const blockStart = value.lastIndexOf("\n", start - 1) + 1;
    let blockEnd = value.indexOf("\n", end);
    if (blockEnd === -1) blockEnd = value.length;

    const lines = value.slice(blockStart, blockEnd).split("\n");
    const next = lines
      .map((line) => {
        if (!shift) return unit + line;
        if (line.startsWith(unit)) return line.slice(unit.length);
        const leading = /^[ \t]+/.exec(line);
        return leading ? line.slice(Math.min(leading[0].length, unit.length)) : line;
      })
      .join("\n");

    input.setSelectionRange(blockStart, blockEnd);
    insertText(next);
    input.setSelectionRange(blockStart, blockStart + next.length);
  }

  /** Enter：按当前行缩进与括号深度自动续缩进 */
  function handleEnter() {
    const input = nodes.input;
    const value = input.value;
    if (input.selectionStart !== input.selectionEnd) return;
    const position = input.selectionStart;
    const lineStart = value.lastIndexOf("\n", position - 1) + 1;
    const leading = /^[ \t]*/.exec(value.slice(lineStart, position));
    const base = leading ? leading[0] : "";
    const opens = /[([{]\s*$/.test(value.slice(0, position));
    const closes = /[)\]}]/.test(value.charAt(position));
    const unit = indentUnitText();

    if (opens && closes) insertText(`\n${base}${unit}\n${base}`);
    else insertText(`\n${base}${opens ? unit : ""}`);
  }

  function clearInput() {
    nodes.input.value = "";
    state.sameText = "";
    state.sameMatches = [];
    flushRender();
    nodes.input.focus();
  }

  /* ------------------------------------------------------ 预设管理 */

  const allPresets = () => [...BUILTIN_PRESETS, ...state.customPresets];
  const currentPreset = () => allPresets().find((item) => item.id === state.presetId) || null;
  const isCustomSelected = () => state.presetId === CUSTOM_ID;

  function renderPresetOptions() {
    const option = (preset) =>
      `<option value="${escapeHtml(preset.id)}">${escapeHtml(preset.name)}</option>`;

    let html = `<optgroup label="内置预设">${BUILTIN_PRESETS.map(option).join("")}</optgroup>`;
    if (state.customPresets.length > 0) {
      html += `<optgroup label="我的预设">${state.customPresets.map(option).join("")}</optgroup>`;
    }
    if (isCustomSelected()) {
      html += `<option value="${CUSTOM_ID}">自定义（未保存）</option>`;
    }

    nodes.preset.innerHTML = html;
    nodes.preset.value = state.presetId;

    const preset = currentPreset();
    const hasCustom = state.customPresets.length > 0;
    nodes.actions.remove.disabled = !preset || preset.builtin === true;
    nodes.actions.remove.title = nodes.actions.remove.disabled
      ? "仅自定义预设可删除"
      : `删除预设「${preset.name}」`;
    nodes.actions.exportJson.disabled = !hasCustom;
    nodes.actions.exportJson.title = hasCustom ? "导出全部自定义预设" : "暂无自定义预设可导出";
    nodes.actions.copyJson.disabled = !hasCustom;
    nodes.actions.copyJson.title = hasCustom ? "复制预设 JSON" : "暂无自定义预设可复制";
  }

  /** 选中预设并填表（syncing 标记避免被误判为手动改动） */
  function applyPreset(id, options) {
    const preset = allPresets().find((item) => item.id === id);
    if (!preset) {
      renderPresetOptions();
      return;
    }
    state.presetId = preset.id;
    writeForm(preset.config);
    renderPresetOptions();
    render();
    writeSession(readForm(), state.presetId);
    if (!options || options.silent !== true) {
      setStatus(`已应用预设「${preset.name}」`, "ok");
    }
  }

  /** 标记为「自定义（未保存）」 */
  function markDirty() {
    if (state.syncing) return;
    if (state.presetId === CUSTOM_ID) return;
    state.presetId = CUSTOM_ID;
    renderPresetOptions();
  }

  /** 两段式内联确认，避免使用 window.confirm */
  function resetRemoveButton() {
    state.removeArmed = false;
    nodes.actions.remove.classList.remove("is-armed");
    nodes.actions.remove.innerHTML = `${icons.icon("trash", 15)} 删除`;
  }

  function armRemove() {
    const preset = currentPreset();
    if (!preset || preset.builtin) return;

    if (!state.removeArmed) {
      state.removeArmed = true;
      nodes.actions.remove.classList.add("is-armed");
      nodes.actions.remove.innerHTML = "确认删除？";
      clearTimer("remove");
      timers.remove = window.setTimeout(resetRemoveButton, REMOVE_CONFIRM_MS);
      return;
    }

    clearTimer("remove");
    resetRemoveButton();
    state.customPresets = state.customPresets.filter((item) => item.id !== preset.id);
    const saved = saveCustomPresets(state.customPresets);
    if (!saved) showError("本地存储不可用，删除结果仅在当前页面内有效。");
    setStatus(`已删除预设「${preset.name}」`, "warn");
    applyPreset("standard", { silent: true });
    renderPresetOptions();
  }

  function openSaveForm() {
    clearError();
    nodes.saveForm.hidden = false;
    const preset = currentPreset();
    nodes.presetName.value = preset && !preset.builtin ? preset.name : "";
    nodes.presetName.focus();
    nodes.presetName.select();
  }

  function closeSaveForm() {
    nodes.saveForm.hidden = true;
    nodes.presetName.value = "";
  }

  function submitSaveForm(event) {
    if (event) event.preventDefault();
    clearError();

    const name = nodes.presetName.value.trim().slice(0, MAX_NAME_LENGTH);
    if (name === "") {
      showError("请输入预设名称。");
      nodes.presetName.focus();
      return;
    }
    if (BUILTIN_PRESETS.some((preset) => preset.name === name)) {
      showError(`「${name}」与内置预设重名，请换一个名称。`);
      nodes.presetName.focus();
      return;
    }

    const config = readForm();
    const existing = state.customPresets.find((preset) => preset.name === name);

    if (existing) {
      existing.config = config;
      state.presetId = existing.id;
      setStatus(`已更新预设「${name}」`, "ok");
    } else {
      if (state.customPresets.length >= MAX_PRESETS) {
        showError(`自定义预设最多 ${MAX_PRESETS} 条，请先删除一些再保存。`);
        return;
      }
      const created = {
        id: createPresetId(),
        name,
        config,
        createdAt: new Date().toISOString(),
        builtin: false,
      };
      state.customPresets.push(created);
      state.presetId = created.id;
      setStatus(`已保存预设「${name}」`, "ok");
    }

    if (!saveCustomPresets(state.customPresets)) {
      showError("本地存储不可用（可能处于无痕模式），本次保存仅在当前页面内有效。");
    }
    writeSession(config, state.presetId);
    closeSaveForm();
    renderPresetOptions();
  }

  /* ------------------------------------------------------ 导入 / 导出 */

  function buildExportJson() {
    return JSON.stringify(serializePresets(state.customPresets, readForm()), null, 2);
  }

  function exportJson() {
    if (state.customPresets.length === 0) {
      setStatus("暂无自定义预设可导出，请先「另存为」。", "warn");
      return;
    }
    downloadFile(`sql-format-presets-${dateStamp()}.json`, buildExportJson(), "application/json");
    setStatus(`已导出 ${state.customPresets.length} 条预设`, "ok");
  }

  async function copyJson() {
    if (state.customPresets.length === 0) {
      setStatus("暂无自定义预设可复制，请先「另存为」。", "warn");
      return;
    }
    const ok = await clipboard.copyText(buildExportJson());
    setStatus(ok ? "预设 JSON 已复制到剪贴板" : "复制失败，请改用「导出」下载文件。", ok ? "ok" : "danger");
  }

  function toggleImportPanel(force) {
    const next = typeof force === "boolean" ? force : nodes.importPanel.hidden;
    nodes.importPanel.hidden = !next;
    if (next) {
      clearError();
      nodes.importText.focus();
    }
  }

  async function confirmImport() {
    clearError();

    let raw = nodes.importText.value.trim();
    const file = nodes.importFile.files && nodes.importFile.files[0];

    if (raw === "" && file) {
      try {
        raw = await readFileAsText(file);
      } catch (error) {
        showError(error.message);
        return;
      }
    }
    if (raw === "") {
      showError("请选择 JSON 文件，或粘贴 JSON 文本后再导入。");
      return;
    }

    let parsed;
    try {
      parsed = parseImportPayload(raw);
    } catch (error) {
      showError(error.message);
      return;
    }

    let added = 0;
    let overwritten = 0;
    let overflow = 0;

    parsed.presets.forEach((item) => {
      const hit = state.customPresets.find((preset) => preset.name === item.name);
      if (hit) {
        hit.config = item.config;
        overwritten += 1;
        return;
      }
      if (state.customPresets.length >= MAX_PRESETS) {
        overflow += 1;
        return;
      }
      state.customPresets.push({
        id: createPresetId(),
        name: item.name,
        config: item.config,
        createdAt: new Date().toISOString(),
        builtin: false,
      });
      added += 1;
    });

    if (!saveCustomPresets(state.customPresets)) {
      showError("本地存储不可用（可能处于无痕模式），本次导入仅在当前页面内有效。");
    }

    const parts = [`新增 ${added} 条`, `覆盖 ${overwritten} 条`];
    if (overflow > 0) parts.push(`超出上限跳过 ${overflow} 条`);
    if (parsed.stats.skipped > 0) parts.push(`忽略非法 ${parsed.stats.skipped} 条`);
    setStatus(`导入完成：${parts.join("，")}`, added + overwritten > 0 ? "ok" : "warn");

    // 导入只恢复预设，不改动当前正在编辑的 SQL 与当前参数
    renderPresetOptions();
    nodes.importText.value = "";
    nodes.importFile.value = "";
    nodes.importFileName.textContent = "未选择文件";
    toggleImportPanel(false);
  }

  /* --------------------------------------------------------- 主操作 */

  /** 格式化：用格式化结果覆盖编辑框现有内容（含原有选区），而非在光标处插入 */
  function runFormat() {
    flushRender();
    const input = nodes.input;
    const value = input.value;
    if (value.trim() === "") {
      setStatus("暂无可格式化的内容。", "warn");
      input.focus();
      return;
    }

    const formatted = formatSql(value, readForm());
    if (formatted === "") {
      setStatus("暂无可格式化的内容。", "warn");
      return;
    }
    if (formatted === value) {
      setStatus("当前内容已是该格式，无需调整。", "info");
      return;
    }

    // 关键：先把焦点交还编辑区。点击「格式化」按钮后焦点在按钮上，
    // 此时设定选区并派发编辑命令不会生效，结果会被插到旧光标处而不是覆盖原文。
    input.focus({ preventScroll: true });
    // 覆盖式替换：先全选现有内容（含用户当前选区），再整体写入格式化结果
    input.setSelectionRange(0, value.length);
    const replaced = insertText(formatted);
    if (!replaced) {
      showError("当前浏览器不支持原地替换，已改用直接写入方式完成格式化。");
    }

    state.sameText = "";
    state.sameMatches = [];
    input.scrollTop = 0;
    input.setSelectionRange(0, 0);
    render();
    setStatus("已按当前参数格式化", "ok");
    writeSession(readForm(), state.presetId);
  }

  async function copyAll() {
    flushRender();
    const value = nodes.input.value;
    if (value === "") {
      setStatus("暂无可复制的内容。", "warn");
      return;
    }
    const ok = await clipboard.copyText(value);
    if (!ok) {
      setStatus("复制失败，请手动选择文本复制。", "danger");
      return;
    }
    clearTimer("copy");
    nodes.actions.copy.innerHTML = `${icons.icon("check", 15)} 已复制`;
    nodes.actions.copy.classList.add("is-ok");
    timers.copy = window.setTimeout(() => {
      nodes.actions.copy.innerHTML = `${icons.icon("copy", 15)} 复制全部`;
      nodes.actions.copy.classList.remove("is-ok");
    }, COPY_FEEDBACK_MS);
  }

  function downloadSql() {
    flushRender();
    const value = nodes.input.value;
    if (value.trim() === "") {
      setStatus("暂无可下载的内容。", "warn");
      return;
    }
    downloadFile(`sql-format-${dateStamp()}.sql`, value, "text/plain");
    setStatus("已下载 SQL 文件", "ok");
  }

  /* --------------------------------------------------------- 搜索条 */

  function openFind() {
    nodes.find.hidden = false;
    const input = nodes.input;
    const selected = input.value.slice(input.selectionStart, input.selectionEnd);
    if (selected !== "" && !selected.includes("\n") && selected.length <= MAX_SAME_SELECTION) {
      nodes.findInput.value = selected;
    }
    state.matchIndex = 0;
    render();
    nodes.findInput.focus();
    nodes.findInput.select();
  }

  function closeFind() {
    nodes.find.hidden = true;
    state.matches = [];
    state.matchIndex = -1;
    render();
    nodes.input.focus();
  }

  /* ---------------------------------------------------------- 事件 */

  bind(nodes.input, "input", () => {
    state.sameText = "";
    state.sameMatches = [];
    scheduleRender();
  });
  bind(nodes.input, "scroll", onScroll);
  bind(nodes.input, "click", scheduleSelection);
  bind(nodes.input, "keyup", scheduleSelection);
  bind(nodes.input, "mouseup", scheduleSelection);
  bind(nodes.input, "select", scheduleSelection);
  bind(nodes.input, "blur", () => {
    if (state.sameMatches.length === 0) return;
    state.sameText = "";
    state.sameMatches = [];
    scheduleRender();
  });
  bind(nodes.input, "keydown", (event) => {
    if (event.key === "Tab") {
      event.preventDefault();
      handleTab(event.shiftKey);
      return;
    }
    if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      handleEnter();
    }
  });

  bind(nodes.dialect, "change", () => {
    if (state.syncing) return;
    markDirty();
    render();
    writeSession(readForm(), state.presetId);
  });

  [
    nodes.indentStyle,
    nodes.indentWidth,
    nodes.keywordCase,
    nodes.functionCase,
    nodes.identifierCase,
    nodes.selectList,
    nodes.lineWidth,
    nodes.commaPosition,
    nodes.blankLines,
  ].forEach((node) => {
    bind(node, "change", () => {
      if (state.syncing) return;
      markDirty();
      render();
      writeSession(readForm(), state.presetId);
    });
  });

  [nodes.clauseNewline, nodes.parenNewline, nodes.logicalIndent].forEach((node) => {
    bind(node, "change", () => {
      if (state.syncing) return;
      markDirty();
      render();
      writeSession(readForm(), state.presetId);
    });
  });

  bind(nodes.preset, "change", () => {
    if (nodes.preset.value === CUSTOM_ID) return;
    applyPreset(nodes.preset.value);
  });

  bind(nodes.actions.format, "click", runFormat);
  bind(nodes.actions.copy, "click", copyAll);
  bind(nodes.actions.download, "click", downloadSql);
  bind(nodes.actions.clear, "click", clearInput);
  bind(nodes.actions.find, "click", () => (nodes.find.hidden ? openFind() : closeFind()));
  bind(nodes.actions.findClose, "click", closeFind);
  bind(nodes.actions.findPrev, "click", () => gotoMatch(-1));
  bind(nodes.actions.findNext, "click", () => gotoMatch(1));

  bind(nodes.saveForm, "submit", submitSaveForm);
  bind(nodes.actions.cancelSave, "click", closeSaveForm);
  bind(nodes.actions.save, "click", openSaveForm);
  bind(nodes.actions.remove, "click", armRemove);
  bind(nodes.actions.reset, "click", () => {
    clearError();
    applyPreset("standard");
  });
  bind(nodes.actions.exportJson, "click", exportJson);
  bind(nodes.actions.copyJson, "click", copyJson);
  bind(nodes.actions.importJson, "click", () => toggleImportPanel());
  host.querySelectorAll('[data-action="close-import"]').forEach((node) => {
    bind(node, "click", () => toggleImportPanel(false));
  });
  bind(nodes.actions.confirmImport, "click", confirmImport);

  bind(nodes.findInput, "input", () => {
    state.matchIndex = 0;
    render();
  });
  bind(nodes.findInput, "keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      gotoMatch(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeFind();
    }
  });
  bind(nodes.findCase, "change", () => {
    state.matchIndex = 0;
    render();
  });
  bind(nodes.findWord, "change", () => {
    state.matchIndex = 0;
    render();
  });

  bind(nodes.importFile, "change", () => {
    const file = nodes.importFile.files && nodes.importFile.files[0];
    nodes.importFileName.textContent = file ? file.name : "未选择文件";
    clearError();
  });

  // 快捷键归属：标签工作台内只有「焦点在本工具面板内」时才响应，
  // 否则并排/多标签时一次按键会同时触发多个工具（docs/DESIGN.md §9.3）
  const inTabsWorkspace = Boolean(root.closest("[data-tabs-workspace]"));
  bind(document, "keydown", (event) => {
    if (inTabsWorkspace && !root.contains(event.target)) return;
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      runFormat();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && (event.key === "f" || event.key === "F")) {
      event.preventDefault();
      openFind();
      return;
    }
    if (event.key === "Escape") {
      if (!nodes.saveForm.hidden) closeSaveForm();
      else if (!nodes.importPanel.hidden) toggleImportPanel(false);
      else if (!nodes.find.hidden) closeFind();
      else if (!nodes.error.hidden) clearError();
    }
  });

  /* ---------------------------------------------------------- 启动 */

  /**
   * 测量 textarea 常驻滚动条宽度，并以 CSS 变量补偿给高亮层，
   * 保证两者内容宽度严格一致、软换行位置完全对齐（见 DESIGN.md §13.5）。
   */
  function measureScrollbar() {
    const input = nodes.input;
    const width = Math.max(0, input.offsetWidth - input.clientWidth);
    nodes.editor.style.setProperty("--sf-sbw", `${width}px`);
  }

  bind(window, "resize", () => {
    measureScrollbar();
    alignGutter();
  });

  const session = readSession();
  if (session) {
    const preset = allPresets().find((item) => item.id === session.presetId);
    state.presetId = preset && configEquals(preset.config, session.config) ? preset.id : CUSTOM_ID;
    writeForm(session.config);
  } else {
    state.presetId = "standard";
    writeForm(DEFAULT_CONFIG);
  }

  renderPresetOptions();
  render();
  measureScrollbar();
  alignGutter();

  console.info(
    `[toolbox] 已挂载工具「${tool.name}」：方言 ${readForm().dialect}，内置预设 ${BUILTIN_PRESETS.length} 项，自定义预设 ${state.customPresets.length} 项`
  );

  /* ---------------------------------------------------------- 清理 */

  return () => {
    Object.keys(timers).forEach(clearTimer);
    if (renderRaf) window.cancelAnimationFrame(renderRaf);
    if (scrollRaf) window.cancelAnimationFrame(scrollRaf);
    if (selectionRaf) window.cancelAnimationFrame(selectionRaf);
    disposers.forEach((dispose) => dispose());
    dom.clear(host);
  };
}

export const meta = {
  id: "sql-format",
  version: "1.0.0",
  status: "ready",
};

export default init;
