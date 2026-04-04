const THEME_IDS = new Set([
  "midnight",
  "charcoal",
  "slate",
  "ocean",
  "lavender",
  "meritus-via",
  "light",
  "paper",
  "high-contrast"
]);

try {
  const savedTheme = window.localStorage.getItem("wcjr.theme");
  if (savedTheme && THEME_IDS.has(savedTheme)) {
    document.documentElement.setAttribute("data-theme", savedTheme);
  }
} catch {
  // Ignore local storage failures during early bootstrap.
}
