# FEEDBACK.md — what broke, confused us, or slowed us down

Team of one human + Claude (Fable 5.1 driving the build, Sonnet 5.5 inside the agent). Hacking remotely from a hotel after check-in. Timestamps are IST, 4 Nov 2026.

## Zcash side

- **The resources page's "doesn't work on NU7" list saved us an hour** — but it should be at the *top* of the page, not the bottom. We nearly started with WebZjs.
- **No Docker on the laptop → ZPay and the WebZjs gRPC-web proxy were out.** A hosted gRPC-web proxy for testnet would make web-app entries possible for teams without Docker.
- **`zcash-devtool` is the only thing that just worked**, and it worked first time on Windows: clone, `cargo build --release` (6 min 17 s), `wallet init`, `sync` (1 s with a current birthday), `list-addresses`. It deserves to be the headline recommendation for CLI/bot/agent teams. Two gaps:
  - `list-tx` has no documented output format; we wrote a tolerant parser blind and had to wait for a real transaction to validate it. A `--json` that includes value, memo and height (not only txid/mined_height) would remove that.
  - `send` prints logs to stderr and the txid to stdout in a format we had to guess (regex for 64 hex chars).
- **`sync` does not decrypt memos; `enhance` does.** After `wallet sync` the deposit showed `0 memos`; only after `wallet enhance` did `Memo: Memo::Text("fund cap=100 …")` appear. Nothing in `--help` says a memo-reading app must run both. One line in the README would save every memo-based project an hour.
- **`list-tx` `Amount` is unsigned for sends.** A 0.0001 TAZ receipt we *sent* printed `Amount: 0.00020000 TAZ` (value + fee, positive) — the only way to tell direction is the `Sent N notes, received M notes` line. Our first parser counted our own receipt as a deposit.
- **A fresh wallet has one note.** The first receipt send consumed the whole 0.1 TAZ note; until its change confirmed, the second receipt failed with `Insufficient balance (have 0, need 20000 including fee)`. We added a retry-on-next-pass; fan-out (`wallet fan-out`) on funding would avoid it. Worth a sentence in the agent-payments guidance: fund agent wallets with several notes.
- **Testnet blocks are lumpy.** 25 s average, but our funding tx waited ~4 min and the receipt ~2 min; the 10-confirmation rule for untrusted notes then adds ~4 min. Plan demos around it.
- **Faucets:** Valar is 0.125 TAZ/day, Fauzec 1 TAZ/day. A remote team has no "walk up to a mentor" option; a faucet with a 2–5 TAZ event allowance keyed to Luma check-in would help.
- **Memo grammar.** There is no convention for machine-readable memos (we invented `fund cap=100 INR reply=utest1…`). A tiny ZIP-style recommendation ("key=value, space-separated, first token is the app name") would let wallets render agent memos nicely.

## Bitrefill side

- **Store credit currency ≠ primary balance.** We bought $10 of "USD Store Credit" with ETH; the website showed $10 USD, but `GET /accounts/balance` returned `{"balance":0,"currency":"BTC"}` and every `POST /invoices` with `payment_method: balance` failed with `Balance too low`, because **Bitcoin was the *primary* store credit** and the API only pays from the primary one. Cost us ~30 minutes. Suggestions: let `payment_method: balance` take a `currency`, or have `/accounts/balance` return all store credits with the primary flagged, or say "Balance too low in BTC (primary); you have $10 USD" in the error.
- **`price` in `packages[]` is in minor units of the primary balance currency** (satoshis for BTC), while the docs describe `payment_price` in USD. The live product details use `id`/`value`/`amount`/`price`, not the documented `package_id`/`value`/`payment_price`. We coded to the docs first and had to re-type against the live response.
- **A line with both `package_id` and `value` is a 400** with a generic message. Either ignore `value` when `package_id` is present, or say so in the error.
- **Error envelope:** 4xx responses put the human message at top-level `message`, not under `error.message`, and `meta` echoes the full request back — including the phone number. We had to strip `meta` so a phone number never reaches logs or the model.
- **Swiggy Money cards are 16 *alphanumeric* characters + 6-digit PIN**, delivered as `redemption_info.code` / `.pin` with empty `instructions`. Swiggy's own redeem form labels it a "16 digit code", so we first validated for digits and rejected a valid card. Worth one line in the product's `instructions` field ("redeem at Swiggy → Account → Swiggy Money → Add voucher; code is alphanumeric").
- **Closing the loop needs the merchant's side.** There is no Swiggy API to redeem a voucher; we found the endpoint Swiggy's own webview uses and call it with the user's session. If Bitrefill ever offers "deliver straight into the user's Swiggy Money" (as it does for phone top-ups), agentic commerce on gift cards becomes one step instead of three.
- **MCP docs are stale on auth.** The resources page and docs say "put the API key in the path: `https://api.bitrefill.com/mcp/YOUR_API_KEY`". That endpoint answers *"This endpoint has been shut down. Connect to /mcp and send your API key in the Authorization header"*. Bearer works; the docs should say so (and the path form was a bad idea anyway — keys end up in logs and URLs).
- **MCP returns TOON, not JSON.** `search-products` over MCP returns a TOON text table; the REST API returns JSON for the same data. Fine for a model, but a `format: "json"` argument would let code consume it without a parser. The product slugs do match the REST ids, which is what makes "discover over MCP, buy over REST" possible.
- **Good:** `/products/search` with `country=IN&type=phone_refill` is fast and exact; the Jio catalog had a ₹10 talktime pack, perfect for a cheap real demo. Invoice creation with `auto_pay: true` is one call.

## Swiggy MCP (for the record — not a Bitrefill issue)

- **Dynamic client registration works, but only `localhost` redirect URIs are honoured.** Our self-registered client signs in fine with `http://localhost:8788/oauth/swiggy/callback`; with `https://munim.heneryshop.com/oauth/swiggy/callback` the consent page says *"Oops, Heneryshop isn't whitelisted yet — request access on Builders Club"*. The bearer token is not bound to the redirect host, so a token obtained on the laptop works from the server; re-links have to happen on localhost and be synced. Whitelisting request filed via Builders Club is on NEXT.md.
- **Instamart lives at `/im`, not `/instamart`.** The launch coverage says "separate servers for Instamart and Dineout" without URLs; `/instamart` is a 404 HTML page. `/food`, `/im`, `/dineout`, `/scenes` all answer MCP `initialize`.
- **Payment method `SwiggyPay` exists on `checkout`** but is not mentioned in the tool descriptions' prose (they talk about UPI and Cash); we found it in the `paymentMethod` enum text. Worth one line in the description, since it's the only method an unattended agent can use.

## Tooling

- `@anthropic-ai/sdk`'s `betaZodTool` requires **zod v4**; `@modelcontextprotocol/sdk` examples still show zod v3. Both installed side by side fine once we pinned `zod@^4`, but the type errors (`$ZodTypeInternals` missing) do not say "upgrade zod".
- Notion public pages render lazily; reading the builder pack programmatically needed scrolling tricks. A plain markdown export of the pack would be kinder to AI-assisted teams.

## Running log

<!-- appended during the hack -->
