# Munim — a spending-capped shopping agent you fund privately in shielded ZEC

**One line:** a household funds an AI agent's purse with shielded Zcash and a cap in the memo; the agent buys real Indian top-ups and gift cards through Bitrefill when a rule fires, and every receipt lands back in the funder's wallet as an encrypted memo.

Built at the Free Society Hackathon, Mumbai, 4 Nov 2026. Entered in **both** tracks: Privacy (Zcash) and Agentic Commerce (Bitrefill). Team: one human (0xStoneyStark) + Claude.

> *Munim* (मुनीम) is the family accountant in an Indian trading house: trusted with a purse, never with the vault.

## What it does, in one loop

```
funder ──shielded TAZ + memo "fund cap=100 INR reply=utest1…"──▶ purse (agent wallet, viewing key watches)
                                                                    │
rule fires (schedule / signal) ──▶ Sonnet 5.5 agent ──search/price──▶ Bitrefill (real invoice, real delivery)
                                        │  purse.check / purse.reserve  (cap enforced before paying)
                                        ▼
funder ◀──shielded dust tx, memo "munim receipt inv=… item=… inr=… code_sha256=…"──── purse
```

- **Private payment rails:** the agent's budget is authorised and its receipts delivered entirely inside encrypted memos.
- **Agent wallet with a spending cap:** `zcash-purse` refuses any spend over what funders authorised. The model cannot raise its own cap.
- **Privacy beyond the transaction:** the dashboard and the accountant's CSV export run from a **view-only** wallet (viewing key, no spend key).
- **No prompt required:** purchases start from a schedule or a signal, not from a person typing "buy".

## Beyond the core loop

| Piece | What it does | Where |
|---|---|---|
| **Close the loop on Swiggy** | A delivered Swiggy Money card is redeemed into the funder's Swiggy balance by the agent (private claim endpoint, user's own session), then spent on **Instamart through Swiggy's official MCP** (`/im`) with `paymentMethod: SwiggyPay` — no UPI, no human tap | `swiggy-money.ts`, `swiggy-mcp.ts`, `instamart.ts`, `mcp-bridge.ts` |
| **Two Bitrefill surfaces** | Catalog discovery through Bitrefill's official MCP (`search-products`, `get-product-details`), money path through REST behind the cap | `bitrefill-mcp.ts`, `agent.ts` |
| **Calendar → eSIM** | Reads Google Calendar + Gmail booking emails (community MCP servers over stdio) or any ICS feed, detects international trips, proposes the right Bitrefill eSIM for the destination and trip length; approve on the dashboard or Telegram; after purchase the LPA activation renders as a **QR** (encoder written in-page, verified against `qrcode`/`jsqr`) | `travel.ts`, `google-mcp.ts`, `dashboard.html` |
| **Plain-language rules** | Type a sentence → structured rule + readback + warnings → confirm → saved | `rule-builder.ts`, `/rules/propose` |
| **Shop from chat** | Telegram bot: `/status`, `/fire`, `/approve`, sentences become rules with Confirm/Edit/Discard buttons, push alerts for proposals and purchases | `telegram.ts` |
| **Verifiable receipt** | Paste a decrypted receipt memo → checks the Bitrefill invoice, delivery, face value, code-hash and the ledger's receipt txid | `/verify`, `verify.ts` |
| **Agent-to-agent payment** | `purse_pay` on the purse MCP: shielded ZEC + encrypted memo to another agent, inside the cap, transparent addresses refused | `packages/zcash-purse` ([README](packages/zcash-purse/README-purse.md)) |
| **Household funders** | Every funder (by `reply=` address) gets a cap, FIFO allocation of spends, and their own receipts | `api-views.ts` |
| **Network privacy** | `PURSE_CONNECTION=tor` routes light-wallet traffic through devtool's built-in Tor client (tested) | `packages/zcash-purse/src/devtool.ts` |
| **Noir Wallet** | "Fund with Noir Wallet" on the dashboard uses the Noir SDK (`sendTransaction` with the cap memo) against the testnet extension build | `dashboard.html`, `noir-sdk.bundle.js` |

## Which track gets what

| | Privacy (Zcash) | Agentic Commerce (Bitrefill) |
|---|---|---|
| Piece | `packages/zcash-purse` — capped shielded purse, memo grammar, receipt memos, view-only export, **MCP server** | `apps/munim` — rules, Sonnet 5.5 agent, Bitrefill REST client, dashboard |
| Lane | Private payment rails + Privacy beyond the transaction | Rails and guardrails + No prompt required + Private by default |
| Evidence | shielded testnet txids (funding + receipt) | real invoice id + delivered order |

## Run it in under 15 minutes

Prerequisites: Node 20+, Rust (for the Zcash CLI wallet), a Bitrefill account with balance, an Anthropic API key.

