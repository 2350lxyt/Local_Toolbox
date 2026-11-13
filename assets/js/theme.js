/**
 * 主题管理
 * ------------------------------------------------------------------
 * 双维偏好（v1.7.47 · §3.7 主题矩阵）：
 *   模式维 toolbox:theme       —— system（跟随系统）/ light / dark
 *   变体维 toolbox:theme-variant —— standard / dimmed / contrast
 * 两维解析出 5 个具体主题之一（light / dark / dark-dimmed / light-contrast /
 * dark-contrast）写入 data-theme；变体偏好另写入 data-theme-variant。
 * 「柔和」只作用于深色系：light + dimmed 回退 light。
 * 偏好持久化在 localStorage，读取失败时安全回退，绝不抛错阻断渲染。
 *
 * 首屏防闪烁由 theme-boot.js（<head> 中的同步脚本）负责，
 * 本模块负责运行时切换与系统主题变化的监听。
 */

export const THEME_KEY = "toolbox:theme";
export const VARIANT_KEY = "toolbox:theme-variant";
export const THEME_PREFS = ["system", "light", "dark"];
export const THEME_VARIANTS = ["standard", "dimmed", "contrast"];

export const THEME_LABEL = Object.freeze({
  system: "跟随系统",
  light: "浅色",
  dark: "深色",
});

export const VARIANT_LABEL = Object.freeze({
  standard: "标准",
  dimmed: "柔和",
  contrast: "高对比",
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

/** 读取模式偏好（可能是 system） */
export function getThemePref() {
  const value = read(THEME_KEY, "system");
  return THEME_PREFS.includes(value) ? value : "system";
}

/** 读取变体偏好 */
export function getThemeVariant() {
  const value = read(VARIANT_KEY, "standard");
  return THEME_VARIANTS.includes(value) ? value : "standard";
}

/**
 * 双维解析为具体主题 id（§3.7）。
 * light + dimmed 回退 light（「柔和」只作用于深色系）。
 */
export function resolveThemeId(pref = getThemePref(), variant = getThemeVariant()) {
  const mode = pref === "system" ? systemTheme() : pref;
  if (variant === "contrast") return `${mode}-contrast`;
  if (variant === "dimmed" && mode === "dark") return "dark-dimmed";
  return mode;
}

/** 将模式偏好解析为浅色 / 深色（不含变体） */
export function resolveTheme(pref = getThemePref()) {
  return pref === "system" ? systemTheme() : pref;
}

/** 应用双维偏好到文档根节点 */
export function applyTheme(pref = getThemePref(), variant = getThemeVariant()) {
  root.dataset.theme = resolveThemeId(pref, variant);
  root.dataset.themePref = pref;
  root.dataset.themeVariant = variant;
  return root.dataset.theme;
}

/** 写入模式偏好并立即生效 */
export function setThemePref(pref) {
  const next = THEME_PREFS.includes(pref) ? pref : "system";
  write(THEME_KEY, next);
  return applyTheme(next, getThemeVariant());
}

/** 写入变体偏好并立即生效 */
export function setThemeVariant(variant) {
  const next = THEME_VARIANTS.includes(variant) ? variant : "standard";
  write(VARIANT_KEY, next);
  return applyTheme(getThemePref(), next);
}

/**
 * 初始化主题：立即应用并监听系统主题变化。
 * @returns {() => void} 取消监听
 */
export function initTheme() {
  applyTheme();

  let media = null;
  const onSystemChange = () => {
    if (getThemePref() === "system") applyTheme("system", getThemeVariant());
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
