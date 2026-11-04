import "dotenv/config";
import path from "node:path";
import type { PurseConfig } from "./index.js";

export function purseConfigFromEnv(): PurseConfig {
  const binary = process.env.ZCASH_DEVTOOL;
  if (!binary) throw new Error("ZCASH_DEVTOOL is not set (path to the zcash-devtool binary)");
  return {
    binary,
    walletDir: process.env.PURSE_WALLET_DIR ?? "./wallets/agent",
    identity: process.env.PURSE_IDENTITY ?? "./wallets/agent-identity.txt",
    server: "zecrocks",
    connection: process.env.PURSE_CONNECTION || "direct",
    ledgerFile: path.resolve(process.env.PURSE_LEDGER ?? "./data/ledger.json"),
  };
}
