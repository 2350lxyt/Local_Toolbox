/**
 * 主题首屏引导（同步脚本，置于 <head> 中）
 * ------------------------------------------------------------------
 * 必须在首屏绘制之前设置 documentElement 的 data-theme / data-sidebar，
 * 以避免深色模式下的白闪（FOUC）。因此本文件刻意使用传统 <script> 同步加载，
 * 而不是 ES Module（模块默认延迟执行，来不及防闪烁）。
 *
 * 与 theme.js 共用同一组 localStorage 键，改动时需同步。
 */
(function () {
  var THEME_KEY = "toolbox:theme";
  var VARIANT_KEY = "toolbox:theme-variant";
  var SIDEBAR_KEY = "toolbox:sidebar";
  var root = document.documentElement;

  var theme = "system";
  var variant = "standard";
  var sidebar = "expanded";

  try {
    var storedTheme = window.localStorage.getItem(THEME_KEY);
    if (storedTheme === "light" || storedTheme === "dark" || storedTheme === "system") {
      theme = storedTheme;
    }
    var storedVariant = window.localStorage.getItem(VARIANT_KEY);
    if (storedVariant === "standard" || storedVariant === "dimmed" || storedVariant === "contrast") {
      variant = storedVariant;
    }
    if (window.localStorage.getItem(SIDEBAR_KEY) === "collapsed") {
      sidebar = "collapsed";
    }
  } catch (error) {
    /* 存储不可用时使用默认值 */
  }

  var resolved = theme;
  if (theme === "system") {
    try {
      resolved = window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    } catch (error) {
      resolved = "light";
    }
  }

  /* 双维解析（与 theme.js resolveThemeId 同一规则，§3.7）：
     light + dimmed 回退 light（「柔和」只作用于深色系）。 */
  if (variant === "contrast") {
    resolved = resolved + "-contrast";
  } else if (variant === "dimmed" && resolved === "dark") {
    resolved = "dark-dimmed";
  }

  root.setAttribute("data-theme", resolved);
  root.setAttribute("data-theme-pref", theme);
  root.setAttribute("data-theme-variant", variant);
  root.setAttribute("data-sidebar", sidebar);
})();
