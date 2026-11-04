// MCP server exposing the capped purse to any agent (Claude Code, Cursor,
// Claude Desktop...). The agent can read its budget, check a spend against the
// cap, record a purchase, send a receipt memo and pay another party inside the
// cap — it never sees the funder's keys, and it cannot raise its own cap.
//
//   npm run purse:mcp     (stdio)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MIN_PAY_ZATOSHIS, PURPOSE_MAX_CHARS, Purse, budget, zatToZec } from "./index.js";
import { purseConfigFromEnv } from "./config.js";

const purse = new Purse(purseConfigFromEnv());
const server = new McpServer({ name: "zcash-purse", version: "0.1.0" });

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });

server.registerTool(
  "purse_address",
  { description: "The purse's shielded unified address (testnet). Funders send TAZ here with memo `fund cap=<INR> reply=<their address>`.", inputSchema: {} },
  async () => text(await purse.address()),
);

server.registerTool(
  "purse_refresh",
  { description: "Sync the chain and ingest new shielded deposits. Returns balance, authorised cap, spent and remaining budget.", inputSchema: {} },
  async () => {
    const { newDeposits, ledger } = await purse.refresh();
    const bal = await purse.balance();
    return text({ newDeposits, balanceTaz: zatToZec(bal.spendable), budget: budget(ledger), deposits: ledger.deposits.length });
  },
);

server.registerTool(
  "purse_budget",
  { description: "Current authorised cap, amount spent and remaining budget in INR, plus the spend log.", inputSchema: {} },
  async () => {
    const l = await purse.state();
    return text({ budget: budget(l), spends: l.spends.map(({ codeHash: _c, ...s }) => s) });
  },
);

server.registerTool(
  "purse_check",
  { description: "Check whether a purchase of the given INR value fits inside the remaining cap. Pure check, spends nothing.", inputSchema: { value_inr: z.number().positive() } },
  async ({ value_inr }) => text(await purse.check(value_inr)),
);

server.registerTool(
  "purse_record_spend",
  {
    description: "Record a purchase against the cap. Fails if it would exceed the remaining budget. Call before paying; update status after.",
    inputSchema: {
      rule_id: z.string(),
      product_id: z.string(),
      product_name: z.string(),
      value_inr: z.number().positive(),
      cost: z.number().nonnegative().describe("what was paid, in minor units of the payer's balance currency"),
      cost_currency: z.string().default("USD"),
      invoice_id: z.string(),
      order_id: z.string().nullable().optional(),
      status: z.string().optional(),
    },
  },
  async (a) =>
    text(
      await purse.reserve({
        ruleId: a.rule_id,
        productId: a.product_id,
        productName: a.product_name,
        valueInr: a.value_inr,
        cost: a.cost,
        costCurrency: a.cost_currency,
        invoiceId: a.invoice_id,
        orderId: a.order_id ?? null,
        status: a.status,
      }),
    ),
);

server.registerTool(
  "purse_send_receipt",
  {
    description: "Send a shielded receipt for a recorded spend back to the funder as an encrypted memo. Returns the receipt txid.",
    inputSchema: { spend_id: z.string(), to: z.string().optional() },
  },
  async ({ spend_id, to }) => {
    const l = await purse.state();
    const spend = l.spends.find((s) => s.id === spend_id);
    if (!spend) throw new Error("unknown spend id");
    const dest = to ?? (await purse.replyAddress());
    if (!dest) throw new Error("no reply address: funder memo carried none and `to` not given");
    return text({ txid: await purse.sendReceipt(spend, dest) });
  },
);

server.registerTool(
  "purse_pay",
  {
    description:
      "Pay another party (e.g. another agent) in shielded ZEC with a memo. This MOVES REAL FUNDS (testnet TAZ) out of the purse and cannot be undone. " +
      "The INR cap applies: the payment is refused if value_inr exceeds the remaining budget. Transparent (t…/tm…/tex…) addresses are refused because paying them leaks amount, memo and payer link on-chain; only shielded utest1…/u1…/ztestsapling1… addresses are accepted. " +
      "The memo is encrypted end-to-end to the recipient; it is sent as `munim pay purpose=<purpose> inr=<value_inr> <memo>`, max 512 bytes. Returns the txid, the ledger spend id and the remaining INR budget.",
    inputSchema: {
      to: z.string().describe("recipient shielded address: utest1… / u1… unified, or ztestsapling1…"),
      zatoshis: z.number().int().min(MIN_PAY_ZATOSHIS).describe("amount to send in zatoshis (1 TAZ = 100,000,000); minimum 10000"),
      memo: z.string().default("").describe("message for the recipient, ≤ 512 UTF-8 bytes, encrypted to them"),
      value_inr: z.number().positive().describe("what this payment is worth against the INR cap — your declaration, recorded as such"),
      purpose: z.string().min(1).max(PURPOSE_MAX_CHARS).describe('short label, ≤ 40 chars, e.g. "research-agent fee"'),
    },
  },
  async (a) => {
    const { txid, spend } = await purse.pay({ to: a.to, zatoshis: a.zatoshis, memo: a.memo, valueInr: a.value_inr, purpose: a.purpose });
    return text({ txid, spend_id: spend.id, remaining_inr: budget(await purse.state()).remainingInr });
  },
);

server.registerTool(
  "purse_ledger",
  { description: "Read-only: every recorded spend and payment (redemption-code hashes omitted) plus the INR budget. Spends nothing.", inputSchema: {} },
  async () => {
    const l = await purse.state();
    return text({ budget: budget(l), spends: l.spends.map(({ codeHash: _c, ...s }) => s) });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
