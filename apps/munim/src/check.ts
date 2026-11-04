// `npm run check`: verifies the three integrations before a demo —
// Bitrefill (auth, balance, catalog), the purse (chain sync, budget), Anthropic key present.
import "dotenv/config";
import { Purse, budget, zatToZec } from "@munim/zcash-purse";
import { purseConfigFromEnv } from "@munim/zcash-purse/src/config.js";
import { Bitrefill } from "./bitrefill.js";
import { bitrefillMcp, productLines } from "./bitrefill-mcp.js";

const out = (k: string, v: unknown) => process.stdout.write(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}\n`);

const b = new Bitrefill(process.env.BITREFILL_API_KEY ?? "");
out("bitrefill.ping", await b.ping());
out("bitrefill.balance", await b.balance());
const jio = await b.search("jio", "IN", "phone_refill");
out("bitrefill.jio", jio.slice(0, 6).map((p) => `${p.id} | ${p.name}`));
const sw = await b.search("swiggy", "IN", "gift_card");
out("bitrefill.swiggy", sw.slice(0, 4).map((p) => `${p.id} | ${p.name}`));
if (jio[0]) {
  const d = await b.product(jio[0].id);
  out(`bitrefill.product(${jio[0].id})`, { packages: d.packages?.slice(0, 5), range: d.range });
}

try {
  const mcp = bitrefillMcp();
  try {
    out("bitrefill.mcp.tools", String((await mcp.tools()).length));
    const found = productLines(await mcp.call("search-products", { query: "jio", country: "IN", intent: "catalog discovery for a household purchasing agent" }));
    out("bitrefill.mcp.search(jio)", found.slice(0, 3).map((l) => l.split(" | ")[0]).join(", "));
  } finally {
    await mcp.close();
  }
} catch (e) {
  out("bitrefill.mcp", `ERROR ${e instanceof Error ? e.message : String(e)}`);
}

const purse = new Purse(purseConfigFromEnv());
const { ledger } = await purse.refresh();
const bal = await purse.balance();
out("purse.address", ledger.address.slice(0, 24) + "…");
out("purse.balance", `${zatToZec(bal.spendable)} TAZ spendable, ${zatToZec(bal.pending)} pending`);
out("purse.budget", budget(ledger));
out("purse.deposits", ledger.deposits.map((d) => ({ txid: d.txid.slice(0, 12), taz: zatToZec(d.zatoshis), cap: d.capInr, memo: d.memo?.slice(0, 40) })));
out("anthropic.key", process.env.ANTHROPIC_API_KEY ? "present" : "MISSING");
out("topup.phone", process.env.TOPUP_PHONE ? "present" : "MISSING");
