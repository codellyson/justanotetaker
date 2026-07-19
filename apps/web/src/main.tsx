import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { bootTheme } from "@codellyson/justui/boot";
import App from "./App";
import "./styles/global.css";

// Apply the user's stored theme/mode to <html> before React's first
// paint. Stamps window.__JUSTUI__ so useTheme() in React components
// knows which localStorage keys to read/write. Default is espresso/dark
// (configured inside @codellyson/justui).
const THEME_PREFIX = "justanotetaker";
bootTheme({ keyPrefix: THEME_PREFIX });

// When embedded (e.g. the marketing site's canvas preview iframe), let the
// host's theme toggle drive the canvas: the parent postMessages the mode/theme
// and we mirror it into our own localStorage, then synthesize a `storage`
// event so bootTheme + useTheme re-apply exactly as they do for a cross-tab
// change (storage events don't fire in the tab that made the write).
if (window.parent !== window) {
  const modeKey = `${THEME_PREFIX}.theme.mode`;
  const idKey = `${THEME_PREFIX}.theme.id`;
  window.addEventListener("message", (e: MessageEvent) => {
    const d = e.data;
    if (!d || d.type !== "justui:theme") return;
    if (d.mode !== "dark" && d.mode !== "light") return;
    try {
      localStorage.setItem(modeKey, d.mode);
      if (typeof d.themeId === "string" && d.themeId) localStorage.setItem(idKey, d.themeId);
    } catch {
      /* localStorage blocked */
    }
    window.dispatchEvent(new StorageEvent("storage", { key: modeKey }));
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
