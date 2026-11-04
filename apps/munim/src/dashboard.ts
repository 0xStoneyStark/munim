// Read-only dashboard for the funder/accountant. Reads the ledger JSON and the
// VIEW-ONLY wallet (viewing key, no spend key) so it can be hosted anywhere.
//   npm run dashboard   -> http://localhost:8788
// POST /signal/<name> drops a signal file that fires the matching rule.

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { budget, type Ledger } from "@munim/zcash-purse";
import { loginUrl, exchangeCode, isLoggedIn } from "./swiggy-oauth.js";

const execFileP = promisify(execFile);
const PORT = parseInt(process.env.DASHBOARD_PORT ?? "8788", 10);
const DATA = path.resolve("data");
const LEDGER = path.join(DATA, "ledger.json");
const STATE = path.join(DATA, "agent-state.json");
const SIGNALS = path.join(DATA, "signals");
const EXPLORER = "https://testnet.zcashexplorer.app/transactions/";

function readJson<T>(file: string, fallback: T): T {
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as T) : fallback;
}

/** CSV of every transaction the viewing key can see — the accountant's export. */
async function viewExport(): Promise<string> {
  const bin = process.env.ZCASH_DEVTOOL;
  const dir = process.env.PURSE_VIEW_WALLET_DIR ?? "./wallets/agent-view";
  if (!bin) return "ZCASH_DEVTOOL not configured";
  await execFileP(bin, ["wallet", "-w", path.resolve(dir), "sync", "-s", "zecrocks"], { timeout: 300_000 }).catch(() => undefined);
  const { stdout } = await execFileP(bin, ["wallet", "-w", path.resolve(dir), "list-tx", "-m", "csv"], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

function api() {
  const ledger = readJson<Ledger>(LEDGER, { address: "", deposits: [], spends: [] });
  const state = readJson<{ runs: unknown[] }>(STATE, { runs: [] });
  const rules = readJson<unknown[]>(path.resolve(process.env.RULES_FILE ?? "apps/munim/rules.json"), []);
  return {
    address: ledger.address,
    budget: budget(ledger),
    deposits: ledger.deposits,
    spends: ledger.spends.map(({ codeHash, ...s }) => ({ ...s, codeHash: codeHash ? codeHash.slice(0, 16) + "…" : null })),
    runs: state.runs,
    rules,
    explorer: EXPLORER,
    swiggyLinked: isLoggedIn(),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (req.method === "POST" && url.pathname.startsWith("/signal/")) {
      const name = url.pathname.slice("/signal/".length);
      if (!/^[a-z0-9-]+$/.test(name)) throw new Error("bad signal name");
      fs.mkdirSync(SIGNALS, { recursive: true });
      fs.writeFileSync(path.join(SIGNALS, name), new Date().toISOString());
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, signal: name }));
      return;
    }
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
    if (url.pathname === "/api") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(api()));
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
