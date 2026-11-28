try {
  if (localStorage.getItem("business-map-theme") === "light") {
    document.documentElement.classList.replace("dark", "light");
    document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", "light");
  }
} catch {
  /* Storage may be disabled. */
}
