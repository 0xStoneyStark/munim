# Manual end-to-end check (no purchases)

Do these in order. Each takes a minute. Nothing here spends money or places an order.

## 0. One command

```bash
npm run check
```
Expect: `bitrefill.balance` with a positive USD balance, `purse.budget` with cap/spent/remaining, `anthropic.key: present`, `topup.phone: present`. If `bitrefill.balance` is 0, set the right store credit as **primary** on bitrefill.com → Store Credits.

## 1. Zcash purse (shielded rails)

```bash
npm run purse -- refresh
```
- `balanceTaz` > 0 and `deposits[]` lists your funding tx with `capInr` parsed from the memo.
- Open any deposit txid on https://testnet.zcashexplorer.app — you should see a shielded tx with **no readable amount or memo**. That is the privacy claim, visible.
- In the funder wallet, `zcash-devtool wallet -w wallets/funder list-tx` after `sync` + `enhance` shows the receipt memos `munim receipt inv=…` decrypted — proof the receipt arrived privately.

## 2. Cap enforcement

```bash
npm run purse -- check 1000
```
Expect `ok: false, reason: "₹1000 exceeds remaining cap ₹…"`. Then `npm run purse -- check 10` → `ok: true`. This is the guardrail judges ask about: it is code, not a prompt.

## 3. Swiggy Money (close the loop)

```bash
npx tsx apps/munim/src/swiggy-money.ts probe
```
Expect `alive, balance: N INR`. If it says `session expired`, re-run `session-from-cookie` with a fresh cookie (DevTools → Network → Copy as cURL). Cross-check: Swiggy app → Account → Swiggy Money shows the same balance.

## 4. Swiggy official MCP (ordering)

```bash
npm run swiggy:tools -- instamart
```
Expect 17 tools incl. `search_products`, `update_cart`, `get_cart`, `checkout`. Dry run that **never** places an order:
```bash
npx tsx apps/munim/src/instamart.ts dry "cheapest 500 ml milk to the address labelled Mumbai" 50
```
Expect a bill readout and "did not place" (₹50 won't cover fees). The cart is cleared automatically; if not: Swiggy app → Instamart cart should be empty.

## 5. Calendar → eSIM proposals

```bash
TRAVEL_PROPOSALS_FILE=data/travel-test.json npx tsx apps/munim/src/travel.ts scan <your-ics-url-or-file>
```
Expect trips with ISO country codes and a Bitrefill eSIM suggestion (product, package, price). Delete `data/travel-test.json` afterwards; nothing is bought until a proposal is approved on the dashboard **and** the agent loop runs.

## 6. Dashboard

Open http://localhost:8788 (`npm run dashboard`).
- Header shows **LIVE** with a time; numbers match step 1.
- Timeline: newest first; a 🔒 deposit, 🧾 purchases with status chips, ↩ receipts linking to the explorer, ⛔ a refusal.
- Merchant wallets: Jio **active**, Swiggy Money **linked** with balance, Swiggy Instamart (MCP) **linked**.
- Rules → "Add a rule in plain words" → type a sentence → **Propose** → read the readback and warnings → **Discard** (or Confirm & save if you want it).
- Fund → the modal shows the purse address and the Noir button; with the Noir testnet extension installed, "Fund with Noir Wallet" opens the wallet's approval sheet (cancel it to test without spending).

## 7. Agent loop, dry

```bash
npm run agent -- --once
```
Expect `purse: … cap ₹… remaining ₹…`, calendar lines (skipped if no `CALENDAR_ICS`), and `nothing due` if no rule is due. Nothing is bought unless a rule is due or a signal is pending — check `apps/munim/rules.json` and `data/signals/` first.

## 8. MCP server for other agents

```bash
npm run purse:mcp
```
Then in Claude Desktop / Claude Code add it as a stdio server and ask "what is my purse budget?" — it answers from the ledger without any key leaving the process.

## What a *real* run adds (only when you say so)

1. Funder sends shielded TAZ with `fund cap=<INR> reply=<addr>` → appears in step 1 within ~5 min.
2. A rule fires (or `npm run agent -- --signal <name>`) → Bitrefill invoice → delivered → receipt memo.
3. If the product was Swiggy Money → auto-redeem → balance in step 3 goes up.
4. An `instamart` rule → cart → `checkout` with `paymentMethod: SwiggyPay` → order id on the timeline.
