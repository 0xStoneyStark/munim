// Pure builders for the dashboard's /api payload: timeline, proposals, merchants,
// privacy. No I/O here except the small file-presence reads in `merchants`.

import fs from "node:fs";
import path from "node:path";
import type { Ledger, Spend } from "@munim/zcash-purse";
import type { Proposal } from "./travel.js";

export const EXPLORER = "https://testnet.zcashexplorer.app/transactions/";

const TIMELINE_CAP = 60;
const ZATOSHIS_PER_ZEC = 1e8;
const SHORT_HEAD = 8;
const SHORT_TAIL = 6;
const MASK = "•••••";
const PHONE_LOCAL_DIGITS = 10;
const DEFAULT_COUNTRY_CODE = "91";
const SWIGGY_FUND_HINT = "redeem a Swiggy Money card to fund";

export type TimelineKind = "deposit" | "purchase" | "receipt" | "trigger" | "decision" | "refusal" | "proposal" | "redeem" | "order";

export interface TimelineItem {
  at: string;
  kind: TimelineKind;
  title: string;
  detail: string;
  status?: string;
  link?: string;
  mono?: string;
}

export interface AgentRun {
  at: string;
  ruleId: string;
  reason: string;
  summary: string;
}

export interface SwiggyRedeem {
  at: string;
  orderId: string;
  creditedInr: number;
  balanceAfterInr: number;
}

export interface Merchant {
  id: string;
  label: string;
  status: string;
  detail?: string;
  action?: { label: string; href: string };
}

export const PRIVACY = {
  onchain: "amounts, sender and receiver of every deposit and receipt are shielded",
  bitrefill: "the phone number for top-ups and the operator's account",
  lightwallet: "this server's IP and sync pattern (zec.rocks)",
  anthropic: "shopping intents and catalog results — never keys or codes",
} as const;

const shortTx = (txid: string): string => `${txid.slice(0, SHORT_HEAD)}…${txid.slice(-SHORT_TAIL)}`;
const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

// ------------------------------------------------------------------ timeline

interface Ranked extends TimelineItem {
  rank: number; // tie-break: higher sorts first when timestamps are equal (cause below effect)
}

function depositItems(ledger: Ledger): Ranked[] {
  return ledger.deposits.map((d) => ({
    at: d.seenAt,
    kind: "deposit",
    title: `Deposit ${d.zatoshis / ZATOSHIS_PER_ZEC} TAZ`,
    detail: d.memo ?? "",
    link: EXPLORER + d.txid,
    mono: shortTx(d.txid),
    rank: 0,
  }));
}

function spendItems(spends: Spend[]): Ranked[] {
  return spends.flatMap((s): Ranked[] => {
    const purchase: Ranked = {
      at: s.at,
      kind: "purchase",
      title: `${s.productName} · ₹${s.valueInr}`,
      detail: `${s.ruleId} · ${s.cost} ${s.costCurrency} · invoice ${s.invoiceId}`,
      status: s.status,
      rank: 0,
    };
    if (!s.receiptTxid) return [purchase];
    const receipt: Ranked = {
      at: s.at,
      kind: "receipt",
      title: "Receipt memo sent",
      detail: `${s.productName} · invoice ${s.invoiceId}`,
      link: EXPLORER + s.receiptTxid,
      mono: shortTx(s.receiptTxid),
      rank: 1,
    };
    return [purchase, receipt];
  });
}

function isRefusal(summary: string): boolean {
  const lower = summary.toLowerCase();
  return lower.includes("exceeds remaining cap") || lower.includes("refused");
}

