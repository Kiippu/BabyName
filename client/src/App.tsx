import { useEffect, useState } from "react";
import { api, SESSION_EXPIRED_EVENT } from "./api";
import type { Me, Settings } from "./types";
import { PinScreen } from "./screens/PinScreen";
import { SetScreen } from "./screens/SetScreen";
import { Shortlist } from "./screens/Shortlist";
import { ThemesScreen } from "./screens/ThemesScreen";
import { SetupSheet } from "./components/SetupSheet";
import { hideSplash } from "./splash";

// Change Order 1, build step 5: the shortlist is now wired up. Per spec §6's
// "zero chrome" rule for the set screen itself, Shortlist is only reachable
// from the waiting-on-partner state and the round-result footer (see
// SetScreen.tsx/RoundResult.tsx's onOpenShortlist prop) — never from the
// core sorting screen. "Names & surnames" is likewise only reachable from
// inside the shortlist now, rendered here as a plain overlay on top of
// whichever view is current. Change Order 3 build order step 6 adds
// "themes" alongside it, reached the same way.
type View = "round" | "shortlist" | "themes";

export function App() {
  const [me, setMe] = useState<Me | undefined>(undefined);
  const [settings, setSettings] = useState<Settings | undefined>(undefined);
  const [view, setView] = useState<View>("round");
  const [showSettings, setShowSettings] = useState(false);
  // Initial /me or /settings load failed (server down, no network). Without
  // this the shell would render nothing forever once the splash lifted.
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    api.getMe().then(setMe).catch(() => setLoadError(true));
  }, []);

  // Splash (index.html + splash.ts): lift it once the first real screen has
  // its data — the PIN screen needs only /me, setup and the set screen also
  // need settings. The 8s timeout means an unreachable server can never trap
  // the user behind it.
  const firstScreenReady = me !== undefined && (!me.claimed || settings !== undefined);
  useEffect(() => {
    if (firstScreenReady || loadError) hideSplash();
  }, [firstScreenReady, loadError]);
  useEffect(() => {
    const t = setTimeout(hideSplash, 8000);
    return () => clearTimeout(t);
  }, []);

  // Sessions now slide for 30 days (server/identity.py, CO-4 §3 -- PINs
  // solve the "stuck as the wrong person" problem the old short session
  // existed for, so there's no reason to force a re-entry every few
  // minutes). Re-check who's signed in whenever the app regains focus —
  // reopening after the phone was locked or backgrounded is exactly when a
  // session is most likely to have lapsed — and whenever any request comes
  // back 401 mid-use. Both land back on the PIN screen automatically instead
  // of a stuck screen or a raw error.
  useEffect(() => {
    const refresh = () => api.getMe().then(setMe).catch(() => {});
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, refresh);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener(SESSION_EXPIRED_EVENT, refresh);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  useEffect(() => {
    if (!me?.claimed) return;
    api.getSettings().then(setSettings).catch(() => setLoadError(true));
  }, [me?.claimed]);

  async function handleGate(pin: string) {
    const updated = await api.gate(pin);
    setMe(updated);
  }

  function handleSettingsSaved(updated: Settings) {
    setSettings(updated);
    setShowSettings(false);
  }

  const firstRunPending = me?.claimed && settings && !settings.setupDone;

  return (
    <div className="shell">
      {loadError && !firstScreenReady ? (
        <div className="takeover">
          <div className="kicker">Can't reach Nameplate</div>
          <div className="sub">Check your connection, then try again.</div>
          <button onClick={() => window.location.reload()}>Try again</button>
        </div>
      ) : me === undefined ? null : !me.claimed ? (
        <PinScreen onGate={handleGate} />
      ) : !settings ? null : firstRunPending ? (
        <SetupSheet settings={settings} me={me} firstRun onSaved={handleSettingsSaved} />
      ) : (
        <>
          {view === "shortlist" ? (
            <Shortlist
              me={me}
              settings={settings}
              onBack={() => setView("round")}
              onOpenSettings={() => setShowSettings(true)}
              onOpenThemes={() => setView("themes")}
            />
          ) : view === "themes" ? (
            <ThemesScreen onBack={() => setView("shortlist")} />
          ) : (
            <SetScreen onOpenShortlist={() => setView("shortlist")} />
          )}
          {showSettings && (
            <SetupSheet
              settings={settings}
              me={me}
              firstRun={false}
              onClose={() => setShowSettings(false)}
              onSaved={handleSettingsSaved}
            />
          )}
        </>
      )}
    </div>
  );
}
