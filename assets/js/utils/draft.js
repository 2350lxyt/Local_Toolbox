/**
 * 工具输入草稿（v1.7.22，§8.1 / R5 例外之二）
 * ------------------------------------------------------------------
 * 两层存储，都只落在**本机浏览器**、永不上传（R2 不变）：
 *   1. 会话级（sessionStorage，**默认写，无开关**）：同一标签页刷新/崩溃恢复不丢；
 *      关闭窗口即弃 —— 这是「底线保障」，不是持久化；
 *   2. 本地草稿箱（localStorage，**仅当用户显式开启该工具的「本地草稿」开关**）：
 *      跨会话持久；关闭开关即删除已存草稿（语义：关 = 清）。
 *
 * 键规则与 §8.1 的实例级配置键同构：serial > 1 时追加 `:<serial>`；
 * 多输入区工具用 slot 区分（如 text-diff 的 left / right）。
 * 全部读写 try/catch 静默降级（隐私模式 / 配额超限不阻断工具，§8.3）。
 */

/** 单个输入区草稿的字符数上限：超出即停止自动保存（会话与本地都不写），由工具提示一次 */
export const DRAFT_MAX_CHARS = 1000000;

/** 会话级草稿键：`toolbox:<tool>:session-draft[:<serial>]:<slot>` */
export function sessionDraftKey(toolId, serial, slot) {
  const suffix = Number.isInteger(serial) && serial > 1 ? ":" + serial : "";
  return "toolbox:" + toolId + ":session-draft" + suffix + ":" + slot;
}

/** 本地草稿键：`toolbox:<tool>:draft[:<serial>]:<slot>`（serial > 1 才带序号，与配置键同构） */
export function localDraftKey(toolId, serial, slot) {
  const suffix = Number.isInteger(serial) && serial > 1 ? ":" + serial : "";
  return "toolbox:" + toolId + ":draft" + suffix + ":" + slot;
}

/** 本地草稿箱开关键（跨实例共享的隐私选择；未登记 = 关） */
export function draftEnabledKey(toolId) {
  return "toolbox:" + toolId + ":draft-enabled";
}

/** 本地草稿箱是否已开启 */
export function isDraftEnabled(toolId) {
  try {
    return window.localStorage.getItem(draftEnabledKey(toolId)) === "1";
  } catch {
    return false;
  }
}

/**
 * 设置本地草稿箱开关。**关闭时同时删除该工具全部已存草稿**（语义：关 = 清）。
 * @param {string} toolId 工具 id
 * @param {boolean} enabled 开 / 关
 * @param {number|undefined} serial 实例序号（工具独立页 / 首实例可省略）
 * @param {string[]} slots 需要清理的输入区槽位（如 ["input"] 或 ["left", "right"]）
 */
export function setDraftEnabled(toolId, enabled, serial, slots) {
  try {
    if (enabled) {
      window.localStorage.setItem(draftEnabledKey(toolId), "1");
      return;
    }
    window.localStorage.removeItem(draftEnabledKey(toolId));
    (slots || []).forEach((slot) => {
      window.localStorage.removeItem(localDraftKey(toolId, serial, slot));
    });
  } catch {
    // 存储不可用（隐私模式等）：开关仅影响本次会话
  }
}

/**
 * 保存草稿：会话级总是写；本地草稿箱仅在开关开启且不超上限时写。
 * @param {string} toolId 工具 id
 * @param {number|undefined} serial 实例序号
 * @param {string} slot 输入区槽位
 * @param {string} text 输入区当前内容
 * @returns {"both"|"session"|"none"} 实际写入层级（超上限返回 "none"，供工具提示一次）
 */
export function saveDraft(toolId, serial, slot, text) {
  let level = "none";
  if (text.length > DRAFT_MAX_CHARS) return level;
  try {
    window.sessionStorage.setItem(sessionDraftKey(toolId, serial, slot), text);
    level = "session";
  } catch {
    // 会话存储不可用 / 超配额：忽略
  }
  if (isDraftEnabled(toolId)) {
    try {
      window.localStorage.setItem(localDraftKey(toolId, serial, slot), text);
      level = "both";
    } catch {
      // 本地配额超出：保持会话级
    }
  }
  return level;
}

/**
 * 读取草稿：优先会话级（同会话内最新），其次本地草稿箱。
 * @param {string} toolId 工具 id
 * @param {number|undefined} serial 实例序号
 * @param {string} slot 输入区槽位
 * @returns {{ text: string, source: "" | "session" | "local" }}
 */
export function loadDraft(toolId, serial, slot) {
  try {
    const session = window.sessionStorage.getItem(sessionDraftKey(toolId, serial, slot));
    if (session !== null) return { text: session, source: "session" };
  } catch {
    // 忽略
  }
  if (isDraftEnabled(toolId)) {
    try {
      const local = window.localStorage.getItem(localDraftKey(toolId, serial, slot));
      if (local !== null) return { text: local, source: "local" };
    } catch {
      // 忽略
    }
  }
  return { text: "", source: "" };
}