// An Instamart order shows up only in the agent's prose summary, so it is read back out of it.
const DECISION_DETAIL_CHARS = 160;
const ORDER_ID_PRIMARY = /Order ID:?\s*([0-9]{8,})/i;
const ORDER_ID_FALLBACK = /order (?:id|ref)\W*([A-Za-z0-9-]{6,})/i;
const ORDER_TOTAL = /(?:total|bill|amount|paid|to pay)\b[^₹\n\d]{0,25}(?:₹|Rs\.?|INR)\s?([0-9][0-9,]*(?:\.[0-9]+)?)/i;
const ORDER_TOTAL_AFTER_ORDER = /order[^.\n₹]{0,40}?(?:₹|Rs\.?|INR)\s?([0-9][0-9,]*(?:\.[0-9]+)?)/i;
const ORDER_ITEM = /\b(\d{1,3})\s*[×x]\s+([^,;.\n(]{2,50}?)(?=\s+and\s+\d|\s+(?:on|from|via|with|paid|for|at)\b|\s*[,;.(\n]|$)/g;
const ORDER_ITEMS_MAX = 3;
const SWIGGY_MONEY = /swiggy\s*money|swiggy\s*pay/i;

function orderIdOf(summary: string): string | null {
  if (!/instamart/i.test(summary)) return null;
  return (ORDER_ID_PRIMARY.exec(summary) ?? ORDER_ID_FALLBACK.exec(summary))?.[1] ?? null;
}

function orderDetail(summary: string): string {
  const items = [...summary.matchAll(ORDER_ITEM)].slice(0, ORDER_ITEMS_MAX).map((m) => `${m[1]} × ${m[2]!.trim()}`);
  const total = (ORDER_TOTAL.exec(summary) ?? ORDER_TOTAL_AFTER_ORDER.exec(summary))?.[1];
  const parts = [...(items.length ? [items.join(", ")] : []), ...(total ? [`₹${total}`] : []), ...(SWIGGY_MONEY.test(summary) ? ["paid with Swiggy Money"] : [])];
  return parts.length ? parts.join(" · ") : "placed on Instamart";
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);

function runItems(runs: AgentRun[]): Ranked[] {
  return runs.flatMap((r): Ranked[] => {
    const orderId = isRefusal(r.summary) ? null : orderIdOf(r.summary);
    const trigger: Ranked = { at: r.at, kind: "trigger", title: `Rule ${r.ruleId} fired (${r.reason})`, detail: "", rank: 0 };
    if (orderId === null) return [trigger, { at: r.at, kind: isRefusal(r.summary) ? "refusal" : "decision", title: `Rule ${r.ruleId}`, detail: r.summary, rank: 1 }];
    return [
      trigger,
      { at: r.at, kind: "decision", title: `Rule ${r.ruleId}`, detail: clip(r.summary, DECISION_DETAIL_CHARS), rank: 1 },
      { at: r.at, kind: "order", title: `Instamart order ${orderId}`, detail: orderDetail(r.summary), status: "placed", rank: 2 },
    ];
  });
}

function proposalItems(proposals: Proposal[]): Ranked[] {
  return proposals.map((p) => ({
    at: p.createdAt,
    kind: "proposal",
    title: `eSIM for ${p.trip.destinationName}`,
    detail: `${p.suggestion.packageLabel} · ${p.suggestion.price} ${p.suggestion.priceCurrency} · ${p.status}`,
    status: p.status,
    rank: 0,
  }));
}

function redeemItems(redeems: SwiggyRedeem[]): Ranked[] {
  return redeems.map((r) => ({
    at: r.at,
    kind: "redeem",
    title: `Swiggy Money +₹${r.creditedInr}`,
    detail: `order ${r.orderId} · balance ₹${r.balanceAfterInr}`,
    rank: 0,
  }));
}

export interface TimelineInput {
  ledger: Ledger;
  runs: AgentRun[];
  proposals: Proposal[];
  redeems: SwiggyRedeem[];
}

/** Newest first, capped. Everything the household might ask "what happened?" about, in one list. */
export function buildTimeline(input: TimelineInput): TimelineItem[] {
  const all = [
    ...depositItems(input.ledger),
    ...spendItems(input.ledger.spends),
    ...runItems(input.runs),
    ...proposalItems(input.proposals),
    ...redeemItems(input.redeems),
  ];
  return all
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.rank - a.rank)
    .slice(0, TIMELINE_CAP)
    .map(({ rank: _rank, ...item }) => item);
}

// ----------------------------------------------------------------- proposals

export interface ProposalCard {
  id: string;
  kind: "esim";
  title: string;
  subtitle: string;
  price: string;
  status: string;
  createdAt: string;
  invoiceId: string | null;
  destination: string;
  departs: string;
  /** eSIM activation string, only once bought; the dashboard draws it as a QR. Never log it. */
  lpa: string | null;
}

export function proposalCards(proposals: Proposal[]): ProposalCard[] {
  return proposals.map((p) => ({
    id: p.id,
    kind: "esim",
    title: `eSIM · ${p.trip.destinationName}`,
    subtitle: `${isoDay(p.trip.departs)} → ${p.trip.returns ? isoDay(p.trip.returns) : ""} · ${p.suggestion.productName}`,
    price: `${p.suggestion.price} ${p.suggestion.priceCurrency}`,
    status: p.status,
    createdAt: p.createdAt,
    invoiceId: p.invoiceId ?? null,
    destination: p.trip.destinationName,
    departs: p.trip.departs.toISOString(),
    lpa: p.status === "bought" && p.lpa ? p.lpa : null,
  }));
}

// ------------------------------------------------------------------- funders

export interface Funder {
  /** the deposit memo's reply address, "anonymous" (capped, no reply) or "fuel" (no cap, no reply) */
  id: string;
  label: string;
  capInr: number;
  depositsTaz: number;
  spentInr: number;
  receipts: number;
}

type Deposit = Ledger["deposits"][number];

const FUEL_ID = "fuel";
const ANON_ID = "anonymous";
const ADDR_TAIL = 4;
const NOT_SPENT = new Set(["failed", "refunded"]); // same exclusions as budget()

function funderId(d: Deposit): string {
  if (d.replyTo) return d.replyTo;
  return d.capInr === null ? FUEL_ID : ANON_ID;
}

function funderLabel(id: string): string {
  if (id === FUEL_ID) return "Fuel (no cap)";
  if (id === ANON_ID) return "Anonymous";
  const head = id.startsWith("utest1") ? 6 : 2;
  return `${id.slice(0, head)}…${id.slice(-ADDR_TAIL)}`;
}

/**
 * One row per funder (deposits grouped by reply address).
 *
 * Spend allocation rule (FIFO): capped deposits are ordered by `seenAt`, spends by
 * `at` (failed/refunded skipped, as in budget()). Each spend's valueInr is charged
 * against the oldest deposit that still has cap left; a spend bigger than that
 * remainder spills into the next deposit. Anything beyond every cap is not charged
 * to anyone. The ledger does not store a receipt's destination, so a spend with a
 * receiptTxid counts as a receipt for the funder whose deposit it was charged to
 * first.
 */
export function funders(ledger: Ledger): Funder[] {
  const byTime = <T>(key: (x: T) => string) => (a: T, b: T): number => Date.parse(key(a)) - Date.parse(key(b));
  const deposits = [...ledger.deposits].sort(byTime<Deposit>((d) => d.seenAt));
  const rows = new Map<string, Funder>();
  for (const d of deposits) {
    const id = funderId(d);
    const row = rows.get(id) ?? { id, label: funderLabel(id), capInr: 0, depositsTaz: 0, spentInr: 0, receipts: 0 };
    rows.set(id, { ...row, capInr: row.capInr + (d.capInr ?? 0), depositsTaz: Math.round((row.depositsTaz + d.zatoshis / ZATOSHIS_PER_ZEC) * ZATOSHIS_PER_ZEC) / ZATOSHIS_PER_ZEC });
  }

  const pots = deposits.filter((d) => (d.capInr ?? 0) > 0).map((d) => ({ id: funderId(d), left: d.capInr ?? 0 }));
  const charge = (id: string, inr: number, receipt: boolean): void => {
    const row = rows.get(id);
    if (row) rows.set(id, { ...row, spentInr: row.spentInr + inr, receipts: row.receipts + (receipt ? 1 : 0) });
  };
  const spends = ledger.spends.filter((s) => !NOT_SPENT.has(s.status)).sort(byTime<Spend>((s) => s.at));
  for (const s of spends) {
    let owed = s.valueInr;
    let first = true;
    for (const pot of pots) {
      if (owed <= 0) break;
      if (pot.left <= 0) continue;
      const take = Math.min(pot.left, owed);
      pot.left -= take;
      owed -= take;
      charge(pot.id, take, first && Boolean(s.receiptTxid));
      first = false;
    }
  }
  return [...rows.values()];
}

// ----------------------------------------------------------------- merchants

function maskPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  const country = digits.length > PHONE_LOCAL_DIGITS ? digits.slice(0, digits.length - PHONE_LOCAL_DIGITS) : DEFAULT_COUNTRY_CODE;
  return `+${country}${MASK}${digits.slice(-4)}`;
}

