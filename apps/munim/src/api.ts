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
import { SwiggyMcp } from "./swiggy-mcp.js";
import { publicKey, sendToAll, subscribe, subscriptionSchema, unsubscribe } from "./push.js";

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
    proposals: [...proposalCards(proposals), ...chatCards(deps, ledger)],
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
  if (process.env.OPEN_DEMO === "1") throw badRequest("deleting rules is disabled while the demo is open to judges; add your own instead");
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

// ---------------------------------------------------------------------- push

const unsubscribeBody = z.object({ endpoint: z.string().min(1) });

async function postSubscribe(deps: ApiDeps, req: http.IncomingMessage): Promise<unknown> {
  const sub = await readBody(req, subscriptionSchema);
  try {
    return { ok: true, subscriptions: subscribe(sub, deps.dataDir) };
  } catch (e) {
    throw badRequest(e instanceof Error ? e.message : String(e));
  }
}

async function postUnsubscribe(deps: ApiDeps, req: http.IncomingMessage): Promise<unknown> {
  const { endpoint } = await readBody(req, unsubscribeBody);
  return { ok: true, removed: unsubscribe(endpoint, deps.dataDir) };
}

async function postPushTest(deps: ApiDeps): Promise<unknown> {
  return sendToAll({ title: "Munim", body: "Notifications are on.", url: "/", tag: "test" }, deps.dataDir);
}

// ---------------------------------------------------------------------- swiggy addresses (official MCP)

const addressBody = z.object({
  fullAddress: z.string().min(6).max(300),
  addressLine: z.string().min(2).max(200),
  addressLine2: z.string().max(200).default(""),
  locality: z.string().max(120).optional(),
  city: z.string().min(2).max(80),
  postalCode: z.string().regex(/^\d{6}$/),
  addressCategory: z.enum(["HOME", "WORK", "OFFICE", "FRIENDS_AND_FAMILY", "OTHER"]).default("OTHER"),
  addressTag: z.string().min(1).max(40),
  userName: z.string().min(1).max(80),
  userPhone: z.string().regex(/^\d{10}$/),
});
const addressDeleteBody = z.object({ addressId: z.string().min(4).max(120) });

function parseAddressList(text: string): Array<{ tag: string; name: string; address: string; id: string }> {
  const out: Array<{ tag: string; name: string; address: string; id: string }> = [];
  const re = /\d+\.\s*\[([^\]]*)\]\s*([^:]+):\s*([\s\S]*?)\s*\(ID:\s*([^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ tag: m[1].trim(), name: m[2].trim(), address: m[3].trim(), id: m[4] });
  return out;
}

async function withSwiggy<T>(fn: (m: SwiggyMcp) => Promise<T>): Promise<T> {
  const m = new SwiggyMcp("instamart");
  try { return await fn(m); } finally { await m.close().catch(() => {}); }
}

async function getAddresses(): Promise<unknown> {
  const text = await withSwiggy((m) => m.call("get_addresses", { pageSize: 10 }));
  return { addresses: parseAddressList(text), raw: text.slice(0, 2000) };
}

async function postAddress(req: http.IncomingMessage): Promise<unknown> {
  const body = await readBody(req, addressBody);
  const text = await withSwiggy((m) => m.call("create_address", body));
  const id = /"addressId"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? null;
  return { ok: true, addressId: id, raw: text.slice(0, 500) };
}

async function deleteAddress(req: http.IncomingMessage): Promise<unknown> {
  if (process.env.OPEN_DEMO === "1") throw badRequest("deleting a saved address is disabled while the demo is open to judges");
  const { addressId } = await readBody(req, addressDeleteBody);
  const text = await withSwiggy((m) => m.call("delete_address", { addressId }));
  return { ok: /success/i.test(text), raw: text.slice(0, 300) };
}

// ---------------------------------------------------------------------- chat proposals (shop from chat)
// A chat line becomes a one-off rule with a private signal trigger plus a card in Approvals.
// Approve fires that signal: the normal agent pass, cap check, Bitrefill and receipt path do the rest.

interface ChatProposal {
  id: string;
  createdAt: string;
  text: string;
  readback: string;
  ruleId: string;
  maxInr: number;
  status: "proposed" | "approved" | "declined";
  decidedAt?: string;
}

function chatFile(deps: ApiDeps): string { return path.join(deps.dataDir, "chat-proposals.json"); }
function loadChat(deps: ApiDeps): ChatProposal[] { return readJson<ChatProposal[]>(chatFile(deps), []); }
function saveChat(deps: ApiDeps, list: ChatProposal[]): void { fs.writeFileSync(chatFile(deps), JSON.stringify(list, null, 2)); }

