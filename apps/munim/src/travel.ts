// "Works while you sleep": read the user's calendar, notice upcoming international
// travel, and propose a Bitrefill eSIM for the destination. Nothing is bought until
// the user approves the proposal on the dashboard. LPA activation strings are cash:
// they are stored for the dashboard to render as a QR and are never logged.

import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Bitrefill, type Order, type Product } from "./bitrefill.js";

const DAY_MS = 86_400_000;
const MERGE_WINDOW_DAYS = 30;
const DEFAULT_TRIP_DAYS = 7;
const MIN_TRIP_SPAN_MS = 12 * 3_600_000;
const MIN_GB = 1;
const PACKAGE_SEP = "<&>";

// ---------------------------------------------------------------- iCalendar

export interface CalendarEvent {
  uid: string;
  summary: string;
  description: string;
  location: string;
  start: Date;
  end: Date | null;
}

interface IcsProp {
  params: Record<string, string>;
  value: string;
}

/** Split "NAME;PARAM=x:value" at the first colon that is not inside double quotes. */
function splitIcsLine(line: string): (IcsProp & { name: string }) | null {
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ":" && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon < 1) return null;
  const [rawName, ...rawParams] = line.slice(0, colon).split(";");
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: rawName.toUpperCase(), params, value: line.slice(colon + 1) };
}

