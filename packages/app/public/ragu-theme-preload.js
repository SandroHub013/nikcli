;(function () {
  var themeId = localStorage.getItem("ragu-theme-id")
  if (!themeId) return

  var scheme = localStorage.getItem("ragu-color-scheme") || "system"
  var isDark = scheme === "dark" || (scheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
  var mode = isDark ? "dark" : "light"

  document.documentElement.dataset.theme = themeId
  document.documentElement.dataset.colorScheme = mode

  if (themeId === "ragu-default") return

  var css = localStorage.getItem("ragu-theme-css-" + mode)
  if (css) {
    var style = document.createElement("style")
    style.id = "ragu-theme-preload"
    style.textContent =
      ":root{color-scheme:" +
      mode +
      ";--text-mix-blend-mode:" +
      (isDark ? "plus-lighter" : "multiply") +
      ";" +
      css +
      "}"
    document.head.appendChild(style)
  }
})()
