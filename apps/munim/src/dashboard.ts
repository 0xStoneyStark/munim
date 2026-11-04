// Read-only dashboard for the funder/accountant. Reads the ledger JSON and the
// VIEW-ONLY wallet (viewing key, no spend key) so it can be hosted anywhere.
//   npm run dashboard   -> http://localhost:8788
// JSON API (GET /api, POST /signal, /proposals, /rules) lives in api.ts.

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { loginUrl, exchangeCode } from "./swiggy-oauth.js";
import { handleApi, type ApiDeps } from "./api.js";
import { Bitrefill } from "./bitrefill.js";

const execFileP = promisify(execFile);
const PORT = parseInt(process.env.DASHBOARD_PORT ?? "8788", 10);
const DATA = path.resolve("data");

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

server.listen(PORT, () => process.stdout.write(`munim dashboard http://localhost:${PORT}\n`));
