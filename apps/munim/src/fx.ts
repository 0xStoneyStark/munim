// Live USD->INR rate for sizing USD-priced eSIM proposals against the INR spending cap.
// Free keyless sources, 24 h file cache, stale cache and then a constant as last resorts.
import fs from "node:fs";
import path from "node:path";

const CACHE_FILE = path.resolve("data", "fx.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const FALLBACK_RATE = 90;

export interface FxRate {
  rate: number;
  source: string;
  asOf: string;
  cached: boolean;
}

interface CacheEntry {
  rate: number;
  source: string;
  asOf: string;
}

interface Provider {
  name: string;
  url: string;
}

const PROVIDERS: Provider[] = [
  { name: "open.er-api.com", url: "https://open.er-api.com/v6/latest/USD" },
  { name: "frankfurter.app", url: "https://api.frankfurter.app/latest?from=USD&to=INR" },
];

function isValidRate(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

function readCache(): CacheEntry | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    const c = raw as Partial<CacheEntry>;
    if (isValidRate(c.rate) && typeof c.source === "string" && typeof c.asOf === "string") {
      return { rate: c.rate, source: c.source, asOf: c.asOf };
    }
  } catch {
    // missing or corrupt cache is the same as no cache
  }
  return null;
}

function writeCache(entry: CacheEntry): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(entry, null, 2));
  } catch {
    // the rate is still good for this run; failing to cache must not block a purchase
  }
}

async function fetchRate(p: Provider): Promise<number | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(p.url, { signal: ctl.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { rates?: { INR?: unknown } };
    const inr = body.rates?.INR;
    return isValidRate(inr) ? inr : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function usdToInr(): Promise<FxRate> {
  const cache = readCache();
  if (cache && Date.now() - Date.parse(cache.asOf) < CACHE_TTL_MS) return { ...cache, cached: true };

  for (const p of PROVIDERS) {
    const rate = await fetchRate(p);
    if (rate === null) continue;
    const entry = { rate, source: p.name, asOf: new Date().toISOString() };
    writeCache(entry);
    return { ...entry, cached: false };
  }

  if (cache) return { ...cache, source: "stale-cache", cached: true };
  return { rate: FALLBACK_RATE, source: "fallback-constant", asOf: new Date().toISOString(), cached: false };
}

/** INR value of an amount in USD or INR, rounded up; null for any other currency. */
export function inrFor(amount: number, currency: string, rate: number): number | null {
  if (currency === "USD") return Math.ceil(amount * rate);
  if (currency === "INR") return Math.ceil(amount);
  return null;
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("fx.ts");
if (isMain) {
  usdToInr().then((fx) => {
    process.stdout.write(`1 USD = ₹${fx.rate} (${fx.source}, as of ${fx.asOf}, cached: ${fx.cached})\n`);
  });
}
