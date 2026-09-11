/**
 * 公共文本处理纯函数
 * ------------------------------------------------------------------
 * 仅提供通用的、与具体工具无关的文本能力，供各工具模块按需引用。
 * 这里不实现任何具体工具的业务逻辑（例如「文本行合并」的合并规则）。
 */

/** 统一换行符为 \n */
export function normalizeLineEndings(value) {
  return String(value === null || value === undefined ? "" : value).replace(
    /\r\n?/g,
    "\n"
  );
}

/** 按行拆分为数组（保留空行信息） */
export function splitLines(value) {
  const text = normalizeLineEndings(value);
  if (text === "") return [];
  return text.split("\n");
}

/** 规范化为「行数组」：统一换行、按需去除每行首尾空白、按需丢弃空行 */
export function toLines(value, { trim = false, dropEmpty = false } = {}) {
  let lines = splitLines(value);
  if (trim) lines = lines.map((line) => line.trim());
  if (dropEmpty) lines = lines.filter((line) => line !== "");
  return lines;
}

/** 统计字符数（按 Unicode 码点计，兼容 emoji） */
export function countChars(value) {
  const text = String(value === null || value === undefined ? "" : value);
  return Array.from(text).length;
}

/** 统计行数（末行为空字符串时不计入） */
export function countLines(value) {
  const lines = splitLines(value);
  if (lines.length === 0) return 0;
  return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

/** 统计单词数（按空白切分，CJK 场景仅供参考） */
export function countWords(value) {
  const text = String(value === null || value === undefined ? "" : value).trim();
  return text === "" ? 0 : text.split(/\s+/).length;
}

/** 截断显示，超出长度时追加省略号 */
export function truncate(value, max = 80, suffix = "…") {
  const text = String(value === null || value === undefined ? "" : value);
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("") + suffix;
}
