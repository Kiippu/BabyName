import { useEffect, useState } from "react";
import { api } from "../api";
import type { ThemeNode, ThemePack } from "../types";

/**
 * Themes screen — Change Order 3 build order step 6. Packs grouped, each
 * region's cultures nested underneath it. Toggling a switch only ever flips
 * that one row: server/src/themes.js never touches a region's children when
 * the region itself is disabled.
 */
export function ThemesScreen({ onBack }: { onBack: () => void }) {
  const [packs, setPacks] = useState<ThemePack[] | undefined>(undefined);
  const [pending, setPending] = useState<number | null>(null);

  useEffect(() => {
    api.getThemes().then(setPacks);
  }, []);

  async function toggle(node: ThemeNode) {
    if (pending !== null) return;
    setPending(node.id);
    try {
      setPacks(await api.setThemeEnabled(node.id, !node.enabled));
    } finally {
      setPending(null);
    }
  }

  function renderNode(node: ThemeNode, isChild: boolean) {
    return (
      <div key={node.id}>
        <div className={`theme-row${isChild ? " child" : ""}`}>
          <span className="theme-main">
            <span className="theme-title">{node.title}</span>
            <span className="theme-sub">
              {node.kind} · {node.nameCount} names
            </span>
          </span>
          <button
            className={`theme-switch${node.enabled ? " on" : ""}`}
            role="switch"
            aria-checked={node.enabled}
            aria-label={`${node.enabled ? "Disable" : "Enable"} ${node.title}`}
            disabled={pending === node.id}
            onClick={() => toggle(node)}
          >
            <span className="knob" />
          </button>
        </div>
        {node.children.map((child) => renderNode(child, true))}
      </div>
    );
  }

  return (
    <>
      <header className="topbar">
        <button className="backbtn" onClick={onBack}>
          <svg viewBox="0 0 24 24">
            <path d="M15 5l-7 7 7 7" />
          </svg>
          Back
        </button>
        <span className="topbar-mark">Themes</span>
      </header>
      <section className="screen">
        <div className="scroll">
          <p className="section-note">
            What a round can draw new names from. Disabling a region leaves its cultures
            untouched &mdash; turn those off too if that&rsquo;s what you mean.
          </p>
          {packs === undefined && (
            <div className="empty">
              <p>Loading…</p>
            </div>
          )}
          {packs?.map((pack) => (
            <div className="theme-pack" key={pack.id}>
              <div className="theme-pack-head">
                <span className="theme-pack-title">{pack.title}</span>
                {pack.blurb && <span className="theme-pack-blurb">{pack.blurb}</span>}
              </div>
              {pack.themes.map((theme) => renderNode(theme, false))}
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
