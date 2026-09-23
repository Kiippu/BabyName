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

// Only the "Out" tab gets a sort control — "Still in" already has a single
// meaningful order (rounds survived, then selectivity) with no reason to
// second-guess it, but "Out" mixes names eliminated at wildly different
// points, and different questions ("what fell recently?" vs. "what almost
// made it?") want different orders.
type OutSort = "eliminatedIn" | "name" | "roundsSurvived";
const OUT_SORTS: { key: OutSort; label: string }[] = [
  { key: "eliminatedIn", label: "Round" },
  { key: "name", label: "Name" },
  { key: "roundsSurvived", label: "Kept #" },
];

function sortOutRows(rows: ListRow[], sort: OutSort): ListRow[] {
  const sorted = [...rows];
  switch (sort) {
    case "name":
      sorted.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case "roundsSurvived":
      // Most rounds survived before falling first — the "how close did it
      // get" question.
      sorted.sort((a, b) => b.roundsSurvived - a.roundsSurvived || a.name.localeCompare(b.name));
      break;
    case "eliminatedIn":
    default:
      // Matches the server's default order: most recently fallen first.
      sorted.sort((a, b) => (b.eliminatedIn ?? 0) - (a.eliminatedIn ?? 0) || a.name.localeCompare(b.name));
  }
  return sorted;
}

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
  const [outSort, setOutSort] = useState<OutSort>("eliminatedIn");
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

  const currentRows = tab === "out" && rows.out ? sortOutRows(rows.out, outSort) : rows[tab];

  return (
    <>
      <header className="topbar">
        <button className="backbtn" onClick={onBack}>
          <svg viewBox="0 0 24 24">
            <path d="M15 5l-7 7 7 7" />
          </svg>
          Back to the round
        </button>
        <div className="topbar-actions">
          <span className="topbar-mark">{me.label}</span>
          <button className="topbar-btn" onClick={onOpenSettings}>
            Settings
          </button>
          <button className="topbar-btn" onClick={onOpenThemes}>
            Themes
          </button>
        </div>
      </header>
      <section className="screen">
        <div className="tabs" role="tablist">
          {TABS.map(({ key, label }) => (
            <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>
              {label} <span className="n">{rows[key]?.length ?? ""}</span>
            </button>
          ))}
        </div>
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
        <div className="scroll">
          <p className="section-note">{note(tab)}</p>
          {tab === "out" && (
            <div className="chips sort-chips">
              {OUT_SORTS.map((s) => (
                <button key={s.key} aria-pressed={outSort === s.key} onClick={() => setOutSort(s.key)}>
                  {s.label}
                </button>
              ))}
            </div>
          )}
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
