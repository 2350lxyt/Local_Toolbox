/**
 * 中国法定节假日与调休上班日（内置静态数据）
 * ==================================================================
 * 纯数据模块（docs/DESIGN.md §9.6）：**无 DOM、无副作用、无依赖**，
 * 只导出常量与纯函数；`ToolRecord.entry` 不指向本文件，由 date-calc.js 相对导入。
 *
 * ── 数据来源（逐条取自官方通知原文，不得凭记忆编造）────────────────
 *   2024：《国务院办公厅关于2024年部分节假日安排的通知》（2023-10-25 发布）
 *   2025：《国务院办公厅关于2025年部分节假日安排的通知》（国办发明电〔2024〕7号，2024-11-12 发布）
 *   2026：《国务院办公厅关于2026年部分节假日安排的通知》（国办发明电〔2025〕7号，2025-11-04 发布）
 *
 * ── 数据形状 ─────────────────────────────────────────────────────
 *   holidays  放假区间数组，元素为 [起始日, 结束日]（闭区间，ISO 日期）
 *   makeup    调休上班日（本该休息但需上班的周六/周日）
 *
 * ── 记录口径（重要，勿随意"修正"）────────────────────────────────
 *   1. 官方以「X 日至 Y 日放假调休，共 N 天」发布的，**整段区间**记入 holidays
 *      （区间内的周六日同样记为法定节假日——它们本就属于这次放假安排）。
 *   2. 官方以「X 日放假，与周末连休」发布的（如 2024 元旦、2024 端午），
 *      只记 X 日当天：与其相连的周末由「周六日 = 休息日」的通用规则覆盖，
 *      **两种记法算出的「工作日 / 休息」结果完全一致**，但只有前者忠实于原文。
 *   3. 数据覆盖范围之外的年份不做任何猜测（§14.4）。
 *
 * ── 校验记录（改动数据后请复核这几项）──────────────────────────
 *   2025 年法定放假天数合计 28 天、2026 年合计 33 天，
 *   与官方通报口径（2026 年「放假调休日期共 33 天」，2025 年为 28 天）一致。
 */

/** 内置数据覆盖的年份（升序） */
export const COVERAGE_YEARS = Object.freeze([2024, 2025, 2026]);

/** 内置数据覆盖的日期闭区间 */
export const COVERAGE_RANGE = Object.freeze({ min: "2024-01-01", max: "2026-12-31" });

/** 各年度数据来源（用于界面注明判定依据） */
export const SOURCES = Object.freeze({
  2024: "国务院办公厅关于2024年部分节假日安排的通知（2023-10-25）",
  2025: "国务院办公厅关于2025年部分节假日安排的通知（国办发明电〔2024〕7号）",
  2026: "国务院办公厅关于2026年部分节假日安排的通知（国办发明电〔2025〕7号）",
});

/**
 * 原始数据（按年组织，紧凑结构：放假区间 + 调休上班日）。
 * 使用 Object.freeze 冻结，任何调用方都不得修改。
 */
