// "Shop from chat": a Telegram front for the Munim dashboard API.
//   npm run telegram                      -> run the bot (long polling, no webhook)
//   npm run telegram -- test-format       -> print the /status text from a canned fixture
// Env: TELEGRAM_BOT_TOKEN (required), TELEGRAM_ALLOWED_CHAT_IDS (comma list),
//      MUNIM_API (default http://localhost:8788), TELEGRAM_API_BASE (default https://api.telegram.org),
//      TELEGRAM_STATE_FILE (default data/telegram-state.json).
// Nothing secret leaves this process: codes and keys are never read from the API, and any long
// token-like string (txid, address) is shortened to 10…6 before it is sent.

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

// ------------------------------------------------------------------ constants

const DEFAULT_MUNIM_API = "http://localhost:8788";
const DEFAULT_TELEGRAM_BASE = "https://api.telegram.org";
const POLL_SECONDS = 25;
const NOTIFY_INTERVAL_MS = 30_000;
const API_TIMEOUT_MS = 15_000;
const PROPOSE_TIMEOUT_MS = 90_000;
const PENDING_TTL_MS = 10 * 60_000;
const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const CONFLICT_WAIT_MS = 5_000;
const SEEN_KEYS_CAP = 300;
const STATUS_TIMELINE_LINES = 3;
const SHORT_HEAD = 10;
const SHORT_TAIL = 6;
const LONG_TOKEN = /[A-Za-z0-9]{24,}/g;
const SIGNAL_NAME = /^[a-z0-9-]+$/;
const NOTIFY_KINDS: ReadonlySet<string> = new Set(["purchase", "receipt", "refusal", "redeem"]);
const MAX_PUSH_DETAIL = 200;

const HELP = [
  "Munim, your household purchasing agent.",
  "",
  "/status - cap, spent, remaining, latest activity",
  "/approvals - open eSIM proposals",
  "/approve <id> or /decline <id>",
  "/fire <signal> - trigger a rule, e.g. /fire treat",
  "/rules - list rules",
  "",
  "Or just type a sentence, e.g. \"every sunday order milk and eggs, up to 400 rupees\". I will read it back before saving anything.",
].join("\n");

// ---------------------------------------------------------------------- types

interface Budget {
  capInr: number;
  spentInr: number;
  remainingInr: number;
}

interface TimelineItem {
  at: string;
  kind: string;
  title: string;
  detail: string;
  status?: string;
  mono?: string;
}

interface ProposalCard {
  id: string;
  title: string;
  subtitle: string;
  price: string;
  status: string;
}

interface RuleView {
  id: string;
  maxInr?: number;
  intent?: string;
  trigger?: Record<string, string>;
}

interface Overview {
  budget: Budget;
  timeline: TimelineItem[];
  proposals: ProposalCard[];
  rules: RuleView[];
}

interface RuleProposalReply {
  rule: RuleView;
  readback: string;
  warnings: string[];
}

interface Pending {
  proposal: RuleProposalReply;
  expiresAt: number;
}

interface BotState {
  chats: number[];
  offset: number;
  seenProposals: string[] | null;
  seenKeys: string[] | null;
}

interface TgChat {
  id: number;
}

interface TgMessage {
  chat: TgChat;
  text?: string;
}

interface TgCallback {
  id: string;
  data?: string;
  message?: TgMessage;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallback;
}

interface Keyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

interface Config {
  token: string;
  tgBase: string;
  munimApi: string;
  allowed: number[] | null;
  stateFile: string;
}

// -------------------------------------------------------------------- logging

