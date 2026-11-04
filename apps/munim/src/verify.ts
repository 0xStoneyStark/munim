// Receipt verifier: takes the decrypted memo the funder got in their wallet and
// checks it against Bitrefill (invoice + order) and the local ledger. The
// redemption code is hashed in-process and never leaves this module.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type http from "node:http";
import { z } from "zod";
import type { Ledger } from "@munim/zcash-purse";
import type { Bitrefill, Invoice, Order } from "./bitrefill.js";
import { EXPLORER } from "./api-views.js";

export interface ParsedReceipt {
  invoiceId: string;
  item: string;
  inr: number;
  cost: number;
  costCurrency: string;
  ruleId: string;
  codeSha256Prefix: string | null;
}

export interface VerifyCheck {
  name: string;
  ok: boolean;
  /** starts with "n/a" when the check does not apply to this receipt */
  detail: string;
}

export interface VerifyResult {
  ok: boolean;
  checks: VerifyCheck[];
  invoice?: {
    id: string;
    status: string;
    created_time?: string;
    orders: Array<{ id: string; status: string; product: string }>;
  };
  /** present when the local ledger knows this invoice */
  ledger?: { status: string; receiptTxid: string | null; receiptTxidShort: string | null; explorer: string | null };
}

type BitrefillReader = Pick<Bitrefill, "invoice" | "order">;

const MAX_MEMO_CHARS = 2000;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_ORDERS = 5;
const ITEM_MATCH_CHARS = 20;
const TXID_HEAD = 8;
const TXID_TAIL = 6;
const HTML_FILE = fileURLToPath(new URL("./verify.html", import.meta.url));

const MEMO_RE =
  /^munim\s+receipt\s+inv=([A-Za-z0-9_-]{1,64})\s+item=(.+?)\s+inr=(\d+(?:\.\d+)?)\s+cost=(\d+(?:\.\d+)?)\s+(\S+)\s+rule=(\S+)(?:\s+code_sha256=([0-9a-fA-F]{4,64}))?$/;

/** Parse the exact format produced by receiptMemo(); null when it is not a Munim receipt. */
export function parseReceiptMemo(memo: string): ParsedReceipt | null {
  // wallets pad memos with NULs; collapse whitespace so extra spaces and newlines are harmless
  const clean = memo.replace(/\0+$/g, "").replace(/\s+/g, " ").trim();
  if (clean.length > MAX_MEMO_CHARS) return null;
  const m = MEMO_RE.exec(clean);
  if (!m) return null;
  return {
    invoiceId: m[1],
    item: m[2].trim(),
    inr: Number(m[3]),
    cost: Number(m[4]),
    costCurrency: m[5],
    ruleId: m[6],
    codeSha256Prefix: m[7] ? m[7].toLowerCase() : null,
  };
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const shortTx = (t: string): string => `${t.slice(0, TXID_HEAD)}…${t.slice(-TXID_TAIL)}`;

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function readLedger(dataDir: string): { ledger?: Ledger; error?: string } {
  const file = path.join(dataDir, "ledger.json");
  if (!fs.existsSync(file)) return {};
  try {
    return { ledger: JSON.parse(fs.readFileSync(file, "utf8")) as Ledger };
  } catch (e) {
    return { error: errMsg(e) };
  }
}

function checkFaceValue(order: Order, inr: number): VerifyCheck {
  const name = "Face value matches";
  const v = order.product.value;
  const numeric = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(numeric)) return { name, ok: true, detail: `n/a: product value is "${String(v)}", not a rupee amount` };
  return numeric === inr
    ? { name, ok: true, detail: `Bitrefill says ${numeric}, memo says ${inr}` }
    : { name, ok: false, detail: `Bitrefill says ${numeric}, memo says ${inr}` };
}

function checkCodeHash(order: Order, prefix: string | null): VerifyCheck {
  const name = "Code hash matches";
  const code = order.redemption_info?.code;
  if (!code) {
    return prefix
      ? { name, ok: true, detail: "n/a: Bitrefill no longer returns a code for this order, so the hash cannot be recomputed" }
      : { name, ok: true, detail: "n/a: this product has no redemption code (a direct top-up)" };
  }
  if (!prefix) return { name, ok: true, detail: "n/a: the memo carries no code hash" };
  const hash = sha256Hex(code);
  return hash.startsWith(prefix)
    ? { name, ok: true, detail: `sha256 of the delivered code starts with ${prefix}` }
    : { name, ok: false, detail: `sha256 of the delivered code does not start with ${prefix}` };
}

