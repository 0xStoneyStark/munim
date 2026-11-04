// Client for Swiggy's private "Swiggy Money" voucher endpoints (chkout.swiggy.com),
// reverse-engineered from Swiggy's own webview JS. One-off, the owner's own account.
// There is no official API: response shapes are parsed defensively. Redemption
// codes and PINs are cash: this module never logs, stores or returns them.
//   tsx apps/munim/src/swiggy-money.ts probe
//   tsx apps/munim/src/swiggy-money.ts redeem <bitrefillOrderId>
//   tsx apps/munim/src/swiggy-money.ts session-from-cookie "<cookie header>"

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Bitrefill, type Order } from "./bitrefill.js";

const DEFAULT_BASE_URL = "https://chkout.swiggy.com";
const ORIGIN = "https://webviews.swiggy.com";
const REFERER = "https://webviews.swiggy.com/swiggy-money/voucher";
const SESSION_FILE = "swiggy-session.json";
const MAX_MESSAGE = 200;
const SESSION_EXPIRED = "session expired";

export interface SwiggySessionHeaders {
  sid: string;
  tid: string;
  token: string;
  userId: string;
  deviceId: string;
  platform: string;
}

export interface SwiggySession {
  capturedAt: string;
  headers: SwiggySessionHeaders;
  cookie: string | undefined;
}

export interface BalanceResult {
  ok: boolean;
  balanceInr: number | null;
  raw: unknown;
  status: number;
  reason?: string;
}

export interface ClaimResult {
  ok: boolean;
  creditedInr: number | null;
  message: string;
  status: number;
}

export interface ProbeResult {
  alive: boolean;
  balanceInr: number | null;
  reason: string | null;
}

export interface RedeemResult {
  ok: boolean;
  creditedInr: number | null;
  balanceAfterInr: number | null;
  message: string;
}

// ---------- session store ----------

function sessionPath(): string {
  return path.join(path.resolve("data"), SESSION_FILE);
}

export function loadSwiggySession(): SwiggySession | null {
  const f = sessionPath();
  if (!fs.existsSync(f)) return null;
  try {
    const s = JSON.parse(fs.readFileSync(f, "utf8")) as Partial<SwiggySession>;
    if (!s.headers || typeof s.headers.sid !== "string") return null;
    return s as SwiggySession;
  } catch {
    return null;
  }
}

export function saveSwiggySession(s: SwiggySession): void {
  fs.mkdirSync(path.dirname(sessionPath()), { recursive: true });
  fs.writeFileSync(sessionPath(), JSON.stringify(s, null, 2));
}

function parseCookies(cookieHeader: string): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of cookieHeader.split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    const raw = part.slice(i + 1).trim().replace(/^"|"$/g, "");
    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch {
      // keep the raw value
    }
    jar.set(name, value);
  }
  return jar;
}

/** Best-effort: derive the six session headers from a swiggy.com Cookie header. */
export function sessionFromCookies(cookieHeader: string, extra: Partial<SwiggySessionHeaders> = {}): SwiggySession {
  const jar = parseCookies(cookieHeader);
  const first = (...names: string[]): string => {
    for (const n of names) {
      const v = jar.get(n);
      if (v) return v;
    }
    return "";
  };
  const headers: SwiggySessionHeaders = {
    sid: first("_sid"),
    tid: first("tid", "_session_tid"),
    token: first("token"),
    userId: first("userId", "_user_id"),
    deviceId: first("_device_id"),
    platform: "web",
    ...extra,
  };
  return { capturedAt: new Date().toISOString(), headers, cookie: cookieHeader.trim() || undefined };
}

// ---------- HTTP ----------

function baseUrl(): string {
  return process.env.SWIGGY_MONEY_BASE_URL ?? DEFAULT_BASE_URL;
}

function requestHeaders(session: SwiggySession): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    ...session.headers,
    Origin: ORIGIN,
    Referer: REFERER,
  };
  if (session.cookie) h.Cookie = session.cookie;
  return h;
}

const isExpired = (status: number): boolean => status === 401 || status === 403;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return null;
}

