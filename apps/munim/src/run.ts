// The loop: refresh the purse, fire due rules, run the agent for each.
//   npm run agent                 -- keeps running, checks every 30s
//   npm run agent -- --once        -- one pass
//   npm run agent -- --signal treat -- fire the rule listening for `treat`, then exit

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { Purse, budget } from "@munim/zcash-purse";
import { purseConfigFromEnv } from "@munim/zcash-purse/src/config.js";
import { Bitrefill } from "./bitrefill.js";
import { loadRules, due } from "./rules.js";
import { runRule } from "./agent.js";

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

async function pass(deps: Parameters<typeof runRule>[0], rulesFile: string, extraSignals: Set<string>) {
  const rules = loadRules(rulesFile);
  const { newDeposits, ledger } = await deps.purse.refresh();
  const b = budget(ledger);
  log(`purse: ${newDeposits} new deposit(s); cap ₹${b.capInr}, spent ₹${b.spentInr}, remaining ₹${b.remainingInr}`);

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
      const r = await runRule(deps, f.rule, f.reason);
      log(`agent: ${r.summary}`);
      state = { ...state, runs: [...state.runs, { at: new Date().toISOString(), ruleId: f.rule.id, reason: f.reason, summary: r.summary, spendId: r.spend?.id ?? null, receiptTxid: r.receiptTxid }] };
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