```bash
# 1. the Zcash testnet wallet CLI (one-time, ~6 min build)
git clone --depth 1 https://github.com/zcash/zcash-devtool tools/zcash-devtool
cd tools/zcash-devtool && cargo build --release && cd ../..

# 2. the purse wallet + a view-only twin
DT=tools/zcash-devtool/target/release/zcash-devtool
$DT wallet -w wallets/agent init --name agent -i wallets/agent-identity.txt -n test
$DT wallet -w wallets/agent sync
$DT wallet -w wallets/agent list-accounts        # copy the UFVK, seed fingerprint
$DT wallet -w wallets/agent-view init-fvk --name view --fvk <UFVK> --seed-fingerprint <fp> --hd-account-index 0

# 3. config
cp .env.example .env    # fill BITREFILL_API_KEY, ANTHROPIC_API_KEY, TOPUP_PHONE, ZCASH_DEVTOOL
npm install

# 4. run
npm run purse -- address        # give this to the funder
npm run dashboard               # http://localhost:8788
npm run agent                   # polls every 30 s, fires due rules
npm run agent -- --signal treat # fire the "treat" rule now
```

Fund it: from any testnet wallet, send ≥ 0.01 TAZ to the purse address with memo `fund cap=100 INR reply=<your utest1 address>`. The agent picks it up on its next pass (10 confirmations ≈ 4 min at 25 s blocks).

Rules live in [`apps/munim/rules.json`](apps/munim/rules.json): an `every` interval or a named `signal`, an intent in plain words, a per-rule ceiling and an optional product type.

### As an MCP server (for any agent)

```bash
npm run purse:mcp
```
Tools: `purse_address`, `purse_refresh`, `purse_budget`, `purse_check`, `purse_record_spend`, `purse_send_receipt`. Claude Code / Cursor / Claude Desktop config: `{"command":"npx","args":["tsx","packages/zcash-purse/src/mcp.ts"],"cwd":"<repo>"}`.

## Guardrails (Bitrefill track)

- **Most an agent can spend:** the smallest of (a) the rule's `maxInr`, (b) the remaining authorised cap across all deposits, (c) the operator's Bitrefill balance. In the demo: ₹20 per top-up rule, ₹60 per treat rule, ₹100 total cap.
- **Who approves above that:** nobody can. Over-cap spends are refused in `Purse.reserve()` before an invoice is created. Raising the cap means a funder sending another shielded deposit with a new `cap=` memo — a human action with a private signature behind it.
- **One purchase per rule firing**, enforced in code, not in the prompt.
- Redemption codes are hashed on receipt and never logged, stored or shown to the model.

## Bitrefill touchpoints used, built vs reused

**Used:** two surfaces. (1) The **official Bitrefill MCP server** (`https://api.bitrefill.com/mcp`, Bearer API key) — the agent's catalog discovery runs through its `search-products` / `get-product-details` tools, bridged into the Anthropic tool runner by `apps/munim/src/mcp-bridge.ts`; `buy-products` is deliberately *not* exposed to the model. (2) **REST API v2** for the money path (`/accounts/balance`, `/products/{id}` for exact package ids and prices, `/invoices` with `payment_method: balance, auto_pay: true`, `/orders/{id}` polled until `delivered`) so every purchase passes the purse's cap check first. Docs read through `docs.bitrefill.com/llms.txt`.
**Built:** the rules engine, the capped purse and its MCP server, the Sonnet 5.5 agent with tool-enforced guardrails, the memo receipt format, the view-only dashboard.
**Reused:** Bitrefill's catalog, pricing and fulfilment; `zcash-devtool` for all wallet operations; the Anthropic SDK tool runner.

## Evidence

All on 4 Nov 2026, Zcash testnet (NU7) and the live Bitrefill API.

