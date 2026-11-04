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
import { ruleSchema, saveRules, type Rule } from "./rules.js";
import {
  EXPLORER,
  PRIVACY,
  buildTimeline,
  merchants,
  proposalCards,
  swiggyLinked,
  type AgentRun,
  type SwiggyRedeem,
} from "./api-views.js";

export interface ApiDeps {
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
    timeline: buildTimeline({ ledger, runs, proposals, redeems }),
    proposals: proposalCards(proposals),
    merchants: merchants(deps.dataDir, ledger),
    privacy: PRIVACY,
    swiggyLinked: swiggyLinked(deps.dataDir),
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

async function postDelete(deps: ApiDeps, req: http.IncomingMessage): Promise<unknown> {
  const { id } = await readBody(req, deleteBody);
  const current = readRules(deps.rulesFile);
  if (!current.some((r) => r.id === id)) throw notFound(`no rule ${id}`);
  const next = current.filter((r) => r.id !== id);
  saveRules(deps.rulesFile, next);
  return { ok: true, rules: next };
}

async function route(req: http.IncomingMessage, url: URL, deps: ApiDeps): Promise<unknown | undefined> {
  const p = url.pathname;
  if (req.method === "GET" && p === "/api") return overview(deps);
  if (req.method !== "POST") return undefined;
  if (p.startsWith("/signal/")) return postSignal(deps, p.slice("/signal/".length));
  const proposal = /^\/proposals\/([^/]+)\/(approve|decline)$/.exec(p);
  if (proposal) return decideProposal(decodeURIComponent(proposal[1]), proposal[2] as "approve" | "decline");
  if (p === "/rules/propose") return postPropose(deps, req);
  if (p === "/rules/commit") return postCommit(deps, req);
  if (p === "/rules/delete") return postDelete(deps, req);
  return undefined;
}

export async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: ApiDeps): Promise<boolean> {
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
