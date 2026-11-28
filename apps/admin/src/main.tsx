import { createRoot } from "react-dom/client";
import { BusinessViewAdmin, THEME_KEY } from "./business-view-admin";
import "@fontsource-variable/public-sans";
import "./admin-tailwind.css";
import "@/packages/web/src/styles/spontra-ui.css";
import "./report-admin.css";
import "./admin-theme.css";
try { if (localStorage.getItem(THEME_KEY) === "light") document.documentElement.classList.remove("dark"); } catch { /* Private window: stay ink. */ }
createRoot(document.getElementById("root")!).render(<BusinessViewAdmin />);
