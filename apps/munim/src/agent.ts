// The agent brain: Claude Sonnet 5.5 with four tools. It decides which product
// fits the rule and the budget; the purse decides whether it may pay.
// Redemption codes never pass through the model: `buy` hashes them and
// returns only the hash.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { Purse, hashCode, type Spend } from "@munim/zcash-purse";
import { Bitrefill } from "./bitrefill.js";
import type { Rule } from "./rules.js";

export const MODEL = "claude-sonnet-5-5";

export interface AgentDeps {
  client: Anthropic;
  purse: Purse;
  bitrefill: Bitrefill;
  log: (line: string) => void;
}

export interface RunResult {
  summary: string;
  spend: Spend | null;
  receiptTxid: string | null;
}

const SYSTEM = `You are Munim, a household purchasing agent. You buy real products on Bitrefill (India catalog) on behalf of a family, paid from a purse the family funded in shielded Zcash with a spending cap.

Hard rules, in order:
1. Find the product with search_products, then get_product to read exact packages and their payment_price (USD) before any purchase.
2. Pick the cheapest package that satisfies the rule's intent. Never exceed the rule's max INR, never exceed the purse's remaining cap.
3. Call purse_check with the INR value BEFORE buy. If it refuses, stop and explain — do not look for workarounds.
4. Copy package values exactly as returned (they are case-sensitive, some contain en dashes). Never retype them.
5. buy exactly once per run. If buy fails, do not retry a different product.
6. You never see redemption codes; buy returns only a hash. Never ask for them.
7. Finish with 2-3 plain sentences: what was bought, for how much, the invoice id, and the receipt txid if one was sent. If nothing was bought, say why.`;

export async function runRule(deps: AgentDeps, rule: Rule, reason: string): Promise<RunResult> {
  const { client, purse, bitrefill, log } = deps;
  let spend: Spend | null = null;
  let receiptTxid: string | null = null;

  const searchProducts = betaZodTool({
    name: "search_products",
    description: "Search the Bitrefill India catalog. Returns id, name and type for up to 25 products.",
    inputSchema: z.object({
      query: z.string().describe("brand or operator name, e.g. 'airtel', 'swiggy'"),
      type: z.enum(["phone_refill", "gift_card", "esim"]).optional(),
    }),
    run: async ({ query, type }) => {
      const products = await bitrefill.search(query, "IN", type ?? rule.productType);
      log(`search '${query}' -> ${products.length} products`);
      return JSON.stringify(products.slice(0, 25).map((p) => ({ id: p.id, name: p.name, type: p.type, currency: p.currency })));
    },
  });

  const getProduct = betaZodTool({
    name: "get_product",
    description: "Product details: packages with value (INR) and payment_price (USD), or a range.",
    inputSchema: z.object({ product_id: z.string() }),
    run: async ({ product_id }) => {
      const p = await bitrefill.product(product_id);
      return JSON.stringify({ id: p.id, name: p.name, type: p.type, currency: p.currency, packages: p.packages, range: p.range });
    },
  });

  const purseCheck = betaZodTool({
    name: "purse_check",
    description: "Check an INR value against the rule ceiling and the purse's remaining cap. Spends nothing.",
    inputSchema: z.object({ value_inr: z.number().positive() }),
    run: async ({ value_inr }) => {
      if (value_inr > rule.maxInr) return JSON.stringify({ ok: false, reason: `₹${value_inr} exceeds this rule's max ₹${rule.maxInr}` });
      const v = await purse.check(value_inr);
      log(`purse_check ₹${value_inr}: ${v.reason}`);
      return JSON.stringify(v);
    },
  });

  const buy = betaZodTool({
    name: "buy",
    description: "Reserve budget on the purse, pay the invoice from Bitrefill balance, wait for delivery, send the receipt memo. Returns invoice id, order status and code hash — never the code.",
    inputSchema: z.object({
      product_id: z.string(),
      product_name: z.string(),
      package_id: z.string().optional().describe("exact package_id from get_product, for fixed packages"),
      value: z.union([z.number(), z.string()]).optional().describe("exact value for range products or string packages"),
      value_inr: z.number().positive().describe("INR face value of what is bought"),
      cost_usd: z.number().nonnegative().describe("payment_price from get_product"),
    }),
    run: async (a) => {
      if (spend) return JSON.stringify({ ok: false, reason: "already bought once this run" });
      if (a.value_inr > rule.maxInr) return JSON.stringify({ ok: false, reason: "exceeds rule max" });
      const needsPhone = (rule.productType ?? "") === "phone_refill" || /refill|top.?up/i.test(a.product_name);
      if (needsPhone && !rule.phone) return JSON.stringify({ ok: false, reason: "rule has no phone number for a top-up" });

      // 1. cap: reserve first, so an over-cap purchase can never be paid
      spend = await purse.reserve({
        ruleId: rule.id,
        productId: a.product_id,
        productName: a.product_name,
        valueInr: a.value_inr,
        costUsd: a.cost_usd,
        invoiceId: "pending",
        orderId: null,
      });
      log(`reserved ₹${a.value_inr} for ${a.product_name}`);

      // 2. pay
      let invoice;
      try {
        invoice = await bitrefill.buy({ productId: a.product_id, packageId: a.package_id, value: a.value, phoneNumber: needsPhone ? rule.phone : undefined });
      } catch (e) {
        spend = { ...spend, status: "failed" };
        await purse.update(spend);
        throw e;
      }
      spend = { ...spend, invoiceId: invoice.id, orderId: invoice.orders[0]?.id ?? null, status: invoice.status };
      await purse.update(spend);
      log(`invoice ${invoice.id} status ${invoice.status}`);

      // 3. delivered? (paid is not delivered)
      let codeHash: string | null = null;
      if (spend.orderId) {
        const order = await bitrefill.waitDelivered(spend.orderId);
        const code = order.redemption_info?.code ?? order.redemption_info?.link ?? order.redemption_info?.pin;
        codeHash = code ? hashCode(code) : null;
        spend = { ...spend, status: order.status, codeHash };
        await purse.update(spend);
        log(`order ${order.id} ${order.status}`);
      }

      // 4. receipt back to the funder, as an encrypted memo
      const to = await purse.replyAddress();
      if (to && spend.status === "delivered") {
        try {
          receiptTxid = await purse.sendReceipt(spend, to);
          log(`receipt tx ${receiptTxid}`);
        } catch (e) {
          log(`receipt failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return JSON.stringify({ ok: true, invoice_id: spend.invoiceId, order_id: spend.orderId, status: spend.status, code_sha256: codeHash, receipt_txid: receiptTxid });
    },
  });

  const budget = await purse.check(0.01);
  const final = await client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: "medium" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    tools: [searchProducts, getProduct, purseCheck, buy],
    max_iterations: 12,
    messages: [
      {
        role: "user",
        content:
          `Rule "${rule.id}" fired (${reason}).\n` +
          `Intent: ${rule.intent}\n` +
          `Rule max: ₹${rule.maxInr}. Product type: ${rule.productType ?? "any"}. ` +
          (rule.phone ? `Top-up phone is configured.\n` : `No phone configured.\n`) +
          `Purse remaining cap: ₹${budget.remainingInr}.\n` +
          `Do the purchase if it fits, otherwise explain.`,
      },
    ],
  });

  const summary = final.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return { summary, spend, receiptTxid };
}