function log(event: string, detail = ""): void {
  process.stdout.write(`${new Date().toISOString()} ${event}${detail ? " " + detail : ""}\n`);
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

// ----------------------------------------------------------------- formatting

/** Shorten any long token-like string (txid, address) so full values never reach chat. */
export function scrub(text: string): string {
  return text.replace(LONG_TOKEN, (m) => `${m.slice(0, SHORT_HEAD)}…${m.slice(-SHORT_TAIL)}`);
}

const inr = (n: number): string => `₹${Math.round(n).toLocaleString("en-IN")}`;
const truncate = (s: string, max: number): string => (s.length > max ? s.slice(0, max - 1) + "…" : s);

function timelineLine(t: TimelineItem): string {
  const when = t.at.slice(0, 16).replace("T", " ");
  const tail = t.status ? ` [${t.status}]` : t.mono ? ` ${t.mono}` : "";
  return scrub(`${when}  ${t.title}${tail}`);
}

export function formatStatus(o: Overview): string {
  const { capInr, spentInr, remainingInr } = o.budget;
  const lines = [`Cap ${inr(capInr)} · spent ${inr(spentInr)} · remaining ${inr(remainingInr)}`];
  const recent = o.timeline.slice(0, STATUS_TIMELINE_LINES);
  if (recent.length === 0) return lines[0] + "\n\nNothing has happened yet.";
  return [lines[0], "", "Latest:", ...recent.map(timelineLine)].join("\n");
}

const priceLabel = (price: string): string => price.replace(/^([\d.]+) USD$/, "$$$1");

function proposalSummary(p: ProposalCard): string {
  const destination = p.title.replace(/^eSIM\s*·\s*/, "");
  const product = p.subtitle.split(" · ").slice(1).join(" · ");
  return ["✈ eSIM for " + destination, product, priceLabel(p.price)].filter(Boolean).join(" · ");
}

export function formatApprovals(cards: ProposalCard[]): string {
  const open = cards.filter((c) => c.status === "proposed");
  if (open.length === 0) return "No proposals waiting for you.";
  return open.map((p) => scrub(`${proposalSummary(p)}\n  /approve ${p.id}   /decline ${p.id}`)).join("\n\n");
}

export function formatProposalPush(p: ProposalCard): string {
  return scrub(`${proposalSummary(p)} — /approve ${p.id} or /decline ${p.id}`);
}

function triggerLabel(t: RuleView["trigger"]): string {
  if (!t) return "?";
  if (t.every) return `every ${t.every}`;
  if (t.signal) return `on /fire ${t.signal}`;
  if (t.calendar) return "calendar";
  return "?";
}

const ruleLine = (r: RuleView): string => `${r.id} · ${triggerLabel(r.trigger)} · max ${inr(r.maxInr ?? 0)}`;

export function formatRules(rules: RuleView[]): string {
  return rules.length === 0 ? "No rules yet. Type a sentence to create one." : rules.map(ruleLine).join("\n");
}

export function formatReadback(p: RuleProposalReply): string {
  const warnings = p.warnings.map((w) => `⚠ ${w}`);
  return [p.readback, "", `Rule: ${ruleLine(p.rule)}`, ...warnings].join("\n");
}

/** One chat line for a timeline event worth pushing; never includes agent detail beyond a short scrubbed summary. */
export function formatTimelinePush(t: TimelineItem): string {
  const status = t.status ? ` [${t.status}]` : "";
  switch (t.kind) {
    case "purchase":
      return scrub(`🛒 ${t.title}${status}`);
    case "receipt":
      return scrub(`🧾 ${t.title}${t.mono ? " " + t.mono : ""}`);
    case "refusal":
      return scrub(`⛔ ${t.title}: ${truncate(t.detail, MAX_PUSH_DETAIL)}`);
    default:
      return scrub(`💳 ${t.title}${t.detail ? " · " + truncate(t.detail, MAX_PUSH_DETAIL) : ""}`);
  }
}

// -------------------------------------------------------------------- fixture

const FIXTURE: Overview = {
  budget: { capInr: 5000, spentInr: 1230, remainingInr: 3770 },
  timeline: [
    { at: "2026-11-04T08:15:02.000Z", kind: "receipt", title: "Receipt memo sent", detail: "Jio ₹29", mono: "a1b2c3d4…9f8e7d" },
    { at: "2026-11-04T08:15:01.000Z", kind: "purchase", title: "Jio talktime · ₹29", detail: "jio-recharge · invoice x", status: "delivered" },
    { at: "2026-11-03T21:00:00.000Z", kind: "proposal", title: "eSIM for Dubai", detail: "1GB/7d · 3.77 USD · proposed", status: "proposed" },
    { at: "2026-11-03T09:00:00.000Z", kind: "deposit", title: "Deposit 0.5 TAZ", detail: "", mono: "ffee1122…334455" },
  ],
  proposals: [
    { id: "esim-dubai-1", title: "eSIM · Dubai", subtitle: "2026-11-20 → 2026-11-27 · Dubai 1GB 7 days", price: "3.77 USD", status: "proposed" },
  ],
  rules: [{ id: "jio-recharge", maxInr: 30, trigger: { every: "24h" } }],
};

function printTestFormat(): void {
  const sample: RuleProposalReply = {
    rule: { id: "weekly-milk", maxInr: 400, trigger: { every: "168h" } },
    readback: "Every 168 hours Munim orders milk and eggs on Instamart, never more than ₹400.",
    warnings: ["The Swiggy account must be linked and Swiggy Money must hold a balance."],
  };
  const out = [
    "--- /status ---",
    formatStatus(FIXTURE),
    "--- /approvals ---",
    formatApprovals(FIXTURE.proposals),
    "--- push: proposal ---",
    formatProposalPush(FIXTURE.proposals[0]),
    "--- push: timeline ---",
    ...FIXTURE.timeline.filter((t) => NOTIFY_KINDS.has(t.kind)).map(formatTimelinePush),
    "--- /rules ---",
    formatRules(FIXTURE.rules),
    "--- sentence readback ---",
    formatReadback(sample),
  ];
  process.stdout.write(out.join("\n") + "\n");
}

// ---------------------------------------------------------------------- state

function loadState(file: string): BotState {
  const empty: BotState = { chats: [], offset: 0, seenProposals: null, seenKeys: null };
  if (!fs.existsSync(file)) return empty;
  try {
    return { ...empty, ...(JSON.parse(fs.readFileSync(file, "utf8")) as Partial<BotState>) };
  } catch (e) {
    log("state-unreadable", errText(e));
    return empty;
  }
}

function saveState(file: string, state: BotState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

// ------------------------------------------------------------------ Munim API

class MunimClient {
  constructor(private readonly base: string) {}

  private async call<T>(method: string, route: string, body?: unknown, timeoutMs = API_TIMEOUT_MS): Promise<T> {
    const res = await fetch(this.base + route, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Munim API ${route}: HTTP ${res.status}, not JSON`);
    }
    if (!res.ok) throw new Error((parsed as { error?: string }).error ?? `Munim API ${route}: HTTP ${res.status}`);
    return parsed as T;
  }

  overview = (): Promise<Overview> => this.call("GET", "/api");
  signal = (name: string): Promise<unknown> => this.call("POST", `/signal/${encodeURIComponent(name)}`, {});
  decide = (id: string, action: "approve" | "decline"): Promise<unknown> =>
    this.call("POST", `/proposals/${encodeURIComponent(id)}/${action}`, {});
  propose = (text: string): Promise<RuleProposalReply> => this.call("POST", "/rules/propose", { text }, PROPOSE_TIMEOUT_MS);
  commit = (rule: RuleView): Promise<unknown> => this.call("POST", "/rules/commit", { rule });
}

// ------------------------------------------------------------------- Telegram

class TelegramError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly retryAfterS = 0,
  ) {
    super(message);
  }
}

class TelegramClient {
  constructor(
    private readonly base: string,
    private readonly signal: AbortSignal,
  ) {}

  async call<T>(method: string, params: Record<string, unknown>, timeoutMs = API_TIMEOUT_MS): Promise<T> {
    const res = await fetch(`${this.base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(timeoutMs)]),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } };
    if (json.ok) return json.result as T;
    throw new TelegramError(json.error_code ?? res.status, json.description ?? `HTTP ${res.status}`, json.parameters?.retry_after ?? 0);
  }

  getUpdates = (offset: number): Promise<TgUpdate[]> =>
    this.call("getUpdates", { offset, timeout: POLL_SECONDS, allowed_updates: ["message", "callback_query"] }, (POLL_SECONDS + 10) * 1000);

  async send(chatId: number, text: string, keyboard?: Keyboard): Promise<void> {
    try {
      await this.call("sendMessage", { chat_id: chatId, text, reply_markup: keyboard });
    } catch (e) {
      if (e instanceof TelegramError && e.code === 429) {
        await sleep(Math.max(1, e.retryAfterS) * 1000, this.signal);
        await this.call("sendMessage", { chat_id: chatId, text, reply_markup: keyboard });
        return;
      }
      throw e;
    }
  }

  answerCallback = (id: string, text?: string): Promise<unknown> => this.call("answerCallbackQuery", { callback_query_id: id, text });
}

