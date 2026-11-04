// The loop: refresh the purse, fire due rules, run the agent for each.
//   npm run agent                 -- keeps running, checks every 30s
//   npm run agent -- --once        -- one pass
//   npm run agent -- --signal treat -- fire the rule listening for `treat`, then exit

import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { Purse, budget } from "@munim/zcash-purse";
import { purseConfigFromEnv } from "@munim/zcash-purse/src/config.js";
import { Bitrefill } from "./bitrefill.js";
import { loadRules, due, type Rule } from "./rules.js";
import { runRule } from "./agent.js";
import { buyApproved, loadProposals, saveProposals, scanAndPropose, type Proposal } from "./travel.js";
import { loadSwiggySession, saveSwiggySession, redeemBitrefillOrder } from "./swiggy-money.js";
import { SwiggyMcp } from "./swiggy-mcp.js";
import { orderOnInstamart } from "./instamart.js";

const DATA = path.resolve("data");
const STATE_FILE = path.join(DATA, "agent-state.json");
const SIGNAL_DIR = path.join(DATA, "signals");
const LOG_FILE = path.join(DATA, "agent.log");

interface State {
  lastRun: Record<string, number>;
  runs: Array<{ at: string; ruleId: string; reason: string; summary: string; spendId: string | null; receiptTxid: string | null }>;
}

function loadState(): State {
  return fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : { lastRun: {}, runs: [] };
}

function log(line: string) {
  const msg = `${new Date().toISOString()} ${line}`;
  process.stdout.write(msg + "\n");
  fs.appendFileSync(LOG_FILE, msg + "\n");
}

/** Signals are files in data/signals/<name>; the dashboard or CLI drops them. */
function takeSignals(): Set<string> {
  fs.mkdirSync(SIGNAL_DIR, { recursive: true });
  const names = fs.readdirSync(SIGNAL_DIR);
  for (const n of names) fs.unlinkSync(path.join(SIGNAL_DIR, n));
  return new Set(names);
}

type Deps = Parameters<typeof runRule>[0];

// TODO: rough INR conversion, used only to size cap checks for USD-priced eSIMs; replace with a live rate.
const USD_TO_INR_FOR_CAP = 90;
const CALENDAR_ESIM_RULE_ID = "calendar-esim";

