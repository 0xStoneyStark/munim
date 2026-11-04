// Trip sources backed by community Google MCP servers, spoken to over stdio:
//   - Google Calendar: @cocal/google-calendar-mcp  (tool `list-events`)
//   - Gmail:           @gongrzhe/server-gmail-autoauth-mcp  (tools `search_emails`, `read_email`)
// Both need one Google Cloud OAuth "Desktop app" client (GOOGLE_OAUTH_CREDENTIALS) and a
// one-time browser consent: `npx tsx apps/munim/src/google-mcp.ts auth`.
// Email bodies are parsed in memory only; nothing here logs them.

import "dotenv/config";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import type { CalendarEvent } from "./travel.js";

const CALENDAR_PKG = "@cocal/google-calendar-mcp@2.8.1";
const GMAIL_PKG = "@gongrzhe/server-gmail-autoauth-mcp@1.1.11";

const DEFAULT_CREDENTIALS = "data/google-credentials.json";
const DEFAULT_CALENDAR_TOKENS = "data/google-calendar-tokens.json";
const DEFAULT_GMAIL_TOKENS = "data/gmail-credentials.json";

const DAY_MS = 86_400_000;
const CONNECT_TIMEOUT_MS = 180_000; // first run downloads the package via npx
const MAX_ERROR_CHARS = 500;
const STDERR_TAIL_CHARS = 2000;
const MAX_EMAILS = 40;
const DESCRIPTION_CHARS = 2000;
const DATE_SCAN_CHARS = 20_000;
const MAX_FUTURE_DAYS = 730;
const CLI_ENTRY = "npx tsx apps/munim/src/google-mcp.ts";

// ------------------------------------------------------------------ configuration

const credentialsPath = (): string => path.resolve(process.env.GOOGLE_OAUTH_CREDENTIALS ?? DEFAULT_CREDENTIALS);
const calendarTokenPath = (): string => path.resolve(process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH ?? DEFAULT_CALENDAR_TOKENS);
const gmailTokenPath = (): string => path.resolve(process.env.GMAIL_CREDENTIALS_PATH ?? DEFAULT_GMAIL_TOKENS);

export class GoogleAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

function fileHasContent(file: string): boolean {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

function assertCredentials(): void {
  const file = credentialsPath();
  if (!fileHasContent(file)) {
    throw new GoogleAuthError(
      `Google OAuth client file not found at ${file}. Create a Google Cloud OAuth "Desktop app" client, ` +
        `save its JSON there (or set GOOGLE_OAUTH_CREDENTIALS), then run google-mcp auth first: ${CLI_ENTRY} auth`,
    );
  }
}

function assertAuthorised(label: string, tokenFile: string): void {
  assertCredentials();
  if (!fileHasContent(tokenFile)) {
    throw new GoogleAuthError(
      `${label} is not authorised yet (no token file at ${tokenFile}). Run google-mcp auth first: ${CLI_ENTRY} auth`,
    );
  }
}

/** The servers report expired/revoked tokens in free text; point the user at the fix. */
function withAuthHint(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof GoogleAuthError || !/invalid_grant|re-?authenticat|not authenticated|unauthori[sz]ed|login required/i.test(msg)) {
    return err instanceof Error ? err : new Error(msg);
  }
  return new Error(`${msg.slice(0, MAX_ERROR_CHARS)} -- run google-mcp auth first: ${CLI_ENTRY} auth`);
}

// -------------------------------------------------------------------- stdio client

export interface McpStdioOptions {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  name?: string;
}

export interface McpStdioTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

/** Same public shape as McpHttp (connect / tools / call / close), over a spawned stdio server. */
export class McpStdio {
  private client: Client | null = null;
  private pending: Promise<void> | null = null;
  private stderrTail = "";

  constructor(private opts: McpStdioOptions) {}

  private get label(): string {
    return this.opts.name ?? "server";
  }

  private fail(prefix: string, e: unknown): Error {
    const msg = e instanceof Error ? e.message : String(e);
    return new Error(`${prefix}: ${msg}`.slice(0, MAX_ERROR_CHARS));
  }

  async connect(): Promise<void> {
    if (this.client) return;
    this.pending ??= this.open().finally(() => {
      this.pending = null;
    });
    await this.pending;
  }

