// Sets the theme before first paint so a light-mode viewer never sees a dark flash.
// A saved choice wins; otherwise the system preference decides. Kept in sync with src/theme.ts.
(function () {
  var theme = null;
  try {
    theme = localStorage.getItem("qkt-insights-theme");
  } catch (e) {
    theme = null;
  }
  if (theme !== "light" && theme !== "dark") {
    theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  document.documentElement.setAttribute("data-theme", theme);
})();
