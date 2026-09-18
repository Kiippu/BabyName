import type {
  BabySurnameMode,
  ListRow,
  ListTab,
  Me,
  NameCard,
  NameDetail,
  PersonSettings,
  RoundPayload,
  RoundResultPayload,
  Settings,
  SetLockResult,
  Stats,
  ThemePack,
} from "./types";

// Sessions slide forward on use (server/identity.py) — but if the app sits
// untouched for 30+ days and then makes a request, the server comes back
// 401. Rather than every screen having to know what that means, broadcast it
// once here so App.tsx can react centrally by dropping back to the PIN
// screen instead of a raw error.
export const SESSION_EXPIRED_EVENT = "nameplate:session-expired";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

export const api = {
  getMe: () => request<Me>("/api/me"),
  // POST /api/gate replaces POST /api/me (CO-4 §1.1/§3): a credential now,
  // not a bare claim. The response is {userId, label, surname} -- no
  // `claimed` field, since the server only ever sends that on success --
  // so it's added here rather than round-tripping through getMe() again.
  gate: async (pin: string) => {
    const body = await request<{ userId: number; label: string; surname: string }>("/api/gate", {
      method: "POST",
      body: JSON.stringify({ pin }),
    });
    return { ...body, claimed: true } as Me;
  },
  getList: (tab: ListTab) => request<ListRow[]>(`/api/list?tab=${tab}`),
  getStats: () => request<Stats>("/api/stats"),
  getSettings: () => request<Settings>("/api/settings"),
  updateSettings: (settings: { father: PersonSettings; mother: PersonSettings; babySurname: BabySurnameMode }) =>
    request<Settings>("/api/settings", { method: "PUT", body: JSON.stringify(settings) }),
  addName: (name: string, note: string) =>
    request<NameCard>("/api/names", { method: "POST", body: JSON.stringify({ name, note }) }),
  getNameDetail: (id: number) => request<NameDetail>(`/api/names/${id}`),
  getRound: () => request<RoundPayload>("/api/round"),
  lockSet: (roundId: number, setIndex: number, keptIds: number[]) =>
    request<SetLockResult>("/api/set", {
      method: "POST",
      body: JSON.stringify({ roundId, setIndex, keptIds }),
    }),
  getRoundResult: (roundId: number) => request<RoundResultPayload>(`/api/round/${roundId}/result`),
  ackRound: (roundId: number) => request<RoundPayload>(`/api/round/${roundId}/ack`, { method: "POST" }),
  getThemes: () => request<ThemePack[]>("/api/themes"),
  setThemeEnabled: (id: number, enabled: boolean) =>
    request<ThemePack[]>(`/api/themes/${id}`, { method: "PUT", body: JSON.stringify({ enabled }) }),
  // CO-4 §12.
  subscribePush: (subscription: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    request<{ ok: true }>("/api/push/subscribe", { method: "POST", body: JSON.stringify(subscription) }),
  unsubscribePush: (endpoint: string) =>
    request<{ ok: true }>("/api/push/subscribe", { method: "DELETE", body: JSON.stringify({ endpoint }) }),
};