  private async open(): Promise<void> {
    const transport = new StdioClientTransport({
      command: this.opts.command,
      args: this.opts.args,
      env: this.opts.env,
      cwd: this.opts.cwd,
      stderr: "pipe",
    });
    // drain stderr so the child never blocks on a full pipe; keep a short tail for error messages
    transport.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
    });
    const client = new Client({ name: "munim", version: "0.1.0" });
    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    } catch (e) {
      await transport.close().catch(() => undefined);
      const tail = this.stderrTail.trim().split("\n").slice(-3).join(" | ");
      throw this.fail(`mcp ${this.label} connect failed`, tail ? `${e instanceof Error ? e.message : String(e)} [${tail}]` : e);
    }
    this.client = client;
  }

  async tools(): Promise<McpStdioTool[]> {
    await this.connect();
    try {
      const r = await this.client!.listTools();
      return r.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    } catch (e) {
      throw this.fail("mcp listTools failed", e);
    }
  }

  /** Returns the concatenated text content; throws if the server flags an error. */
  async call(name: string, args: Record<string, unknown>): Promise<string> {
    await this.connect();
    let r;
    try {
      r = await this.client!.callTool({ name, arguments: args });
    } catch (e) {
      throw this.fail(`mcp ${name} failed`, e);
    }
    const content = (r.content ?? []) as Array<{ type: string; text?: string }>;
    const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
    if (r.isError) throw new Error(`mcp ${name}: ${text.slice(0, MAX_ERROR_CHARS)}`);
    return text;
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    await c?.close();
  }
}

export function calendarClient(): McpStdio {
  assertAuthorised("Google Calendar", calendarTokenPath());
  return new McpStdio({
    name: "google-calendar",
    command: "npx",
    args: ["-y", CALENDAR_PKG],
    env: {
      GOOGLE_OAUTH_CREDENTIALS: credentialsPath(),
      GOOGLE_CALENDAR_MCP_TOKEN_PATH: calendarTokenPath(),
    },
  });
}

export function gmailClient(): McpStdio {
  assertAuthorised("Gmail", gmailTokenPath());
  return new McpStdio({
    name: "gmail",
    command: "npx",
    args: ["-y", GMAIL_PKG],
    env: {
      GMAIL_OAUTH_PATH: credentialsPath(),
      GMAIL_CREDENTIALS_PATH: gmailTokenPath(),
    },
  });
}

async function withClient<T>(
  injected: McpStdio | undefined,
  make: () => McpStdio,
  run: (client: McpStdio) => Promise<T>,
): Promise<T> {
  const client = injected ?? make();
  try {
    return await run(client);
  } catch (err) {
    throw withAuthHint(err);
  } finally {
    if (!injected) await client.close().catch(() => undefined);
  }
}

// ------------------------------------------------------------------ Google Calendar

const isoSeconds = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, "Z");

const dateTimeSchema = z.object({ dateTime: z.string().optional(), date: z.string().optional() });
const calendarEventSchema = z.object({
  id: z.string(),
  summary: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  status: z.string().optional(),
  start: dateTimeSchema,
  end: dateTimeSchema.optional(),
});
const listEventsSchema = z.object({ events: z.array(z.unknown()) });