function lastTopup(spends: Spend[]): Spend | undefined {
  return [...spends]
    .filter((s) => s.status === "delivered" && /jio|refill|top.?up/i.test(`${s.ruleId} ${s.productName}`))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
}

function jioMerchant(ledger: Ledger): Merchant {
  const phone = process.env.TOPUP_PHONE;
  if (!phone) return { id: "jio", label: "Jio prepaid", status: "unknown", detail: "set TOPUP_PHONE to enable top-ups" };
  const last = lastTopup(ledger.spends);
  const tail = last ? `last top-up ₹${last.valueInr} on ${last.at.slice(0, 10)}` : "no top-up delivered yet";
  return { id: "jio", label: "Jio prepaid", status: "active", detail: `${maskPhone(phone)} · ${tail}` };
}

function sessionBalance(file: string): number | null {
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { lastBalanceInr?: unknown };
  return typeof parsed.lastBalanceInr === "number" ? parsed.lastBalanceInr : null;
}

export function merchants(dataDir: string, ledger: Ledger): Merchant[] {
  const sessionFile = path.join(dataDir, "swiggy-session.json");
  const balance = sessionBalance(sessionFile);
  return [
    jioMerchant(ledger),
    {
      id: "swiggy-money",
      label: "Swiggy Money",
      status: fs.existsSync(sessionFile) ? "linked" : "not_linked",
      detail: balance === null ? SWIGGY_FUND_HINT : `balance ₹${balance}`,
    },
    {
      id: "swiggy-mcp",
      label: "Swiggy Instamart (MCP)",
      status: swiggyLinked(dataDir) ? "linked" : "not_linked",
      action: { label: "Link", href: "/swiggy/login" },
    },
    { id: "uber", label: "Uber", status: "not_linked", detail: "next: Uber vouchers + official MCP" },
  ];
}