/** Breadth-first search for the first numeric value under a key matching one of the patterns (in priority order). */
function pickNumber(raw: unknown, patterns: RegExp[]): number | null {
  for (const re of patterns) {
    const queue: Array<{ v: unknown; depth: number }> = [{ v: raw, depth: 0 }];
    while (queue.length > 0) {
      const { v, depth } = queue.shift()!;
      if (!isRecord(v) || depth > 4) continue;
      for (const [k, val] of Object.entries(v)) {
        const n = re.test(k) ? toNumber(val) : null;
        if (n !== null) return n;
        if (isRecord(val)) queue.push({ v: val, depth: depth + 1 });
      }
    }
  }
  return null;
}

function pickMessage(raw: unknown): string | null {
  const queue: unknown[] = [raw];
  while (queue.length > 0) {
    const v = queue.shift();
    if (!isRecord(v)) continue;
    for (const k of ["message", "statusMessage", "status_message", "error", "msg"]) {
      const m = v[k];
      if (typeof m === "string" && m.trim()) return m.trim();
    }
    for (const val of Object.values(v)) if (isRecord(val)) queue.push(val);
  }
  return null;
}

function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join("***");
  return out.slice(0, MAX_MESSAGE);
}

interface Fetched {
  status: number;
  body: unknown;
}

