// zcash-purse: a spending-capped shielded purse for an AI agent.
//
// The funder authorises a budget by sending shielded TAZ to the purse with a
// memo like `fund cap=100 INR reply=utest1...`. The purse records the cap,
// refuses any spend that would exceed what's left, and sends a receipt back to
// the funder as an encrypted memo after each purchase.

import crypto from "node:crypto";
import { Devtool, type DevtoolConfig, type TxOutput, zatToZec } from "./devtool.js";
import {
  LedgerStore,
  type Ledger,
  type Spend,
  budget,
  parseFundMemo,
  withDeposit,
  withSpend,
} from "./ledger.js";

export { zatToZec, parseFundMemo, budget };
export type { Ledger, Spend, TxOutput, DevtoolConfig };

export interface PurseConfig extends DevtoolConfig {
  ledgerFile: string;
}

/** dust value carried by a receipt tx: 0.0001 TAZ */
export const RECEIPT_ZATOSHIS = 10_000;

export class Purse {
  private devtool: Devtool;
  private store: LedgerStore;
  private ledger: Ledger | null = null;

  constructor(private cfg: PurseConfig) {
    this.devtool = new Devtool(cfg);
    this.store = new LedgerStore(cfg.ledgerFile);
  }

  async address(): Promise<string> {
    return this.devtool.address();
  }

  async state(): Promise<Ledger> {
    if (!this.ledger) this.ledger = this.store.load(await this.address());
    return this.ledger;
  }

  /** Sync the chain and fold any new incoming shielded payments into deposits. */
  async refresh(): Promise<{ newDeposits: number; ledger: Ledger }> {
    await this.devtool.sync();
    const txs = await this.devtool.listTx();
    let ledger = await this.state();
    let added = 0;
    for (const tx of txs) {
      if (tx.direction !== "in" || tx.value <= 0) continue;
      const known = ledger.deposits.find((d) => d.txid === tx.txid);
      const { capInr, replyTo } = parseFundMemo(tx.memo);
      if (known) {
        // memo can arrive after the first sighting (sync sees the note, enhance decrypts the memo)
        if (!known.memo && tx.memo) {
          ledger = { ...ledger, deposits: ledger.deposits.map((d) => (d.txid === tx.txid ? { ...d, memo: tx.memo, capInr, replyTo } : d)) };
        }
        continue;
      }
      ledger = withDeposit(ledger, {
        txid: tx.txid,
        zatoshis: tx.value,
        memo: tx.memo,
        capInr,
        replyTo,
        seenAt: new Date().toISOString(),
      });
      added++;
    }
    this.ledger = ledger;
    this.store.save(ledger);
    return { newDeposits: added, ledger };
  }

  async balance() {
    return this.devtool.balance();
  }

  /** The cap check. Pure: returns a decision, never spends. */
  async check(valueInr: number): Promise<{ ok: boolean; reason: string; remainingInr: number }> {
    const b = budget(await this.state());
    if (b.capInr === 0) return { ok: false, reason: "no funded cap: nobody has authorised a budget yet", remainingInr: 0 };
    if (valueInr > b.remainingInr) {
      return { ok: false, reason: `₹${valueInr} exceeds remaining cap ₹${b.remainingInr}`, remainingInr: b.remainingInr };
    }
    return { ok: true, reason: `₹${valueInr} within remaining cap ₹${b.remainingInr}`, remainingInr: b.remainingInr - valueInr };
  }

  /** Reserve budget for a purchase. Throws if over cap. */
  async reserve(spend: Omit<Spend, "id" | "at" | "receiptTxid" | "codeHash" | "status"> & { status?: string }): Promise<Spend> {
    const verdict = await this.check(spend.valueInr);
    if (!verdict.ok) throw new Error("cap refused: " + verdict.reason);
    const full: Spend = {
      ...spend,
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      status: spend.status ?? "reserved",
      receiptTxid: null,
      codeHash: null,
    };
    this.ledger = withSpend(await this.state(), full);
    this.store.save(this.ledger);
    return full;
  }

  async update(spend: Spend): Promise<void> {
    this.ledger = withSpend(await this.state(), spend);
    this.store.save(this.ledger);
  }

  /** Who funded us most recently with a reply address, if anyone. */
  async replyAddress(): Promise<string | null> {
    const l = await this.state();
    const withReply = [...l.deposits].reverse().find((d) => d.replyTo);
    return withReply?.replyTo ?? null;
  }

  /**
   * Send the receipt for a spend back to the funder as an encrypted memo.
   * The memo carries the invoice id, product, value and a hash of the code —
   * never the code itself — so the funder can verify against Bitrefill.
   */
  async sendReceipt(spend: Spend, to: string): Promise<string> {
    const memo = receiptMemo(spend);
    const txid = await this.devtool.send(to, RECEIPT_ZATOSHIS, memo);
    await this.update({ ...spend, receiptTxid: txid });
    return txid;
  }
}

export function receiptMemo(s: Spend): string {
  // ZIP 302 memos are 512 bytes; keep it short and greppable
  const parts = [
    `munim receipt`,
    `inv=${s.invoiceId}`,
    `item=${s.productName.slice(0, 40)}`,
    `inr=${s.valueInr}`,
    `cost=${s.cost} ${s.costCurrency}`,
    `rule=${s.ruleId}`,
  ];
  if (s.codeHash) parts.push(`code_sha256=${s.codeHash.slice(0, 16)}`);
  return parts.join(" ");
}

export function hashCode(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}
