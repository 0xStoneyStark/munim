// Web Push for the installed dashboard PWA: VAPID keys, the subscription store, and a
// notifier that turns new timeline items into notifications.
//   data/vapid.json              {publicKey, privateKey, subject}   (only when env keys are unset)
//   data/push-subscriptions.json [{endpoint, keys, expirationTime?, addedAt}]
//   data/push-cursor.json        {seen: ["<at>|<title>", ...]}      (newest first, capped)

import fs from "node:fs";
import path from "node:path";
import webpush from "web-push";
import { z } from "zod";
import type { Ledger } from "@munim/zcash-purse";
import { buildTimeline, type AgentRun, type SwiggyRedeem, type TimelineItem, type TimelineKind } from "./api-views.js";
import { loadProposals } from "./travel.js";

const DEFAULT_SUBJECT = "mailto:munim@heneryshop.com";
const DEFAULT_INTERVAL_MS = 15_000;
const MAX_PUSHES_PER_RUN = 10;
const CURSOR_CAP = 500;
const MAX_SUBSCRIPTIONS = 50;
const SEND_TIMEOUT_MS = 10_000;
const TTL_SECONDS = 24 * 60 * 60;
const GONE_STATUSES = new Set([404, 410]);

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

const base64url = z.string().min(1).regex(/^[A-Za-z0-9_-]+={0,2}$/, "not base64url");

export const subscriptionSchema = z.object({
  endpoint: z.url().refine((u) => u.startsWith("https://"), "endpoint must be https"),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: base64url, auth: base64url }),
});

export type PushSubscriptionJson = z.infer<typeof subscriptionSchema>;
export type StoredSubscription = PushSubscriptionJson & { addedAt: string };

interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

const defaultDir = (): string => path.resolve("data");

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw e;
  }
}

function writeJsonAtomic(file: string, value: unknown, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), mode === undefined ? undefined : { mode });
  fs.renameSync(tmp, file);
  if (mode !== undefined) fs.chmodSync(file, mode);
}

// ------------------------------------------------------------------------ VAPID

let cachedVapid: { dir: string; keys: VapidKeys } | undefined;

/** Env keys win; else data/vapid.json; else generate once and persist (chmod 600). */
function vapid(dataDir: string): VapidKeys {
  if (cachedVapid?.dir === dataDir) return cachedVapid.keys;
  const subject = process.env.VAPID_SUBJECT || DEFAULT_SUBJECT;
  const envPublic = process.env.VAPID_PUBLIC_KEY;
  const envPrivate = process.env.VAPID_PRIVATE_KEY;
  let keys: VapidKeys;
  if (envPublic && envPrivate) {
    keys = { publicKey: envPublic, privateKey: envPrivate, subject };
  } else {
    const file = path.join(dataDir, "vapid.json");
    const stored = readJson<Partial<VapidKeys> | undefined>(file, undefined);
    if (stored?.publicKey && stored.privateKey) {
      keys = { publicKey: stored.publicKey, privateKey: stored.privateKey, subject: process.env.VAPID_SUBJECT || stored.subject || subject };
    } else {
      keys = { ...webpush.generateVAPIDKeys(), subject };
      writeJsonAtomic(file, keys, 0o600);
    }
  }
  cachedVapid = { dir: dataDir, keys };
  return keys;
}

/** The application server key the browser subscribes with. Throws if VAPID cannot be set up. */
export function publicKey(dataDir: string = defaultDir()): string {
  return vapid(dataDir).publicKey;
}

// ---------------------------------------------------------------- subscriptions

const subscriptionsFile = (dataDir: string): string => path.join(dataDir, "push-subscriptions.json");

function loadSubscriptions(dataDir: string): StoredSubscription[] {
  return readJson<StoredSubscription[]>(subscriptionsFile(dataDir), []);
}

/** Add or refresh a subscription, deduped by endpoint. Returns the stored list size. */
export function subscribe(sub: PushSubscriptionJson, dataDir: string = defaultDir()): number {
  const others = loadSubscriptions(dataDir).filter((s) => s.endpoint !== sub.endpoint);
  if (others.length >= MAX_SUBSCRIPTIONS) throw new Error("too many push subscriptions");
  const next = [...others, { ...sub, addedAt: new Date().toISOString() }];
  writeJsonAtomic(subscriptionsFile(dataDir), next);
  return next.length;
}

/** Returns true when a subscription with that endpoint existed. */
export function unsubscribe(endpoint: string, dataDir: string = defaultDir()): boolean {
  const current = loadSubscriptions(dataDir);
  const next = current.filter((s) => s.endpoint !== endpoint);
  if (next.length === current.length) return false;
  writeJsonAtomic(subscriptionsFile(dataDir), next);
  return true;
}

