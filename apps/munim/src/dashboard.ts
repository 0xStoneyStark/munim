// Read-only dashboard for the funder/accountant. Reads the ledger JSON and the
// VIEW-ONLY wallet (viewing key, no spend key) so it can be hosted anywhere.
//   npm run dashboard   -> http://localhost:8788
// JSON API (GET /api, POST /signal, /proposals, /rules) lives in api.ts.
// Auth: set DASHBOARD_PASSWORD to require a login (cookie session); unset = open (local dev).

import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { loginUrl, exchangeCode } from "./swiggy-oauth.js";
import { handleApi, type ApiDeps } from "./api.js";
import { Bitrefill } from "./bitrefill.js";

const execFileP = promisify(execFile);
const PORT = parseInt(process.env.DASHBOARD_PORT ?? "8788", 10);
const HOST = process.env.DASHBOARD_HOST || "127.0.0.1";
const DATA = path.resolve("data");

// ---- auth -------------------------------------------------------------
const PASSWORD = process.env.DASHBOARD_PASSWORD ?? "";
const AUTH_ON = PASSWORD !== "";
// Without DASHBOARD_SESSION_SECRET a random key is made per process start, so a restart logs everyone out.
const SECRET = process.env.DASHBOARD_SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const COOKIE = "munim_session";
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_BODY = 4096;
const sha256 = (v: string): Buffer => crypto.createHash("sha256").update(v).digest();
const sign = (expiry: string): string => crypto.createHmac("sha256", SECRET).update(expiry).digest("hex");

/** `v1.<expiry unix seconds>.<hmac-sha256(secret, expiry) hex>` */
function makeToken(): string {
  const expiry = String(Math.floor(Date.now() / 1000) + SESSION_SECONDS);
  return `v1.${expiry}.${sign(expiry)}`;
}

function validToken(token: string | undefined): boolean {
  const parts = (token ?? "").split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !/^\d+$/.test(parts[1]) || !/^[0-9a-f]{64}$/.test(parts[2])) return false;
  if (Number(parts[1]) <= Math.floor(Date.now() / 1000)) return false;
  return crypto.timingSafeEqual(Buffer.from(parts[2], "hex"), Buffer.from(sign(parts[1]), "hex"));
}

function cookieValue(req: http.IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === COOKIE) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function isSecure(req: http.IncomingMessage): boolean {
  return process.env.DASHBOARD_SECURE_COOKIES === "1" || String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https";
}

