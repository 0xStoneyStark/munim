// Thin wrapper over the zcash-devtool CLI (https://github.com/zcash/zcash-devtool).
// Everything the purse does on-chain goes through here: sync, balance, list
// transactions (with memos), send with a memo. Testnet only (NU7, zec.rocks).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileP = promisify(execFile);

export interface DevtoolConfig {
  binary: string;
  walletDir: string;
  identity?: string; // age identity file; only needed to send
  server?: string;
}

export interface TxOutput {
  txid: string;
  minedHeight: number | null;
  /** zatoshis, positive = received, negative = sent */
  value: number;
  memo: string | null;
  address: string | null;
  direction: "in" | "out";
}

const ZAT_PER_ZEC = 100_000_000;

export function zatToZec(zat: number): string {
  return (zat / ZAT_PER_ZEC).toFixed(8);
}

export class Devtool {
  constructor(private cfg: DevtoolConfig) {}

  private async run(args: string[], timeoutMs = 180_000): Promise<string> {
    const { stdout, stderr } = await execFileP(
      this.cfg.binary,
      ["wallet", "-w", path.resolve(this.cfg.walletDir), ...args],
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, RUST_LOG: "warn" } },
    );
    // devtool logs INFO lines to stderr; the useful output is stdout
    return (stdout || "") + (stderr && !stdout ? stderr : "");
  }

  async sync(): Promise<void> {
    await this.run(["sync", "-s", this.cfg.server ?? "zecrocks"], 600_000);
  }

  async address(): Promise<string> {
    const out = await this.run(["list-addresses"]);
    const m = out.match(/Default Address:\s*(utest1[0-9a-z]+|u1[0-9a-z]+)/);
    if (!m) throw new Error("could not find default address in: " + out);
    return m[1];
  }

  /** spendable shielded balance in zatoshis */
  async balance(): Promise<{ spendable: number; pending: number }> {
    const out = await this.run(["balance"]);
    const pick = (label: string) => {
      const m = out.match(new RegExp(label + "\\s+Spendable:\\s+([0-9.]+) TAZ"));
      return m ? Math.round(parseFloat(m[1]) * ZAT_PER_ZEC) : 0;
    };
    const spendable = pick("Sapling") + pick("Orchard") + pick("Ironwood");
    const total = (() => {
      const m = out.match(/Balance:\s+([0-9.]+) TAZ/);
      return m ? Math.round(parseFloat(m[1]) * ZAT_PER_ZEC) : spendable;
    })();
    return { spendable, pending: Math.max(0, total - spendable) };
  }

  /** Parse `list-tx` text output into outputs with memos. */
  async listTx(): Promise<TxOutput[]> {
    const out = await this.run(["list-tx"]);
    return parseListTx(out);
  }

  async send(address: string, zatoshis: number, memo?: string): Promise<string> {
    if (!this.cfg.identity) throw new Error("send requires an identity file (spend key)");
    const args = [
      "send",
      "-i", path.resolve(this.cfg.identity),
      "--address", address,
      "--value", String(zatoshis),
      "-s", this.cfg.server ?? "zecrocks",
    ];
    if (memo) args.push("--memo", memo);
    const out = await this.run(args, 600_000);
    const m = out.match(/([0-9a-f]{64})/);
    if (!m) throw new Error("send produced no txid: " + out);
    return m[1];
  }
}

/**
 * `list-tx` prints a block per transaction. We don't rely on an exact layout:
 * we scan for a txid, then collect value / memo / height / address lines that
 * follow it until the next txid. Adjusted against real NU7 testnet output.
 */
export function parseListTx(text: string): TxOutput[] {
  const txs: TxOutput[] = [];
  let cur: TxOutput | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const txid = line.match(/\b([0-9a-f]{64})\b/);
    if (txid && !/memo/i.test(line)) {
      if (cur) txs.push(cur);
      cur = { txid: txid[1], minedHeight: null, value: 0, memo: null, address: null, direction: "in" };
      continue;
    }
    if (!cur) continue;
    const height = line.match(/(?:height|mined)[^0-9]*([0-9]{6,})/i);
    if (height) cur.minedHeight = parseInt(height[1], 10);
    const value = line.match(/(?:value|amount)[^-0-9]*(-?[0-9]+)\s*(?:zat)?/i) ?? line.match(/(-?[0-9]+\.[0-9]{8})\s*TAZ/);
    if (value) {
      const v = value[1].includes(".") ? Math.round(parseFloat(value[1]) * ZAT_PER_ZEC) : parseInt(value[1], 10);
      if (v !== 0) {
        cur.value += v;
        cur.direction = cur.value < 0 ? "out" : "in";
      }
    }
    const memo = line.match(/memo[^:]*:\s*(.*)$/i);
    if (memo && memo[1] && !/^(none|empty|<empty>|\(none\))$/i.test(memo[1].trim())) {
      cur.memo = memo[1].trim().replace(/^["']|["']$/g, "");
    }
    const addr = line.match(/\b(utest1[0-9a-z]{20,}|u1[0-9a-z]{20,})\b/);
    if (addr) cur.address = addr[1];
  }
  if (cur) txs.push(cur);
  return txs;
}