function unescapeIcsText(s: string): string {
  return s.replace(/\\([nN,;\\])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

function tzOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - utcMs;
}

/** Wall-clock time in an IANA zone -> instant. Unknown zones (e.g. Windows names) fall back to host-local. */
function zonedToDate(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  try {
    const first = guess - tzOffsetMs(guess, tz);
    return new Date(guess - tzOffsetMs(first, tz));
  } catch {
    return new Date(y, mo - 1, d, h, mi, s);
  }
}

function parseIcsDate(prop: IcsProp): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(prop.value.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (m[4] === undefined) return new Date(y, mo - 1, d); // all-day: host-local midnight
  const [h, mi, s] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  if (m[7]) return new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  const tz = prop.params["TZID"];
  return tz ? zonedToDate(y, mo, d, h, mi, s, tz) : new Date(y, mo - 1, d, h, mi, s);
}

/** Small dependency-free iCalendar reader: VEVENTs only, no recurrence expansion. */
export function parseIcs(text: string): CalendarEvent[] {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const events: CalendarEvent[] = [];
  let props: Map<string, IcsProp> | null = null;
  let alarmDepth = 0;

  for (const line of lines) {
    const upper = line.trim().toUpperCase();
    if (upper === "BEGIN:VEVENT") {
      props = new Map();
      alarmDepth = 0;
      continue;
    }
    if (!props) continue;
    if (upper === "BEGIN:VALARM") alarmDepth++;
    else if (upper === "END:VALARM") alarmDepth = Math.max(0, alarmDepth - 1);
    else if (upper === "END:VEVENT") {
      const ev = buildEvent(props);
      if (ev) events.push(ev);
      props = null;
    } else if (alarmDepth === 0) {
      const p = splitIcsLine(line);
      if (p && !props.has(p.name)) props.set(p.name, { params: p.params, value: p.value });
    }
  }
  return events;
}

function buildEvent(props: Map<string, IcsProp>): CalendarEvent | null {
  if (props.get("STATUS")?.value.trim().toUpperCase() === "CANCELLED") return null;
  const startProp = props.get("DTSTART");
  const start = startProp ? parseIcsDate(startProp) : null;
  if (!start) return null;
  const endProp = props.get("DTEND");
  const text = (k: string) => unescapeIcsText(props.get(k)?.value ?? "").trim();
  const summary = text("SUMMARY");
  return {
    uid: props.get("UID")?.value.trim() || `${summary}|${start.toISOString()}`,
    summary,
    description: text("DESCRIPTION"),
    location: text("LOCATION"),
    start,
    end: endProp ? parseIcsDate(endProp) : null,
  };
}

export async function fetchCalendar(source: string): Promise<CalendarEvent[]> {
  if (/^(https?|webcal):\/\//i.test(source)) {
    const res = await fetch(source.replace(/^webcal:/i, "https:"));
    if (!res.ok) throw new Error(`calendar fetch failed: HTTP ${res.status}`);
    return parseIcs(await res.text());
  }
  return parseIcs(await fs.promises.readFile(source, "utf8"));
}

// -------------------------------------------------------------- destinations

type Place = readonly [iso2: string, name: string];

const IATA: Record<string, Place> = {
  DXB: ["AE", "Dubai"], AUH: ["AE", "Abu Dhabi"], SHJ: ["AE", "Sharjah"],
  DOH: ["QA", "Qatar"], RUH: ["SA", "Saudi Arabia"], JED: ["SA", "Saudi Arabia"],
  MCT: ["OM", "Oman"], KWI: ["KW", "Kuwait"], BAH: ["BH", "Bahrain"],
  SIN: ["SG", "Singapore"], KUL: ["MY", "Malaysia"], PEN: ["MY", "Malaysia"],
  BKK: ["TH", "Thailand"], DMK: ["TH", "Thailand"], HKT: ["TH", "Thailand"], CNX: ["TH", "Thailand"],
  DPS: ["ID", "Bali"], CGK: ["ID", "Indonesia"], SGN: ["VN", "Vietnam"], HAN: ["VN", "Vietnam"],
  MNL: ["PH", "Philippines"], HKG: ["HK", "Hong Kong"],
  NRT: ["JP", "Japan"], HND: ["JP", "Japan"], KIX: ["JP", "Japan"],
  ICN: ["KR", "South Korea"], PEK: ["CN", "China"], PVG: ["CN", "China"], TPE: ["TW", "Taiwan"],
  LHR: ["GB", "United Kingdom"], LGW: ["GB", "United Kingdom"], MAN: ["GB", "United Kingdom"],
  CDG: ["FR", "France"], FRA: ["DE", "Germany"], MUC: ["DE", "Germany"], BER: ["DE", "Germany"],
  AMS: ["NL", "Netherlands"], IST: ["TR", "Turkey"], FCO: ["IT", "Italy"], MAD: ["ES", "Spain"],
  BCN: ["ES", "Spain"], ZRH: ["CH", "Switzerland"], VIE: ["AT", "Austria"], LIS: ["PT", "Portugal"],
  ATH: ["GR", "Greece"], DUB: ["IE", "Ireland"],
  JFK: ["US", "United States"], EWR: ["US", "United States"], SFO: ["US", "United States"],
  LAX: ["US", "United States"], ORD: ["US", "United States"], IAD: ["US", "United States"],
  SEA: ["US", "United States"], BOS: ["US", "United States"],
  YYZ: ["CA", "Canada"], YVR: ["CA", "Canada"],
  SYD: ["AU", "Australia"], MEL: ["AU", "Australia"], AKL: ["NZ", "New Zealand"],
  KTM: ["NP", "Nepal"], CMB: ["LK", "Sri Lanka"], DAC: ["BD", "Bangladesh"], MLE: ["MV", "Maldives"],
  CAI: ["EG", "Egypt"], JNB: ["ZA", "South Africa"], MRU: ["MU", "Mauritius"],
  BOM: ["IN", "Mumbai"], DEL: ["IN", "Delhi"], BLR: ["IN", "Bengaluru"], MAA: ["IN", "Chennai"],
  HYD: ["IN", "Hyderabad"], CCU: ["IN", "Kolkata"], GOI: ["IN", "Goa"], AMD: ["IN", "Ahmedabad"],
  PNQ: ["IN", "Pune"], COK: ["IN", "Kochi"], JAI: ["IN", "Jaipur"],
};

/** Place names, matched case-insensitively on word boundaries; the display name feeds the Bitrefill search. */
const PLACE_NAMES: ReadonlyArray<readonly [string, string, string]> = [
  ["united arab emirates", "AE", "United Arab Emirates"], ["abu dhabi", "AE", "Abu Dhabi"],
  ["dubai", "AE", "Dubai"], ["uae", "AE", "United Arab Emirates"],
  ["singapore", "SG", "Singapore"], ["bangkok", "TH", "Bangkok"], ["phuket", "TH", "Phuket"],
  ["thailand", "TH", "Thailand"], ["bali", "ID", "Bali"], ["jakarta", "ID", "Jakarta"],
  ["indonesia", "ID", "Indonesia"], ["kuala lumpur", "MY", "Kuala Lumpur"], ["malaysia", "MY", "Malaysia"],
  ["united kingdom", "GB", "United Kingdom"], ["london", "GB", "London"], ["england", "GB", "United Kingdom"],
  ["scotland", "GB", "United Kingdom"], ["uk", "GB", "United Kingdom"],
  ["paris", "FR", "Paris"], ["france", "FR", "France"], ["berlin", "DE", "Berlin"],
  ["frankfurt", "DE", "Frankfurt"], ["munich", "DE", "Munich"], ["germany", "DE", "Germany"],
  ["amsterdam", "NL", "Amsterdam"], ["netherlands", "NL", "Netherlands"],
  ["tokyo", "JP", "Tokyo"], ["osaka", "JP", "Osaka"], ["japan", "JP", "Japan"],
  ["seoul", "KR", "Seoul"], ["south korea", "KR", "South Korea"], ["korea", "KR", "South Korea"],
  ["hong kong", "HK", "Hong Kong"], ["vietnam", "VN", "Vietnam"], ["hanoi", "VN", "Hanoi"],
  ["ho chi minh", "VN", "Vietnam"], ["nepal", "NP", "Nepal"], ["kathmandu", "NP", "Kathmandu"],
  ["sri lanka", "LK", "Sri Lanka"], ["colombo", "LK", "Colombo"], ["maldives", "MV", "Maldives"],
  ["united states", "US", "United States"], ["usa", "US", "United States"], ["new york", "US", "New York"],
  ["san francisco", "US", "San Francisco"], ["los angeles", "US", "Los Angeles"],
  ["canada", "CA", "Canada"], ["toronto", "CA", "Toronto"], ["vancouver", "CA", "Vancouver"],
  ["australia", "AU", "Australia"], ["sydney", "AU", "Sydney"], ["melbourne", "AU", "Melbourne"],
  ["new zealand", "NZ", "New Zealand"], ["turkey", "TR", "Turkey"], ["istanbul", "TR", "Istanbul"],
  ["qatar", "QA", "Qatar"], ["doha", "QA", "Doha"], ["switzerland", "CH", "Switzerland"],
  ["italy", "IT", "Italy"], ["rome", "IT", "Rome"], ["spain", "ES", "Spain"],
  ["barcelona", "ES", "Barcelona"], ["madrid", "ES", "Madrid"], ["china", "CN", "China"],
  ["beijing", "CN", "Beijing"], ["shanghai", "CN", "Shanghai"], ["philippines", "PH", "Philippines"],
  ["manila", "PH", "Manila"], ["saudi arabia", "SA", "Saudi Arabia"], ["bangladesh", "BD", "Bangladesh"],
  ["dhaka", "BD", "Dhaka"], ["oman", "OM", "Oman"], ["egypt", "EG", "Egypt"],
  ["south africa", "ZA", "South Africa"], ["mauritius", "MU", "Mauritius"], ["ireland", "IE", "Ireland"],
  ["portugal", "PT", "Portugal"], ["greece", "GR", "Greece"],
  // home-country names, so "Mumbai to Dubai" is not read as a trip to Mumbai
  ["india", "IN", "India"], ["mumbai", "IN", "Mumbai"], ["new delhi", "IN", "Delhi"], ["delhi", "IN", "Delhi"],
  ["bengaluru", "IN", "Bengaluru"], ["bangalore", "IN", "Bengaluru"], ["chennai", "IN", "Chennai"],
  ["hyderabad", "IN", "Hyderabad"], ["kolkata", "IN", "Kolkata"], ["goa", "IN", "Goa"],
  ["pune", "IN", "Pune"], ["ahmedabad", "IN", "Ahmedabad"], ["kochi", "IN", "Kochi"], ["jaipur", "IN", "Jaipur"],
];

const PLACE_MATCHERS = PLACE_NAMES.map(([name, iso2, display]) => ({
  re: new RegExp(`(?<![A-Za-z])${name.replace(/ /g, "\\s+")}(?![A-Za-z])`, "i"),
  place: [iso2, display] as Place,
}));

/** First place named in `text` that is not the home country, by position in the text. */
function findForeignPlace(text: string, home: string): Place | null {
  let best: { index: number; place: Place } | null = null;
  for (const { re, place } of PLACE_MATCHERS) {
    if (place[0] === home) continue;
    const m = re.exec(text);
    if (m && (best === null || m.index < best.index)) best = { index: m.index, place };
  }
  return best?.place ?? null;
}

// ---------------------------------------------------------------- trip detection

export interface Trip {
  eventUid: string;
  summary: string;
  destinationCountry: string; // ISO2
  destinationName: string;
  departs: Date;
  returns: Date | null;
  days: number;
}

export interface DetectOptions {
  homeCountry?: string;
  now?: Date;
  horizonDays?: number;
}

const FLIGHT_WORDS =
  /flight|✈|airways|airlines|indigo|air india|vistara|emirates|qatar|etihad|singapore air|lufthansa|british airways/i;
const FLIGHT_CODE = /\b[A-Z]{2}\s?\d{2,4}\b/;
const TRAVEL_WORDS = /\b(trip|holiday|vacation|travel|tour)\b/i;
const RETURN_WORDS = /\b(return|returning|inbound|back)\b/i;
const ROUTE = /\b([A-Z]{3})\s*(?:→|➝|->|=>|–|—|-|>|\bto\b|\bTO\b)\s*([A-Z]{3})\b/g;

function findRoute(text: string): { from: Place | null; to: Place | null } | null {
  for (const m of text.matchAll(ROUTE)) {
    const from = IATA[m[1]] ?? null;
    const to = IATA[m[2]] ?? null;
    if (from || to) return { from, to };
  }
  return null;
}

interface Leg {
  event: CalendarEvent;
  kind: "out" | "back" | "stay";
  country: string; // out/stay: destination; back: country being left
  name: string;
}

function classify(event: CalendarEvent, home: string): Leg | null {
  const route = findRoute(event.summary) ?? findRoute(event.description);
  if (route) {
    const { from, to } = route;
    if (to && to[0] !== home) return { event, kind: "out", country: to[0], name: to[1] };
    if (to && from && to[0] === home && from[0] !== home) return { event, kind: "back", country: from[0], name: from[1] };
    if (to && to[0] === home && (!from || from[0] === home)) return null; // domestic
  }
  const flightLike = FLIGHT_WORDS.test(event.summary) || FLIGHT_CODE.test(event.summary);
  const tripLike = flightLike || TRAVEL_WORDS.test(event.summary);
  const place =
    (tripLike ? findForeignPlace(`${event.summary}\n${event.description}`, home) : null) ??
    findForeignPlace(event.location, home);
  if (!place) return null;
  const kind = flightLike ? (RETURN_WORDS.test(event.summary) ? "back" : "out") : "stay";
  return { event, kind, country: place[0], name: place[1] };
}

function spanEnd(event: CalendarEvent): Date | null {
  return event.end && event.end.getTime() - event.start.getTime() >= MIN_TRIP_SPAN_MS ? event.end : null;
}

function withLength(trip: Trip): Trip {
  const days = trip.returns
    ? Math.max(1, Math.ceil((trip.returns.getTime() - trip.departs.getTime()) / DAY_MS))
    : DEFAULT_TRIP_DAYS;
  return { ...trip, days };
}

export function detectTrips(events: CalendarEvent[], opts: DetectOptions = {}): Trip[] {
  const home = (opts.homeCountry ?? "IN").toUpperCase();
  const now = (opts.now ?? new Date()).getTime();
  const horizonEnd = now + (opts.horizonDays ?? 45) * DAY_MS;
  const mergeWindow = MERGE_WINDOW_DAYS * DAY_MS;

  const legs = events
    .filter((e) => e.start.getTime() >= now && e.start.getTime() <= horizonEnd + mergeWindow)
    .map((e) => classify(e, home))
    .filter((l): l is Leg => l !== null)
    .sort((a, b) => a.event.start.getTime() - b.event.start.getTime());

  let trips: Trip[] = [];
  for (const leg of legs) {
    const start = leg.event.start;
    if (leg.kind === "back") {
      const i = trips.findIndex(
        (t) =>
          t.returns === null &&
          t.destinationCountry === leg.country &&
          start.getTime() > t.departs.getTime() &&
          start.getTime() - t.departs.getTime() <= mergeWindow,
      );
      if (i >= 0) trips = trips.map((t, j) => (j === i ? withLength({ ...t, returns: start }) : t));
      continue;
    }
    const i = trips.findIndex(
      (t) =>
        t.destinationCountry === leg.country &&
        start.getTime() >= t.departs.getTime() &&
        start.getTime() <= (t.returns ?? new Date(t.departs.getTime() + mergeWindow)).getTime(),
    );
    if (i >= 0) {
      const end = spanEnd(leg.event);
      if (trips[i].returns === null && end) trips = trips.map((t, j) => (j === i ? withLength({ ...t, returns: end }) : t));
      continue;
    }
    trips = [
      ...trips,
      withLength({
        eventUid: leg.event.uid,
        summary: leg.event.summary,
        destinationCountry: leg.country,
        destinationName: leg.name,
        departs: start,
        returns: leg.kind === "stay" ? spanEnd(leg.event) : null,
        days: DEFAULT_TRIP_DAYS,
      }),
    ];
  }
  return trips.filter((t) => t.departs.getTime() <= horizonEnd);
}

// ------------------------------------------------------------------ eSIM lookup

export interface EsimSuggestion {
  trip: Trip;
  productId: string;
  productName: string;
  packageId: string;
  packageLabel: string;
  /** exactly as Bitrefill returned it (see `priceCurrency`); not converted */
  price: number;
  priceCurrency: string;
}

/** Fields the live search/product payloads carry beyond the typed `Product`. */
interface EsimListing extends Product {
  country_code?: string;
  country_name?: string;
  categories?: string[];
  in_stock?: boolean;
}

/** Lower is better; null = not an eSIM for this destination. */
function esimRank(p: EsimListing, trip: Trip): number | null {
  const isEsim = p.id.includes("bitrefill-esim") || p.type === "esim" || p.categories?.includes("esim");
  if (!isEsim || p.in_stock === false) return null;
  const dest = trip.destinationName.toLowerCase();
  const name = `${p.name} ${p.country_name ?? ""}`.toLowerCase();
  const exact = (p.country_code ?? p.country ?? "").toUpperCase() === trip.destinationCountry;
  const base = p.id.includes("bitrefill-esim") ? 0 : 10;
  if (exact) return base;
  if (name.includes(dest)) return base + 1;
  if (p.id.includes("global")) return base + 2;
  return null;
}

function rankProducts(products: Product[], trip: Trip): EsimListing[] {
  return (products as EsimListing[])
    .map((p) => ({ p, rank: esimRank(p, trip) }))
    .filter((x): x is { p: EsimListing; rank: number } => x.rank !== null)
    .sort((a, b) => a.rank - b.rank)
    .map((x) => x.p);
}

/** Parse "3GB, 30 Days"-style labels; "Unlimited" and anything unparseable returns null. */
function parsePackageLabel(label: string): { gb: number; days: number } | null {
  const gb = /(\d+(?:\.\d+)?)\s*GB/i.exec(label);
  const days = /(\d+)\s*Days?/i.exec(label);
  return gb && days ? { gb: Number(gb[1]), days: Number(days[1]) } : null;
}

export async function suggestEsim(bitrefill: Bitrefill, trip: Trip): Promise<EsimSuggestion | null> {
  const queries: Array<() => Promise<Product[]>> = [
    () => bitrefill.search(`esim ${trip.destinationName}`, trip.destinationCountry, "esim"),
    () => bitrefill.search("esim", trip.destinationCountry),
  ];
  const tried = new Set<string>();
  for (const run of queries) {
    for (const listing of rankProducts(await run(), trip)) {
      if (tried.has(listing.id)) continue;
      tried.add(listing.id);
      const details = await bitrefill.product(listing.id);
      const best = (details.packages ?? [])
        .map((pkg) => {
          const label = String(pkg.value);
          const spec = parsePackageLabel(label);
          const price = pkg.price ?? pkg.amount;
          return spec && price !== undefined ? { pkg, label, spec, price } : null;
        })
        .filter((c): c is NonNullable<typeof c> => c !== null && c.spec.days >= trip.days && c.spec.gb >= MIN_GB)
        .sort((a, b) => a.price - b.price)[0];
      if (!best) continue;
      return {
        trip,
        productId: details.id,
        productName: details.name,
        packageId: best.pkg.id,
        packageLabel: best.label,
        price: best.price,
        priceCurrency: details.currency,
      };
    }
  }
  return null;
}

// -------------------------------------------------------------- proposals store

export type ProposalStatus = "proposed" | "approved" | "declined" | "bought";

export interface Proposal {
  id: string;
  createdAt: string;
  trip: Trip;
  suggestion: EsimSuggestion;
  status: ProposalStatus;
  invoiceId?: string;
  orderId?: string;
  /** LPA activation string if the order returned one; the dashboard renders it as a QR. Never log it. */
  lpa?: string;
}

function proposalsFile(): string {
  return path.resolve(process.env.TRAVEL_PROPOSALS_FILE ?? "data/travel-proposals.json");
}

function reviveTrip(t: Trip): Trip {
  return { ...t, departs: new Date(t.departs), returns: t.returns ? new Date(t.returns) : null };
}

export function loadProposals(): Proposal[] {
  let raw: string;
  try {
    raw = fs.readFileSync(proposalsFile(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const list = JSON.parse(raw) as Proposal[];
  return list.map((p) => {
    const trip = reviveTrip(p.trip);
    return { ...p, trip, suggestion: { ...p.suggestion, trip } };
  });
}

export function saveProposals(proposals: Proposal[]): void {
  const file = proposalsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(proposals, null, 2));
  fs.renameSync(tmp, file);
}

export async function scanAndPropose(opts: {
  calendarSource: string;
  bitrefill: Bitrefill;
  homeCountry?: string;
}): Promise<Proposal[]> {
  const trips = detectTrips(await fetchCalendar(opts.calendarSource), { homeCountry: opts.homeCountry });
  const known = new Set(loadProposals().map((p) => p.trip.eventUid));
  const added: Proposal[] = [];
  for (const trip of trips) {
    if (known.has(trip.eventUid)) continue;
    const suggestion = await suggestEsim(opts.bitrefill, trip);
    if (!suggestion) continue;
    added.push({
      id: crypto.randomUUID().slice(0, 8),
      createdAt: new Date().toISOString(),
      trip,
      suggestion,
      status: "proposed",
    });
  }
  // reload right before writing so a dashboard approval made during the scan is not lost
  if (added.length > 0) saveProposals([...loadProposals(), ...added]);
  return added;
}

function setStatus(id: string, from: ProposalStatus[], to: ProposalStatus): Proposal {
  const all = loadProposals();
  const found = all.find((p) => p.id === id);
  if (!found) throw new Error(`no proposal ${id}`);
  if (!from.includes(found.status)) throw new Error(`proposal ${id} is ${found.status}, cannot become ${to}`);
  const updated = { ...found, status: to };
  saveProposals(all.map((p) => (p.id === id ? updated : p)));
  return updated;
}

export const approve = (id: string): Proposal => setStatus(id, ["proposed"], "approved");
export const decline = (id: string): Proposal => setStatus(id, ["proposed"], "declined");

// ------------------------------------------------------------------- buying

export interface BuyResult {
  id: string;
  invoiceId?: string;
  status: ProposalStatus | "pending" | "failed" | "skipped";
}

/** eSIM orders carry the install string in redemption_info; the field name varies, so read best-effort. */
function extractLpa(order: Order): string | undefined {
  const info = (order.redemption_info ?? {}) as Record<string, unknown>;
  for (const key of ["lpa", "barcode_value", "link"]) {
    const v = info[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function patchProposal(id: string, patch: Partial<Proposal>): void {
  saveProposals(loadProposals().map((p) => (p.id === id ? { ...p, ...patch } : p)));
}

/** Buy every approved proposal. Never logs codes or LPA strings; never buys twice for one proposal. */
export async function buyApproved(bitrefill: Bitrefill, opts: { maxPrice?: number } = {}): Promise<BuyResult[]> {
  const results: BuyResult[] = [];
  for (const p of loadProposals().filter((x) => x.status === "approved")) {
    const { suggestion } = p;
    if (!p.invoiceId && opts.maxPrice !== undefined && suggestion.price > opts.maxPrice) {
      results.push({ id: p.id, status: "skipped" });
      continue;
    }
    try {
      let { invoiceId, orderId } = p;
      if (!invoiceId) {
        const invoice = await bitrefill.buy({ productId: suggestion.productId, packageId: suggestion.packageId });
        invoiceId = invoice.id;
        orderId = invoice.orders[0]?.id;
        // persist before waiting, so a crash or timeout never leads to a second purchase
        patchProposal(p.id, { invoiceId, orderId });
      } else if (!orderId) {
        orderId = (await bitrefill.invoice(invoiceId)).orders[0]?.id;
        if (orderId) patchProposal(p.id, { orderId });
      }
      if (!orderId) {
        results.push({ id: p.id, invoiceId, status: "pending" });
        continue;
      }
      const order = await bitrefill.waitDelivered(orderId);
      if (order.status === "delivered") {
        patchProposal(p.id, { status: "bought", invoiceId, orderId, lpa: extractLpa(order) });
        results.push({ id: p.id, invoiceId, status: "bought" });
      } else if (order.status === "failed" || order.status === "refunded") {
        results.push({ id: p.id, invoiceId, status: "failed" });
      } else {
        results.push({ id: p.id, invoiceId, status: "pending" });
      }
    } catch (err) {
      // message comes from Bitrefill client, which never includes redemption info
      process.stderr.write(`travel: buy ${p.id} failed: ${err instanceof Error ? err.message : String(err)}\n`);
      results.push({ id: p.id, invoiceId: loadProposals().find((x) => x.id === p.id)?.invoiceId, status: "failed" });
    }
  }
  return results;
}

// ----------------------------------------------------------------------- CLI

const out = (s: string) => process.stdout.write(`${s}\n`);
const day = (d: Date) => d.toISOString().slice(0, 10);

function describeTrip(t: Trip): string {
  return `${t.destinationName} (${t.destinationCountry}) ${day(t.departs)} -> ${t.returns ? day(t.returns) : "?"}, ~${t.days} days  [${t.summary}]`;
}

function describeProposal(p: Proposal): string {
  const s = p.suggestion;
  const extra = p.invoiceId ? ` invoice=${p.invoiceId}` : "";
  const lpa = p.lpa ? " lpa=stored" : "";
  return `${p.id}  ${p.status.padEnd(8)} ${p.trip.destinationName} ${day(p.trip.departs)}  ${s.productId} | ${s.packageLabel} | ${s.price} ${s.priceCurrency}${extra}${lpa}`;
}

async function cli(argv: string[]): Promise<void> {
  const [cmd, arg] = argv;
  if (cmd === "scan" && arg) {
    const trips = detectTrips(await fetchCalendar(arg), { homeCountry: process.env.HOME_COUNTRY });
    out(`trips detected: ${trips.length}`);
    for (const t of trips) out(`  ${describeTrip(t)}`);
    const added = await scanAndPropose({
      calendarSource: arg,
      bitrefill: new Bitrefill(process.env.BITREFILL_API_KEY ?? ""),
      homeCountry: process.env.HOME_COUNTRY,
    });
    out(`new proposals: ${added.length}`);
    for (const p of added) out(`  ${describeProposal(p)}`);
  } else if (cmd === "list") {
    const all = loadProposals();
    if (all.length === 0) out("no proposals");
    for (const p of all) out(describeProposal(p));
  } else if (cmd === "approve" && arg) {
    out(describeProposal(approve(arg)));
  } else if (cmd === "decline" && arg) {
    out(describeProposal(decline(arg)));
  } else {
    out("usage: travel.ts scan <icsUrlOrPath> | list | approve <id> | decline <id>");
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("travel.ts");
if (isMain) {
  cli(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`travel: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
