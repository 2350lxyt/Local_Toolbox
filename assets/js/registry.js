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
  tagline: "纯客户端计算 · 数据不出设备",
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
    status: "ready",
    keywords: ["文本", "合并", "去换行", "前缀", "后缀", "预设"],
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
