// `npm run purse -- <cmd>`: address | refresh | budget | check <inr> | pay <to> <zatoshis> <value_inr> "<purpose>" ["memo"]
import { Purse, budget, zatToZec } from "./index.js";
import { purseConfigFromEnv } from "./config.js";

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const purse = new Purse(purseConfigFromEnv());
  switch (cmd) {
    case "address":
      process.stdout.write((await purse.address()) + "\n");
      break;
    case "refresh": {
      const { newDeposits, ledger } = await purse.refresh();
      const bal = await purse.balance();
      process.stdout.write(
        JSON.stringify({ newDeposits, balanceTaz: zatToZec(bal.spendable), pendingTaz: zatToZec(bal.pending), budget: budget(ledger), deposits: ledger.deposits }, null, 2) + "\n",
      );
      break;
    }
    case "budget":
      process.stdout.write(JSON.stringify(budget(await purse.state()), null, 2) + "\n");
      break;
    case "check":
      process.stdout.write(JSON.stringify(await purse.check(parseFloat(rest[0] ?? "0")), null, 2) + "\n");
      break;
    case "pay": {
      const [to, zat, inr, purpose, memo] = rest;
      if (!to || !zat || !inr || !purpose) throw new Error('usage: purse pay <to> <zatoshis> <value_inr> "<purpose>" ["memo"]');
      const { txid, spend } = await purse.pay({ to, zatoshis: Number(zat), valueInr: Number(inr), purpose, memo: memo ?? "" });
      process.stdout.write(JSON.stringify({ txid, spendId: spend.id, budget: budget(await purse.state()) }, null, 2) + "\n");
      break;
    }
    default:
      process.stderr.write('usage: purse address | refresh | budget | check <inr> | pay <to> <zatoshis> <value_inr> "<purpose>" ["memo"]\n');
      process.exit(1);
  }
}

main().catch((e) => {
  process.stderr.write(String(e?.stack ?? e) + "\n");
  process.exit(1);
});
