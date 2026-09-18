// CO-4 §12: subscribing to push. The public VAPID key is compiled in here --
// it's the one half of the keypair that's safe in the client, matching the
// private half the server holds in NAMEPLATE_VAPID_PRIVATE (never in git).
import { api } from "./api";

const VAPID_PUBLIC_KEY = "BMrGHTf8al5Zkc-SHLvnsJknnhV7pA-PgVJL2ILtxwMIFtz5nRy1y8jRB7mR6ONZeHe6SKf3BsgWbGvmB_j9IaE";

// pushManager.subscribe wants the application server key as a raw Uint8Array,
// not the base64url string the server (and every push-key generator) deals
// in -- this is the standard conversion, not written inline so it isn't
// silently wrong in two places.
function urlBase64ToUint8Array(base64url: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export type PushPermission = "granted" | "denied" | "unsupported";

export function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

export async function isPushSubscribed(): Promise<boolean> {
  if (!pushSupported()) return false;
  const sub = await currentSubscription();
  return sub !== null;
}

// Must be called from inside a click handler -- Chrome silently ignores
// Notification.requestPermission() otherwise, and once a user denies it,
// nothing but a manual reset in site settings can re-prompt them. Callers
// are expected to handle the "denied" result with an explanation, not treat
// a dead toggle as a bug.
export async function subscribeToPush(): Promise<PushPermission> {
  if (!pushSupported()) return "unsupported";

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "denied";

  const registration = await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true, // mandatory in Chrome
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    }));

  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error("push subscription is missing its endpoint or keys");
  }
  await api.subscribePush({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } });
  return "granted";
}

// Both halves have to come off, or the server keeps pushing into a dead
// endpoint until it 404s/410s months later (CO-4 §12).
export async function unsubscribeFromPush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  await api.unsubscribePush(endpoint);
}