/** Calendar API date or dateTime -> Date. All-day dates are host-local midnight, like parseIcs. */
function parseGoogleTime(t: z.infer<typeof dateTimeSchema> | undefined): Date | null {
  if (!t) return null;
  if (t.dateTime) {
    const d = new Date(t.dateTime);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t.date ?? "");
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

export interface ListCalendarOptions {
  days?: number;
  calendarId?: string;
  now?: Date;
  /** pre-connected client (tests); not closed by this function */
  client?: McpStdio;
}

export async function listCalendarEvents(opts: ListCalendarOptions = {}): Promise<CalendarEvent[]> {
  const now = opts.now ?? new Date();
  const days = opts.days ?? 60;
  return withClient(opts.client, calendarClient, async (client) => {
    const text = await client.call("list-events", {
      calendarId: opts.calendarId ?? "primary",
      timeMin: isoSeconds(now),
      timeMax: isoSeconds(new Date(now.getTime() + days * DAY_MS)),
      // the server's default field set omits description
      fields: ["id", "summary", "description", "location", "start", "end", "status"],
    });
    let payload: z.infer<typeof listEventsSchema>;
    try {
      payload = listEventsSchema.parse(JSON.parse(text));
    } catch {
      throw new Error("google-calendar: list-events returned an unexpected payload");
    }
    const events: CalendarEvent[] = [];
    for (const raw of payload.events) {
      const parsed = calendarEventSchema.safeParse(raw);
      if (!parsed.success || parsed.data.status === "cancelled") continue;
      const ev = parsed.data;
      const start = parseGoogleTime(ev.start);
      if (!start) continue;
      events.push({
        uid: ev.id,
        summary: ev.summary ?? "",
        description: ev.description ?? "",
        location: ev.location ?? "",
        start,
        end: parseGoogleTime(ev.end),
      });
    }
    return events;
  });
}

// ------------------------------------------------------------------------- Gmail

export function bookingQuery(days: number): string {
  return (
    `newer_than:${days}d (subject:(itinerary OR "e-ticket" OR PNR OR "booking confirmation" OR "flight" OR "boarding pass") ` +
    `OR from:(makemytrip.com OR cleartrip.com OR goindigo.in OR airindia.com OR vistara.com OR emirates.com OR booking.com OR airbnb.com))`
  );
}

interface EmailHead {
  id: string;
  subject: string;
  date: Date;
}

/** search_emails answers with blocks of "ID: ..\nSubject: ..\nFrom: ..\nDate: ..". */
function parseSearchResults(text: string): EmailHead[] {
  const heads: EmailHead[] = [];
  for (const m of text.matchAll(/^ID: (\S+)\r?\nSubject: (.*)\r?\nFrom: .*\r?\nDate: (.*)$/gm)) {
    const date = new Date(m[3].trim());
    if (!Number.isNaN(date.getTime())) heads.push({ id: m[1], subject: m[2].trim(), date });
  }
  return heads;
}

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", rarr: "->" };

function htmlToText(s: string): string {
  return s
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

/** read_email prints "Thread ID/Subject/From/To/Date" headers, a blank line, then body (+ attachment list). */
function extractBody(text: string): string {
  const split = text.indexOf("\n\n");
  let body = split >= 0 ? text.slice(split + 2) : text;
  body = body.replace(/\n\nAttachments \(\d+\):[\s\S]*$/, "");
  const isHtml = body.startsWith("[Note: This email is HTML-formatted") || /<(html|body|div|table|p|br)\b/i.test(body);
  if (isHtml) body = htmlToText(body.replace(/^\[Note: This email is HTML-formatted[^\]]*\]\s*/, ""));
  return body
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?";
const DAY_MONTH_YEAR = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?[\\s,-]+${MONTH_RE}[\\s,-]+(\\d{4})\\b`, "gi");
const MONTH_DAY_YEAR = new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi");
const SLASH_DATE = /\b(\d{2})\/(\d{2})\/(\d{4})\b/g;
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;

/** Noon local time, so a trip departing today still sorts after `now`; null for impossible dates like 31 Feb. */
function makeDate(y: number, month0: number, d: number): Date | null {
  const date = new Date(y, month0, d, 12);
  return date.getFullYear() === y && date.getMonth() === month0 && date.getDate() === d ? date : null;
}

/** Earliest date in the body that lies in the future (past ones are booking/issue dates). */
export function findFutureTravelDate(text: string, now: Date): Date | null {
  const scan = text.slice(0, DATE_SCAN_CHARS);
  const found: Array<Date | null> = [];
  for (const m of scan.matchAll(DAY_MONTH_YEAR)) {
    found.push(makeDate(Number(m[3]), MONTHS.indexOf(m[2].toLowerCase()), Number(m[1])));
  }
  for (const m of scan.matchAll(MONTH_DAY_YEAR)) {
    found.push(makeDate(Number(m[3]), MONTHS.indexOf(m[1].toLowerCase()), Number(m[2])));
  }
  for (const m of scan.matchAll(SLASH_DATE)) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    const [day, month] = b > 12 && a <= 12 ? [b, a] : [a, b]; // day-first unless it cannot be
    found.push(makeDate(Number(m[3]), month - 1, day));
  }
  for (const m of scan.matchAll(ISO_DATE)) {
    found.push(makeDate(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  }
  const limit = now.getTime() + MAX_FUTURE_DAYS * DAY_MS;
  const future = found.filter((d): d is Date => d !== null && d.getTime() >= now.getTime() && d.getTime() <= limit);
  return future.sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
}

export interface ListBookingOptions {
  days?: number;
  maxResults?: number;
  now?: Date;
  /** pre-connected client (tests); not closed by this function */
  client?: McpStdio;
}

export async function listBookingEmails(opts: ListBookingOptions = {}): Promise<CalendarEvent[]> {
  const now = opts.now ?? new Date();
  const days = opts.days ?? 90;
  return withClient(opts.client, gmailClient, async (client) => {
    const found = await client.call("search_emails", {
      query: bookingQuery(days),
      maxResults: opts.maxResults ?? MAX_EMAILS,
    });
    const events: CalendarEvent[] = [];
    let skipped = 0;
    let lastError = "";
    for (const head of parseSearchResults(found)) {
      let body: string;
      try {
        body = extractBody(await client.call("read_email", { messageId: head.id }));
      } catch (err) {
        skipped++;
        lastError = err instanceof Error ? err.message : String(err);
        continue;
      }
      events.push({
        uid: `gmail:${head.id}`,
        summary: head.subject,
        description: body.slice(0, DESCRIPTION_CHARS),
        location: "",
        start: findFutureTravelDate(body, now) ?? head.date,
        end: null,
      });
    }
    if (skipped > 0) process.stderr.write(`google-mcp: skipped ${skipped} email(s) that failed to read (${lastError})\n`);
    return events;
  });
}

// --------------------------------------------------------------------------- CLI

const out = (s: string) => process.stdout.write(`${s}\n`);
const day = (d: Date) => d.toISOString().slice(0, 10);

function runAuth(label: string, pkg: string, env: Record<string, string>): Promise<void> {
  out(`\n[${label}] a browser window opens for Google consent; approve it, then come back here.`);
  return new Promise((resolve, reject) => {
    // one command string (no args array) keeps `npx.cmd` working on Windows under shell: true
    const child = spawn(`npx -y ${pkg} auth`, { stdio: "inherit", shell: true, env: { ...process.env, ...env } });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${label} auth exited with code ${code}`))));
  });
}

