// Rules are what start a purchase without a person typing "buy me": a schedule
// or a named signal. Each rule carries its own ceiling; the purse cap sits
// above all of them.

import fs from "node:fs";
import { z } from "zod";

export const ruleSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  intent: z.string().min(5),
  /** ceiling for one purchase from this rule, INR */
  maxInr: z.number().positive(),
  productType: z.enum(["phone_refill", "gift_card", "esim"]).optional(),
  /** phone number for top-ups; "$TOPUP_PHONE" reads the env var */
  phone: z.string().optional(),
  /** how the purchase is made when it is not a plain Bitrefill buy */
  spend: z.enum(["instamart"]).optional(),
  trigger: z.union([
    z.object({ every: z.string().regex(/^[0-9]+(s|m|h)$/) }),
    z.object({ signal: z.string().regex(/^[a-z0-9-]+$/) }),
    /** ics URL or "default" (CALENDAR_ICS); handled by the travel scan, never fires the shopping agent */
    z.object({ calendar: z.string().min(1) }),
  ]),
});

export type Rule = z.infer<typeof ruleSchema>;

export function loadRules(file: string): Rule[] {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return z.array(ruleSchema).parse(raw).map((r) => ({
    ...r,
    phone: r.phone === "$TOPUP_PHONE" ? process.env.TOPUP_PHONE : r.phone,
  }));
}

export function saveRules(file: string, rules: Rule[]): void {
  const checked = z.array(ruleSchema).parse(rules);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(checked, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export function intervalMs(every: string): number {
  const n = parseInt(every, 10);
  const unit = every.slice(-1);
  return n * (unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000);
}

export interface Firing {
  rule: Rule;
  reason: string; // "schedule" | "signal:<name>"
}

/** Decide which rules fire now (calendar rules never fire here: the travel scan owns them), given when each last ran and which signals are pending. */
export function due(rules: Rule[], lastRun: Record<string, number>, signals: Set<string>, now = Date.now()): Firing[] {
  const out: Firing[] = [];
  for (const rule of rules) {
    if ("every" in rule.trigger) {
      const last = lastRun[rule.id] ?? 0;
      if (now - last >= intervalMs(rule.trigger.every)) out.push({ rule, reason: "schedule" });
    } else if ("signal" in rule.trigger && signals.has(rule.trigger.signal)) {
      out.push({ rule, reason: `signal:${rule.trigger.signal}` });
    }
  }
  return out;
}
