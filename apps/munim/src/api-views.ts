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

export type TimelineKind = "deposit" | "purchase" | "receipt" | "trigger" | "decision" | "refusal" | "proposal" | "redeem";

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

function runItems(runs: AgentRun[]): Ranked[] {
  return runs.flatMap((r): Ranked[] => [
    { at: r.at, kind: "trigger", title: `Rule ${r.ruleId} fired (${r.reason})`, detail: "", rank: 0 },
    {
      at: r.at,
      kind: isRefusal(r.summary) ? "refusal" : "decision",
      title: `Rule ${r.ruleId}`,
      detail: r.summary,
      rank: 1,
    },
  ]);
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
