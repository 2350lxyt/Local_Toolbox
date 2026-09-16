/**
 * 《日期天数计算器》
 * ==================================================================
 * 工具 id：date-calc（docs/DESIGN.md §14）
 *
 * 分层（§9.3）：
 *   ① 纯函数内核  ── 日期数学 / 类型判定 / 区间统计，零 DOM 依赖，可在 Node 中直接断言
 *   ② 存储适配层  ── 覆盖层与参数的 localStorage 读写（全部 try/catch 静默降级）
 *   ③ UI 编排层   ── init(ctx) 渲染界面、绑定事件、返回清理函数
 *
 * 关键约定：
 *   - 日期内部表示统一为「整数序列日号」（1970-01-01 = 0），全部整数运算；
 *     **禁止** `new Date('YYYY-MM-DD')`（按 UTC 解析会引入 ±1 天偏差）。
 *   - 任何行为差异都必须由 DEFAULT_CONFIG 的字段表达，不得存在隐藏分支（R7）。
 *   - 模块内不得有任何可变模块级状态（多实例共享同一模块，§9.3 第 8 条）。
 */

import {
  COVERAGE_YEARS,
  COVERAGE_RANGE,
  isCoveredYear,
  lookupBuiltinType,
  sourceOfYear,
} from "./cn-holidays.js";

/* ────────────────────────────────────────────────────────────────
 * 常量
 * ──────────────────────────────────────────────────────────────── */

const APP_ID = "local-toolbox";
const TOOL_ID = "date-calc";

/** 状态行清除（与既有工具一致：2000ms 提示 × 2） */
const STATE_CLEAR_MS = 4000;
/** 输入防抖（§6） */
const DEBOUNCE_MS = 180;
/** 两段式确认超时（§6） */
const CONFIRM_MS = 3000;
/** 导入导出结构版本（§8.4） */
const EXPORT_VERSION = 1;
/** 自定义日历条目上限 */
const MAX_OVERRIDES = 2000;
/** 区间跨度上限（年） */
const MAX_SPAN_YEARS = 100;
/** 推算步数上限 */
const MAX_SHIFT = 100000;

const CONFIG_KEY = `toolbox:${TOOL_ID}:config`;
const CALENDAR_KEY = `toolbox:${TOOL_ID}:calendar`;

const MS_PER_DAY = 86400000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/* ────────────────────────────────────────────────────────────────
 * ① 纯函数内核
 * ──────────────────────────────────────────────────────────────── */

/**
 * 日期类型（唯一真源，界面与计算共用）。
 * `rest === true` 表示该日计入「休息」，否则计入「工作日」。
 */
export const DAY_TYPES = Object.freeze({
  workday: Object.freeze({ key: "workday", label: "工作日", rest: false }),
  makeup: Object.freeze({ key: "makeup", label: "调休上班日", rest: false }),
  weekend: Object.freeze({ key: "weekend", label: "休息日", rest: true }),
  holiday: Object.freeze({ key: "holiday", label: "法定节假日", rest: true }),
});

/** 类型的固定展示顺序（工作日 → 调休 → 休息日 → 法定节假日） */
export const DAY_TYPE_KEYS = Object.freeze(["workday", "makeup", "weekend", "holiday"]);

/** 计算方式页签（唯一真源：界面、键盘与持久化共用） */
export const MODE_VALUES = Object.freeze(["span", "shift", "countdown"]);

/** 页签的展示名称 */
export const MODE_LABEL = Object.freeze({
  span: "日期间隔",
  shift: "日期推算",
  countdown: "天数计算",
});

/** 参数默认值（§14.2）。两个日历字段为 null 表示「今天所在年月」。 */
export const DEFAULT_CONFIG = Object.freeze({
  mode: "span",
  boundary: "exclusive",
  shiftBoundary: "exclusive",
  countdownBoundary: "exclusive",
  shiftUnit: "day",
  shiftDirection: "after",
  weekStartsOn: 1,
  calendarYear: null,
  calendarMonth: null,
});

const BOUNDARY_VALUES = Object.freeze(["exclusive", "inclusive"]);
const SHIFT_UNIT_VALUES = Object.freeze(["day", "week", "month", "year", "workday"]);
const SHIFT_DIRECTION_VALUES = Object.freeze(["after", "before"]);

const WEEKDAY_LABELS = Object.freeze(["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"]);
const WEEKDAY_SHORT = Object.freeze(["日", "一", "二", "三", "四", "五", "六"]);
const MONTH_LABELS = Object.freeze([
  "一月", "二月", "三月", "四月", "五月", "六月",
  "七月", "八月", "九月", "十月", "十一月", "十二月",
]);

/** 该年是否闰年 */
export function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** 该年该月的天数（month 为 1–12） */
export function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

const pad2 = (n) => String(n).padStart(2, "0");

/**
 * 是否为合法的 `YYYY-MM-DD` 日期（会校验真实存在的日期，如非闰年的 2 月 29 日判为非法）。
 * @param {unknown} iso
 * @returns {boolean}
 */
export function isValidISODate(iso) {
  if (typeof iso !== "string" || !ISO_DATE.test(iso)) return false;
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  if (year < 1 || year > 9999) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  return true;
}

/**
 * 日期字符串 → 整数日号（1970-01-01 = 0）。
 * @param {string} iso `YYYY-MM-DD`
 * @returns {number|null} 非法输入返回 null（不抛错）
 */
export function parseDate(iso) {
  if (!isValidISODate(iso)) return null;
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  return Math.floor(Date.UTC(year, month - 1, day) / MS_PER_DAY);
}

/**
 * 整数日号 → 日期字符串。
 * @param {number} serial
 * @returns {string|null}
 */