function removeEndpoints(endpoints: Set<string>, dataDir: string): void {
  // re-read: a subscribe may have landed while the sends were in flight
  const next = loadSubscriptions(dataDir).filter((s) => !endpoints.has(s.endpoint));
  writeJsonAtomic(subscriptionsFile(dataDir), next);
}

export interface SendResult {
  sent: number;
  removed: number;
  failed: number;
}

/** Push to every subscription. 404/410 means the browser dropped it, so it is removed. */
export async function sendToAll(payload: PushPayload, dataDir: string = defaultDir()): Promise<SendResult> {
  const subs = loadSubscriptions(dataDir);
  if (subs.length === 0) return { sent: 0, removed: 0, failed: 0 };
  const { subject, publicKey: pub, privateKey } = vapid(dataDir);
  const body = JSON.stringify(payload);
  const options = { vapidDetails: { subject, publicKey: pub, privateKey }, TTL: TTL_SECONDS, timeout: SEND_TIMEOUT_MS };
  const gone = new Set<string>();
  let sent = 0;
  let failed = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, options);
        sent += 1;
      } catch (e) {
        if (e instanceof webpush.WebPushError && GONE_STATUSES.has(e.statusCode)) gone.add(s.endpoint);
        else failed += 1;
      }
    }),
  );
  if (gone.size > 0) removeEndpoints(gone, dataDir);
  return { sent, removed: gone.size, failed };
}

// --------------------------------------------------------------------- notifier

interface Notice {
  title: (item: TimelineItem) => string;
  url?: string;
}

/** Kinds that notify. trigger, decision and deposit are deliberately absent. */
const NOTICES: Partial<Record<TimelineKind, Notice>> = {
  purchase: { title: (i) => `Bought: ${i.title}` },
  order: { title: (i) => `Order placed: ${i.title}` },
  redeem: { title: (i) => `Swiggy Money: ${i.title}` },
  receipt: { title: () => "Receipt sent" },
  refusal: { title: (i) => `Refused: ${i.title}` },
  proposal: { title: (i) => `Approve? ${i.title}`, url: "/approvals" },
};

export function itemKey(item: TimelineItem): string {
  return `${item.at}|${item.title}`;
}

/** The notification for a timeline item, or undefined for kinds that stay silent. */
export function payloadFor(item: TimelineItem): PushPayload | undefined {
  const notice = NOTICES[item.kind];
  if (!notice) return undefined;
  return { title: notice.title(item), body: item.detail, url: notice.url ?? "/", tag: item.kind };
}

/** The same data-file reads as overview() in api.ts, narrowed to what buildTimeline needs. */
export function readTimeline(dataDir: string): TimelineItem[] {
  const ledger = readJson<Ledger>(path.join(dataDir, "ledger.json"), { address: "", deposits: [], spends: [] });
  const runs = readJson<{ runs: AgentRun[] }>(path.join(dataDir, "agent-state.json"), { runs: [] }).runs;
  const redeems = readJson<SwiggyRedeem[]>(path.join(dataDir, "swiggy-redeems.json"), []);
  return buildTimeline({ ledger, runs, proposals: loadProposals(), redeems });
}

const cursorFile = (dataDir: string): string => path.join(dataDir, "push-cursor.json");

function saveCursor(dataDir: string, seen: string[]): void {
  writeJsonAtomic(cursorFile(dataDir), { seen: seen.slice(0, CURSOR_CAP) });
}

/**
 * One notifier pass. With no cursor yet it only records what exists. Otherwise every unseen
 * item is marked seen and the newest MAX_PUSHES_PER_RUN notifiable ones are pushed (oldest first).
 * Returns how many items were pushed.
 */
export async function notifyOnce(dataDir: string, build: () => TimelineItem[] = () => readTimeline(dataDir)): Promise<number> {
  const items = build();
  const keys = items.map(itemKey);
  if (!fs.existsSync(cursorFile(dataDir))) {
    saveCursor(dataDir, keys);
    return 0;
  }
  const seen = new Set(readJson<{ seen: string[] }>(cursorFile(dataDir), { seen: [] }).seen);
  const fresh = items.filter((i) => !seen.has(itemKey(i)));
  if (fresh.length === 0) return 0;
  saveCursor(dataDir, [...new Set([...keys, ...seen])]);
  const payloads = fresh.flatMap((i) => payloadFor(i) ?? []).slice(0, MAX_PUSHES_PER_RUN).reverse();
  for (const p of payloads) await sendToAll(p, dataDir);
  return payloads.length;
}

export interface NotifierOptions {
  dataDir: string;
  intervalMs?: number;
  build?: () => TimelineItem[];
}

/** Poll the timeline and push new items. Returns a stop function. */
export function startNotifier({ dataDir, intervalMs = DEFAULT_INTERVAL_MS, build }: NotifierOptions): () => void {
  let running = false;
  let lastError = "";
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await notifyOnce(dataDir, build);
      lastError = "";
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message !== lastError) process.stderr.write(`push notifier: ${message}\n`);
      lastError = message;
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