function checkLedger(dataDir: string, invoiceId: string): { check: VerifyCheck; ledger?: VerifyResult["ledger"] } {
  const name = "Ledger cross-check";
  const { ledger, error } = readLedger(dataDir);
  if (error) return { check: { name, ok: false, detail: `ledger unreadable: ${error}` } };
  const spend = ledger?.spends.find((s) => s.invoiceId === invoiceId);
  if (!spend) return { check: { name, ok: true, detail: "n/a: this invoice is not in the local ledger" } };
  const tx = spend.receiptTxid;
  return {
    check: { name, ok: true, detail: `ledger status ${spend.status}; receipt tx ${tx ? shortTx(tx) : "not recorded"}` },
    ledger: { status: spend.status, receiptTxid: tx, receiptTxidShort: tx ? shortTx(tx) : null, explorer: tx ? EXPLORER + tx : null },
  };
}

export async function verifyReceipt(
  bitrefill: BitrefillReader,
  memo: string,
  opts: { dataDir?: string } = {},
): Promise<VerifyResult> {
  const dataDir = opts.dataDir ?? path.resolve("data");
  const parsed = parseReceiptMemo(memo);
  if (!parsed) {
    return { ok: false, checks: [{ name: "Memo parses", ok: false, detail: "not a Munim receipt memo (expected: munim receipt inv=… item=… inr=… cost=… rule=…)" }] };
  }
  const checks: VerifyCheck[] = [
    { name: "Memo parses", ok: true, detail: `invoice ${parsed.invoiceId}, ${parsed.item}, INR ${parsed.inr}, rule ${parsed.ruleId}` },
  ];

  let invoice: Invoice & { created_time?: string };
  try {
    invoice = await bitrefill.invoice(parsed.invoiceId);
  } catch (e) {
    checks.push({ name: "Invoice exists on Bitrefill", ok: false, detail: errMsg(e) });
    return { ok: false, checks };
  }

  let orders: Order[];
  try {
    orders = await Promise.all(invoice.orders.slice(0, MAX_ORDERS).map((o) => bitrefill.order(o.id)));
  } catch (e) {
    checks.push({ name: "Invoice exists on Bitrefill", ok: false, detail: `invoice found but its order could not be read: ${errMsg(e)}` });
    return { ok: false, checks };
  }
  const summary: VerifyResult["invoice"] = {
    id: invoice.id,
    status: invoice.status,
    created_time: invoice.created_time,
    orders: orders.map((o) => ({ id: o.id, status: o.status, product: o.product.name })),
  };

  const first = orders[0];
  if (!first) {
    checks.push({ name: "Invoice exists on Bitrefill", ok: false, detail: "invoice has no orders" });
    return { ok: false, checks, invoice: summary };
  }
  const needle = parsed.item.slice(0, ITEM_MATCH_CHARS).toLowerCase();
  const itemOk = first.product.name.toLowerCase().includes(needle);
  checks.push({
    name: "Invoice exists on Bitrefill",
    ok: itemOk,
    detail: itemOk ? `order product is "${first.product.name}"` : `order product is "${first.product.name}", memo says "${parsed.item}"`,
  });
  checks.push({
    name: "Order delivered",
    ok: first.status === "delivered",
    detail: `order status is ${first.status}`,
  });
  checks.push(checkFaceValue(first, parsed.inr));
  checks.push(checkCodeHash(first, parsed.codeSha256Prefix));
  const { check, ledger } = checkLedger(dataDir, parsed.invoiceId);
  checks.push(check);

  return { ok: checks.every((c) => c.ok), checks, invoice: summary, ledger };
}

// ------------------------------------------------------------------------ HTTP

const postBody = z.object({ memo: z.string().min(1, "memo is required").max(MAX_MEMO_CHARS) });

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
}

async function readMemoFromBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("body is not valid JSON");
  }
  const parsed = postBody.safeParse(json);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join("; "));
  return parsed.data.memo;
}

/** Serves GET /verify (page), POST /api/verify {memo} and GET /api/verify?memo=. Returns true when it handled the request. */
export async function handleVerify(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  deps: { bitrefill: BitrefillReader; dataDir?: string },
): Promise<boolean> {
  if (url.pathname === "/verify") {
    if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" }), true;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(fs.readFileSync(HTML_FILE, "utf8"));
    return true;
  }
  if (url.pathname !== "/api/verify") return false;
  try {
    let memo: string;
    if (req.method === "POST") memo = await readMemoFromBody(req);
    else if (req.method === "GET") memo = url.searchParams.get("memo") ?? "";
    else return sendJson(res, 405, { error: "method not allowed" }), true;
    if (!memo.trim()) return sendJson(res, 400, { error: "memo is required" }), true;
    sendJson(res, 200, await verifyReceipt(deps.bitrefill, memo, { dataDir: deps.dataDir }));
  } catch (e) {
    sendJson(res, 400, { error: errMsg(e) });
  }
  return true;
}