| Step | Evidence |
|---|---|
| Funder → purse, 0.1 TAZ, memo `fund cap=100 INR reply=utest1…` | [`0c7247b5c65fd308cad895f9c798583ca12ffe4a90fa7efe25d257319b7291c6`](https://testnet.zcashexplorer.app/transactions/0c7247b5c65fd308cad895f9c798583ca12ffe4a90fa7efe25d257319b7291c6) — mined 4581752, shielded (Ironwood) |
| Rule `jio-recharge` fired on schedule → Sonnet picked the ₹10 Jio talktime pack → `purse_check` ✓ → bought | Bitrefill invoice `3bb79e4e-6d7a-4b56-a921-07e5cb060f89`, order `6aeb0da57073473b2edcb0fd`, **delivered**, $0.11 |
| Purse → funder receipt, memo `munim receipt inv=3bb79e4e… item=Jio Bundles India inr=10 cost=0.11 USD rule=jio-recharge` | [`4377c5c7acdbd4239a87c574aee8f070b1dc84d963c09804a7376824e4042461`](https://testnet.zcashexplorer.app/transactions/4377c5c7acdbd4239a87c574aee8f070b1dc84d963c09804a7376824e4042461) — mined 4581796; decrypted in the funder's wallet with `zcash-devtool wallet list-tx` |
| Signal `treat` → ₹50 Swiggy Money gift card → bought, code hashed | Bitrefill invoice `599b5c2f-aba9-4774-8d2d-676d2e64b373`, order `6aeb0e027073473b2edcb9d5`, **delivered**, $0.55 |
| Purse → funder receipt for the Swiggy card (sent on the next pass, after the purse's change note confirmed) | [`3552ff34bbf513e269fc88bef1dc4cb7609aee68ad87fb5c043125de3966557b`](https://testnet.zcashexplorer.app/transactions/3552ff34bbf513e269fc88bef1dc4cb7609aee68ad87fb5c043125de3966557b) |
| **Close the loop:** the delivered Swiggy Money card was redeemed into the funder's Swiggy balance by the agent, through the funder's saved Swiggy web session (`PATCH chkout.swiggy.com/swiggymoney/voucher/claim`), with no app and no copy-paste | `credited 50 INR, balance now 50 INR (Completed)` — the code never left the process; only amounts are logged |
| Signal `treat` again → `purse_check ₹50: ₹50 exceeds remaining cap ₹40` → **refused**, no invoice | agent log: "the purse refused it because only about ₹40 of the cap is left … I didn't try Zomato because a ₹50 Zomato card would hit the same limit" |
| Earlier attempt, same rule: Jio *data add-on* ₹11 | invoice `efa3987e-ef86-45c7-83a7-f93a52442e22` — **refunded** by Bitrefill (data packs need an active base plan). Kept in the ledger as `refunded`, not counted against the cap. |

| **Works while you sleep:** two flight events on the funder's Google Calendar (`IndiGo 6E 1407 BOM → DXB`, 15 Nov; return 20 Nov), read through the Google Calendar MCP; Gmail booking mail read through the Gmail MCP | trip detected `Dubai (AE) 2026-11-15 → 11-20`, proposal `22ca92db`: `bitrefill-esim-united-arab-emirates · 1GB, 7 Days · 3.76 USD` — waiting in the dashboard's Approvals inbox; bought only after approval and only inside the cap |
| **Agent-to-agent payment:** `purse_pay` from the purse MCP to the funder, 0.0001 TAZ with memo `munim pay purpose=mcp-pay-test inr=1 hello from munim` | [`e03a2b3ca20c85c20448e6a59d2e51c9fc54cfe3896ec13c43789b10b57dee22`](https://testnet.zcashexplorer.app/transactions/e03a2b3ca20c85c20448e6a59d2e51c9fc54cfe3896ec13c43789b10b57dee22) — counted against the cap (₹40 → ₹39) |

Cap after the run: ₹100 authorised, ₹61 spent, ₹39 remaining — a third `treat` (₹50) is refused by `purse_check`.

## Technologies

TypeScript on Node 24 · `@anthropic-ai/sdk` (Claude Sonnet 5.5, beta tool runner, Zod tools) · `@modelcontextprotocol/sdk` · `zod` v4 · `zcash-devtool` (Rust; `zcash_client_sqlite`, NU7 testnet via `testnet.zec.rocks`) · Bitrefill REST API v2 · plain `node:http` dashboard.

## Design decisions

- **devtool over an SDK.** On NU7 testnet the web SDK (WebZjs) and the CLIs (zcli, Zallet) are broken or need Docker; `zcash-devtool` built and synced first time. Wrapping a CLI is less elegant than linking a library, but it is the thing that *works*, which is the first criterion.
- **Cap in the memo, not in a config file.** The funder's authorisation travels with the money, encrypted. The operator cannot forge a cap without a deposit behind it.
- **Receipt as a dust transaction.** 0.0001 TAZ carries a 512-byte encrypted memo to the funder's wallet. It costs a fee, but it means the funder needs nothing but their wallet to audit the agent.
- **Hash, don't forward, the code.** The model and the memo get `sha256(code)`; the funder reads the real code in the Bitrefill order. No code ever sits in a log.
- **Operator-settled Bitrefill.** ZEC isn't accepted by Bitrefill and the testnet has no swap path, so the operator's balance pays. This is a stated trust gap, not hidden — see [PRIVACY.md](PRIVACY.md).

## Already continuing

- Upstream, filed during the hack from what we hit: [zcash/zcash-devtool#272](https://github.com/zcash/zcash-devtool/issues/272) (memo decryption, `list-tx --json`, unsigned sends — PR offered) and [bitrefill/agents#19](https://github.com/bitrefill/agents/issues/19) (MCP auth docs, TOON output, voucher format).
- Hosted and in daily use by the builder's own household: https://munim.heneryshop.com (installable PWA, password-protected; see [deploy/README-deploy.md](deploy/README-deploy.md)).
- The purse is a standalone package with its own MCP server: [packages/zcash-purse/README-purse.md](packages/zcash-purse/README-purse.md).

## Privacy and trust note

See [PRIVACY.md](PRIVACY.md). Next 30 days: [NEXT.md](NEXT.md). Friction notes: [FEEDBACK.md](FEEDBACK.md).
