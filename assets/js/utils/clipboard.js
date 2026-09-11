/**
 * 公共剪贴板能力
 * ------------------------------------------------------------------
 * 优先使用异步 Clipboard API；在非安全上下文（如 http 局域网访问）下
 * 自动降级为 execCommand 方案。所有操作均在本地完成，不涉及任何网络请求。
 */

/**
 * 复制文本到剪贴板。
 * @param {string} text
 * @returns {Promise<boolean>} 是否复制成功
 */
export async function copyText(text) {
  const value = String(text === null || text === undefined ? "" : text);

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (error) {
    /* 继续尝试降级方案 */
  }

  return legacyCopy(value);
}

/** 降级方案：借助临时 textarea + execCommand */
function legacyCopy(value) {
  try {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-9999px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, area.value.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch (error) {
    return false;
  }
}

/**
 * 读取剪贴板文本（部分浏览器会要求用户授权，失败返回空字符串）。
 * @returns {Promise<string>}
 */
export async function readText() {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      return await navigator.clipboard.readText();
    }
  } catch (error) {
    /* 忽略 */
  }
  return "";
}
