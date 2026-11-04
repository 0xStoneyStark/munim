// MCP server exposing the capped purse to any agent (Claude Code, Cursor,
// Claude Desktop...). The agent can read its budget, check a spend against the
// cap, record a purchase and send a receipt memo — it never sees the funder's
// keys, and it cannot raise its own cap.
//
//   npm run purse:mcp     (stdio)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Purse, budget, zatToZec } from "./index.js";
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

const transport = new StdioServerTransport();
await server.connect(transport);