const CONFIRM_KEYBOARD: Keyboard = {
  inline_keyboard: [
    [
      { text: "✅ Confirm & save", callback_data: "confirm" },
      { text: "✏️ Edit", callback_data: "edit" },
      { text: "❌ Discard", callback_data: "discard" },
    ],
  ],
};

// ------------------------------------------------------------------------ bot

class Bot {
  private readonly pending = new Map<number, Pending>();
  private state: BotState;

  constructor(
    private readonly cfg: Config,
    private readonly tg: TelegramClient,
    private readonly munim: MunimClient,
    private readonly signal: AbortSignal,
  ) {
    this.state = loadState(cfg.stateFile);
  }

  private persist(): void {
    saveState(this.cfg.stateFile, this.state);
  }

  private recipients(): number[] {
    return this.cfg.allowed ?? this.state.chats;
  }

  /** Env list wins; otherwise the first chat that ever sent /start is the only one. */
  private isAllowed(chatId: number, text: string): boolean {
    if (this.cfg.allowed) return this.cfg.allowed.includes(chatId);
    if (this.state.chats.length > 0) return this.state.chats.includes(chatId);
    if (!/^\/start(@\w+)?(\s|$)/.test(text)) return false;
    this.state = { ...this.state, chats: [chatId] };
    this.persist();
    log("chat-registered", String(chatId));
    return true;
  }

