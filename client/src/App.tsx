import { useEffect, useState } from "react";
import { api, SESSION_EXPIRED_EVENT } from "./api";
import type { Me, Settings } from "./types";
import { ClaimDevice } from "./screens/ClaimDevice";
import { SetScreen } from "./screens/SetScreen";
import { Shortlist } from "./screens/Shortlist";
import { ThemesScreen } from "./screens/ThemesScreen";
import { SetupSheet } from "./components/SetupSheet";

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

  useEffect(() => {
    api.getMe().then(setMe);
  }, []);

  // Sessions expire after 5 minutes of inactivity (server/src/identity.js,
  // owner's revision to the old permanent-device-claim model). Re-check who's
  // signed in whenever the app regains focus — reopening after the phone was
  // locked or backgrounded is exactly when a session is most likely to have
  // lapsed — and whenever any request comes back 401 mid-use. Both land back
  // on "which one of you is this?" automatically instead of a stuck screen
  // or a raw error.
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
    api.getSettings().then(setSettings);
  }, [me?.claimed]);

  async function handleClaim(userId: number) {
    const updated = await api.claim(userId);
    setMe(updated);
  }

  function handleSettingsSaved(updated: Settings) {
    setSettings(updated);
    setShowSettings(false);
  }

  const firstRunPending = me?.claimed && settings && !settings.setupDone;

  return (
    <div className="shell">
      {me === undefined ? null : !me.claimed ? (
        <ClaimDevice candidates={me.candidates} onClaim={handleClaim} />
      ) : !settings ? null : firstRunPending ? (
        <SetupSheet settings={settings} firstRun onSaved={handleSettingsSaved} />
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
