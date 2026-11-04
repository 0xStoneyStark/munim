// JSON API behind the dashboard. handleApi returns false for routes it does not
// own so dashboard.ts can fall through to the page, CSV export and Swiggy OAuth.

import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { budget, type Ledger } from "@munim/zcash-purse";
import { approve, decline, loadProposals } from "./travel.js";
import { proposeRule } from "./rule-builder.js";
import { spawn } from "node:child_process";
import { RULE_SIGNAL_PREFIX, ruleSchema, saveRules, signalFileName, type Rule } from "./rules.js";
import {
  EXPLORER,
  PRIVACY,
  buildTimeline,
  connections,
  merchants,
  proposalCards,
  swiggyLinked,
  funders,
  type AgentRun,
  type SwiggyRedeem,
} from "./api-views.js";
import { handleVerify } from "./verify.js";
import type { Bitrefill } from "./bitrefill.js";
import { loadSwiggySession, probe } from "./swiggy-money.js";

export interface ApiDeps {
  readonly bitrefill: Bitrefill;
  /** constructed lazily by the caller: only /rules/propose touches it */
  readonly client: Anthropic;
  rulesFile: string;
  dataDir: string;
}

const MAX_BODY_BYTES = 64 * 1024;
const SIGNAL_NAME = /^[a-z0-9-]+$/;
const CODE_HASH_SHOWN = 16;

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const badRequest = (message: string): ApiError => new ApiError(400, message);
const notFound = (message: string): ApiError => new ApiError(404, message);

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw badRequest("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw badRequest("body is not valid JSON");
  }
}

async function readBody<T extends z.ZodType>(req: http.IncomingMessage, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await readJsonBody(req));
  if (!parsed.success) throw badRequest(parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return parsed.data;
}

function readJson<T>(file: string, fallback: T): T {
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as T) : fallback;
}

/** Raw rules as stored ("$TOPUP_PHONE" stays a placeholder), validated. */
function readRules(file: string): Rule[] {
  return z.array(ruleSchema).parse(readJson<unknown[]>(file, []));
}

// ---------------------------------------------------------------------- GET /api

function overview(deps: ApiDeps): Record<string, unknown> {
  const ledger = readJson<Ledger>(path.join(deps.dataDir, "ledger.json"), { address: "", deposits: [], spends: [] });
  const runs = readJson<{ runs: AgentRun[] }>(path.join(deps.dataDir, "agent-state.json"), { runs: [] }).runs;
  const redeems = readJson<SwiggyRedeem[]>(path.join(deps.dataDir, "swiggy-redeems.json"), []);
  const proposals = loadProposals();
  return {
    address: ledger.address,
    explorer: EXPLORER,
    budget: budget(ledger),
    deposits: ledger.deposits,
    spends: ledger.spends.map(({ codeHash, ...s }) => ({ ...s, codeHash: codeHash ? codeHash.slice(0, CODE_HASH_SHOWN) + "…" : null })),
    rules: readJson<unknown[]>(deps.rulesFile, []),
    runs,
    lastRun: readJson<{ lastRun?: Record<string, number> }>(path.join(deps.dataDir, "agent-state.json"), {}).lastRun ?? {},
    timeline: buildTimeline({ ledger, runs, proposals, redeems }),
    proposals: proposalCards(proposals),
    merchants: merchants(deps.dataDir, ledger),
    funders: funders(ledger),
    privacy: PRIVACY,
    swiggyLinked: swiggyLinked(deps.dataDir),
    connections: connections(deps.dataDir),
  };
}

// ------------------------------------------------------------------------ POST

function postSignal(deps: ApiDeps, name: string): unknown {
  if (!SIGNAL_NAME.test(name)) throw badRequest("bad signal name");
  const dir = path.join(deps.dataDir, "signals");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), new Date().toISOString());
  return { ok: true, signal: name };
}

/** Drop the force-fire signal for rule `id` (`rule:<id>`, stored as `rule--<id>`). Returns the file written. */
export function writeRuleSignal(dataDir: string, id: string): string {
  if (!SIGNAL_NAME.test(id)) throw badRequest("bad rule id");
  const dir = path.join(dataDir, "signals");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, signalFileName(RULE_SIGNAL_PREFIX + id));
  fs.writeFileSync(file, new Date().toISOString());
  return file;
}

/** Force rule `id` to run now: 404 for an unknown id, otherwise signal it and start an agent pass. */
export function fireRule(deps: ApiDeps, id: string, runPass: (d: ApiDeps) => { started: boolean; reason: string } = runAgentPass): unknown {
  if (!readRules(deps.rulesFile).some((r) => r.id === id)) throw notFound(`no rule ${id}`);
  writeRuleSignal(deps.dataDir, id);
  const { started, reason } = runPass(deps);
  return { ok: true, started, reason };
}

function decideProposal(id: string, action: "approve" | "decline"): unknown {
  if (!loadProposals().some((p) => p.id === id)) throw notFound(`no proposal ${id}`);
  try {
    return { ok: true, proposal: action === "approve" ? approve(id) : decline(id) };
  } catch (e) {
    throw badRequest(e instanceof Error ? e.message : String(e));
  }
}

