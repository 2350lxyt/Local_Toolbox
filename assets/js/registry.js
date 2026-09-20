/**
 * 工具注册表 —— 本项目唯一的「扩展点」
 * ------------------------------------------------------------------
 * 新增一个工具只需要三步：
 *   1. 在 tools/<工具 id>/ 下创建 index.html（工具独立页面）；
 *   2. 在同目录创建 <工具 id>.js，导出 init(ctx) 处理函数；
 *   3. 在本文件 TOOLS 数组末尾追加一条记录。
 * 左侧列表与首页工具总览均由本注册表动态渲染，无需改动外壳代码。
 *
 * 注意：path 与 entry 一律使用「站点根相对路径」（不带前导斜杠），
 *      由 shell.js 通过 import.meta.url 解析为绝对地址，
 *      从而同时兼容 CloudBase 根路径与 GitHub Pages 子路径部署。
 */

/** 站点级元信息 */
export const SITE = {
  name: "本地工具箱",
  description:
    "一个完全在浏览器本地运行的工具集合。所有计算均在本机完成，不上传任何数据，也不请求任何第三方资源。",
  version: "0.1.0",
};

/**
 * @typedef {Object} ToolRecord
 * @property {string} id          工具唯一标识（同时作为 body[data-tool] 的值）
 * @property {string} name        显示名称
 * @property {string} icon        图标名，对应 icons.js 中的键
 * @property {string} description 一句话说明
 * @property {string} path        工具页面路径（站点根相对）
 * @property {string} entry       工具处理模块路径（站点根相对）
 * @property {string[]} [styles]  工具私有样式路径（站点根相对，按顺序生效）
 * @property {'ready'|'planned'} status 状态：ready=可用，planned=开发中
 * @property {string[]} [keywords] 可选关键字，用于后续搜索/过滤
 */

/** @type {ToolRecord[]} */
export const TOOLS = [
  {
    id: "text-line-merge",
    name: "文本行合并",
    icon: "merge",
    description:
      "将多行文本按指定分隔符合并为一行，支持自定义前缀与后缀、转义规则与预设模板。",
    path: "tools/text-line-merge/index.html",
    entry: "tools/text-line-merge/text-line-merge.js",
    styles: ["tools/text-line-merge/text-line-merge.css"],
    status: "ready",
    keywords: ["文本", "合并", "去换行", "前缀", "后缀", "预设"],
  },
  {
    id: "sql-format",
    name: "SQL 格式化",
    icon: "database",
    description:
      "格式化 Oracle / PostgreSQL 语句，带语法高亮、关键词搜索与选中文本全部高亮，并支持预设模板。",
    path: "tools/sql-format/index.html",
    entry: "tools/sql-format/sql-format.js",
    styles: ["tools/sql-format/sql-format.css"],
    status: "ready",
    keywords: ["SQL", "格式化", "美化", "Oracle", "PostgreSQL", "高亮", "搜索"],
  },
  {
    id: "date-calc",
    name: "日期天数计算器",
    icon: "calendar",
    description:
      "计算日期间隔与增减推算，并按中国日历区分工作日与休息日；内置官方节假日与调休安排，支持自定义与导入导出。",
    path: "tools/date-calc/index.html",
    entry: "tools/date-calc/date-calc.js",
    styles: ["tools/date-calc/date-calc.css"],
    status: "ready",
    keywords: ["日期", "天数", "工作日", "休息日", "节假日", "调休", "日历", "倒计时"],
  },
  {
    id: "text-diff",
    name: "文本对比",
    icon: "diff",
    description:
      "左右两栏文本对照，自动高亮行级与行内差异，支持拖入文件、两侧独立搜索、差异跳转、折叠相同行与代码高亮。",
    path: "tools/text-diff/index.html",
    entry: "tools/text-diff/text-diff.js",
    styles: ["tools/text-diff/text-diff.css"],
    status: "ready",
    keywords: ["文本", "对比", "比较", "差异", "diff", "代码高亮", "两栏"],
  },
];

/** 按 id 查找工具记录 */
export function getToolById(id) {
  if (!id) return null;
  return TOOLS.find((tool) => tool.id === id) || null;
}

/** 过滤出已可用的工具 */
export function getReadyTools() {
  return TOOLS.filter((tool) => tool.status === "ready");
}

/** 工具状态对应的展示文案 */
export const STATUS_LABEL = Object.freeze({
  ready: "可用",
  planned: "开发中",
});

export default TOOLS;