export const HOLIDAYS_BY_YEAR = Object.freeze({
  2024: Object.freeze({
    holidays: Object.freeze([
      Object.freeze(["2024-01-01", "2024-01-01"]), // 元旦：1 月 1 日放假，与周末连休
      Object.freeze(["2024-02-10", "2024-02-17"]), // 春节：2 月 10 日至 17 日，共 8 天
      Object.freeze(["2024-04-04", "2024-04-06"]), // 清明节：4 月 4 日至 6 日，共 3 天
      Object.freeze(["2024-05-01", "2024-05-05"]), // 劳动节：5 月 1 日至 5 日，共 5 天
      Object.freeze(["2024-06-10", "2024-06-10"]), // 端午节：6 月 10 日放假，与周末连休
      Object.freeze(["2024-09-15", "2024-09-17"]), // 中秋节：9 月 15 日至 17 日，共 3 天
      Object.freeze(["2024-10-01", "2024-10-07"]), // 国庆节：10 月 1 日至 7 日，共 7 天
    ]),
    makeup: Object.freeze([
      "2024-02-04", // 春节调休（周日上班）
      "2024-02-18", // 春节调休（周日上班）
      "2024-04-07", // 清明调休（周日上班）
      "2024-04-28", // 劳动节调休（周日上班）
      "2024-05-11", // 劳动节调休（周六上班）
      "2024-09-14", // 中秋调休（周六上班）
      "2024-09-29", // 国庆调休（周日上班）
      "2024-10-12", // 国庆调休（周六上班）
    ]),
  }),

  2025: Object.freeze({
    holidays: Object.freeze([
      Object.freeze(["2025-01-01", "2025-01-01"]), // 元旦：1 月 1 日放假 1 天，不调休
      Object.freeze(["2025-01-28", "2025-02-04"]), // 春节：1 月 28 日至 2 月 4 日，共 8 天
      Object.freeze(["2025-04-04", "2025-04-06"]), // 清明节：4 月 4 日至 6 日，共 3 天
      Object.freeze(["2025-05-01", "2025-05-05"]), // 劳动节：5 月 1 日至 5 日，共 5 天
      Object.freeze(["2025-05-31", "2025-06-02"]), // 端午节：5 月 31 日至 6 月 2 日，共 3 天
      Object.freeze(["2025-10-01", "2025-10-08"]), // 国庆节、中秋节：10 月 1 日至 8 日，共 8 天
    ]),
    makeup: Object.freeze([
      "2025-01-26", // 春节调休（周日上班）
      "2025-02-08", // 春节调休（周六上班）
      "2025-04-27", // 劳动节调休（周日上班）
      "2025-09-28", // 国庆调休（周日上班）
      "2025-10-11", // 国庆调休（周六上班）
    ]),
  }),

  2026: Object.freeze({
    holidays: Object.freeze([
      Object.freeze(["2026-01-01", "2026-01-03"]), // 元旦：1 月 1 日至 3 日，共 3 天
      Object.freeze(["2026-02-15", "2026-02-23"]), // 春节：2 月 15 日至 23 日，共 9 天
      Object.freeze(["2026-04-04", "2026-04-06"]), // 清明节：4 月 4 日至 6 日，共 3 天
      Object.freeze(["2026-05-01", "2026-05-05"]), // 劳动节：5 月 1 日至 5 日，共 5 天
      Object.freeze(["2026-06-19", "2026-06-21"]), // 端午节：6 月 19 日至 21 日，共 3 天
      Object.freeze(["2026-09-25", "2026-09-27"]), // 中秋节：9 月 25 日至 27 日，共 3 天（不调休）
      Object.freeze(["2026-10-01", "2026-10-07"]), // 国庆节：10 月 1 日至 7 日，共 7 天
    ]),
    makeup: Object.freeze([
      "2026-01-04", // 元旦调休（周日上班）
      "2026-02-14", // 春节调休（周六上班）
      "2026-02-28", // 春节调休（周六上班）
      "2026-05-09", // 劳动节调休（周六上班）
      "2026-09-20", // 国庆调休（周日上班）
      "2026-10-10", // 国庆调休（周六上班）
    ]),
  }),
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 日号 ↔ 日期字符串（本模块自带最小实现，避免依赖主模块造成循环导入） */
function toSerial(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

function toIso(serial) {
  const date = new Date(serial * 86400000);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * 由原始数据构建只读索引：`ISO 日期 → 'holiday' | 'makeup'`。
 * 纯函数，无副作用；同一日期只会命中一种类型（调休优先于放假区间，
 * 二者在官方数据中本就互斥，此处仅为防御重叠数据）。
 * @returns {Map<string, 'holiday'|'makeup'>}
 */
export function buildHolidayIndex() {
  const index = new Map();

  Object.keys(HOLIDAYS_BY_YEAR).forEach((yearKey) => {
    const year = HOLIDAYS_BY_YEAR[yearKey];
    year.holidays.forEach(([from, to]) => {
      if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) return;
      for (let s = toSerial(from); s <= toSerial(to); s += 1) index.set(toIso(s), "holiday");
    });
  });

  Object.keys(HOLIDAYS_BY_YEAR).forEach((yearKey) => {
    HOLIDAYS_BY_YEAR[yearKey].makeup.forEach((iso) => {
      if (!ISO_DATE.test(iso)) return;
      index.set(iso, "makeup");
    });
  });

  return index;
}

/**
 * 内置索引（模块加载时构建一次）。
 * 只读常量：**调用方不得修改**（Map 的冻结不阻止 `set`，故以约定 + 不对外暴露写入口保证）。
 */
export const HOLIDAY_INDEX = buildHolidayIndex();

/** 某年份是否在内置数据覆盖范围内 */
export function isCoveredYear(year) {
  return COVERAGE_YEARS.includes(year);
}

/**
 * 查询内置数据中某日期的类型。
 * @param {string} iso `YYYY-MM-DD`
 * @returns {'holiday'|'makeup'|null} 未命中返回 `null`（交由周末规则 / 回退处理）
 */
export function lookupBuiltinType(iso) {
  if (!ISO_DATE.test(iso)) return null;
  const hit = HOLIDAY_INDEX.get(iso);
  return hit || null;
}

/** 该日期所属年份的数据来源说明（未覆盖返回空字符串） */
export function sourceOfYear(year) {
  return SOURCES[year] || "";
}
