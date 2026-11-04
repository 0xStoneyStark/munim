// Rules are what start a purchase without a person typing "buy me": a schedule
// or a named signal. Each rule carries its own ceiling; the purse cap sits
// above all of them.

import fs from "node:fs";
import { z } from "zod";

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const DEFAULT_TZ = "Asia/Kolkata";

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

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
    /** clock time "HH:MM" (24h) in `tz` (default MUNIM_TZ or Asia/Kolkata), optionally only on some days; fires once a day */
    z.object({
      at: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),
      days: z.array(z.enum(WEEKDAYS)).min(1).optional(),
      tz: z.string().refine(isValidTimeZone, "unknown time zone").optional(),
    }),
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

export type AtTrigger = Extract<Rule["trigger"], { at: string }>;

const DAY_MS = 86_400_000;
const LOOKBACK_DAYS = 8;

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localParts(epochMs: number, timeZone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const parts = fmt.formatToParts(epochMs);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute"), second: get("second") };
}

/** How far `timeZone` is ahead of UTC at this instant, in ms. */
function zoneOffsetMs(epochMs: number, timeZone: string): number {
  const p = localParts(epochMs, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(epochMs / 1000) * 1000;
}

/** The instant at which the wall clock in `timeZone` reads this civil date (UTC midnight of it) and time. */
function zonedEpoch(civilDay: number, hour: number, minute: number, timeZone: string): number {
  const guess = civilDay + (hour * 60 + minute) * 60_000;
  const first = guess - zoneOffsetMs(guess, timeZone);
  return guess - zoneOffsetMs(first, timeZone); // re-check: the offset may differ across a DST change
}

/** Most recent scheduled firing instant (epoch ms) of an `at` trigger that is <= now. */
export function lastScheduledAt(trigger: AtTrigger, now = Date.now()): number {
  const timeZone = trigger.tz ?? process.env.MUNIM_TZ ?? DEFAULT_TZ;
  const [hour, minute] = trigger.at.split(":").map(Number);
  const today = localParts(now, timeZone);
  const todayCivil = Date.UTC(today.year, today.month - 1, today.day);
  const days = trigger.days?.length ? trigger.days : WEEKDAYS;
  const allowed = new Set<number>(days.map((d) => WEEKDAYS.indexOf(d)));
  for (let back = 0; back < LOOKBACK_DAYS; back++) {
    const civilDay = todayCivil - back * DAY_MS;
    if (!allowed.has(new Date(civilDay).getUTCDay())) continue;
    const instant = zonedEpoch(civilDay, hour, minute, timeZone);
    if (instant <= now) return instant;
  }
  throw new Error(`no scheduled instant found for at ${trigger.at}`);
}

/** Signals named `rule:<id>` force rule <id> to run now. */
export const RULE_SIGNAL_PREFIX = "rule:";
const RULE_FILE_PREFIX = "rule--";

/** On-disk name for a signal; ':' is illegal in Windows file names. */
export function signalFileName(name: string): string {
  return name.startsWith(RULE_SIGNAL_PREFIX) ? RULE_FILE_PREFIX + name.slice(RULE_SIGNAL_PREFIX.length) : name;
}

/** Inverse of signalFileName. */
export function signalFromFileName(file: string): string {
  return file.startsWith(RULE_FILE_PREFIX) ? RULE_SIGNAL_PREFIX + file.slice(RULE_FILE_PREFIX.length) : file;
}

/** Rule ids named by `rule:<id>` signals. */
export function forcedRuleIds(signals: Set<string>): Set<string> {
  const ids = new Set<string>();
  for (const s of signals) if (s.startsWith(RULE_SIGNAL_PREFIX)) ids.add(s.slice(RULE_SIGNAL_PREFIX.length));
  return ids;
}

export interface Firing {
  rule: Rule;
  reason: string; // "schedule" | "signal:<name>" | "manual"
}

/**
 * Decide which rules fire now, given when each last ran and which signals are pending.
 * - A rule whose id is named by a `rule:<id>` signal fires with reason "manual", whatever its trigger.
 * - `every` fires when at least that long has passed since the last run.
 * - `at` fires once the most recent scheduled instant is newer than the last run.
 * - `signal` fires when its named signal is pending.
 * - `calendar` rules only fire here when forced; otherwise the travel scan owns them.
 */
export function due(rules: Rule[], lastRun: Record<string, number>, signals: Set<string>, now = Date.now()): Firing[] {
  const forced = forcedRuleIds(signals);
  const out: Firing[] = [];
  for (const rule of rules) {
    const last = lastRun[rule.id] ?? 0;
    if (forced.has(rule.id)) {
      out.push({ rule, reason: "manual" });
    } else if ("every" in rule.trigger) {
      if (now - last >= intervalMs(rule.trigger.every)) out.push({ rule, reason: "schedule" });
    } else if ("at" in rule.trigger) {
      if (last < lastScheduledAt(rule.trigger, now)) out.push({ rule, reason: "schedule" });
    } else if ("signal" in rule.trigger && signals.has(rule.trigger.signal)) {
      out.push({ rule, reason: `signal:${rule.trigger.signal}` });
    }
  }
  return out;
}