/** Calendar rules never fire the shopping agent: they scan for trips and leave proposals for approval. */
async function scanCalendarRules(deps: Deps, rules: Rule[]) {
  for (const rule of rules) {
    if (!("calendar" in rule.trigger)) continue;
    const source = rule.trigger.calendar === "default" ? (process.env.CALENDAR_ICS ?? "") : rule.trigger.calendar;
    if (!source) {
      deps.log(`calendar rule ${rule.id}: no calendar source (set CALENDAR_ICS), skipping`);
      continue;
    }
    try {
      const added = await scanAndPropose({ calendarSource: source, bitrefill: deps.bitrefill });
      for (const p of added) deps.log(`calendar rule ${rule.id}: proposal ${p.id} eSIM for ${p.trip.destinationName} (${p.suggestion.price} ${p.suggestion.priceCurrency})`);
    } catch (e) {
      deps.log(`calendar rule ${rule.id}: scan failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** INR value used for the cap check; null when the proposal's currency cannot be sized. */
function proposalValueInr(p: Proposal): number | null {
  const { price, priceCurrency } = p.suggestion;
  if (priceCurrency === "USD") return Math.ceil(price * USD_TO_INR_FOR_CAP);
  if (priceCurrency === "INR") return Math.ceil(price);
  return null;
}

/**
 * Cap-check every approved, not-yet-invoiced proposal (cumulatively). buyApproved buys all approved
 * proposals, so ones the cap refuses are held back as "proposed" for the call and re-approved after.
 */
async function holdOutOverCap(deps: Deps): Promise<Set<string>> {
  const held = new Set<string>();
  let committedInr = 0;
  for (const p of loadProposals().filter((x) => x.status === "approved" && !x.invoiceId)) {
    const valueInr = proposalValueInr(p);
    const verdict = valueInr === null ? null : await deps.purse.check(committedInr + valueInr);
    if (valueInr !== null && verdict?.ok) {
      committedInr += valueInr;
      continue;
    }
    held.add(p.id);
    deps.log(`eSIM ${p.id} not bought: ${verdict ? verdict.reason : `cannot size ${p.suggestion.priceCurrency} price against the cap`}`);
  }
  if (held.size > 0) saveProposals(loadProposals().map((p) => (held.has(p.id) ? { ...p, status: "proposed" } : p)));
  return held;
}

function restoreHeld(held: Set<string>): void {
  if (held.size === 0) return;
  // only undo our own hold-out: a decline made on the dashboard meanwhile must stay declined
  saveProposals(loadProposals().map((p) => (held.has(p.id) && p.status === "proposed" ? { ...p, status: "approved" } : p)));
}

async function recordEsimSpend(deps: Deps, p: Proposal, invoiceId: string): Promise<void> {
  const valueInr = proposalValueInr(p) ?? 0;
  const base = {
    ruleId: CALENDAR_ESIM_RULE_ID,
    productId: p.suggestion.productId,
    productName: p.suggestion.productName,
    valueInr,
    cost: p.suggestion.price,
    costCurrency: p.suggestion.priceCurrency,
    invoiceId,
    orderId: p.orderId ?? null,
  };
  try {
    const reserved = await deps.purse.reserve(base);
    await deps.purse.update({ ...reserved, status: "delivered" });
  } catch (e) {
    // the money is already spent: the ledger must show it even if the cap moved since the check
    deps.log(`eSIM ${p.id}: reserve failed (${e instanceof Error ? e.message : String(e)}); recording spend anyway`);
    await deps.purse.update({ ...base, id: crypto.randomUUID(), at: new Date().toISOString(), status: "delivered", receiptTxid: null, codeHash: null });
  }
}

async function buyApprovedEsims(deps: Deps) {
  const held = await holdOutOverCap(deps);
  let results;
  try {
    results = await buyApproved(deps.bitrefill, { maxPrice: undefined });
  } finally {
    restoreHeld(held);
  }
  for (const r of results) {
    if (r.status !== "bought" || !r.invoiceId) {
      deps.log(`eSIM proposal ${r.id}: ${r.status}`);
      continue;
    }
    const bought = loadProposals().find((p) => p.id === r.id);
    if (bought) await recordEsimSpend(deps, bought, r.invoiceId);
    deps.log(`eSIM proposal ${r.id} bought, invoice ${r.invoiceId}`);
  }
}

const REDEEMS_FILE = path.join(DATA, "swiggy-redeems.json");

/**
 * Close the loop on a delivered Swiggy Money card: redeem it into the funder's Swiggy
 * balance through their saved session. Codes never touch logs; only amounts are kept.
 */
async function redeemSwiggyMoney(deps: Deps, orderId: string): Promise<void> {
  const session = loadSwiggySession();
  if (!session) {
    deps.log(`swiggy money: no session saved; redeem the card by hand or run swiggy-money session-from-cookie`);
    return;
  }
  const r = await redeemBitrefillOrder(deps.bitrefill, session, orderId);
  deps.log(`swiggy money redeem ${orderId}: ${r.ok ? `credited ₹${r.creditedInr}, balance ₹${r.balanceAfterInr}` : r.message}`);
  if (!r.ok) return;
  const existing: unknown[] = fs.existsSync(REDEEMS_FILE) ? JSON.parse(fs.readFileSync(REDEEMS_FILE, "utf8")) : [];
  fs.writeFileSync(REDEEMS_FILE, JSON.stringify([...existing, { at: new Date().toISOString(), orderId, creditedInr: r.creditedInr, balanceAfterInr: r.balanceAfterInr }], null, 2));
  saveSwiggySession({ ...session, lastBalanceInr: r.balanceAfterInr ?? undefined } as typeof session);
}

/** Rules with `spend: "instamart"` don't buy on Bitrefill: they spend the Swiggy Money balance through Swiggy's MCP. */
async function runInstamartRule(deps: Deps, rule: Rule): Promise<{ summary: string }> {
  const session = loadSwiggySession() as (ReturnType<typeof loadSwiggySession> & { lastBalanceInr?: number }) | null;
  const mcp = new SwiggyMcp("instamart");
  try {
    return await orderOnInstamart(
      { client: deps.client, mcp, log: deps.log },
      { intent: rule.intent, maxInr: rule.maxInr, balanceInr: session?.lastBalanceInr ?? null },
    );
  } finally {
    await mcp.close();
  }
}

async function pass(deps: Deps, rulesFile: string, extraSignals: Set<string>) {
  const rules = loadRules(rulesFile);
  const { newDeposits, ledger } = await deps.purse.refresh();
  const b = budget(ledger);
  log(`purse: ${newDeposits} new deposit(s); cap ₹${b.capInr}, spent ₹${b.spentInr}, remaining ₹${b.remainingInr}`);

  // receipts that could not be sent earlier (e.g. purse notes still unconfirmed) go out as soon as funds free up
  const replyTo = await deps.purse.replyAddress();
  for (const s of ledger.spends.filter((x) => x.status === "delivered" && !x.receiptTxid)) {
    if (!replyTo) break;
    try {
      const txid = await deps.purse.sendReceipt(s, replyTo);
      log(`receipt (retry) for ${s.invoiceId}: ${txid}`);
    } catch (e) {
      log(`receipt (retry) for ${s.invoiceId} still failing: ${e instanceof Error ? e.message.split("\n").pop() : String(e)}`);
      break;
    }
  }

  await scanCalendarRules(deps, rules);
  await buyApprovedEsims(deps);

  let state = loadState();
  const signals = new Set([...takeSignals(), ...extraSignals]);
  const firings = due(rules, state.lastRun, signals);
  if (firings.length === 0) {
    log("nothing due");
    return;
  }
  for (const f of firings) {
    log(`rule ${f.rule.id} fired (${f.reason})`);
    state = { ...state, lastRun: { ...state.lastRun, [f.rule.id]: Date.now() } };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    try {
      const r = f.rule.spend === "instamart" ? { ...(await runInstamartRule(deps, f.rule)), spend: null, receiptTxid: null } : await runRule(deps, f.rule, f.reason);
      log(`agent: ${r.summary}`);
      state = { ...state, runs: [...state.runs, { at: new Date().toISOString(), ruleId: f.rule.id, reason: f.reason, summary: r.summary, spendId: r.spend?.id ?? null, receiptTxid: r.receiptTxid }] };
      // a delivered Swiggy Money card is only useful once it sits in the funder's Swiggy balance
      if (r.spend?.status === "delivered" && r.spend.orderId && /swiggy-money/i.test(r.spend.productId)) {
        await redeemSwiggyMoney(deps, r.spend.orderId);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`agent failed: ${msg}`);
      state = { ...state, runs: [...state.runs, { at: new Date().toISOString(), ruleId: f.rule.id, reason: f.reason, summary: "FAILED: " + msg, spendId: null, receiptTxid: null }] };
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  }
}

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  const args = process.argv.slice(2);
  const once = args.includes("--once");
  const sigIdx = args.indexOf("--signal");
  const extraSignals = new Set(sigIdx >= 0 ? [args[sigIdx + 1]] : []);
  const rulesFile = path.resolve(process.env.RULES_FILE ?? "apps/munim/rules.json");

  const apiKey = process.env.BITREFILL_API_KEY ?? "";
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured");
  const deps = {
    client: new Anthropic(),
    purse: new Purse(purseConfigFromEnv()),
    bitrefill: new Bitrefill(apiKey),
    log,
  };
  log(`munim starting; purse ${await deps.purse.address()}`);

  if (once || extraSignals.size) {
    await pass(deps, rulesFile, extraSignals);
    return;
  }
  const every = parseInt(process.env.POLL_SECONDS ?? "30", 10) * 1000;
  for (;;) {
    try {
      await pass(deps, rulesFile, new Set());
    } catch (e) {
      log(`pass failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    await new Promise((r) => setTimeout(r, every));
  }
}

main().catch((e) => {
  process.stderr.write(String(e?.stack ?? e) + "\n");
  process.exit(1);
});