export function toISODate(serial) {
  if (!Number.isInteger(serial)) return null;
  const date = new Date(serial * MS_PER_DAY);
  const year = date.getUTCFullYear();
  if (year < 1 || year > 9999) return null;
  return `${year}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/** 星期（0 = 周日 … 6 = 周六）；非法输入返回 null */
export function weekdayOf(iso) {
  const serial = parseDate(iso);
  if (serial === null) return null;
  return new Date(serial * MS_PER_DAY).getUTCDay();
}

/** 星期中文名（如「星期四」） */
export function weekdayLabel(iso) {
  const weekday = weekdayOf(iso);
  return weekday === null ? "" : WEEKDAY_LABELS[weekday];
}

/** 星期短名（如「四」） */
export function weekdayShort(iso) {
  const weekday = weekdayOf(iso);
  return weekday === null ? "" : WEEKDAY_SHORT[weekday];
}

/** 月份中文名 */
export function monthLabel(month) {
  return MONTH_LABELS[month - 1] || "";
}

/** 加 / 减天数；非法输入返回 null */
export function addDays(iso, amount) {
  const serial = parseDate(iso);
  if (serial === null || !Number.isFinite(amount)) return null;
  return toISODate(serial + Math.trunc(amount));
}

/**
 * 加 / 减月数。**月末钳制**：1 月 31 日 + 1 个月 → 2 月 28/29 日（不溢出到下个月）。
 */
export function addMonths(iso, amount) {
  const serial = parseDate(iso);
  if (serial === null || !Number.isFinite(amount)) return null;
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));

  const total = (year * 12 + (month - 1)) + Math.trunc(amount);
  const nextYear = Math.floor(total / 12);
  const nextMonth = total - nextYear * 12 + 1;
  if (nextYear < 1 || nextYear > 9999) return null;

  const clampedDay = Math.min(day, daysInMonth(nextYear, nextMonth));
  return `${nextYear}-${pad2(nextMonth)}-${pad2(clampedDay)}`;
}

/**
 * 加 / 减年数。**月末钳制**：2 月 29 日 + 1 年 → 次年 2 月 28 日。
 */
export function addYears(iso, amount) {
  const serial = parseDate(iso);
  if (serial === null || !Number.isFinite(amount)) return null;
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));

  const nextYear = year + Math.trunc(amount);
  if (nextYear < 1 || nextYear > 9999) return null;
  const clampedDay = Math.min(day, daysInMonth(nextYear, month));
  return `${nextYear}-${pad2(month)}-${pad2(clampedDay)}`;
}

/**
 * 日期间的「相差天数」（不含首尾口径，与 Excel 日期相减一致）。
 * @returns {number|null}
 */
export function diffDays(startISO, endISO) {
  const from = parseDate(startISO);
  const to = parseDate(endISO);
  if (from === null || to === null) return null;
  return to - from;
}

/**
 * 按参数模型归一化「天数」结果的口径换算。
 * `exclusive`：`[start, end)`（不含首尾，默认）；`inclusive`：`[start, end]`（含首尾）。
 * @returns {{ from: number, to: number, total: number, swapped: boolean }|null}
 */
function resolveSpan(startISO, endISO, boundary) {
  const a = parseDate(startISO);
  const b = parseDate(endISO);
  if (a === null || b === null) return null;

  const swapped = a > b;
  const from = swapped ? b : a;
  const to = swapped ? a : b;
  const total = boundary === "inclusive" ? to - from + 1 : to - from;
  return { from, to, total, swapped };
}

/**
 * 判定某日期的类型（§14.3 优先级：用户覆盖 > 内置数据 > 周六日规则 > 回退）。
 * @param {string} iso
 * @param {Record<string,string>} [overrides] 用户覆盖层
 * @returns {{ type: string, label: string, isRest: boolean, source: string, covered: boolean }|null}
 */
export function resolveDayType(iso, overrides) {
  if (!isValidISODate(iso)) return null;

  const forced = overrides ? overrides[iso] : null;
  if (forced && DAY_TYPES[forced]) {
    return describeType(forced, "override", isCoveredYear(Number(iso.slice(0, 4))));
  }

  const builtin = lookupBuiltinType(iso);
  if (builtin && DAY_TYPES[builtin]) {
    return describeType(builtin, "builtin", true);
  }

  const weekday = weekdayOf(iso);
  if (weekday === 0 || weekday === 6) {
    return describeType("weekend", "weekend", isCoveredYear(Number(iso.slice(0, 4))));
  }

  const covered = isCoveredYear(Number(iso.slice(0, 4)));
  return describeType("workday", covered ? "builtin" : "out-of-range", covered);
}

function describeType(type, source, covered) {
  const meta = DAY_TYPES[type];
  return { type, label: meta.label, isRest: meta.rest, source, covered: Boolean(covered) };
}

/** 判定依据的可读说明 */
export function sourceLabel(source) {
  switch (source) {
    case "override":
      return "你的自定义";
    case "builtin":
      return "内置日历数据";
    case "weekend":
      return "周六日通用规则";
    case "out-of-range":
      return "超出内置数据范围（按周六日规则）";
    default:
      return "";
  }
}

/**
 * 区间统计（§14.9）。
 * @param {string} startISO
 * @param {string} endISO
 * @param {{ boundary?: string }} [options]
 * @param {Record<string,string>} [overrides]
 * @returns {{
 *   ok: boolean, reason?: string, total?: number, workdays?: number, restdays?: number,
 *   outOfRange?: number, swapped?: boolean
 * }}
 */
export function countDays(startISO, endISO, options, overrides) {
  const boundary = BOUNDARY_VALUES.includes(options && options.boundary) ? options.boundary : DEFAULT_CONFIG.boundary;
  const span = resolveSpan(startISO, endISO, boundary);
  if (!span) return { ok: false, reason: "invalid" };
  if (span.to - span.from > MAX_SPAN_YEARS * 366) return { ok: false, reason: "range" };

  let workdays = 0;
  let restdays = 0;
  let outOfRange = 0;

  // exclusive 时统计 `[from + 1, to]`，即「不含首尾」
  const first = boundary === "inclusive" ? span.from : span.from + 1;
  for (let serial = first; serial <= span.to; serial += 1) {
    const iso = toISODate(serial);
    const type = resolveDayType(iso, overrides);
    if (!type) continue;
    if (type.isRest) restdays += 1;
    else workdays += 1;
    if (!type.covered) outOfRange += 1;
  }

  return { ok: true, total: span.total, workdays, restdays, outOfRange, swapped: span.swapped };
}

/**
 * 按工作日推算：向后 / 向前移动 n 个工作日，自动跳过一切休息日。
 * @param {string} iso 基准日期
 * @param {number} amount 步数（可为负；0 返回基准日自身）
 * @param {Record<string,string>} [overrides]
 * @returns {string|null}
 */
export function addWorkdays(iso, amount, overrides) {
  const start = parseDate(iso);
  if (start === null || !Number.isFinite(amount)) return null;

  const steps = Math.trunc(amount);
  if (Math.abs(steps) > MAX_SHIFT) return null;
  if (steps === 0) return iso;

  const step = steps > 0 ? 1 : -1;
  let remaining = Math.abs(steps);
  let serial = start;

  // 每轮至少推进一天，因此循环次数有限（最坏情况约 3 × steps）
  while (remaining > 0) {
    serial += step;
    const candidate = toISODate(serial);
    if (candidate === null) return null;
    const type = resolveDayType(candidate, overrides);
    if (type && !type.isRest) remaining -= 1;
  }

  return toISODate(serial);
}

/**
 * 按参数模型推算结果日期（单位：天 / 周 / 月 / 年 / 工作日）。
 * 「计入基准日」（`boundary === 'inclusive'`）时，基准日占据第 1 个单位，
 * 因此结果是「按不计入算出的日期」整体回退一天（工作日口径见下）。
 * @param {string} baseISO 基准日期
 * @param {number} amount 数量（非负整数，方向由 `shiftDirection` 决定）
 * @param {{ shiftUnit?: string, shiftDirection?: string, boundary?: string }} [options]
 * @param {Record<string,string>} [overrides]
 * @returns {string|null}
 */
export function shiftDate(baseISO, amount, options, overrides) {
  const unit = SHIFT_UNIT_VALUES.includes(options && options.shiftUnit) ? options.shiftUnit : DEFAULT_CONFIG.shiftUnit;
  const direction = SHIFT_DIRECTION_VALUES.includes(options && options.shiftDirection)
    ? options.shiftDirection
    : DEFAULT_CONFIG.shiftDirection;
  const inclusive = Boolean(options) && options.boundary === "inclusive";

  const value = Math.abs(Math.trunc(Number(amount) || 0));
  if (value > MAX_SHIFT) return null;

  const sign = direction === "before" ? -1 : 1;

  // 工作日口径：只有基准日本身是工作日时，「计入基准日」才占用第 1 个名额
  if (unit === "workday") {
    const baseType = resolveDayType(baseISO, overrides);
    const consumed = inclusive && baseType && !baseType.isRest ? 1 : 0;
    return addWorkdays(baseISO, sign * Math.max(0, value - consumed), overrides);
  }

  let shifted;
  switch (unit) {
    case "day":
      shifted = addDays(baseISO, sign * value);
      break;
    case "week":
      shifted = addDays(baseISO, sign * value * 7);
      break;
    case "month":
      shifted = addMonths(baseISO, sign * value);
      break;
    case "year":
      shifted = addYears(baseISO, sign * value);
      break;
    default:
      return null;
  }

  if (!shifted || !inclusive || value === 0) return shifted;
  // 计入基准日 ⇒ 实际区间为 [基准, 结果)，结果整体回退一天
  return addDays(shifted, -sign);
}

/**
 * 构建月历网格（固定 6 行 × 7 列 = 42 格，含上下月补位，保证高度稳定不抖动）。
 * @param {number} year
 * @param {number} month 1–12
 * @param {number} weekStartsOn 0 = 周日，1 = 周一
 * @returns {Array<{ iso: string, day: number, inMonth: boolean, weekday: number }>}
 */
export function buildMonthGrid(year, month, weekStartsOn) {
  if (!Number.isInteger(year) || year < 1 || year > 9999) return [];
  if (!Number.isInteger(month) || month < 1 || month > 12) return [];

  const lead = weekStartsOn === 0 ? 0 : 1;
  const firstSerial = parseDate(`${year}-${pad2(month)}-01`);
  if (firstSerial === null) return [];

  const firstWeekday = new Date(firstSerial * MS_PER_DAY).getUTCDay();
  const offset = (firstWeekday - lead + 7) % 7;
  const startSerial = firstSerial - offset;

  const cells = [];
  for (let i = 0; i < 42; i += 1) {
    const serial = startSerial + i;
    const iso = toISODate(serial);
    if (iso === null) break;
    cells.push({
      iso,
      day: Number(iso.slice(8, 10)),
      inMonth: Number(iso.slice(5, 7)) === month,
      weekday: new Date(serial * MS_PER_DAY).getUTCDay(),
    });
  }
  return cells;
}

/** 月历表头（按周起始排列，返回 7 个短名） */
export function weekdayHeader(weekStartsOn) {
  const lead = weekStartsOn === 0 ? 0 : 1;
  return Array.from({ length: 7 }, (_, i) => WEEKDAY_SHORT[(lead + i) % 7]);
}

/** 参数归一化：非法值一律回退默认值（§14.2） */
export function normalizeConfig(partial) {
  const input = partial && typeof partial === "object" ? partial : {};
  const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

  const year = Number(input.calendarYear);
  const month = Number(input.calendarMonth);

  return {
    mode: pick(input.mode, MODE_VALUES, DEFAULT_CONFIG.mode),
    boundary: pick(input.boundary, BOUNDARY_VALUES, DEFAULT_CONFIG.boundary),
    shiftBoundary: pick(input.shiftBoundary, BOUNDARY_VALUES, DEFAULT_CONFIG.shiftBoundary),
    countdownBoundary: pick(input.countdownBoundary, BOUNDARY_VALUES, DEFAULT_CONFIG.countdownBoundary),
    shiftUnit: pick(input.shiftUnit, SHIFT_UNIT_VALUES, DEFAULT_CONFIG.shiftUnit),
    shiftDirection: pick(input.shiftDirection, SHIFT_DIRECTION_VALUES, DEFAULT_CONFIG.shiftDirection),
    weekStartsOn: input.weekStartsOn === 0 ? 0 : 1,
    calendarYear: Number.isInteger(year) && year >= 1 && year <= 9999 ? year : null,
    calendarMonth: Number.isInteger(month) && month >= 1 && month <= 12 ? month : null,
  };
}

/** 参数相等比较（用于「是否需要写回存储」） */
export function configEquals(a, b) {
  const left = normalizeConfig(a);
  const right = normalizeConfig(b);
  return Object.keys(DEFAULT_CONFIG).every((key) => left[key] === right[key]);
}

/** 覆盖层归一化：过滤非法键值、按上限截断（§8.1） */
export function normalizeOverrides(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;

  Object.keys(raw).forEach((iso) => {
    if (Object.keys(out).length >= MAX_OVERRIDES) return;
    const value = raw[iso];
    if (!isValidISODate(iso)) return;
    if (!DAY_TYPES[value]) return;
    out[iso] = value;
  });

  return out;
}

/** 覆盖层条数 */
export function countOverrides(overrides) {
  return overrides && typeof overrides === "object" ? Object.keys(overrides).length : 0;
}

/**
 * 距今天数（自然日与工作日两种口径**同时**给出，不存在「主口径」）。
 * 正数表示目标日期在将来，负数表示已过去。
 * 「计入当天」（`boundary === 'inclusive'`）时今天也占 1 天，故绝对值 +1。
 * @param {string} iso 目标日期
 * @param {{ boundary?: string }} [options]
 * @param {Record<string,string>} [overrides]
 * @param {string} [todayStr] 便于测试注入「今天」
 * @returns {{ today: string, natural: number, workdays: number }|null}
 */
export function daysFromToday(iso, options, overrides, todayStr) {
  const today = isValidISODate(todayStr) ? todayStr : todayISO();
  const inclusive = Boolean(options) && options.boundary === "inclusive";

  const diff = diffDays(today, iso);
  if (diff === null) return null;

  let workdays = 0;
  if (diff > 0) workdays = countWorkdaysBetween(today, iso, overrides) || 0;
  else if (diff < 0) workdays = -(countWorkdaysBetween(iso, today, overrides) || 0);

  // 计入当天：自然日直接 +1；工作日仅当今天本身是工作日才 +1
  const natural = inclusive ? (diff >= 0 ? diff + 1 : diff - 1) : diff;
  if (inclusive) {
    const todayType = resolveDayType(today, overrides);
    if (todayType && !todayType.isRest) workdays += diff >= 0 ? 1 : -1;
  }

  return { today, diff, natural, workdays };
}

/**
 * 从 `from`（不含）到 `to`（含）之间的工作日数；`to` 必须晚于 `from`。
 * 用于「距今天还有多少工作日」。
 */
export function countWorkdaysBetween(fromISO, toISO, overrides) {
  const from = parseDate(fromISO);
  const to = parseDate(toISO);
  if (from === null || to === null || to < from) return null;
  if (to - from > MAX_SPAN_YEARS * 366) return null;

  let total = 0;
  for (let serial = from + 1; serial <= to; serial += 1) {
    const type = resolveDayType(toISODate(serial), overrides);
    if (type && !type.isRest) total += 1;
  }
  return total;
}

/** 今天的 ISO 日期（按本地时区，不使用 UTC 以免跨时区偏差） */
export function todayISO() {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** 格式化展示：2026-10-01 → 2026 年 10 月 1 日 */
export function formatDisplay(iso) {
  if (!isValidISODate(iso)) return "";
  return `${Number(iso.slice(0, 4))} 年 ${Number(iso.slice(5, 7))} 月 ${Number(iso.slice(8, 10))} 日`;
}

/** 界面用：内置数据的覆盖范围说明 */
export function coverageNote() {
  return `内置官方日历数据覆盖 ${COVERAGE_YEARS[0]}–${COVERAGE_YEARS[COVERAGE_YEARS.length - 1]} 年（${COVERAGE_RANGE.min} ~ ${COVERAGE_RANGE.max}），其余年份按「周六日 = 休息日」通用规则计算。`;
}

/** 界面用：某年的数据来源说明 */
export function yearSourceNote(year) {
  return sourceOfYear(year);
}

/* ────────────────────────────────────────────────────────────────
 * ② 存储适配层（全部 try/catch 静默降级，§8.3）
 * ──────────────────────────────────────────────────────────────── */

function readJSON(key) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

function writeJSON(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    return false;
  }
}

/** 按实例推导配置键：首个实例沿用默认键，第 2 个及以后用 `:config:<serial>`（§8.1） */
export function instanceSessionKey(instance) {
  return instance && instance.serial > 1 ? `${CONFIG_KEY}:${instance.serial}` : CONFIG_KEY;
}

/** 读取自定义日历覆盖层（跨实例共享） */
export function loadOverrides() {
  const payload = readJSON(CALENDAR_KEY);
  if (!payload || typeof payload !== "object") return {};
  return normalizeOverrides(payload.overrides);
}

/**
 * 写入自定义日历覆盖层。
 * @returns {boolean} 写入成功与否（隐私模式等场景返回 false，由界面提示降级）
 */
export function saveOverrides(overrides) {
  return writeJSON(CALENDAR_KEY, { version: EXPORT_VERSION, overrides: normalizeOverrides(overrides) });
}

/** 读取参数（按实例） */
export function loadSession(storageKey) {
  const payload = readJSON(storageKey || CONFIG_KEY);
  if (!payload || typeof payload !== "object") return normalizeConfig();
  return normalizeConfig(payload.config);
}

/** 写入参数（按实例） */
export function saveSession(config, storageKey) {
  return writeJSON(storageKey || CONFIG_KEY, { config: normalizeConfig(config) });
}

/* ────────────────────────────────────────────────────────────────
 * ③ 导入 / 导出（§8.4、§14.7）
 * ──────────────────────────────────────────────────────────────── */

/**
 * 序列化自定义日历为导出 JSON 文本。
 * 只导出覆盖层，不含内置数据、不含任何输入内容。
 */
export function serializeCalendar(overrides) {
  return JSON.stringify(
    {
      app: APP_ID,
      tool: TOOL_ID,
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      calendar: { overrides: normalizeOverrides(overrides) },
    },
    null,
    2
  );
}

/**
 * 校验并解析导入数据（先整体校验，通过后由调用方一次性写入，§8.3）。
 * @param {string} raw 文件文本或粘贴的 JSON 文本
 * @param {Record<string,string>} [currentOverrides] 当前覆盖层，用于统计「新增 / 覆盖」
 * @returns {{ ok: true, overrides: Record<string,string>, added: number, overwritten: number, invalid: number, total: number }
 *          | { ok: false, message: string }}
 */
export function parseImportPayload(raw, currentOverrides) {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, message: "内容为空，请提供导出的 JSON 文件或文本。" };
  }

  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    return { ok: false, message: "不是合法的 JSON 文本，请检查文件是否完整。" };
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, message: "顶层结构不是对象，可能不是本工具导出的文件。" };
  }

  if (payload.app !== APP_ID) {
    return { ok: false, message: "来源标识不匹配：该文件不是「本地工具箱」导出的数据。" };
  }

  if (payload.tool !== TOOL_ID) {
    return { ok: false, message: `工具标识不匹配：该文件属于「${payload.tool}」，不是《日期天数计算器》。` };
  }

  if (payload.version !== EXPORT_VERSION) {
    return { ok: false, message: `版本不匹配：文件为 v${payload.version}，当前仅支持 v${EXPORT_VERSION}。` };
  }

  const calendar = payload.calendar;
  if (!calendar || typeof calendar !== "object" || !calendar.overrides || typeof calendar.overrides !== "object") {
    return { ok: false, message: "缺少 calendar.overrides 字段，没有可导入的日历条目。" };
  }

  const entries = Object.keys(calendar.overrides);
  if (entries.length === 0) {
    return { ok: false, message: "文件中的自定义日历条目为空。" };
  }

  const current = normalizeOverrides(currentOverrides);
  const incoming = normalizeOverrides(calendar.overrides);
  const invalid = entries.length - Object.keys(incoming).length;

  const merged = { ...current };
  let added = 0;
  let overwritten = 0;
  Object.keys(incoming).forEach((iso) => {
    if (Object.prototype.hasOwnProperty.call(current, iso)) overwritten += 1;
    else added += 1;
    merged[iso] = incoming[iso];
  });

  if (Object.keys(merged).length > MAX_OVERRIDES) {
    return {
      ok: false,
      message: `导入后将超过自定义条目上限（${MAX_OVERRIDES} 条），请先清理部分条目再导入。`,
    };
  }

  return { ok: true, overrides: merged, added, overwritten, invalid, total: entries.length };
}

/* ────────────────────────────────────────────────────────────────
 * ④ UI 编排层（init 与界面渲染）
 * ──────────────────────────────────────────────────────────────── */

const TEMPLATE = `
<p class="dc-status" id="dc-status" role="status" aria-live="polite"></p>

<div class="notice notice--danger" data-error hidden>
  <span class="notice__icon" aria-hidden="true">__I_ALERT__</span>
  <div class="notice__body">
    <p class="notice__title">操作失败</p>
    <p class="notice__text" data-error-text></p>
  </div>
</div>

<div class="dc-stack">

  <!-- 计算方式：页签条 + 三个面板（切换只改可见性，绝不重建面板） -->
  <section class="panel" aria-labelledby="dc-modes-title">
    <div class="panel__head">
      <h2 class="panel__title" id="dc-modes-title">__I_SWITCH__ 计算方式</h2>
      <span class="panel__hint" data-mode-hint>—</span>
    </div>

    <div class="dc-modes" role="tablist" aria-label="计算方式" data-mode-list>
      <button class="dc-mode" type="button" role="tab" id="dc-tab-span" aria-controls="dc-panel-span" aria-selected="true" tabindex="0" data-mode="span">日期间隔</button>
      <button class="dc-mode" type="button" role="tab" id="dc-tab-shift" aria-controls="dc-panel-shift" aria-selected="false" tabindex="-1" data-mode="shift">日期推算</button>
      <button class="dc-mode" type="button" role="tab" id="dc-tab-countdown" aria-controls="dc-panel-countdown" aria-selected="false" tabindex="-1" data-mode="countdown">天数计算</button>
    </div>

    <!-- 页签 1：日期间隔 -->
    <div class="dc-mode-pane" role="tabpanel" id="dc-panel-span" aria-labelledby="dc-tab-span" data-mode-panel="span">
    <div class="panel__body dc-pane__body">
      <div class="dc-fields">
        <div class="field">
          <div class="field__label"><label for="dc-span-start">起始日期</label></div>
          <input class="input" type="date" id="dc-span-start" data-role="span-start" />
        </div>
        <div class="field">
          <div class="field__label"><label for="dc-span-end">结束日期</label></div>
          <input class="input" type="date" id="dc-span-end" data-role="span-end" />
        </div>
      </div>

      <div class="dc-fields">
        <div class="field">
          <div class="field__label"><label for="dc-boundary">天数口径</label></div>
          <select class="select" id="dc-boundary" data-role="boundary">
            <option value="exclusive">不含首尾</option>
            <option value="inclusive">含首尾</option>
          </select>
        </div>
      </div>

      <div class="dc-stats">
        <div class="dc-stat">
          <span class="stat__value" data-stat="natural">—</span>
          <span class="stat__label">自然日</span>
        </div>
        <div class="dc-stat">
          <span class="stat__value" data-stat="workday">—</span>
          <span class="stat__label">工作日</span>
        </div>
        <div class="dc-stat">
          <span class="stat__value" data-stat="restday">—</span>
          <span class="stat__label">休息日</span>
        </div>
      </div>

      <p class="field__hint" data-span-note></p>
    </div>
    <div class="panel__foot">
      <button class="btn btn--ghost" type="button" data-action="span-today">结束日期＝今天</button>
      <button class="btn btn--ghost" type="button" data-action="span-swap">交换起止</button>
      <span class="panel__spacer"></span>
      <span class="panel__hint">工作日 / 休息日按中国日历判定</span>
    </div>
    </div>

    <!-- 页签 2：日期推算 -->
    <div class="dc-mode-pane" role="tabpanel" id="dc-panel-shift" aria-labelledby="dc-tab-shift" data-mode-panel="shift" hidden>
    <div class="panel__body dc-pane__body">
      <div class="dc-fields">
        <div class="field">
          <div class="field__label"><label for="dc-shift-base">基准日期</label></div>
          <input class="input" type="date" id="dc-shift-base" data-role="shift-base" />
        </div>
        <div class="field">
          <div class="field__label"><label for="dc-shift-amount">数量</label></div>
          <input
            class="input"
            type="number"
            id="dc-shift-amount"
            data-role="shift-amount"
            min="0"
            max="100000"
            step="1"
            value="1"
            inputmode="numeric"
          />
        </div>
      </div>

      <div class="dc-fields">
        <div class="field">
          <div class="field__label"><label for="dc-shift-direction">方向</label></div>
          <select class="select" id="dc-shift-direction" data-role="shift-direction">
            <option value="after">向后（未来）</option>
            <option value="before">向前（过去）</option>
          </select>
        </div>
        <div class="field">
          <div class="field__label"><label for="dc-shift-unit">单位</label></div>
          <select class="select" id="dc-shift-unit" data-role="shift-unit">
            <option value="day">天</option>
            <option value="week">周</option>
            <option value="month">月</option>
            <option value="year">年</option>
            <option value="workday">工作日</option>
          </select>
        </div>
        <div class="field">
          <div class="field__label"><label for="dc-shift-boundary">基准日口径</label></div>
          <select class="select" id="dc-shift-boundary" data-role="shift-boundary">
            <option value="exclusive">不计入基准日</option>
            <option value="inclusive">计入基准日</option>
          </select>
        </div>
      </div>

      <div class="dc-result">
        <p class="dc-result__label">结果日期</p>
        <p class="dc-result__value mono" data-shift-result>—</p>
        <p class="dc-result__meta" data-shift-meta></p>
      </div>
    </div>
    <div class="panel__foot">
      <button class="btn btn--primary" type="button" data-action="shift-run">推算</button>
      <span class="panel__spacer"></span>
      <span class="panel__hint">快捷键 <kbd>Ctrl</kbd> + <kbd>Enter</kbd>；按「工作日」增减会自动跳过休息日</span>
    </div>
    </div>

    <!-- 页签 3：天数计算（原「距今天数」） -->
    <div class="dc-mode-pane" role="tabpanel" id="dc-panel-countdown" aria-labelledby="dc-tab-countdown" data-mode-panel="countdown" hidden>
    <div class="panel__body dc-pane__body">
      <div class="dc-fields">
        <div class="field">
          <div class="field__label"><label for="dc-countdown-date">目标日期</label></div>
          <input class="input" type="date" id="dc-countdown-date" data-role="countdown-date" />
        </div>
        <div class="field">
          <div class="field__label"><label for="dc-countdown-boundary">当天口径</label></div>
          <select class="select" id="dc-countdown-boundary" data-role="countdown-boundary">
            <option value="exclusive">不计入当天</option>
            <option value="inclusive">计入当天（今天算 1 天）</option>
          </select>
        </div>
      </div>

      <div class="dc-stats">
        <div class="dc-stat">
          <span class="stat__value" data-countdown="natural">—</span>
          <span class="stat__label">自然日</span>
        </div>
        <div class="dc-stat">
          <span class="stat__value" data-countdown="workday">—</span>
          <span class="stat__label">工作日</span>
        </div>
      </div>

      <p class="field__hint" data-countdown-note></p>
    </div>
    <div class="panel__foot">
      <button class="btn btn--ghost" type="button" data-action="countdown-today">目标日期＝今天</button>
      <button class="btn btn--ghost" type="button" data-action="countdown-from-span">取「日期间隔」的结束日期</button>
    </div>
    </div>
  </section>

  <!-- 中国日历：常驻通栏，不随页签切换而隐藏（它是全部计算的类型真源） -->
  <section class="panel" aria-labelledby="dc-cal-title">
    <div class="panel__head">
      <h2 class="panel__title" id="dc-cal-title">__I_CALENDAR__ 中国日历</h2>
      <span class="panel__hint" data-coverage></span>
    </div>
    <div class="panel__body">
      <div class="dc-cal-bar">
        <button class="icon-btn" type="button" data-action="cal-prev" title="上一个月" aria-label="上一个月">__I_LEFT__</button>
        <span class="dc-cal-bar__title mono" data-cal-title>—</span>
        <button class="icon-btn" type="button" data-action="cal-next" title="下一个月" aria-label="下一个月">__I_RIGHT__</button>
        <button class="btn btn--ghost" type="button" data-action="cal-today">回到今天</button>
        <span class="panel__spacer"></span>
        <div class="field dc-field--bar">
          <label class="sr-only" for="dc-week-start">每周起始</label>
          <select class="select" id="dc-week-start" data-role="week-start" title="日历以周一或周日为首列">
            <option value="1">周一</option>
            <option value="0">周日</option>
          </select>
        </div>
      </div>

      <div class="dc-cal" data-cal-grid role="grid" aria-labelledby="dc-cal-title"></div>

      <ul class="dc-legend">
        <li class="dc-legend__item"><span class="dc-tag dc-tag--workday" aria-hidden="true">工</span>工作日</li>
        <li class="dc-legend__item"><span class="dc-tag dc-tag--makeup" aria-hidden="true">班</span>调休上班日（计入工作日）</li>
        <li class="dc-legend__item"><span class="dc-tag dc-tag--weekend" aria-hidden="true">休</span>休息日</li>
        <li class="dc-legend__item"><span class="dc-tag dc-tag--holiday" aria-hidden="true">节</span>法定节假日（计入休息）</li>
        <li class="dc-legend__item"><span class="dc-legend__mark" aria-hidden="true"></span>已自定义</li>
      </ul>

      <div class="dc-editor" data-cal-editor hidden>
        <p class="dc-editor__title" data-editor-title>—</p>
        <div class="dc-editor__actions" role="group" aria-label="设置所选日期的类型">
          <button class="btn btn--ghost" type="button" data-set-type="workday">工作日</button>
          <button class="btn btn--ghost" type="button" data-set-type="makeup">调休上班日</button>
          <button class="btn btn--ghost" type="button" data-set-type="weekend">休息日</button>
          <button class="btn btn--ghost" type="button" data-set-type="holiday">法定节假日</button>
          <button class="btn btn--ghost" type="button" data-action="clear-day">还原为内置判定</button>
        </div>
      </div>
    </div>

    <div class="panel__foot dc-cal-foot">
      <button class="btn btn--ghost" type="button" data-action="reset-calendar">__I_REFRESH__ 恢复内置预设</button>
      <span class="panel__spacer"></span>
      <button class="btn btn--ghost" type="button" data-action="copy-json" title="复制自定义日历 JSON" aria-label="复制自定义日历 JSON">__I_JSON__ 复制 JSON</button>
      <button class="btn btn--ghost" type="button" data-action="export-json">__I_DOWN__ 导出</button>
      <label class="btn" for="dc-import-file">__I_UP__ 选择 JSON 文件</label>
      <input class="sr-only" type="file" id="dc-import-file" accept=".json,application/json" />
      <button class="btn btn--ghost" type="button" data-action="toggle-import">粘贴 JSON</button>
      <span class="panel__hint dc-cal-foot__count" data-custom-count></span>
    </div>

    <div class="dc-migrate" data-import-panel hidden>
      <div class="field">
        <div class="field__label">
          <label for="dc-import-text">粘贴 JSON 文本</label>
          <span class="field__hint">与「导出」的结构一致；导入只写自定义条目，不改动当前输入与结果</span>
        </div>
        <textarea
          class="textarea textarea--compact"
          id="dc-import-text"
          spellcheck="false"
          placeholder="在此粘贴导出的 JSON 文本"
        ></textarea>
        <p class="field__hint" data-import-filename>未选择文件</p>
      </div>
      <div class="dc-migrate__actions">
        <button class="btn btn--ghost" type="button" data-action="close-import">取消</button>
        <button class="btn btn--primary" type="button" data-action="confirm-import">导入</button>
      </div>
    </div>
  </section>
</div>
`;

/** 模板中的图标占位符 → [icons.js 中的键, 尺寸] */
const ICON_TOKENS = {
  __I_SWITCH__: ["columns", 15],
  __I_CALENDAR__: ["calendar", 15],
  __I_ALERT__: ["alert", 18],
  __I_REFRESH__: ["refresh", 15],
  __I_JSON__: ["fileJson", 15],
  __I_DOWN__: ["download", 15],
  __I_UP__: ["upload", 15],
  __I_LEFT__: ["chevronLeft", 16],
  __I_RIGHT__: ["chevronRight", 16],
};

/** 日历格中的类型角标（纯文字，避免只靠颜色传达信息） */
const DAY_TAG = Object.freeze({ workday: "工", makeup: "班", weekend: "休", holiday: "节" });

/** 推算单位的中文文案（用于面板提示） */
const SHIFT_UNIT_TEXT = Object.freeze({ day: "天", week: "周", month: "月", year: "年", workday: "个工作日" });

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

/** 读取本地文件文本（FileReader，永不上传） */
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("文件读取失败，请重试。"));
    reader.readAsText(file, "utf-8");
  });
}

/** 文件名用的日期戳（YYYYMMDD） */
function dateStamp() {
  const now = new Date();
  return `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
}