export function swiggyLinked(dataDir: string): boolean {
  return fs.existsSync(path.join(dataDir, "swiggy-tokens.json"));
}

// --------------------------------------------------------------- connections

export type ConnectionGroup = "merchant" | "money" | "calendar" | "ai" | "chat" | "wallet";
export type ConnectionStatus = "linked" | "not_linked" | "attention" | "unknown";

export interface ConnectionAction {
  kind: "link" | "relink" | "instructions" | "external";
  label: string;
  href?: string;
  text?: string;
}

export interface Connection {
  id: string;
  name: string;
  group: ConnectionGroup;
  status: ConnectionStatus;
  /** One line for the page. Never contains a secret or token value. */
  detail: string;
  action?: ConnectionAction;
}

const DAY_MS = 86_400_000;
const SWIGGY_SESSION_STALE_DAYS = 14;
const GOOGLE_TOKEN_STALE_DAYS = 6; // Google test-mode refresh tokens expire after 7 days
const ADDR_HEAD = 8;
const BITREFILL_DEV_URL = "https://www.bitrefill.com/account/developers";
const NOIR_RELEASES_URL = "https://github.com/NoirWallet/noir-wallet-sdk/releases";

const SWIGGY_SESSION_HOWTO = [
  "Capture the Swiggy Money session on the machine that runs Munim:",
  "1. In Chrome, sign in at https://webviews.swiggy.com/swiggy-money/voucher",
  "2. DevTools -> Network -> pick any chkout.swiggy.com request -> right-click -> Copy -> Copy as cURL",
  "3. Take the Cookie header from that cURL and run:",
  '   npx tsx apps/munim/src/swiggy-money.ts session-from-cookie "<cookie>"',
].join("\n");

