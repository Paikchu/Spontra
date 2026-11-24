try {
  if (new URLSearchParams(location.search).get("embed") === "statements") {
    const preference = matchMedia("(prefers-color-scheme: light)");
    const apply = ({ matches }) => {
      document.documentElement.classList.toggle("light", matches);
      document.documentElement.classList.toggle("dark", !matches);
      document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", matches ? "light" : "dark");
    };
    apply(preference);
    preference.addEventListener("change", apply);
  } else if (localStorage.getItem("business-map-theme") === "light") {
    document.documentElement.classList.replace("dark", "light");
    document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", "light");
  }
} catch {
  /* Storage may be disabled. */
}