  // ---------------------------------------------------------------- commands

  private async runCommand(cmd: string, arg: string): Promise<string> {
    switch (cmd) {
      case "/start":
      case "/help":
        return HELP;
      case "/status":
        return formatStatus(await this.munim.overview());
      case "/approvals":
        return formatApprovals((await this.munim.overview()).proposals);
      case "/rules":
        return formatRules((await this.munim.overview()).rules);
      case "/fire":
        return this.fire(arg);
      case "/approve":
      case "/decline":
        return this.decide(cmd === "/approve" ? "approve" : "decline", arg);
      default:
        return "Unknown command. Send /start for help.";
    }
  }

  private async fire(name: string): Promise<string> {
    if (!SIGNAL_NAME.test(name)) return "Usage: /fire <signal>  (lowercase letters, digits, dashes)";
    await this.munim.signal(name);
    return `ok, fired "${name}"`;
  }

  private async decide(action: "approve" | "decline", id: string): Promise<string> {
    if (!id) return `Usage: /${action} <id>  (see /approvals)`;
    await this.munim.decide(id, action);
    return `ok, ${action === "approve" ? "approved" : "declined"} ${id}`;
  }

  private async propose(chatId: number, text: string): Promise<void> {
    await this.tg.send(chatId, "Reading that as a rule…");
    const proposal = await this.munim.propose(text);
    this.pending.set(chatId, { proposal, expiresAt: Date.now() + PENDING_TTL_MS });
    await this.tg.send(chatId, formatReadback(proposal), CONFIRM_KEYBOARD);
  }