function sessionCookie(req: http.IncomingMessage, value: string, maxAge: number): string {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isSecure(req) ? "; Secure" : ""}`;
}

/** First hop of x-forwarded-for (set by Caddy), else the socket address. */
function clientIp(req: http.IncomingMessage): string {
  const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  return fwd || req.socket.remoteAddress || "unknown";
}

const fails = new Map<string, { count: number; resetAt: number }>();
function failState(ip: string): { count: number; resetAt: number } {
  const now = Date.now();
  for (const [k, v] of fails) if (v.resetAt <= now) fails.delete(k);
  return fails.get(ip) ?? { count: 0, resetAt: now + FAIL_WINDOW_MS };
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_LOGIN_BODY) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const loginPage = (error: string): string => fs.readFileSync(here("./login.html"), "utf8").replace("<!--ERROR-->", error);

/** Static PWA files: public so the browser can fetch the manifest/SW/icons before login. */
const PWA_FILES: Record<string, { file: string; type: string; headers?: Record<string, string> }> = {
  "/manifest.webmanifest": { file: "./pwa/manifest.webmanifest", type: "application/manifest+json" },
  "/sw.js": { file: "./pwa/sw.js", type: "text/javascript", headers: { "cache-control": "no-cache", "service-worker-allowed": "/" } },
  "/icon-192.png": { file: "./pwa/icon-192.png", type: "image/png" },
  "/icon-512.png": { file: "./pwa/icon-512.png", type: "image/png" },
  "/icon.svg": { file: "./pwa/icon.svg", type: "image/svg+xml" },
};

/** Routes that answer with JSON/data or mutate: an unauthenticated caller gets 401, not a redirect. */
function wantsJson(req: http.IncomingMessage, p: string): boolean {
  return (req.method !== "GET" && req.method !== "HEAD") || p === "/api" || p.startsWith("/api/") || p === "/export.csv" || p === "/noir-sdk.js";
}

/** Returns true when the request was fully answered (health, PWA files, login, logout, or a rejection). */
async function handleAuth(req: http.IncomingMessage, res: http.ServerResponse, p: string): Promise<boolean> {
  if (p === "/health") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end('{"ok":true}');
    return true;
  }
  const pwa = PWA_FILES[p];
  if (pwa && (req.method === "GET" || req.method === "HEAD")) {
    res.writeHead(200, { "content-type": pwa.type, "cache-control": "public, max-age=3600", ...pwa.headers }).end(fs.readFileSync(here(pwa.file)));
    return true;
  }
  if (!AUTH_ON) return false;
  const authed = validToken(cookieValue(req));
  if (p === "/login" && req.method === "GET") {
    if (authed) res.writeHead(302, { location: "/" }).end();
    else res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(loginPage(""));
    return true;
  }
  if (p === "/login" && req.method === "POST") {
    const ip = clientIp(req);
    const state = failState(ip);
    const html = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
    if (state.count >= MAX_FAILS) {
      res.writeHead(429, { ...html, "retry-after": String(Math.ceil((state.resetAt - Date.now()) / 1000)) }).end(loginPage("too many attempts, try again later"));
      return true;
    }
    const given = new URLSearchParams(await readBody(req)).get("password") ?? "";
    if (!crypto.timingSafeEqual(sha256(given), sha256(PASSWORD))) {
      fails.set(ip, { count: state.count + 1, resetAt: state.resetAt });
      res.writeHead(401, html).end(loginPage("wrong password"));
      return true;
    }
    fails.delete(ip);
    res.writeHead(302, { location: "/", "set-cookie": sessionCookie(req, makeToken(), SESSION_SECONDS), "cache-control": "no-store" }).end();
    return true;
  }
  if (p === "/logout" && req.method === "POST") {
    res.writeHead(302, { location: "/login", "set-cookie": sessionCookie(req, "", 0) }).end();
    return true;
  }
  // Swiggy's redirect target: reachable without a session, it only consumes a one-time code + state.
  if (authed || (p === "/oauth/swiggy/callback" && req.method === "GET")) return false;
  if (wantsJson(req, p)) res.writeHead(401, { "content-type": "application/json" }).end('{"error":"login required"}');
  else res.writeHead(302, { location: "/login" }).end();
  return true;
}

let anthropic: Anthropic | undefined;
let bitrefill: Bitrefill | undefined;
const apiDeps: ApiDeps = {
  // lazy: the Bitrefill constructor throws on an empty key, which must not stop the dashboard starting
  get bitrefill(): Bitrefill {
    return (bitrefill ??= new Bitrefill(process.env.BITREFILL_API_KEY ?? ""));
  },
  // built on first use so the dashboard runs without ANTHROPIC_API_KEY until /rules/propose is called
  get client(): Anthropic {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured");
    anthropic ??= new Anthropic();
    return anthropic;
  },
  rulesFile: path.resolve(process.env.RULES_FILE ?? "apps/munim/rules.json"),
  dataDir: DATA,
};

/** CSV of every transaction the viewing key can see — the accountant's export. */
async function viewExport(): Promise<string> {
  const bin = process.env.ZCASH_DEVTOOL;
  const dir = process.env.PURSE_VIEW_WALLET_DIR ?? "./wallets/agent-view";
  if (!bin) return "ZCASH_DEVTOOL not configured";
  await execFileP(bin, ["wallet", "-w", path.resolve(dir), "sync", "-s", "zecrocks", ...(process.env.PURSE_CONNECTION && process.env.PURSE_CONNECTION !== "direct" ? ["--connection", process.env.PURSE_CONNECTION] : [])], { timeout: 300_000 }).catch(() => undefined);
  const { stdout } = await execFileP(bin, ["wallet", "-w", path.resolve(dir), "list-tx", "-m", "csv"], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (await handleAuth(req, res, url.pathname)) return;
    if (await handleApi(req, res, url, apiDeps)) return;
    if (url.pathname === "/swiggy/login") {
      res.writeHead(302, { location: await loginUrl() }).end();
      return;
    }
    if (url.pathname === "/oauth/swiggy/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) throw new Error("missing code/state: " + (url.searchParams.get("error_description") ?? ""));
      await exchangeCode(code, state);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<p style='font:16px system-ui;padding:24px'>Swiggy linked to Munim. You can close this tab.</p>");
      return;
    }
    if (url.pathname === "/noir-sdk.js") {
      res.writeHead(200, { "content-type": "text/javascript" }).end(fs.readFileSync(path.resolve("apps/munim/src/noir-sdk.bundle.js")));
      return;
    }
    if (url.pathname === "/export.csv") {
      res.writeHead(200, { "content-type": "text/csv", "content-disposition": "attachment; filename=purse-view-export.csv" }).end(await viewExport());
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(fs.readFileSync(path.resolve("apps/munim/src/dashboard.html"), "utf8"));
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" }).end(e instanceof Error ? e.message : String(e));
  }
});

if (!AUTH_ON) process.stdout.write("dashboard: no DASHBOARD_PASSWORD set, auth disabled\n");
server.listen(PORT, HOST, () => process.stdout.write(`munim dashboard http://${HOST}:${PORT}\n`));
