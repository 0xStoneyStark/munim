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

**Used:** REST API v2 (`/ping`, `/accounts/balance`, `/products/search`, `/products/{id}`, `/invoices` with `payment_method: balance, auto_pay: true`, `/orders/{id}` polled until `delivered`). Docs read through `docs.bitrefill.com/llms.txt`.
**Built:** the rules engine, the capped purse and its MCP server, the Sonnet 5.5 agent with tool-enforced guardrails, the memo receipt format, the view-only dashboard.
**Reused:** Bitrefill's catalog, pricing and fulfilment; `zcash-devtool` for all wallet operations; the Anthropic SDK tool runner.

## Evidence

<!-- filled in at submission -->
- Funding tx (shielded, testnet): `TBD`
- Receipt tx (shielded, testnet): `TBD`
- Bitrefill invoice: `TBD`

## Technologies

TypeScript on Node 24 · `@anthropic-ai/sdk` (Claude Sonnet 5.5, beta tool runner, Zod tools) · `@modelcontextprotocol/sdk` · `zod` v4 · `zcash-devtool` (Rust; `zcash_client_sqlite`, NU7 testnet via `testnet.zec.rocks`) · Bitrefill REST API v2 · plain `node:http` dashboard.

## Design decisions

- **devtool over an SDK.** On NU7 testnet the web SDK (WebZjs) and the CLIs (zcli, Zallet) are broken or need Docker; `zcash-devtool` built and synced first time. Wrapping a CLI is less elegant than linking a library, but it is the thing that *works*, which is the first criterion.
- **Cap in the memo, not in a config file.** The funder's authorisation travels with the money, encrypted. The operator cannot forge a cap without a deposit behind it.
- **Receipt as a dust transaction.** 0.0001 TAZ carries a 512-byte encrypted memo to the funder's wallet. It costs a fee, but it means the funder needs nothing but their wallet to audit the agent.
- **Hash, don't forward, the code.** The model and the memo get `sha256(code)`; the funder reads the real code in the Bitrefill order. No code ever sits in a log.
- **Operator-settled Bitrefill.** ZEC isn't accepted by Bitrefill and the testnet has no swap path, so the operator's balance pays. This is a stated trust gap, not hidden — see [PRIVACY.md](PRIVACY.md).

## Privacy and trust note

See [PRIVACY.md](PRIVACY.md). Next 30 days: [NEXT.md](NEXT.md). Friction notes: [FEEDBACK.md](FEEDBACK.md).
