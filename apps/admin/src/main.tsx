import { createRoot } from "react-dom/client";
import { BusinessViewAdmin, THEME_KEY } from "./business-view-admin";
import { PUBLIC_SITE_ORIGIN } from "@/shared/analysis-runtime/site";
import "@fontsource-variable/public-sans";
import "@fontsource-variable/roboto-slab";
import "./admin-tailwind.css";
import "@/packages/web/src/styles/spontra-ui.css";
import "./report-admin.css";
import "./admin-theme.css";
try { if (localStorage.getItem(THEME_KEY) === "light") document.documentElement.classList.remove("dark"); } catch { /* Private window: stay ink. */ }
createRoot(document.getElementById("root")!).render(<BusinessViewAdmin mapOrigin={PUBLIC_SITE_ORIGIN} />);