const GOOGLE_HOWTO = [
  "Google consent opens a browser on the machine hosting Munim (callbacks on localhost:3500 and :3000), so it cannot be finished from a phone.",
  "1. On the Munim machine run: npx tsx apps/munim/src/google-mcp.ts auth",
  "2. Approve Calendar and Gmail in the browser window that opens.",
  "3. If Munim runs on a server, copy the new token files across with deploy/sync-from-laptop.sh (or .ps1).",
  "Google test-mode tokens expire after 7 days, so repeat this weekly.",
].join("\n");

const TELEGRAM_HOWTO = [
  "1. In Telegram, message @BotFather and send /newbot, then follow the prompts.",
  "2. Put the token it gives you in .env as TELEGRAM_BOT_TOKEN and restart Munim.",
  "3. Open your new bot and send /start. The first chat to do so becomes the only one allowed.",
].join("\n");

const dayOf = (ms: number): string => isoDay(new Date(ms));
const isSet = (name: string): boolean => (process.env[name] ?? "").trim() !== "";

function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function swiggyMcpConnection(dataDir: string): Connection {
  const base = { id: "swiggy-mcp", name: "Swiggy (official MCP)", group: "merchant" } as const;
  const tokens = readJsonObject(path.join(dataDir, "swiggy-tokens.json"));
  if (!tokens) return { ...base, status: "not_linked", detail: "sign in with your Swiggy OTP once", action: { kind: "link", label: "Link", href: "/swiggy/login" } };
  const expiresAt = typeof tokens.expires_at === "number" ? tokens.expires_at : null;
  // accessToken() refreshes on demand, so only an expired token with nothing to refresh it needs the human.
  const dead = expiresAt !== null && expiresAt < Date.now() && !tokens.refresh_token;
  return {
    ...base,
    status: dead ? "attention" : "linked",
    detail: expiresAt === null ? "linked" : `${dead ? "expired" : "expires"} ${dayOf(expiresAt)}`,
    action: { kind: "relink", label: "Re-link", href: "/swiggy/login" },
  };
}

function swiggyMoneyConnection(dataDir: string): Connection {
  const base = { id: "swiggy-money", name: "Swiggy Money session", group: "money" } as const;
  const action: ConnectionAction = { kind: "instructions", label: "How to", text: SWIGGY_SESSION_HOWTO };
  const session = readJsonObject(path.join(dataDir, "swiggy-session.json"));
  if (!session) return { ...base, status: "not_linked", detail: "no session captured yet", action };
  const captured = typeof session.capturedAt === "string" ? Date.parse(session.capturedAt) : NaN;
  const parts = [Number.isNaN(captured) ? "captured (date unknown)" : `captured ${dayOf(captured)}`];
  if (typeof session.lastBalanceInr === "number") parts.push(`balance ₹${session.lastBalanceInr}`);
  const stale = !Number.isNaN(captured) && Date.now() - captured > SWIGGY_SESSION_STALE_DAYS * DAY_MS;
  return { ...base, status: stale ? "attention" : "linked", detail: parts.join(" · "), action };
}

interface GoogleSpec {
  id: string;
  name: string;
  tokenEnv: string;
  tokenFile: string;
}

