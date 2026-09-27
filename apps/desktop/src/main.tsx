import { createRoot } from "react-dom/client";
import { App } from "./app";
import { initializePlatform } from "./transport";
import "@/packages/ui/src/styles.css";
import "katex/dist/katex.min.css";
import "./desktop.css";
initializePlatform();
document.documentElement.dataset.platform = "desktop";
createRoot(document.getElementById("root")!).render(<App />);