  private async handleMessage(msg: TgMessage): Promise<void> {
    const chatId = msg.chat.id;
    const text = (msg.text ?? "").trim();
    if (!text || !this.isAllowed(chatId, text)) {
      if (text) log("ignored-chat", String(chatId));
      return;
    }
    log("message", `chat=${chatId} ${text.startsWith("/") ? text.split(/\s/)[0] : "sentence"}`);
    try {
      if (text.startsWith("/")) {
        const [head, ...rest] = text.split(/\s+/);
        await this.tg.send(chatId, await this.runCommand(head.replace(/@\w+$/, "").toLowerCase(), rest.join(" ")));
      } else {
        await this.propose(chatId, text);
      }
    } catch (e) {
      log("command-failed", errText(e));
      await this.tg.send(chatId, `Could not do that: ${scrub(errText(e))}`);
    }
  }

  private livePending(chatId: number): Pending | undefined {
    const p = this.pending.get(chatId);
    if (p && p.expiresAt < Date.now()) this.pending.delete(chatId);
    return this.pending.get(chatId);
  }

  private async handleCallback(cb: TgCallback): Promise<void> {
    const chatId = cb.message?.chat.id;
    if (chatId === undefined || !this.isAllowed(chatId, "")) {
      await this.tg.answerCallback(cb.id);
      return;
    }
    log("callback", `chat=${chatId} ${cb.data ?? ""}`);
    await this.tg.answerCallback(cb.id);
    try {
      await this.applyChoice(chatId, cb.data ?? "");
    } catch (e) {
      log("callback-failed", errText(e));
      await this.tg.send(chatId, `Could not do that: ${scrub(errText(e))}`);
    }
  }

  private async applyChoice(chatId: number, choice: string): Promise<void> {
    if (choice === "edit") {
      this.pending.delete(chatId);
      await this.tg.send(chatId, "Send the corrected sentence.");
      return;
    }
    if (choice === "discard") {
      this.pending.delete(chatId);
      await this.tg.send(chatId, "Discarded. Nothing saved.");
      return;
    }
    const pending = this.livePending(chatId);
    if (!pending) {
      await this.tg.send(chatId, "That proposal expired. Send the sentence again.");
      return;
    }
    await this.munim.commit(pending.proposal.rule);
    this.pending.delete(chatId);
    await this.tg.send(chatId, `Saved rule ${pending.proposal.rule.id}. ${ruleLine(pending.proposal.rule)}`);
  }

  // -------------------------------------------------------------- update loop

  async pollLoop(): Promise<void> {
    let backoff = BACKOFF_START_MS;
    while (!this.signal.aborted) {
      try {
        const updates = await this.tg.getUpdates(this.state.offset);
        backoff = BACKOFF_START_MS;
        for (const u of updates) await this.handleUpdate(u);
      } catch (e) {
        if (this.signal.aborted) return;
        backoff = await this.backoffAfter(e, backoff);
      }
    }
  }

  private async handleUpdate(u: TgUpdate): Promise<void> {
    this.state = { ...this.state, offset: u.update_id + 1 };
    try {
      if (u.message) await this.handleMessage(u.message);
      else if (u.callback_query) await this.handleCallback(u.callback_query);
    } catch (e) {
      log("update-failed", errText(e));
    }
    this.persist();
  }

  private async backoffAfter(e: unknown, backoff: number): Promise<number> {
    if (e instanceof TelegramError && e.code === 429) {
      const wait = Math.max(1, e.retryAfterS) * 1000;
      log("telegram-429", `retry in ${wait}ms`);
      await sleep(wait, this.signal);
      return backoff;
    }
    if (e instanceof TelegramError && e.code === 409) {
      log("telegram-409", "another getUpdates consumer is active; retrying");
      await sleep(CONFLICT_WAIT_MS, this.signal);
      return backoff;
    }
    log("telegram-error", `${errText(e)}; retry in ${backoff}ms`);
    await sleep(backoff, this.signal);
    return Math.min(backoff * 2, BACKOFF_MAX_MS);
  }

  // ------------------------------------------------------------ push notifier