async function send(session: SwiggySession, method: string, urlPath: string, body?: unknown): Promise<Fetched> {
  const res = await fetch(baseUrl() + urlPath, {
    method,
    headers: requestHeaders(session),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text ? { message: text } : null;
  }
  return { status: res.status, body: parsed };
}

export async function getBalance(session: SwiggySession): Promise<BalanceResult> {
  let r: Fetched;
  try {
    r = await send(session, "GET", "/payment/presentation/v1/swiggypay/getbalance");
  } catch {
    return { ok: false, balanceInr: null, raw: null, status: 0, reason: "network error" };
  }
  if (isExpired(r.status)) return { ok: false, balanceInr: null, raw: null, status: r.status, reason: SESSION_EXPIRED };
  if (r.status < 200 || r.status >= 300) {
    const m = pickMessage(r.body) ?? `HTTP ${r.status}`;
    return { ok: false, balanceInr: null, raw: r.body, status: r.status, reason: scrub(m, []) };
  }
  const balanceInr = pickNumber(r.body, [/^balance$/i, /balance/i, /^amount$/i, /amount|value/i]);
  return { ok: true, balanceInr, raw: r.body, status: r.status };
}

export async function claimVoucher(
  session: SwiggySession,
  voucher: { code: string; secret: string },
): Promise<ClaimResult> {
  const code = voucher.code.replace(/[\s-]/g, "");
  const secret = voucher.secret.trim();
  const secrets = [code, secret, voucher.code, voucher.secret];
  // Swiggy's form says "16 digit code" but Bitrefill-issued vouchers are 16 alphanumerics
  if (!/^[A-Z0-9]{16}$/i.test(code)) return { ok: false, creditedInr: null, message: "voucher code is not 16 characters", status: 0 };
  if (!/^\d{6}$/.test(secret)) return { ok: false, creditedInr: null, message: "voucher PIN is not 6 digits", status: 0 };

  let r: Fetched;
  try {
    r = await send(session, "PATCH", "/swiggymoney/voucher/claim", { code, secret });
  } catch {
    return { ok: false, creditedInr: null, message: "network error", status: 0 };
  }
  if (isExpired(r.status)) return { ok: false, creditedInr: null, message: SESSION_EXPIRED, status: r.status };

  const serverMessage = pickMessage(r.body);
  const body = isRecord(r.body) ? r.body : {};
  const httpOk = r.status >= 200 && r.status < 300;
  const logicalFail = (typeof body.statusCode === "number" && body.statusCode !== 0) || body.success === false;
  if (!httpOk || logicalFail) {
    return { ok: false, creditedInr: null, message: scrub(serverMessage ?? `HTTP ${r.status}`, secrets), status: r.status };
  }
  const creditedInr = pickNumber(r.body, [/^amount$/i, /^value$/i, /amount|value|credited/i, /balance/i]);
  return { ok: true, creditedInr, message: scrub(serverMessage ?? "claimed", secrets), status: r.status };
}

export async function probe(session: SwiggySession): Promise<ProbeResult> {
  const b = await getBalance(session);
  return { alive: b.ok, balanceInr: b.balanceInr, reason: b.ok ? null : (b.reason ?? `HTTP ${b.status}`) };
}

// ---------- Bitrefill glue ----------

const PIN_WITH_LABEL = /pin\D{0,20}(\d{6})(?!\d)/i;
const BARE_PIN = /(?<!\d)(\d{6})(?!\d)/;

function findPin(order: Order): string | null {
  const extra = (order as Order & { extra_fields?: unknown }).extra_fields;
  const haystacks = [order.redemption_info?.instructions ?? "", extra === undefined ? "" : JSON.stringify(extra)];
  for (const re of [PIN_WITH_LABEL, BARE_PIN]) {
    for (const h of haystacks) {
      const m = re.exec(h);
      if (m) return m[1];
    }
  }
  return null;
}

/** Fetch a delivered Bitrefill Swiggy Money order and claim it into the session's Swiggy Money wallet. */
export async function redeemBitrefillOrder(
  bitrefill: Pick<Bitrefill, "order">,
  session: SwiggySession,
  orderId: string,
): Promise<RedeemResult> {
  const fail = (message: string): RedeemResult => ({ ok: false, creditedInr: null, balanceAfterInr: null, message });
  let order: Order;
  try {
    order = await bitrefill.order(orderId);
  } catch (e) {
    return fail(`could not fetch order: ${scrub(e instanceof Error ? e.message : "unknown error", [])}`);
  }
  if (order.status !== "delivered") return fail(`order not delivered (status ${order.status})`);
  const code = order.redemption_info?.code;
  if (!code) return fail("no code in order");
  const pin = order.redemption_info?.pin?.trim() || findPin(order);
  if (!pin) return fail("no PIN in order");

  const claim = await claimVoucher(session, { code, secret: pin });
  if (!claim.ok) return fail(claim.message);
  const after = await getBalance(session);
  return { ok: true, creditedInr: claim.creditedInr, balanceAfterInr: after.ok ? after.balanceInr : null, message: claim.message };
}

// ---------- CLI ----------

function out(line: string): void {
  process.stdout.write(line + "\n");
}

async function printProbe(session: SwiggySession): Promise<void> {
  const p = await probe(session);
  out(p.alive ? `alive, balance: ${p.balanceInr ?? "unknown"} INR` : `not alive: ${p.reason}`);
}

async function cli(cmd: string | undefined, arg: string | undefined): Promise<void> {
  if (cmd === "session-from-cookie") {
    if (!arg) return out('usage: session-from-cookie "<cookie header>"');
    const s = sessionFromCookies(arg);
    saveSwiggySession(s);
    const present = Object.entries(s.headers).filter(([, v]) => v).map(([k]) => k);
    out(`session saved (headers found: ${present.join(", ") || "none"})`);
    return printProbe(s);
  }
  const session = loadSwiggySession();
  if (!session) return out("no session: run session-from-cookie first");
  if (cmd === "probe") return printProbe(session);
  if (cmd === "redeem") {
    if (!arg) return out("usage: redeem <bitrefillOrderId>");
    const r = await redeemBitrefillOrder(new Bitrefill(process.env.BITREFILL_API_KEY ?? ""), session, arg);
    out(r.ok ? `redeemed: credited ${r.creditedInr ?? "unknown"} INR, balance now ${r.balanceAfterInr ?? "unknown"} INR (${r.message})` : `failed: ${r.message}`);
    return;
  }
  out("commands: probe | redeem <bitrefillOrderId> | session-from-cookie \"<cookie header>\"");
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("swiggy-money.ts");
if (isMain) {
  const [cmd, arg] = process.argv.slice(2);
  await cli(cmd, arg);
}
