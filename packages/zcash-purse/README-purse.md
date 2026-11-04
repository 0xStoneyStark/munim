# zcash-purse

A spending-capped, shielded Zcash purse for AI agents (testnet TAZ). A funder sends TAZ to
the purse with a cap in the memo. The agent can spend only up to that cap: it buys things,
sends receipts back to the funder and pays other agents. Each payment is a shielded
transaction with a memo that is encrypted to the recipient. The cap is in INR, and the
purse knows no other budget.

## Memo grammar

One line per memo. Every field is `key=value`.

| Direction | Memo | Meaning |
|---|---|---|
| funder → purse | `fund cap=100 INR reply=utest1…` | adds ₹100 to the cap; receipts go to `reply` |
| funder → purse | `fuel for receipt fees` (no `cap=`) | plain balance, cap unchanged |
| purse → funder | `munim receipt inv=… item=… inr=… cost=… rule=… [code_sha256=…]` | proof of a purchase (a hash of the code, never the code) |
| purse → anyone | `munim pay purpose=<purpose> inr=<value_inr> <memo>` | agent-to-agent payment, max 512 UTF-8 bytes |

## MCP tools

| Tool | Moves funds | What it does |
|---|---|---|
| `purse_address` | no | the purse's shielded unified address |
| `purse_refresh` | no | syncs the chain, adds new deposits, returns balance and budget |
| `purse_budget` / `purse_ledger` | no | the cap, the amount spent, the amount left, and the spend log (code hashes left out) |
| `purse_check` | no | says if a given INR value fits in the cap that is left |
| `purse_record_spend` | no | reserves budget for a purchase (refused if it goes over the cap) |
| `purse_send_receipt` | dust | sends the receipt memo for a recorded spend to the funder |
| `purse_pay` | **yes** | pays `to` with `zatoshis` (≥ 10000) and `memo`, and records `value_inr` against the cap |

`purse_pay` accepts only shielded addresses (`utest1…`, `u1…`, `ztestsapling1…`). It refuses
transparent `t…`/`tm…`/`tex…` addresses, because a payment to one shows the amount, the memo
and the payer link on-chain. `value_inr` is the caller's own statement of what the payment
is worth, and the purse records it as given. If a send fails, the purse marks the spend
`failed` and does not count it against the cap.

CLI equivalent: `npm run purse -- pay <to> <zatoshis> <value_inr> "<purpose>" ["memo"]`.

## Add it to an agent

The server uses stdio. Run it from the repo root, because `.env`, `wallets/` and
`data/ledger.json` are resolved relative to the working directory.

```
command: npx tsx packages/zcash-purse/src/mcp.ts      (cwd = D:\free-society-hack)
```

- **Claude Code**: in the repo, run `claude mcp add zcash-purse -- npx tsx packages/zcash-purse/src/mcp.ts`.
- **Claude Desktop**: in `claude_desktop_config.json`, under `mcpServers`, add
  `"zcash-purse": { "command": "cmd", "args": ["/c", "cd /d D:\\free-society-hack && npx tsx packages/zcash-purse/src/mcp.ts"] }`
  (on macOS/Linux, use `sh -c "cd /path/to/repo && npx tsx …"`).
- **Cursor**: in `.cursor/mcp.json` in the repo, add
  `"zcash-purse": { "command": "npx", "args": ["tsx", "packages/zcash-purse/src/mcp.ts"] }`.
  If Cursor does not start the server in the workspace folder, use the same `cd` wrapper as for Desktop.

## Trust model

1. The operator holds the purse spend key (`PURSE_IDENTITY`). The agent uses the purse only through these tools.
2. The software enforces the cap. `check`/`reserve` refuse a spend that goes over it, and no tool can raise it.
3. Funding is the hard limit: the purse cannot spend more TAZ than funders sent it, whatever the cap says.
4. The INR value of a payment is what the agent declares. The ledger records that declaration, and the funder can audit it.
5. Memos are encrypted end-to-end to each recipient. A viewing key lets the funder audit the purse without the spend key.

## Example: one agent pays another

```
user      > Ask the research agent for the Q3 GPU price brief and pay its fee.
research  < Fee is 0.0001 TAZ, worth ₹1. Pay utest1qx…9k with memo "job=gpu-q3".
munim     → purse_check { value_inr: 1 }                  → ok, ₹39 left after
munim     → purse_pay { to: "utest1qx…9k", zatoshis: 10000, value_inr: 1,
                        purpose: "research-agent fee", memo: "job=gpu-q3" }
purse     ← { txid: "e03a2b3c…7dee22", spend_id: "667e3df9…", remaining_inr: 39 }
research  ← decrypts memo "munim pay purpose=research-agent fee inr=1 job=gpu-q3"
research  < Payment seen for job=gpu-q3. Here is the brief: …
munim     → purse_ledger {}                                → spend status "sent", ₹61 of ₹100 used
munim     > Paid ₹1 (0.0001 TAZ) for the brief; ₹39 of the cap left.
```
