import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { AddNameSheet } from "../components/AddNameSheet";
import { NameDetailSheet } from "../components/NameDetailSheet";
import { Toast, type ToastData } from "../components/Toast";
import type { ListRow, ListTab, Me, Settings, Stats } from "../types";

// Change Order 1 replaced the Elo "Ours/Mine/Struck out" model with a single
// shared standing (server/src/list.js): rounds_survived, then selectivity as
// the tiebreaker. Nothing here is per-viewer gated any more — once a round
// is sealed its outcome is common knowledge to both parents.
const TABS: { key: ListTab; label: string }[] = [
  { key: "in", label: "Still in" },
  { key: "out", label: "Out" },
];

function note(tab: ListTab) {
  if (tab === "in") {
    return (
      <>
        Ordered by rounds survived, then by how picky the round was when it
        was kept — surviving a round where little else did counts for more.
      </>
    );
  }
  return (
    <>
      Fell in a round when it wasn&rsquo;t kept. There&rsquo;s no strike-out
      button &mdash; a name only leaves by failing to be kept.
    </>
  );
}

export function Shortlist({
  me,
  settings,
  onBack,
  onOpenSettings,
  onOpenThemes,
}: {
  me: Me;
  settings: Settings;
  onBack: () => void;
  onOpenSettings: () => void;
  onOpenThemes: () => void;
}) {
  const [tab, setTab] = useState<ListTab>("in");
  const [rows, setRows] = useState<Partial<Record<ListTab, ListRow[]>>>({});
  const [stats, setStats] = useState<Stats | undefined>(undefined);
  const [showAdd, setShowAdd] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [toast, setToast] = useState<ToastData | null>(null);

  const loadTab = useCallback((t: ListTab) => {
    api.getList(t).then((data) => setRows((prev) => ({ ...prev, [t]: data })));
  }, []);

  const refreshAll = useCallback(() => {
    loadTab("in");
    loadTab("out");
    api.getStats().then(setStats);
  }, [loadTab]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  function handleAdded(name: string) {
    setShowAdd(false);
    refreshAll();
    setToast({ message: `“${name}” is in the pile.` });
  }

  function handleDuplicate(name: string) {
    setToast({ message: `“${name}” is already in the pile.` });
  }

  const currentRows = rows[tab];

  return (
    <>
      <header className="topbar">
        <button className="backbtn" onClick={onBack}>
          <svg viewBox="0 0 24 24">
            <path d="M15 5l-7 7 7 7" />
          </svg>
          Back to the round
        </button>
        <span className="topbar-mark">{me.label}</span>
      </header>
      <section className="screen">
        <div className="tabs" role="tablist">
          {TABS.map(({ key, label }) => (
            <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>
              {label} <span className="n">{rows[key]?.length ?? ""}</span>
            </button>
          ))}
        </div>
        <div className="scroll">
          <p className="section-note">{note(tab)}</p>
          <button className="addrow" onClick={() => setShowAdd(true)}>
            <svg viewBox="0 0 24 24">
              <path d="M12 5v14M5 12h14" />
            </svg>
            <span>Add a name to the pile</span>
          </button>
          {currentRows && currentRows.length === 0 && (
            <div className="empty">
              <p>Nothing here yet.</p>
              <small>{tab === "in" ? "Play a round to get started" : "No names have fallen yet"}</small>
            </div>
          )}
          {currentRows?.map((row, i) => (
            <button
              key={row.id}
              className={`row${tab === "out" ? " out" : ""}`}
              onClick={() => setDetailId(row.id)}
            >
              <span className="row-rank">{String(i + 1).padStart(2, "0")}</span>
              <span className="row-main">
                <span className="row-name">{row.name}</span>
                <span className="row-sub">
                  {row.origin} · {row.meaning}
                </span>
              </span>
              <span className="row-side">
                {row.roundsSurvived > 0 && <span className="chip kept">Kept {row.roundsSurvived}</span>}
              </span>
              <span className="row-go">›</span>
            </button>
          ))}
          <div className="stats">
            <div className="stat">
              <b>{stats?.rounds ?? 0}</b>
              <span>Rounds</span>
            </div>
            <div className="stat">
              <b>{stats?.stillIn ?? 0}</b>
              <span>Still in</span>
            </div>
            <div className="stat">
              <b>{stats?.agreement ?? 0}%</b>
              <span>Agreement</span>
            </div>
          </div>
          <div className="pad">
            <button className="linkish" onClick={onOpenSettings}>
              Names & surnames
            </button>
            <button className="linkish" onClick={onOpenThemes}>
              Manage themes
            </button>
          </div>
        </div>
      </section>
      {showAdd && (
        <AddNameSheet
          settings={settings}
          onClose={() => setShowAdd(false)}
          onAdded={handleAdded}
          onDuplicate={handleDuplicate}
        />
      )}
      {detailId !== null && <NameDetailSheet nameId={detailId} onClose={() => setDetailId(null)} />}
      {toast && <Toast toast={toast} onDismiss={() => setToast(null)} />}
    </>
  );
}