const proposeBody = z.object({ text: z.string().trim().min(1, "text is required") });
const commitBody = z.object({ rule: ruleSchema });
const deleteBody = z.object({ id: z.string().min(1) });
const fireBody = z.object({ id: z.string().min(1) });

async function postPropose(deps: ApiDeps, req: http.IncomingMessage): Promise<unknown> {
  const { text } = await readBody(req, proposeBody);
  const existing = readRules(deps.rulesFile);
  try {
    return await proposeRule(deps.client, text, existing);
  } catch (e) {
    throw new ApiError(502, e instanceof Error ? e.message : String(e));
  }
}

/** A rule with an id that already exists replaces it in place; otherwise it is appended. */
async function postCommit(deps: ApiDeps, req: http.IncomingMessage): Promise<unknown> {
  const { rule } = await readBody(req, commitBody);
  const current = readRules(deps.rulesFile);
  const replaces = current.some((r) => r.id === rule.id);
  const next = replaces ? current.map((r) => (r.id === rule.id ? rule : r)) : [...current, rule];
  saveRules(deps.rulesFile, next);
  return { ok: true, rules: next };
}

async function postFire(deps: ApiDeps, req: http.IncomingMessage): Promise<unknown> {
  const { id } = await readBody(req, fireBody);
  return fireRule(deps, id);
}

async function postDelete(deps: ApiDeps, req: http.IncomingMessage): Promise<unknown> {
  const { id } = await readBody(req, deleteBody);
  const current = readRules(deps.rulesFile);
  if (!current.some((r) => r.id === id)) throw notFound(`no rule ${id}`);
  const next = current.filter((r) => r.id !== id);
  saveRules(deps.rulesFile, next);
  return { ok: true, rules: next };
}

// ---------------------------------------------------------------- POST /agent/run
// One agent pass (`run.ts --once`) spawned from the dashboard, so no terminal is
// needed. A lock file keeps passes from overlapping; a stale lock (>15 min) is ignored.

const AGENT_LOCK_MAX_AGE_MS = 15 * 60_000;

function agentLockPath(deps: ApiDeps): string {
  return path.join(deps.dataDir, "agent.lock");
}

export function agentRunning(deps: ApiDeps): boolean {
  const lock = agentLockPath(deps);
  if (!fs.existsSync(lock)) return false;
  const age = Date.now() - fs.statSync(lock).mtimeMs;
  if (age > AGENT_LOCK_MAX_AGE_MS) {
    fs.unlinkSync(lock);
    return false;
  }
  return true;
}

function runAgentPass(deps: ApiDeps): { started: boolean; reason: string } {
  if (agentRunning(deps)) return { started: false, reason: "an agent pass is already running" };
  const lock = agentLockPath(deps);
  fs.writeFileSync(lock, new Date().toISOString());
  const tsx = path.resolve("node_modules/tsx/dist/cli.mjs");
  const child = spawn(process.execPath, [tsx, path.resolve("apps/munim/src/run.ts"), "--once"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "ignore",
    detached: false,
    windowsHide: true,
  });
  child.on("exit", () => fs.rmSync(lock, { force: true }));
  child.on("error", () => fs.rmSync(lock, { force: true }));
  return { started: true, reason: "agent pass started; the timeline updates as it works" };
}

/** Live check of the saved Swiggy Money session: the "Test" button on the Connections page. */
async function probeSwiggyMoney(): Promise<unknown> {
  const session = loadSwiggySession();
  if (!session) throw notFound("no Swiggy Money session saved");
  const { alive, balanceInr, reason } = await probe(session);
  return { alive, balanceInr, reason };
}

async function route(req: http.IncomingMessage, url: URL, deps: ApiDeps): Promise<unknown | undefined> {
  const p = url.pathname;
  if (req.method === "GET" && p === "/api") return { ...overview(deps), agentRunning: agentRunning(deps) };
  if (req.method !== "POST") return undefined;
  if (p === "/agent/run") return runAgentPass(deps);
  if (p === "/connections/swiggy-money/probe") return probeSwiggyMoney();
  if (p.startsWith("/signal/")) return postSignal(deps, p.slice("/signal/".length));
  const proposal = /^\/proposals\/([^/]+)\/(approve|decline)$/.exec(p);
  if (proposal) return decideProposal(decodeURIComponent(proposal[1]), proposal[2] as "approve" | "decline");
  if (p === "/rules/propose") return postPropose(deps, req);
  if (p === "/rules/commit") return postCommit(deps, req);
  if (p === "/rules/delete") return postDelete(deps, req);
  if (p === "/rules/fire") return postFire(deps, req);
  return undefined;
}

export async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: ApiDeps): Promise<boolean> {
  if (url.pathname === "/verify" || url.pathname === "/api/verify") return handleVerify(req, res, url, { bitrefill: deps.bitrefill });
  try {
    const body = await route(req, url, deps);
    if (body === undefined) return false;
    sendJson(res, 200, body);
  } catch (e) {
    const status = e instanceof ApiError ? e.status : 500;
    sendJson(res, status, { error: e instanceof Error ? e.message : String(e) });
  }
  return true;
}
