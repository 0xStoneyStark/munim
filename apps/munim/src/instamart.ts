// The spend stage: a Sonnet tool-runner drives Swiggy's official Instamart MCP
// server to turn a redeemed Swiggy Money balance into a grocery order.
//   tsx apps/munim/src/instamart.ts tools
//   tsx apps/munim/src/instamart.ts dry "<intent>" <maxInr>   (never places an order)

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { MODEL } from "./agent.js";
import { bridgeTools } from "./mcp-bridge.js";
import { SwiggyMcp } from "./swiggy-mcp.js";

export interface InstamartDeps {
  client: Anthropic;
  mcp: SwiggyMcp;
  log: (l: string) => void;
  confirmBeforeCall?: (name: string, args: Record<string, unknown>) => Promise<boolean>;
}

export interface InstamartJob {
  intent: string;
  maxInr: number;
  balanceInr: number | null;
  address?: string;
}

export interface InstamartResult {
  summary: string;
  orderRef: string | null;
  spentInr: number | null;
}

const SYSTEM = `You are Munim's grocery runner. You spend a Swiggy Money balance on Swiggy Instamart through the tools provided, which come from Swiggy's official MCP server.

Rules:
1. Use the tools to search Instamart for what the intent asks. Build a cart whose total, including fees, is at or below the budget you are given.
2. If a payment-method choice exists, prefer paying with the Swiggy Money balance.
3. Place the order ONLY if the total fits the budget. If it does not fit, or an item is unavailable, stop without ordering and explain why.
4. Never invent tool names or arguments; use only the tools provided, and read their schemas. If a tool returns an ERROR, read it, adjust once, and do not loop.
5. Finish with 2-3 plain sentences: the order id or reference, the items, and the total in ₹. If nothing was ordered, say why.`;

const ORDER_REF = /(order[_ -]?id|order)\W{0,3}([A-Za-z0-9-]{6,})/i;
const INR_TOTAL = /₹\s?([0-9,]+(?:\.[0-9]+)?)/;

export function parseSummary(summary: string): { orderRef: string | null; spentInr: number | null } {
  const ref = ORDER_REF.exec(summary)?.[2] ?? null;
  const inr = INR_TOTAL.exec(summary)?.[1];
  const spent = inr ? Number(inr.replace(/,/g, "")) : NaN;
  return { orderRef: ref, spentInr: Number.isFinite(spent) ? spent : null };
}

export async function orderOnInstamart(deps: InstamartDeps, job: InstamartJob): Promise<InstamartResult> {
  const { client, mcp, log, confirmBeforeCall } = deps;
  await mcp.connect();
  const tools = await bridgeTools(mcp, { log, confirmBeforeCall });
  log(`instamart tools: ${tools.map((t) => t.name).join(", ")}`);

  const budget = job.balanceInr === null ? job.maxInr : Math.min(job.maxInr, job.balanceInr);
  const final = await client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: "medium" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    tools,
    max_iterations: 20,
    messages: [
      {
        role: "user",
        content:
          `Intent: ${job.intent}\n` +
          `Budget (hard ceiling, total including fees): ₹${budget}. Rule max: ₹${job.maxInr}. ` +
          (job.balanceInr === null ? `Swiggy Money balance unknown; check it if a tool exposes it.\n` : `Swiggy Money balance: ₹${job.balanceInr}.\n`) +
          (job.address ? `Delivery address: ${job.address}\n` : `Use the account's default delivery address.\n`) +
          `Place the order if it fits, otherwise explain.`,
      },
    ],
  });

  const summary = final.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return { summary, ...parseSummary(summary) };
}

// CLI
const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("instamart.ts");
if (isMain) {
  const [cmd, intent, max] = process.argv.slice(2);
  const mcp = new SwiggyMcp("instamart");
  try {
    await mcp.connect();
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
  if (cmd === "tools") {
    for (const t of await bridgeTools(mcp)) process.stdout.write(`- ${t.name}\n`);
    await mcp.close();
  } else if (cmd === "dry" && intent && Number(max) > 0) {
    const log = (l: string) => process.stderr.write(`[instamart] ${l}\n`);
    const r = await orderOnInstamart(
      {
        client: new Anthropic(),
        mcp,
        log,
        confirmBeforeCall: async (name) => {
          log(`DRY RUN: would call ${name}, blocked`);
          return false;
        },
      },
      { intent, maxInr: Number(max), balanceInr: null },
    );
    process.stdout.write(`${r.summary}\n(orderRef=${r.orderRef} spentInr=${r.spentInr})\n`);
    await mcp.close();
  } else {
    await mcp.close();
    process.stderr.write('usage: instamart tools | dry "<intent>" <maxInr>\n');
    process.exit(1);
  }
}
