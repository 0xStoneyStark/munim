// The purse ledger: what was deposited (with the cap the funder authorised in
// the memo), what the agent spent, and the receipts it sent back. Plain JSON on
// disk so the dashboard and the view-only export can read it without the
// spend key.

import fs from "node:fs";
import path from "node:path";

export interface Deposit {
  txid: string;
  zatoshis: number;
  memo: string | null;
  /** cap parsed from memo, in INR; null = memo carried no cap, deposit counts as plain balance */
  capInr: number | null;
  /** address the receipt goes back to, if the memo named one */
  replyTo: string | null;
  seenAt: string;
}

export interface Spend {
  id: string;
  at: string;
  ruleId: string;
  productId: string;
  productName: string;
  valueInr: number;
  /** what the operator paid, as Bitrefill reports `price` for the primary balance currency (0.13 for USD, satoshis for BTC) */
  cost: number;
  costCurrency: string;
  invoiceId: string;
  orderId: string | null;
  status: string;
  /** receipt tx sent back to the funder, if any */
  receiptTxid: string | null;
  /** sha256 of the redemption code, never the code itself */
  codeHash: string | null;
}

export interface Ledger {
  address: string;
  deposits: Deposit[];
  spends: Spend[];
}

/** memo grammar, one line, e.g. "fund cap=100 INR reply=utest1...". A negative cap (cap=-100) lowers the authorisation: the funder taking budget back. */
export function parseFundMemo(memo: string | null): { capInr: number | null; replyTo: string | null } {
  if (!memo) return { capInr: null, replyTo: null };
  const cap = memo.match(/cap\s*=\s*(-?[0-9]+(?:\.[0-9]+)?)/i);
  const reply = memo.match(/reply\s*=\s*(utest1[0-9a-z]+|u1[0-9a-z]+)/i);
  return {
    capInr: cap ? parseFloat(cap[1]) : null,
    replyTo: reply ? reply[1] : null,
  };
}

export class LedgerStore {
  constructor(private file: string) {}

  load(address: string): Ledger {
    if (!fs.existsSync(this.file)) return { address, deposits: [], spends: [] };
    const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Ledger;
    return { ...raw, address };
  }

  save(ledger: Ledger): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(ledger, null, 2));
  }
}

/** Budget = sum of caps authorised by funders, minus what the agent has spent. */
export function budget(ledger: Ledger): { capInr: number; spentInr: number; remainingInr: number } {
  const capInr = Math.max(0, ledger.deposits.reduce((s, d) => s + (d.capInr ?? 0), 0));
  const spentInr = ledger.spends
    .filter((s) => s.status !== "failed" && s.status !== "refunded")
    .reduce((s, x) => s + x.valueInr, 0);
  return { capInr, spentInr, remainingInr: Math.max(0, capInr - spentInr) };
}

export function withDeposit(ledger: Ledger, d: Deposit): Ledger {
  if (ledger.deposits.some((x) => x.txid === d.txid)) return ledger;
  return { ...ledger, deposits: [...ledger.deposits, d] };
}

export function withSpend(ledger: Ledger, s: Spend): Ledger {
  const i = ledger.spends.findIndex((x) => x.id === s.id);
  const spends = i >= 0 ? ledger.spends.map((x) => (x.id === s.id ? s : x)) : [...ledger.spends, s];
  return { ...ledger, spends };
}
