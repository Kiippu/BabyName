import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/round.css";
import "./styles/overlay.css";
import "./styles/list.css";
import "./styles/sheet.css";
import "./styles/themes.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

if ("serviceWorker" in navigator) {
  // sw.js uses skipWaiting()/clients.claim() so an updated worker takes
  // control immediately in the background — but that alone doesn't refresh
  // an already-open tab's in-memory JS. Without this listener, a phone that
  // opened the app before a deploy keeps running the OLD bundle indefinitely
  // (it just silently polls the API forever), even though the SW underneath
  // it has already updated. That's what happened 2026-09-06/07: a session
  // opened before the round-result feature shipped kept running pre-
  // resultReady code against the new server response shape, rendering a
  // blank set screen with an empty layout ("Set 6 of 5", "Keep -1 of 3")
  // instead of the round-result screen. Reload once when control changes so
  // a stale open tab self-heals instead of needing a manual force-quit.
  let refreshedOnce = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshedOnce) return;
    refreshedOnce = true;
    window.location.reload();
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(console.error);
  });
}
