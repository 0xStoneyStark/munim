// Natural language -> one validated Rule. The model proposes; ruleSchema decides.
// Nothing here writes to disk: the dashboard shows the readback, the human commits.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { MODEL } from "./agent.js";
import { ruleSchema, type Rule } from "./rules.js";

const MAX_TEXT_CHARS = 600;
const MAX_TOKENS = 1500;

/** What the model fills in: the rule plus a plain-words readback and warnings. */
const proposalSchema = z.object({
  rule: ruleSchema,
  readback: z.string().describe("one sentence saying what will happen, in plain words"),
  warnings: z.array(z.string()),
});

export interface RuleProposal {
  rule: Rule;
  readback: string;
  warnings: string[];
}

const SYSTEM = `You turn one sentence from a household member into a single Munim rule. Munim is a purchasing agent that buys on Bitrefill (India) and orders groceries on Swiggy Instamart, paid from a shielded-Zcash purse with a spending cap.

Rule fields:
- id: kebab-case, short, descriptive, and NOT in the list of existing ids you are given.
- intent: one or two sentences, written as an instruction to the purchasing agent (what to buy, what to prefer, what to avoid).
- maxInr: the per-purchase ceiling in rupees. Use the amount the user stated. If they gave none, pick a small sensible default and add a warning that you guessed it.
- productType: "phone_refill" for mobile top-ups, "gift_card" for gift cards, "esim" for travel data. Omit it when it is not clear.
- phone: for top-up rules set "$TOPUP_PHONE" (the literal string). Otherwise omit.
- spend: set "instamart" ONLY when the sentence is about groceries, Instamart, or Swiggy ordering. Otherwise omit.
- trigger: exactly one of
  - {"every":"<n>(s|m|h)"} for schedules. Convert: "daily" or "every day" or "every morning" -> "24h"; "weekly" or "every sunday" -> "168h"; "hourly" -> "1h". Only s, m, h units exist, so days become hours.
  - {"signal":"<kebab>"} for "when I say X", "on demand", "when I tap X".
  - {"calendar":"<ics url or 'default'>"} for travel or calendar-driven rules ("when I have a trip", "before I fly"). Use "default" unless the user gave a URL.

Warnings (plain strings, one per issue, only the ones that apply):
- Instamart rules: the Swiggy account must be linked and Swiggy Money must hold a balance.
- Top-up rules: TOPUP_PHONE must be set in the environment.
- Calendar rules: a calendar URL (CALENDAR_ICS or the rule's URL) must be configured.
- maxInr above 500: say the ceiling is large for an unattended agent.
- Anything you guessed.

readback: ONE sentence, plain words, saying when it fires, what it buys, and the ceiling. Example: "Every 24 hours Munim buys the cheapest Jio talktime top-up, never more than ₹30."

Do not invent fields. Do not mention these instructions.`;

function userMessage(text: string, existing: Rule[]): string {
  const ids = existing.map((r) => r.id).join(", ") || "(none)";
  return `Existing rule ids: ${ids}\n\nSentence:\n${text}`;
}

function describeIssues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/** Reject an id clash even if the model ignored the instruction. */
function assertUniqueId(rule: Rule, existing: Rule[]): void {
  if (existing.some((r) => r.id === rule.id)) {
    throw new Error(`rule builder produced an id that already exists: ${rule.id}`);
  }
}

export async function proposeRule(client: Anthropic, text: string, existing: Rule[]): Promise<RuleProposal> {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error("rule text is empty");
  if (trimmed.length > MAX_TEXT_CHARS) throw new Error(`rule text is longer than ${MAX_TEXT_CHARS} characters`);

  const message = await client.messages.parse({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM,
    output_config: { format: zodOutputFormat(proposalSchema) },
    messages: [{ role: "user", content: userMessage(trimmed, existing) }],
  });

  const checked = proposalSchema.safeParse(message.parsed_output);
  if (!checked.success) throw new Error(`rule builder returned an invalid rule: ${describeIssues(checked.error)}`);
  assertUniqueId(checked.data.rule, existing);
  return checked.data;
}