/**
 * 工具入口：渲染界面、绑定事件。
 * @param {Object} ctx 外壳注入的上下文（§9.3）
 * @returns {Function} 清理函数：注销全部监听与定时器（关闭标签时由外壳调用）
 */
export function init(ctx) {
  const { root, utils, icons } = ctx;
  const { dom, clipboard } = utils;

  // 宿主解析：标签面板内为 [data-tool-body]，工具独立页为 #tool-body（§9.3）
  const host = root.querySelector("[data-tool-body]") || root.querySelector("#tool-body");
  if (!host) return () => {};

  // 实例级配置键：同一工具可开多个实例，各自记住自己的参数（§8.1、§9.3）
  const sessionKey = instanceSessionKey(ctx.instance);
  const readSession = () => loadSession(sessionKey);
  const writeSession = (config) => saveSession(config, sessionKey);

  // 同一工具可开多个实例，因此 DOM id 必须按实例唯一：
  // 否则 <label for> 与 aria-labelledby 会解析到第一个实例的节点（§9.3 第 8 条）。
  const uid = `dc-${ctx.instance && ctx.instance.serial ? ctx.instance.serial : 1}`;

  host.innerHTML = TEMPLATE.replace(/(id="|for="|aria-controls="|aria-labelledby=")dc-/g, (match, prefix) => `${prefix}${uid}-`).replace(
    /__I_\w+__/g,
    (token) => {
      const entry = ICON_TOKENS[token];
      return entry ? icons.icon(entry[0], entry[1]) : "";
    }
  );

  const el = (selector) => host.querySelector(selector);
  const nodes = {
    status: el(`#${uid}-status`),
    error: el("[data-error]"),
    errorText: el("[data-error-text]"),

    modeList: el("[data-mode-list]"),
    modeHint: el("[data-mode-hint]"),

    spanStart: el('[data-role="span-start"]'),
    spanEnd: el('[data-role="span-end"]'),
    boundary: el('[data-role="boundary"]'),
    spanNote: el("[data-span-note]"),
    statNatural: el('[data-stat="natural"]'),
    statWorkday: el('[data-stat="workday"]'),
    statRestday: el('[data-stat="restday"]'),

    shiftBase: el('[data-role="shift-base"]'),
    shiftAmount: el('[data-role="shift-amount"]'),
    shiftUnit: el('[data-role="shift-unit"]'),
    shiftDirection: el('[data-role="shift-direction"]'),
    shiftResult: el("[data-shift-result]"),
    shiftMeta: el("[data-shift-meta]"),
    shiftBoundary: el('[data-role="shift-boundary"]'),

    countdownDate: el('[data-role="countdown-date"]'),
    countdownBoundary: el('[data-role="countdown-boundary"]'),
    countdownNatural: el('[data-countdown="natural"]'),
    countdownWorkday: el('[data-countdown="workday"]'),
    countdownNote: el("[data-countdown-note]"),

    weekStart: el('[data-role="week-start"]'),
    calTitle: el("[data-cal-title]"),
    calGrid: el("[data-cal-grid]"),
    coverage: el("[data-coverage]"),
    customCount: el("[data-custom-count]"),
    editor: el("[data-cal-editor]"),
    editorTitle: el("[data-editor-title]"),
    resetCalendar: el('[data-action="reset-calendar"]'),
    copyJson: el('[data-action="copy-json"]'),
    exportJson: el('[data-action="export-json"]'),
    importPanel: el("[data-import-panel]"),
    importText: el(`#${uid}-import-text`),
    importFile: el(`#${uid}-import-file`),
    importFileName: el("[data-import-filename]"),
  };

  if (!nodes.spanStart || !nodes.calGrid || !nodes.shiftBase || !nodes.importPanel) return () => {};

  const RESET_LABEL = `${icons.icon("refresh", 15)} 恢复内置预设`;

  /* ── 资源池：定时器 / 监听器 ──────────────────────────────── */
  const timers = { debounce: 0, status: 0, confirm: 0 };

  const disposers = [];
  const bind = (target, type, handler, options) => {
    disposers.push(dom.on(target, type, handler, options));
  };

  const clearTimer = (key) => {
    if (timers[key]) {
      window.clearTimeout(timers[key]);
      timers[key] = 0;
    }
  };

  /* ── 状态 ────────────────────────────────────────────────── */
  const today = todayISO();
  const restored = readSession();

  const state = {
    config: {
      ...restored,
      calendarYear: restored.calendarYear || Number(today.slice(0, 4)),
      calendarMonth: restored.calendarMonth || Number(today.slice(5, 7)),
    },
    overrides: loadOverrides(),
    selectedISO: today,
    editorOpen: false,
    syncing: false,
    resetArmed: false,
    storageWarned: false,
  };

  /* ── 瞬时反馈与错误 ──────────────────────────────────────── */
  function setStatus(message, tone) {
    if (!nodes.status) return;
    clearTimer("status");
    nodes.status.textContent = message || "";
    if (!message) {
      delete nodes.status.dataset.tone;
      return;
    }
    nodes.status.dataset.tone = tone || "info";
    timers.status = window.setTimeout(() => {
      nodes.status.textContent = "";
      delete nodes.status.dataset.tone;
    }, STATE_CLEAR_MS);
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

  function warnStorageOnce() {
    if (state.storageWarned) return;
    state.storageWarned = true;
    showError("本地存储不可用（可能处于无痕模式），本次的自定义条目与参数仅在当前页面内有效。");
  }

  /* ── 参数读写（日期属用户输入，一律不落盘；只持久化选项，§8.3、§14.11）── */
  function readConfig() {
    return normalizeConfig({
      mode: state.config.mode,
      boundary: nodes.boundary.value,
      shiftBoundary: nodes.shiftBoundary.value,
      countdownBoundary: nodes.countdownBoundary.value,
      shiftUnit: nodes.shiftUnit.value,
      shiftDirection: nodes.shiftDirection.value,
      weekStartsOn: Number(nodes.weekStart.value),
      calendarYear: state.config.calendarYear,
      calendarMonth: state.config.calendarMonth,
    });
  }

  function writeConfigToForm(config) {
    state.syncing = true;
    nodes.boundary.value = config.boundary;
    nodes.shiftBoundary.value = config.shiftBoundary;
    nodes.countdownBoundary.value = config.countdownBoundary;
    nodes.shiftUnit.value = config.shiftUnit;
    nodes.shiftDirection.value = config.shiftDirection;
    nodes.weekStart.value = String(config.weekStartsOn);
    state.syncing = false;
  }

  function refreshNow() {
    const next = readConfig();
    if (!configEquals(next, state.config)) {
      state.config = next;
      if (!writeSession(state.config)) warnStorageOnce();
    }
    renderAll();
  }

  function scheduleRefresh() {
    if (state.syncing) return;
    clearTimer("debounce");
    timers.debounce = window.setTimeout(refreshNow, DEBOUNCE_MS);
  }

  /** 结算尚未到期的防抖刷新（导出、复制、推算前先结算，避免读到旧参数） */
  function flushPendingRefresh() {
    if (timers.debounce) {
      clearTimer("debounce");
      refreshNow();
    }
  }

  /* ── ① 日期间隔 ──────────────────────────────────────────── */
  function setStat(node, value) {
    if (node) node.textContent = value === null || value === undefined ? "—" : String(value);
  }

  function renderSpan() {
    const result = countDays(
      nodes.spanStart.value,
      nodes.spanEnd.value,
      { boundary: state.config.boundary },
      state.overrides
    );

    if (!result.ok) {
      setStat(nodes.statNatural, "—");
      setStat(nodes.statWorkday, "—");
      setStat(nodes.statRestday, "—");
      nodes.spanNote.textContent =
        result.reason === "range"
          ? `区间跨度超过上限（${MAX_SPAN_YEARS} 年），请缩小范围。`
          : "请选择有效的起始与结束日期。";
      return;
    }

    setStat(nodes.statNatural, result.total);
    setStat(nodes.statWorkday, result.workdays);
    setStat(nodes.statRestday, result.restdays);

    const notes = [
      state.config.boundary === "inclusive"
        ? "含首尾（起始与结束都计入）"
        : "不含首尾（1 月 1 日 → 1 月 2 日 = 1 天）",
    ];
    if (result.swapped) notes.push("已按较小日期在前统计");
    if (result.outOfRange > 0) {
      notes.push(`其中 ${result.outOfRange} 天不在内置日历数据范围内，按「周六日 = 休息日」判定`);
    }
    nodes.spanNote.textContent = notes.join("；");
  }

  /* ── ② 日期推算 ──────────────────────────────────────────── */
  function shiftResult() {
    const base = nodes.shiftBase.value;
    const amount = Number(nodes.shiftAmount.value);

    if (!isValidISODate(base)) return { ok: false, message: "请选择有效的基准日期。" };
    if (!Number.isFinite(amount) || amount < 0) return { ok: false, message: "数量请填 0 或更大的整数。" };
    if (amount > MAX_SHIFT) return { ok: false, message: `数量超过上限（${MAX_SHIFT}），请缩小。` };

    const iso = shiftDate(
      base,
      amount,
      {
        shiftUnit: state.config.shiftUnit,
        shiftDirection: state.config.shiftDirection,
        boundary: state.config.shiftBoundary,
      },
      state.overrides
    );

    if (!iso) return { ok: false, message: "推算失败，请检查基准日期与数量。" };
    return { ok: true, iso, base, amount };
  }

  function renderShift() {
    const result = shiftResult();

    if (!result.ok) {
      nodes.shiftResult.textContent = "—";
      nodes.shiftMeta.textContent = result.message;
      return;
    }

    const type = resolveDayType(result.iso, state.overrides);
    nodes.shiftResult.textContent = result.iso;
    nodes.shiftMeta.textContent = `${weekdayLabel(result.iso)} · ${type.label}（依据：${sourceLabel(type.source)}）`;
  }

  /* ── ③ 距今天数 ──────────────────────────────────────────── */
  function renderCountdown() {
    const info = daysFromToday(
      nodes.countdownDate.value,
      { boundary: state.config.countdownBoundary },
      state.overrides,
      todayISO()
    );

    if (!info) {
      setStat(nodes.countdownNatural, "—");
      setStat(nodes.countdownWorkday, "—");
      nodes.countdownNote.textContent = "请选择有效的目标日期。";
      return;
    }

    setStat(nodes.countdownNatural, Math.abs(info.natural));
    setStat(nodes.countdownWorkday, Math.abs(info.workdays));

    const basisText = state.config.countdownBoundary === "inclusive" ? "含当天" : "不含当天";
    nodes.countdownNote.textContent =
      info.diff === 0
        ? `目标日期就是今天（${info.today}）。`
        : `今天 ${info.today}，距目标日期${
            info.diff > 0 ? "还有" : "已过去"
          } ${Math.abs(info.natural)} 个自然日 / ${Math.abs(info.workdays)} 个工作日（${basisText}）。`;
  }

  /* ── ④ 中国日历 ──────────────────────────────────────────── */
  const leadWeekday = () => (state.config.weekStartsOn === 0 ? 0 : 1);

  /** 相对当前视图月份步进，返回 [年, 月] */
  function stepMonth(delta) {
    const total = state.config.calendarYear * 12 + (state.config.calendarMonth - 1) + delta;
    const nextYear = Math.floor(total / 12);
    return [nextYear, total - nextYear * 12 + 1];
  }

  function setView(year, month) {
    state.config = { ...state.config, calendarYear: year, calendarMonth: month };
    if (!writeSession(state.config)) warnStorageOnce();
    renderCalendar();
  }

  function focusCell(iso) {
    const button = dom.qs(`[data-date="${iso}"]`, nodes.calGrid);
    if (!button) return;
    dom.qsa("[data-date]", nodes.calGrid).forEach((node) => {
      node.tabIndex = node === button ? 0 : -1;
    });
    button.focus();
  }

  function buildDayCell(cell) {
    const type = resolveDayType(cell.iso, state.overrides);
    const custom = Object.prototype.hasOwnProperty.call(state.overrides, cell.iso);
    const selected = cell.iso === state.selectedISO;

    const button = dom.el("button", {
      className: "dc-day",
      attrs: {
        type: "button",
        "data-date": cell.iso,
        "data-type": type.type,
        tabindex: "-1",
        "aria-label": `${formatDisplay(cell.iso)}，${weekdayLabel(cell.iso)}，${type.label}${
          custom ? "，已自定义" : `，依据：${sourceLabel(type.source)}`
        }`,
      },
    });

    if (!cell.inMonth) button.classList.add("is-outside");
    if (custom) button.classList.add("is-custom");
    if (selected) button.classList.add("is-selected");
    if (cell.iso === today) button.classList.add("is-today");

    button.append(dom.el("span", { className: "dc-day__num mono", text: String(cell.day) }));
    button.append(
      dom.el("span", {
        className: `dc-tag dc-tag--${type.type}`,
        text: DAY_TAG[type.type] || "",
        attrs: { "aria-hidden": "true" },
      })
    );

    return dom.el("div", {
      className: "dc-cal__cell",
      attrs: { role: "gridcell", "aria-selected": String(selected) },
      children: button,
    });
  }

  function renderCalendar() {
    const { calendarYear: year, calendarMonth: month, weekStartsOn } = state.config;
    const active = document.activeElement;
    const activeDate = active instanceof Element && nodes.calGrid.contains(active) ? active.dataset.date : null;

    nodes.calTitle.textContent = `${year} 年 ${monthLabel(month)}`;
    dom.clear(nodes.calGrid);

    const head = dom.el("div", { className: "dc-cal__row dc-cal__row--head", attrs: { role: "row" } });
    weekdayHeader(weekStartsOn).forEach((name) => {
      head.append(dom.el("div", { className: "dc-cal__head", text: name, attrs: { role: "columnheader" } }));
    });
    nodes.calGrid.append(head);

    const cells = buildMonthGrid(year, month, weekStartsOn);
    for (let index = 0; index < cells.length; index += 7) {
      const row = dom.el("div", { className: "dc-cal__row", attrs: { role: "row" } });
      cells.slice(index, index + 7).forEach((cell) => row.append(buildDayCell(cell)));
      nodes.calGrid.append(row);
    }

    // roving tabindex：优先让「已选日期」可 Tab 聚焦，否则退化为当月第一个可用格
    const selectedButton = dom.qs(`[data-date="${state.selectedISO}"]`, nodes.calGrid);
    const fallback = dom.qs(".dc-cal__cell .dc-day:not(.is-outside)", nodes.calGrid);
    const focusable = selectedButton || fallback;
    if (focusable) focusable.tabIndex = 0;

    if (activeDate) focusCell(activeDate);
  }

  function renderEditor() {
    if (!state.editorOpen || !state.selectedISO) {
      nodes.editor.hidden = true;
      return;
    }

    const iso = state.selectedISO;
    const type = resolveDayType(iso, state.overrides);
    const custom = Object.prototype.hasOwnProperty.call(state.overrides, iso);

    nodes.editor.hidden = false;
    nodes.editorTitle.textContent = `${formatDisplay(iso)} · ${weekdayLabel(iso)} · 当前为「${type.label}」，依据：${
      custom ? "你的自定义" : sourceLabel(type.source)
    }`;

    dom.qsa("[data-set-type]", nodes.editor).forEach((button) => {
      const isActive = button.dataset.setType === type.type;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", String(isActive));
    });

    const clearButton = dom.qs('[data-action="clear-day"]', nodes.editor);
    if (clearButton) {
      clearButton.disabled = !custom;
      clearButton.title = custom ? "清除该日期的自定义类型" : "该日期没有自定义条目";
    }
  }

  function renderCalendarActions() {
    const count = countOverrides(state.overrides);
    const has = count > 0;

    nodes.customCount.textContent = has ? `自定义 ${count} 条` : "暂无自定义条目";

    nodes.exportJson.disabled = !has;
    nodes.exportJson.title = has ? "导出自定义日历 JSON" : "暂无自定义条目可导出";
    nodes.copyJson.disabled = !has;
    nodes.copyJson.title = has ? "复制自定义日历 JSON" : "暂无自定义条目可复制";
    nodes.resetCalendar.disabled = !has;
    nodes.resetCalendar.title = has ? "清除全部自定义条目，恢复内置判定" : "当前没有自定义条目";
  }

  /* ── 计算方式页签 ────────────────────────────────────────── */
  /** 页签切换只改可见性与 ARIA 属性，绝不重建面板（§14.8） */
  function renderTabs() {
    const active = state.config.mode;

    dom.qsa("[data-mode]", nodes.modeList).forEach((button) => {
      const isActive = button.dataset.mode === active;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-selected", String(isActive));
      button.tabIndex = isActive ? 0 : -1;
    });

    dom.qsa("[data-mode-panel]", host).forEach((panel) => {
      panel.hidden = panel.dataset.modePanel !== active;
    });

    renderModeHint();
  }

  function setMode(mode) {
    if (!MODE_VALUES.includes(mode) || mode === state.config.mode) return;
    state.config = { ...state.config, mode };
    if (!writeSession(state.config)) warnStorageOnce();
    renderTabs();
    const button = dom.qs(`[data-mode="${mode}"]`, nodes.modeList);
    if (button) button.focus();
    setStatus(`已切换到「${MODE_LABEL[mode]}」`, "info");
  }

  /** 卡片头部的模式摘要（随页签与输入变化） */
  function renderModeHint() {
    if (!nodes.modeHint) return;
    const mode = state.config.mode;

    if (mode === "span") {
      nodes.modeHint.textContent =
        isValidISODate(nodes.spanStart.value) && isValidISODate(nodes.spanEnd.value)
          ? `${nodes.spanStart.value} → ${nodes.spanEnd.value}`
          : "—";
      return;
    }

    if (mode === "shift") {
      const result = shiftResult();
      nodes.modeHint.textContent = result.ok
        ? `${result.base} ${state.config.shiftDirection === "before" ? "向前" : "向后"} ${result.amount} ${
            SHIFT_UNIT_TEXT[state.config.shiftUnit]
          }`
        : "—";
      return;
    }

    nodes.modeHint.textContent = isValidISODate(nodes.countdownDate.value)
      ? `目标日期 ${nodes.countdownDate.value}`
      : "—";
  }

  /** 当前页签的主操作（Ctrl/Cmd+Enter 与「推算」按钮共用） */
  function runPrimary() {
    flushPendingRefresh();
    const mode = state.config.mode;

    if (mode === "shift") {
      const result = shiftResult();
      renderShift();
      if (!result.ok) {
        setStatus(result.message, "warn");
        return;
      }
      setStatus(`已推算出结果日期 ${result.iso}`, "ok");
      return;
    }

    if (mode === "span") {
      const result = countDays(
        nodes.spanStart.value,
        nodes.spanEnd.value,
        { boundary: state.config.boundary },
        state.overrides
      );
      if (!result.ok) {
        setStatus(
          result.reason === "range" ? `区间跨度超过上限（${MAX_SPAN_YEARS} 年）。` : "请选择有效的起始与结束日期。",
          "warn"
        );
        return;
      }
      setStatus(`已重新计算：${result.total} 个自然日，其中工作日 ${result.workdays} / 休息日 ${result.restdays}`, "ok");
      return;
    }

    const info = daysFromToday(
      nodes.countdownDate.value,
      { boundary: state.config.countdownBoundary },
      state.overrides,
      todayISO()
    );
    if (!info) {
      setStatus("请选择有效的目标日期。", "warn");
      return;
    }
    setStatus(`已重新计算：${Math.abs(info.natural)} 个自然日 / ${Math.abs(info.workdays)} 个工作日`, "ok");
  }

  function renderAll() {
    renderSpan();
    renderShift();
    renderCountdown();
    renderCalendar();
    renderEditor();
    renderCalendarActions();
    renderTabs();
  }

  function selectDay(iso, options = {}) {
    if (!isValidISODate(iso)) return;
    state.selectedISO = iso;
    state.editorOpen = options.openEditor === false ? state.editorOpen : true;

    const year = Number(iso.slice(0, 4));
    const month = Number(iso.slice(5, 7));
    if (year !== state.config.calendarYear || month !== state.config.calendarMonth) {
      setView(year, month);
    }

    renderCalendar();
    renderEditor();
    focusCell(iso);
  }

  function closeEditor() {
    state.editorOpen = false;
    renderEditor();
  }

  /** 键盘导航：把焦点移动到目标日期（必要时跨月） */
  function moveFocus(iso) {
    if (!isValidISODate(iso)) return;
    const year = Number(iso.slice(0, 4));
    const month = Number(iso.slice(5, 7));
    if (year !== state.config.calendarYear || month !== state.config.calendarMonth) {
      setView(year, month);
    }
    focusCell(iso);
  }

  function shiftMonth(iso, delta) {
    const moved = addMonths(iso, delta);
    if (!moved) return null;
    // 月份切换时保留「日」，超出目标月天数则由 addMonths 钳制到月末
    return moved;
  }

  function setDayType(iso, type) {
    const next = { ...state.overrides };

    if (type) {
      const isNew = !Object.prototype.hasOwnProperty.call(next, iso);
      if (isNew && countOverrides(next) >= MAX_OVERRIDES) {
        setStatus(`自定义条目已达上限（${MAX_OVERRIDES} 条），请先清理部分条目。`, "warn");
        return;
      }
      next[iso] = type;
    } else {
      delete next[iso];
    }

    state.overrides = next;
    if (!saveOverrides(state.overrides)) warnStorageOnce();

    setStatus(
      type
        ? `已将 ${formatDisplay(iso)} 设为「${DAY_TYPES[type].label}」`
        : `已还原 ${formatDisplay(iso)} 的内置判定`,
      type ? "ok" : "warn"
    );
    renderAll();
  }

  function resetResetButton() {
    state.resetArmed = false;
    nodes.resetCalendar.classList.remove("is-armed");
    nodes.resetCalendar.innerHTML = RESET_LABEL;
  }

  /** 「恢复内置预设」：两段式确认（§6、§14.5），3000ms 超时复位 */
  function armResetCalendar() {
    if (countOverrides(state.overrides) === 0) {
      setStatus("当前没有自定义条目，无需恢复。", "warn");
      return;
    }

    if (!state.resetArmed) {
      state.resetArmed = true;
      nodes.resetCalendar.classList.add("is-armed");
      nodes.resetCalendar.textContent = "确认清空全部自定义？";
      clearTimer("confirm");
      timers.confirm = window.setTimeout(resetResetButton, CONFIRM_MS);
      return;
    }

    clearTimer("confirm");
    resetResetButton();
    state.overrides = {};
    if (!saveOverrides(state.overrides)) warnStorageOnce();
    setStatus("已恢复内置预设，全部自定义条目已清除。", "warn");
    renderAll();
  }

  /* ── 导入 / 导出 ─────────────────────────────────────────── */
  function exportJson() {
    flushPendingRefresh();
    const count = countOverrides(state.overrides);
    if (count === 0) {
      setStatus("暂无自定义条目可导出。", "warn");
      return;
    }
    downloadFile(`date-calc-calendar-${dateStamp()}.json`, serializeCalendar(state.overrides), "application/json");
    setStatus(`已导出 ${count} 条自定义条目`, "ok");
  }

  async function copyJson() {
    flushPendingRefresh();
    const count = countOverrides(state.overrides);
    if (count === 0) {
      setStatus("暂无自定义条目可复制。", "warn");
      return;
    }
    const ok = await clipboard.copyText(serializeCalendar(state.overrides));
    setStatus(ok ? `已复制 ${count} 条自定义条目` : "复制失败，请手动选择文本复制。", ok ? "ok" : "danger");
  }

  function toggleImportPanel(force) {
    const next = typeof force === "boolean" ? force : nodes.importPanel.hidden;
    nodes.importPanel.hidden = !next;
    if (next) {
      clearError();
      nodes.importText.focus();
    }
  }

  function applyImport(raw) {
    const parsed = parseImportPayload(raw, state.overrides);
    if (!parsed.ok) {
      showError(parsed.message);
      return;
    }

    state.overrides = parsed.overrides;
    if (!saveOverrides(state.overrides)) warnStorageOnce();

    const parts = [`新增 ${parsed.added} 条`, `覆盖 ${parsed.overwritten} 条`];
    if (parsed.invalid > 0) parts.push(`忽略非法 ${parsed.invalid} 条`);
    setStatus(`导入完成：${parts.join("，")}`, parsed.added + parsed.overwritten > 0 ? "ok" : "warn");

    clearError();
    nodes.importText.value = "";
    if (nodes.importFile) nodes.importFile.value = "";
    nodes.importFileName.textContent = "未选择文件";
    toggleImportPanel(false);
    renderAll();
  }

  function confirmImport() {
    clearError();

    const file = nodes.importFile && nodes.importFile.files ? nodes.importFile.files[0] : null;
    if (file) {
      readFileAsText(file)
        .then(applyImport)
        .catch((error) => showError(error.message));
      return;
    }

    if (!nodes.importText.value || nodes.importText.value.trim() === "") {
      showError("请先选择 JSON 文件，或粘贴导出的 JSON 文本。");
      return;
    }

    applyImport(nodes.importText.value);
  }

  /* ── 事件 ────────────────────────────────────────────────── */
  bind(nodes.boundary, "change", () => {
    scheduleRefresh();
    setStatus(nodes.boundary.value === "inclusive" ? "天数口径：含首尾" : "天数口径：不含首尾", "info");
  });
  bind(nodes.shiftUnit, "change", scheduleRefresh);
  bind(nodes.shiftDirection, "change", scheduleRefresh);
  bind(nodes.shiftBoundary, "change", () => {
    scheduleRefresh();
    setStatus(nodes.shiftBoundary.value === "inclusive" ? "基准日口径：计入基准日" : "基准日口径：不计入基准日", "info");
  });
  bind(nodes.countdownBoundary, "change", () => {
    scheduleRefresh();
    setStatus(nodes.countdownBoundary.value === "inclusive" ? "当天口径：计入当天" : "当天口径：不计入当天", "info");
  });
  bind(nodes.weekStart, "change", scheduleRefresh);

  bind(nodes.spanStart, "input", () => {
    scheduleRefresh();
  });
  bind(nodes.spanEnd, "input", () => {
    scheduleRefresh();
  });
  bind(nodes.shiftBase, "input", scheduleRefresh);
  bind(nodes.shiftAmount, "input", scheduleRefresh);
  bind(nodes.countdownDate, "input", scheduleRefresh);

  bind(el('[data-action="span-today"]'), "click", () => {
    nodes.spanEnd.value = todayISO();
    refreshNow();
    setStatus("结束日期已设为今天。", "ok");
  });

  bind(el('[data-action="span-swap"]'), "click", () => {
    const start = nodes.spanStart.value;
    nodes.spanStart.value = nodes.spanEnd.value;
    nodes.spanEnd.value = start;
    refreshNow();
  });

  bind(el('[data-action="shift-run"]'), "click", runPrimary);

  // 页签：点击切换；键盘 ←/→/Home/End（选择随焦点移动，与外壳标签栏一致）
  bind(nodes.modeList, "click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("[data-mode]") : null;
    if (button) setMode(button.dataset.mode);
  });

  bind(nodes.modeList, "keydown", (event) => {
    const button = event.target instanceof Element ? event.target.closest("[data-mode]") : null;
    if (!button) return;

    const current = MODE_VALUES.indexOf(state.config.mode);
    const last = MODE_VALUES.length - 1;
    let next = null;

    switch (event.key) {
      case "ArrowLeft":
      case "ArrowUp":
        next = MODE_VALUES[(current - 1 + MODE_VALUES.length) % MODE_VALUES.length];
        break;
      case "ArrowRight":
      case "ArrowDown":
        next = MODE_VALUES[(current + 1) % MODE_VALUES.length];
        break;
      case "Home":
        next = MODE_VALUES[0];
        break;
      case "End":
        next = MODE_VALUES[last];
        break;
      default:
        return;
    }

    event.preventDefault();
    setMode(next);
  });

  bind(el('[data-action="countdown-today"]'), "click", () => {
    nodes.countdownDate.value = todayISO();
    refreshNow();
    setStatus("目标日期已设为今天。", "ok");
  });

  bind(el('[data-action="countdown-from-span"]'), "click", () => {
    if (!isValidISODate(nodes.spanEnd.value)) {
      setStatus("上方结束日期无效，无法取用。", "warn");
      return;
    }
    nodes.countdownDate.value = nodes.spanEnd.value;
    refreshNow();
  });

  bind(el('[data-action="cal-prev"]'), "click", () => {
    setView(...stepMonth(-1));
  });
  bind(el('[data-action="cal-next"]'), "click", () => {
    setView(...stepMonth(1));
  });
  bind(el('[data-action="cal-today"]'), "click", () => {
    const now = todayISO();
    state.selectedISO = now;
    setView(Number(now.slice(0, 4)), Number(now.slice(5, 7)));
    selectDay(now);
  });

  bind(nodes.calGrid, "click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-date]") : null;
    if (!target) return;
    selectDay(target.dataset.date);
  });

  bind(nodes.calGrid, "keydown", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-date]") : null;
    if (!target) return;

    const iso = target.dataset.date;
    const weekday = weekdayOf(iso);
    const lead = leadWeekday();
    const offset = (weekday - lead + 7) % 7;
    let next = null;

    switch (event.key) {
      case "ArrowLeft":
        next = addDays(iso, -1);
        break;
      case "ArrowRight":
        next = addDays(iso, 1);
        break;
      case "ArrowUp":
        next = addDays(iso, -7);
        break;
      case "ArrowDown":
        next = addDays(iso, 7);
        break;
      case "Home":
        next = addDays(iso, -offset);
        break;
      case "End":
        next = addDays(iso, 6 - offset);
        break;
      case "PageUp":
        next = shiftMonth(iso, -1);
        break;
      case "PageDown":
        next = shiftMonth(iso, 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        selectDay(iso);
        return;
      default:
        return;
    }

    if (!next) return;
    event.preventDefault();
    moveFocus(next);
  });

  bind(nodes.editor, "click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-set-type], [data-action]") : null;
    if (!target) return;

    if (target.dataset.setType) {
      setDayType(state.selectedISO, target.dataset.setType);
      focusCell(state.selectedISO);
      return;
    }
    if (target.dataset.action === "clear-day") {
      setDayType(state.selectedISO, null);
      focusCell(state.selectedISO);
    }
  });

  bind(nodes.resetCalendar, "click", armResetCalendar);
  bind(nodes.exportJson, "click", exportJson);
  bind(nodes.copyJson, "click", () => {
    copyJson();
  });
  bind(el('[data-action="toggle-import"]'), "click", () => toggleImportPanel());
  bind(el('[data-action="close-import"]'), "click", () => toggleImportPanel(false));
  bind(el('[data-action="confirm-import"]'), "click", confirmImport);

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
      runPrimary();
      return;
    }

    if (event.key === "Escape") {
      // 由外到内只关闭最上层的一个（§6、§14.8）
      if (!nodes.importPanel.hidden) toggleImportPanel(false);
      else if (state.resetArmed) resetResetButton();
      else if (state.editorOpen) closeEditor();
      else if (!nodes.error.hidden) clearError();
    }
  });

  /* ── 启动 ────────────────────────────────────────────────── */
  writeConfigToForm(state.config);
  nodes.spanStart.value = `${today.slice(0, 8)}01`;
  nodes.spanEnd.value = today;
  nodes.shiftBase.value = today;
  nodes.countdownDate.value = today;
  nodes.coverage.textContent = coverageNote();
  nodes.importFileName.textContent = "未选择文件";
  renderAll();
  setStatus("");

  return () => {
    Object.keys(timers).forEach(clearTimer);
    disposers.forEach((dispose) => dispose());
    dom.clear(host);
  };
}

export const meta = {
  id: "date-calc",
  version: "1.0.0",
  status: "ready",
};

export default init;
