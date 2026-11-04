# Privacy and trust note

Judges score "Private" from this note, so it is written to be honest rather than flattering.

## 1. What stays private

- **Every on-chain movement is shielded.** The funder's deposit into the purse and the agent's receipt back to the funder are shielded-to-shielded transactions on Zcash testnet (NU7, unified addresses). Amounts, sender and receiver are not visible on the chain. The explorer shows only that a shielded transaction exists.
- **The funding memo is encrypted.** `fund cap=100 INR reply=utest1…` is readable only by the purse's viewing key. Nobody watching the chain learns the cap or the reply address.
- **The receipt memo is encrypted.** `munim receipt inv=… item=… inr=… code_sha256=…` is readable only by the funder. The chain does not learn what was bought.
- **Redemption codes never leave the Bitrefill order.** The agent hashes a code (SHA-256) and stores/sends only the hash. The code is not in the ledger, not in the memo, not in the logs, and not in anything sent to the AI model. The funder redeems from their own Bitrefill account/order; the hash lets them check it is the same code.
- **The funder's spending key never touches this system.** The funder sends from their own wallet. Munim holds only its own purse key.

## 2. What the app reveals, and to whom

| Party | What they can see |
|---|---|
| **Munim server (the operator)** | The purse's spending key (bounded: it can never spend more than funders deposited, and the software cap is lower still), the ledger (deposits, caps, spends, invoice ids, code hashes), the funder's reply address, the rules file, the top-up phone number. |
| **Bitrefill** | The operator's account, every purchase, the phone number for top-ups, the operator's IP. Bitrefill is paid from the operator's balance in USD, not in ZEC, so Bitrefill never sees any Zcash activity. |
| **Light-wallet server (`testnet.zec.rocks`)** | The server's IP address and its sync pattern (which blocks it fetches, when). It cannot read notes or memos (it only serves compact blocks) but it can infer that *something* at this IP has a wallet that syncs every 30 s. |
| **Swiggy** | Once the funder saves their Swiggy web session (`data/swiggy-session.json`, gitignored), the operator holds a long-lived credential that can read the Swiggy Money balance, redeem vouchers into it and — through Swiggy's official MCP, after a separate OAuth consent — place Instamart orders paid from that balance. Swiggy sees the orders, the delivery address and the operator's IP. The voucher code and PIN pass through the process memory once and are never logged or stored; only amounts are kept. The session can be revoked by logging out of Swiggy. |
| **Anthropic (the model provider)** | Each rule's intent text, the Bitrefill search results and package prices, the cap check verdicts, and the invoice id / order status / code hash returned by `buy`. Never the purse key, the Bitrefill API key, the funder's address, or a redemption code. |
| **The chain / anyone** | That shielded transactions happened. Nothing else. |

## 3. What users have to trust

1. **The operator of Munim.** They run the process that holds the purse key and the Bitrefill key. A malicious operator could spend the purse (up to the cap) on anything. The cap is enforced in software by the same operator; the only hard bound is the amount deposited.
2. **Bitrefill**, to deliver what was paid for and to keep the operator's account safe.
3. **The hosted light-wallet server**, for honest chain data and for not correlating IP with wallet activity.
4. **The operator, again, with your Swiggy session.** Saving it is optional; without it the redeem step is manual. With it, the operator could spend your existing Swiggy Money balance on Instamart, not only what the purse funded — the cap bounds funding, not the merchant wallet. We call this out rather than hide it; the fix is in section 4.
5. **Anthropic**, to not misuse the shopping intents it sees and to follow the tool contract (it cannot bypass the cap: `buy` calls `purse.reserve`, which refuses over-cap spends regardless of what the model asks).
5. **This code**, including `zcash-devtool`, which its own README says is not production-ready.

## 4. What we would fix next

- **ZEC → Bitrefill is a trust gap, not a payment rail.** The purse is funded in ZEC but Bitrefill is paid from the operator's USD balance. The honest description is "ZEC-authorised, operator-settled". Closing it needs a ZEC→USDC swap (NEAR Intents 1Click, transparent address, mainnet only) or x402 with a USDC wallet, neither of which has a testnet path today.
- **Network privacy — partly done.** `PURSE_CONNECTION=tor` routes the purse's sync, enhance, send and view-export traffic through `zcash-devtool`'s built-in Tor client (tested on this machine: cold start ~2 min, warm sync ~15 s), so the light server no longer sees our IP. It still sees *what* is asked — the block ranges and tx fetches, now tied to a Tor exit — and the transactions we broadcast. Bitrefill, Swiggy and Anthropic traffic does **not** go through Tor; direct is the default. Nym's mixnet (the Zcash SDK for Nym) is the next step for the sync pattern itself.
- **The cap is operator-enforced.** A real design would hold the purse key in a separate signer (PCZT flow in `zcash-devtool`, or FROST 2-of-3 with the funder) so the operator alone cannot exceed the cap.
- **Phone number and intents sit in plaintext config.** They should be in the funding memo (encrypted) so the server never stores them at rest.
- **The ledger is unencrypted JSON** on the operator's disk, and so is the Swiggy session file.
- **Merchant sessions are over-scoped.** A Swiggy web session can do anything the user can. The right shape is Swiggy's official MCP OAuth token (scoped, refreshable, revocable) for ordering, and a merchant-side "redeem into my balance" API for vouchers — which does not exist yet. Until then, the private claim call is a documented, opt-in shortcut.
- **Receipts leak timing.** A receipt is sent minutes after a purchase; someone who can see both the Bitrefill order time and the chain could correlate. Batching receipts would blur this.