const chatBody = z.object({ text: z.string().trim().min(3).max(400) });

async function postChat(deps: ApiDeps, req: http.IncomingMessage): Promise<unknown> {
  const { text } = await readBody(req, chatBody);
  const existing = readRules(deps.rulesFile);
  let proposal;
  try {
    proposal = await proposeRule(deps.client, `${text}. Do this once, when I say so.`, existing);
  } catch (e) {
    throw new ApiError(502, e instanceof Error ? e.message : String(e));
  }
  const id = `chat-${Date.now().toString(36)}`;
  const rule = { ...proposal.rule, id, trigger: { signal: id } };
  saveRules(deps.rulesFile, [...existing.filter((r) => r.id !== id), rule]);
  const entry: ChatProposal = { id, createdAt: new Date().toISOString(), text, readback: proposal.readback, ruleId: id, maxInr: Number(rule.maxInr) || 0, status: "proposed" };
  saveChat(deps, [...loadChat(deps), entry]);
  return { ok: true, proposal: entry, warnings: proposal.warnings ?? [] };
}

function decideChat(deps: ApiDeps, id: string, action: "approve" | "decline"): unknown {
  const list = loadChat(deps);
  const entry = list.find((p) => p.id === id);
  if (!entry) throw notFound(`no chat proposal ${id}`);
  if (entry.status !== "proposed") throw badRequest(`already ${entry.status}`);
  const next: ChatProposal = { ...entry, status: action === "approve" ? "approved" : "declined", decidedAt: new Date().toISOString() };
  saveChat(deps, list.map((p) => (p.id === id ? next : p)));
  if (action === "approve") {
    const fired = fireRule(deps, entry.ruleId) as { started: boolean; reason: string };
    return { ok: true, proposal: next, fired };
  }
  saveRules(deps.rulesFile, readRules(deps.rulesFile).filter((r) => r.id !== entry.ruleId));
  return { ok: true, proposal: next };
}

/** Cards in the same shape the Approvals page already renders for eSIM proposals. */
function chatCards(deps: ApiDeps, ledger: Ledger): Array<Record<string, unknown>> {
  return loadChat(deps).map((p) => {
    const spend = ledger.spends.find((s) => (s as { ruleId?: string }).ruleId === p.ruleId && s.status === "delivered");
    const status = p.status === "approved" && spend ? "bought" : p.status;
    return { id: p.id, createdAt: p.createdAt, kind: "chat", title: p.readback, sub: `you said: “${p.text}”`, detail: `you said: “${p.text}”`, price: p.maxInr ? `up to ₹${p.maxInr}` : "inside the cap", status, invoiceId: spend?.invoiceId };
  });
}

async function route(req: http.IncomingMessage, url: URL, deps: ApiDeps): Promise<unknown | undefined> {
  const p = url.pathname;
  if (req.method === "GET" && p === "/api") return { ...overview(deps), agentRunning: agentRunning(deps) };
  if (req.method === "GET" && p === "/push/public-key") return { publicKey: publicKey(deps.dataDir) };
  if (req.method === "GET" && p === "/connections/swiggy/addresses") return getAddresses();
  if (req.method !== "POST") return undefined;
  if (p === "/agent/run") return runAgentPass(deps);
  if (p === "/connections/swiggy-money/probe") return probeSwiggyMoney();
  if (p === "/connections/swiggy/addresses") return postAddress(req);
  if (p === "/connections/swiggy/addresses/delete") return deleteAddress(req);
  if (p.startsWith("/signal/")) return postSignal(deps, p.slice("/signal/".length));
  const proposal = /^\/proposals\/([^/]+)\/(approve|decline)$/.exec(p);
  if (proposal) { const pid = decodeURIComponent(proposal[1]); const verb = proposal[2] as "approve" | "decline"; return pid.startsWith("chat-") ? decideChat(deps, pid, verb) : decideProposal(pid, verb); }
  if (p === "/chat") return postChat(deps, req);
  if (p === "/rules/propose") return postPropose(deps, req);
  if (p === "/rules/commit") return postCommit(deps, req);
  if (p === "/rules/delete") return postDelete(deps, req);
  if (p === "/rules/fire") return postFire(deps, req);
  if (p === "/push/subscribe") return postSubscribe(deps, req);
  if (p === "/push/unsubscribe") return postUnsubscribe(deps, req);
  if (p === "/push/test") return postPushTest(deps);
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
