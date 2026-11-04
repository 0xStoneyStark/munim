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
  /**
   * Network path to the light-wallet server: "direct" | "tor" | "socks5://host:port".
   * "direct" (or unset) adds no flag, so the CLI line is identical to before; the
   * devtool's own default is already direct.
   */
  connection?: string;
}

const CONNECTION_RE = /^(direct|tor|socks5:\/\/[^\s/]+:\d+)$/;

/** `--connection X` for commands that talk to the server; empty for direct/unset. */
export function connectionArgs(connection?: string): string[] {
  if (!connection || connection === "direct") return [];
  if (!CONNECTION_RE.test(connection)) {
    throw new Error(`invalid PURSE_CONNECTION "${connection}" (use direct, tor, or socks5://host:port)`);
  }
  return ["--connection", connection];
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

  /** sync scans compact blocks (no memos); enhance fetches full tx data so memos decrypt */
  async sync(): Promise<void> {
    await this.run(["sync", "-s", this.cfg.server ?? "zecrocks", ...connectionArgs(this.cfg.connection)], 600_000);
    await this.run(["enhance", "-s", this.cfg.server ?? "zecrocks", ...connectionArgs(this.cfg.connection)], 600_000);
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
      ...connectionArgs(this.cfg.connection),
    ];
    if (memo) args.push("--memo", memo);
    const out = await this.run(args, 600_000);
    // the proposal lists input notes (txid:index) first; the sent txid is the last bare 64-hex line
    const all = [...out.matchAll(/^\s*([0-9a-f]{64})\s*$/gm)];
    if (all.length === 0) throw new Error("send produced no txid: " + out);
    return all[all.length - 1][1];
  }
}

/**
 * `list-tx` text output (zcash-devtool, Nov 2026) looks like:
 *
 *   <txid>
 *        Mined: 4581732 (2026-11-04 10:25:04.0 +00:00:00)
 *       Amount:   1.00000000 TAZ
 *     Fee paid: Unknown
 *     Sent 0 notes, received 1 notes, 0 memos
 *     Output 0 (Ironwood)
 *       Value:   1.00000000 TAZ
 *       Received by account: <uuid> (name)
 *       To: utest1...
 *       Memo (text): fund cap=100 INR reply=utest1...
 *
 * A bare 64-hex line starts a transaction; `Amount` is the net effect on the
 * wallet (negative when sent); per-output `Value` lines are ignored.
 */
export function parseListTx(text: string): TxOutput[] {
  const txs: TxOutput[] = [];
  let cur: TxOutput | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const txid = line.match(/^([0-9a-f]{64})$/);
    if (txid) {
      if (cur) txs.push(cur);
      cur = { txid: txid[1], minedHeight: null, value: 0, memo: null, address: null, direction: "in" };
      continue;
    }
    if (!cur) continue;
    const mined = line.match(/^Mined:\s*([0-9]+)/);
    if (mined) cur.minedHeight = parseInt(mined[1], 10);
    const amount = line.match(/^Amount:\s*(-?[0-9]+\.[0-9]+)\s*TAZ/);
    if (amount) {
      cur.value = Math.round(parseFloat(amount[1]) * ZAT_PER_ZEC);
      cur.direction = cur.value < 0 ? "out" : "in";
    }
    // `Amount` is unsigned for sends, so the note counts decide direction
    const sentRecv = line.match(/^Sent ([0-9]+) notes?, received ([0-9]+) notes?/);
    if (sentRecv && parseInt(sentRecv[1], 10) > 0) cur.direction = "out";
    // after `enhance`: `Memo: Memo::Text("fund cap=100 INR ...")`
    const memo = line.match(/^Memo(?: \(text\))?:\s*(?:Memo::Text\()?"?(.*?)"?\)?\s*$/);
    if (memo && memo[1].trim() && !/^Memo::Empty/.test(memo[1])) cur.memo = memo[1].trim();
    const to = line.match(/^To:\s*(utest1[0-9a-z]+|u1[0-9a-z]+)/);
    if (to) cur.address = to[1];
  }
  if (cur) txs.push(cur);
  return txs;
}
