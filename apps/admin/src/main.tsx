import { createRoot } from "react-dom/client";
import { BusinessViewAdmin, THEME_KEY } from "./business-view-admin";
import { BUSINESS_MAP_ORIGIN } from "@/shared/admin-site";
import "@/packages/web/src/styles/globals.css";
import "@/packages/web/src/styles/spontra-ui.css";
import "./report-admin.css";
try { if (localStorage.getItem(THEME_KEY) === "light") document.documentElement.classList.remove("dark"); } catch { /* Private window: stay ink. */ }
createRoot(document.getElementById("root")!).render(<BusinessViewAdmin mapOrigin={BUSINESS_MAP_ORIGIN} />);