  async notifyLoop(): Promise<void> {
    while (!this.signal.aborted) {
      await this.notifyOnce().catch((e: unknown) => log("notify-error", errText(e)));
      await sleep(NOTIFY_INTERVAL_MS, this.signal);
    }
  }

  async notifyOnce(): Promise<void> {
    const o = await this.munim.overview();
    const proposalIds = o.proposals.filter((p) => p.status === "proposed").map((p) => p.id);
    const keyed = o.timeline.filter((t) => NOTIFY_KINDS.has(t.kind)).map((t) => ({ key: `${t.at}|${t.title}`, item: t }));
    const firstRun = this.state.seenProposals === null || this.state.seenKeys === null;
    const newProposals = firstRun ? [] : o.proposals.filter((p) => p.status === "proposed" && !this.state.seenProposals?.includes(p.id));
    const newItems = firstRun ? [] : keyed.filter((k) => !this.state.seenKeys?.includes(k.key));
    const texts = [...newProposals.map(formatProposalPush), ...newItems.reverse().map((k) => formatTimelinePush(k.item))];
    if (firstRun) log("notify-seeded", `${proposalIds.length} proposals, ${keyed.length} events`);
    for (const text of texts) await this.broadcast(text);
    this.state = {
      ...this.state,
      seenProposals: [...new Set([...(this.state.seenProposals ?? []), ...proposalIds])],
      seenKeys: [...(this.state.seenKeys ?? []), ...keyed.map((k) => k.key).filter((k) => !this.state.seenKeys?.includes(k))].slice(-SEEN_KEYS_CAP),
    };
    this.persist();
  }

  private async broadcast(text: string): Promise<void> {
    const chats = this.recipients();
    if (chats.length === 0) log("push-skipped", "no registered chat (send /start)");
    for (const chatId of chats) {
      await this.tg.send(chatId, text).catch((e: unknown) => log("push-failed", `chat=${chatId} ${errText(e)}`));
      log("push", `chat=${chatId} ${text.split("\n")[0].slice(0, 60)}`);
    }
  }
}

// ----------------------------------------------------------------------- main

function parseAllowed(raw: string | undefined): number[] | null {
  if (!raw?.trim()) return null;
  const ids = raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n));
  return ids.length > 0 ? ids : null;
}

function readConfig(): Config | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  const tgBase = (process.env.TELEGRAM_API_BASE ?? DEFAULT_TELEGRAM_BASE).replace(/\/$/, "");
  return {
    token,
    tgBase: `${tgBase}/bot${token}`,
    munimApi: (process.env.MUNIM_API ?? DEFAULT_MUNIM_API).replace(/\/$/, ""),
    allowed: parseAllowed(process.env.TELEGRAM_ALLOWED_CHAT_IDS),
    stateFile: path.resolve(process.env.TELEGRAM_STATE_FILE ?? "data/telegram-state.json"),
  };
}

async function runBot(cfg: Config): Promise<void> {
  const stop = new AbortController();
  process.once("SIGINT", () => {
    log("shutdown", "SIGINT");
    stop.abort();
  });
  const bot = new Bot(cfg, new TelegramClient(cfg.tgBase, stop.signal), new MunimClient(cfg.munimApi), stop.signal);
  log("start", `munim=${cfg.munimApi} allowed=${cfg.allowed ? cfg.allowed.join(",") : "first /start"}`);
  await Promise.all([bot.pollLoop(), bot.notifyLoop()]);
  log("stopped");
}

async function main(): Promise<void> {
  if (process.argv[2] === "test-format") return printTestFormat();
  const cfg = readConfig();
  if (!cfg) {
    process.stderr.write("telegram: TELEGRAM_BOT_TOKEN is not set (create a bot with @BotFather and put the token in .env)\n");
    process.exit(1);
  }
  await runBot(cfg);
}

main().catch((e: unknown) => {
  process.stderr.write(`telegram: fatal: ${errText(e)}\n`);
  process.exit(1);
});