function googleConnection(dataDir: string, spec: GoogleSpec): Connection {
  const base = { id: spec.id, name: spec.name, group: "calendar" } as const;
  const action: ConnectionAction = { kind: "instructions", label: "How to", text: GOOGLE_HOWTO };
  const credentials = process.env.GOOGLE_OAUTH_CREDENTIALS || path.join(dataDir, "google-credentials.json");
  if (!fs.existsSync(credentials)) return { ...base, status: "not_linked", detail: "no OAuth client file", action };
  const tokenFile = process.env[spec.tokenEnv] || path.join(dataDir, spec.tokenFile);
  if (!fs.existsSync(tokenFile) || fs.statSync(tokenFile).size === 0) return { ...base, status: "not_linked", detail: "not authorised yet", action };
  const mtime = fs.statSync(tokenFile).mtimeMs;
  const stale = Date.now() - mtime > GOOGLE_TOKEN_STALE_DAYS * DAY_MS;
  return { ...base, status: stale ? "attention" : "linked", detail: `tokens from ${dayOf(mtime)}${stale ? " · likely expired, re-run consent" : ""}`, action };
}

function telegramConnection(dataDir: string): Connection {
  const base = { id: "telegram", name: "Telegram bot", group: "chat" } as const;
  const action: ConnectionAction = { kind: "instructions", label: "How to", text: TELEGRAM_HOWTO };
  if (!isSet("TELEGRAM_BOT_TOKEN")) return { ...base, status: "not_linked", detail: "TELEGRAM_BOT_TOKEN not set", action };
  const stateFile = process.env.TELEGRAM_STATE_FILE || path.join(dataDir, "telegram-state.json");
  const chats = readJsonObject(stateFile)?.chats;
  if (Array.isArray(chats) && chats.length > 0) return { ...base, status: "linked", detail: `bot token set · ${chats.length} chat${chats.length === 1 ? "" : "s"} registered`, action };
  return { ...base, status: "attention", detail: "send /start to the bot", action };
}

function purseConnection(dataDir: string): Connection {
  const base = { id: "zcash-purse", name: "Zcash purse (testnet)", group: "wallet" } as const;
  const address = readJsonObject(path.join(dataDir, "ledger.json"))?.address;
  if (typeof address !== "string" || address === "") return { ...base, status: "not_linked", detail: "agent not started yet, no purse address" };
  const short = `${address.slice(0, ADDR_HEAD)}…${address.slice(-ADDR_TAIL)}`;
  return { ...base, status: "linked", detail: `${short} · via zec.rocks${process.env.PURSE_CONNECTION === "tor" ? " over Tor" : ""}` };
}

/** Every external link Munim depends on, with a one-line state. Reads files and env only; never returns a secret. */
export function connections(dataDir: string): Connection[] {
  const bitrefillSet = isSet("BITREFILL_API_KEY");
  const anthropicSet = isSet("ANTHROPIC_API_KEY");
  return [
    swiggyMcpConnection(dataDir),
    {
      id: "bitrefill",
      name: "Bitrefill",
      group: "merchant",
      status: bitrefillSet ? "linked" : "not_linked",
      detail: bitrefillSet ? "API key set · MCP + REST" : "BITREFILL_API_KEY not set",
      action: { kind: "external", label: "Get an API key", href: BITREFILL_DEV_URL },
    },
    swiggyMoneyConnection(dataDir),
    googleConnection(dataDir, { id: "google-calendar", name: "Google Calendar", tokenEnv: "GOOGLE_CALENDAR_MCP_TOKEN_PATH", tokenFile: "google-calendar-tokens.json" }),
    googleConnection(dataDir, { id: "gmail", name: "Gmail", tokenEnv: "GMAIL_CREDENTIALS_PATH", tokenFile: "gmail-credentials.json" }),
    {
      id: "anthropic",
      name: "Claude (Sonnet 5.5)",
      group: "ai",
      status: anthropicSet ? "linked" : "not_linked",
      detail: anthropicSet ? "API key set" : "ANTHROPIC_API_KEY not set",
    },
    telegramConnection(dataDir),
    {
      id: "noir",
      name: "Noir Wallet",
      group: "wallet",
      status: "unknown",
      detail: "desktop Chrome extension — detected in the browser, not on the server",
      action: { kind: "external", label: "Get the extension", href: NOIR_RELEASES_URL },
    },
    purseConnection(dataDir),
  ];
}
