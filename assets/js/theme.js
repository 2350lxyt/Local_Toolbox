/**
 * 主题管理
 * ------------------------------------------------------------------
 * 三态偏好：system（跟随系统）/ light（浅色）/ dark（深色）。
 * 偏好持久化在 localStorage，读取失败时安全回退，绝不抛错阻断渲染。
 *
 * 首屏防闪烁由 theme-boot.js（<head> 中的同步脚本）负责，
 * 本模块负责运行时切换与系统主题变化的监听。
 */

export const THEME_KEY = "toolbox:theme";
export const THEME_PREFS = ["system", "light", "dark"];

export const THEME_LABEL = Object.freeze({
  system: "跟随系统",
  light: "浅色",
  dark: "深色",
});

export const THEME_ICON = Object.freeze({
  system: "monitor",
  light: "sun",
  dark: "moon",
});

const DARK_QUERY = "(prefers-color-scheme: dark)";
const root = document.documentElement;

/** 安全读取 localStorage */
function read(key, fallback) {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value;
  } catch (error) {
    return fallback;
  }
}

/** 安全写入 localStorage */
function write(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch (error) {
    /* 隐私模式或存储被禁用时静默忽略 */
  }
}

/** 系统当前偏好的主题 */
export function systemTheme() {
  try {
    return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
  } catch (error) {
    return "light";
  }
}

/** 读取用户偏好（可能是 system） */
export function getThemePref() {
  const value = read(THEME_KEY, "system");
  return THEME_PREFS.includes(value) ? value : "system";
}

/** 将偏好解析为最终生效的主题 */
export function resolveTheme(pref = getThemePref()) {
  return pref === "system" ? systemTheme() : pref;
}

/** 应用偏好到文档根节点 */
export function applyTheme(pref = getThemePref()) {
  const resolved = resolveTheme(pref);
  root.dataset.theme = resolved;
  root.dataset.themePref = pref;
  return resolved;
}

/** 写入偏好并立即生效 */
export function setThemePref(pref) {
  const next = THEME_PREFS.includes(pref) ? pref : "system";
  write(THEME_KEY, next);
  return applyTheme(next);
}

/** 按 跟随系统 → 浅色 → 深色 → 跟随系统 的顺序循环 */
export function cycleThemePref() {
  const current = getThemePref();
  const index = THEME_PREFS.indexOf(current);
  const next = THEME_PREFS[(index + 1) % THEME_PREFS.length];
  setThemePref(next);
  return next;
}

/**
 * 初始化主题：立即应用并监听系统主题变化。
 * @returns {() => void} 取消监听
 */
export function initTheme() {
  applyTheme();

  let media = null;
  const onSystemChange = () => {
    if (getThemePref() === "system") applyTheme("system");
  };

  try {
    media = window.matchMedia(DARK_QUERY);
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", onSystemChange);
    } else if (typeof media.addListener === "function") {
      media.addListener(onSystemChange);
    }
  } catch (error) {
    media = null;
  }

  return () => {
    if (!media) return;
    if (typeof media.removeEventListener === "function") {
      media.removeEventListener("change", onSystemChange);
    } else if (typeof media.removeListener === "function") {
      media.removeListener(onSystemChange);
    }
  };
}