async function auth(): Promise<void> {
  assertCredentials();
  for (const file of [calendarTokenPath(), gmailTokenPath()]) fs.mkdirSync(path.dirname(file), { recursive: true });
  out(`Using OAuth client ${credentialsPath()}`);
  out("Sign in with the Google account whose calendar and mail Munim should read.");
  out("If the consent screen says the app is unverified, choose Advanced > Continue (your account must be a test user).");
  await runAuth("calendar", CALENDAR_PKG, {
    GOOGLE_OAUTH_CREDENTIALS: credentialsPath(),
    GOOGLE_CALENDAR_MCP_TOKEN_PATH: calendarTokenPath(),
  });
  await runAuth("gmail", GMAIL_PKG, { GMAIL_OAUTH_PATH: credentialsPath(), GMAIL_CREDENTIALS_PATH: gmailTokenPath() });
  out("\nDone. Verify with:");
  out(`  ${CLI_ENTRY} calendar`);
  out(`  ${CLI_ENTRY} gmail`);
}

function printEvents(label: string, events: CalendarEvent[]): void {
  out(`${label}: ${events.length}`);
  for (const e of events) out(`  ${day(e.start)}  ${e.summary || "(no title)"}  [${e.uid}]`);
}

async function cli(argv: string[]): Promise<void> {
  const [cmd] = argv;
  if (cmd === "auth") await auth();
  else if (cmd === "calendar") printEvents("calendar events (next 60 days)", await listCalendarEvents());
  else if (cmd === "gmail") printEvents("booking emails (last 90 days)", await listBookingEmails());
  else {
    out("usage: google-mcp.ts auth | calendar | gmail");
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("google-mcp.ts");
if (isMain) {
  cli(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`google-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
