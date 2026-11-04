# Stadium submission — paste-ready text

Program: https://stadium.joinwebzero.com/programs/free-society-hack-2026
Tracks: **both** (Privacy / Zcash + Agentic Commerce / Bitrefill)
Draft by Wed 4 Nov 20:00 IST · finalize by Thu 5 Nov 00:00 IST

## One-line pitch (both tracks)

Munim is a spending-capped shopping agent for a household: you fund it privately in shielded ZEC with the cap in the memo, it buys real Indian top-ups and gift cards through Bitrefill when a rule fires, and every receipt comes back to your wallet as an encrypted memo.

## Demo video

https://munim.heneryshop.com/demo.mp4 — 2:08 (receipt proof inside the first 2 minutes; under the 3-minute Bitrefill limit). Shot 4 Nov 2026 20:07–20:14 IST: a real 0.05 TAZ deposit with `fund cap=300 INR` (txid `2b0bc48da9a0e9b06a9a50179365eda4ab30289c0f54a02dd4bad4208866723b`), the PWA installed fresh on a Galaxy S24 Ultra over USB (scrcpy), the `topup` rule fired on the phone and bought invoice `726b27d8-fe5b-4f4f-95eb-fcfad260bc05` (₹250 Swiggy Money, $2.76) in ~30 s, the Dubai eSIM proposal raised from a calendar event created minutes earlier, web push enabled and delivered. Voice: the builder's cloned ElevenLabs voice. Source of the cut: `walkthrough/`.

## Repo

https://github.com/0xStoneyStark/munim

## Public URL

https://munim.heneryshop.com — hosted, installable PWA; password-protected because purchases are real (demo password on request in the mentor chat). Pages: /, /approvals, /rules, /wallets, /privacy, /connections. The agent loop runs on the same server (pm2).

## Testnet transaction ID (shielded)

`0c7247b5c65fd308cad895f9c798583ca12ffe4a90fa7efe25d257319b7291c6` — funder → purse, 0.1 TAZ, memo `fund cap=100 INR reply=…`, mined 4581752 (Ironwood, shielded).
Second one if the form allows: `4377c5c7acdbd4239a87c574aee8f070b1dc84d963c09804a7376824e4042461` — purse → funder receipt memo, mined 4581796.

## Bitrefill invoice ID

`7827bbf6-1825-4b00-8598-abbfaa1b92dd` — ₹250 Swiggy Money card, delivered, $2.75, bought by the `topup` rule, auto-redeemed into the household Swiggy balance (₹50 → ₹300), then spent by the `daily-diet-coke` rule at 19:05 IST through Swiggy's official Instamart MCP: **Instamart order 252768923926074, paid with Swiggy Money, no human step.**
Also: `3bb79e4e-6d7a-4b56-a921-07e5cb060f89` — Jio ₹10 talktime, delivered, $0.11 (agent-initiated on schedule).
Also: `599b5c2f-aba9-4774-8d2d-676d2e64b373` — Swiggy Money ₹50 gift card, delivered, $0.55 (agent-initiated on the `treat` signal).

## Which parts are for which track

- **Privacy track:** `packages/zcash-purse` — the capped shielded purse (memo-authorised budget, cap enforcement, receipt memos, view-only export) and its MCP server with `purse_pay` (agent-to-agent shielded payment inside the cap), the verifiable receipt page (`/verify`), household funders with per-funder receipts, `PURSE_CONNECTION=tor` network privacy, and the Noir Wallet funding button. Themes: private payment rails ("agent wallet with a spending cap", "MCP server so agents use Zcash") and privacy beyond the transaction ("read-only export from a viewing key", "invoices in encrypted memos").
- **Agentic Commerce track:** `apps/munim` — rules (schedule / signal / calendar triggers, plus plain-language rule creation), the Sonnet 5.5 agent with tool-enforced guardrails, the Bitrefill REST integration, **close the loop**: a delivered Swiggy Money card is redeemed by the agent into the funder's Swiggy balance (no app, no copy-paste) and spent on Instamart through Swiggy's official MCP server; calendar-driven eSIM proposals for upcoming international trips; the dashboard. Lanes: Rails and guardrails, Close the loop, No prompt required, Private by default (with Zcash).

## Guardrails (Bitrefill form field)

Most an agent can spend: the smallest of the rule's ceiling (₹20 top-up / ₹60 treat in the demo), the remaining memo-authorised cap (₹100 in the demo) and the operator's Bitrefill balance. Nobody approves above that — over-cap spends are refused in code before an invoice exists; the only way to raise the cap is a funder sending a new shielded deposit with a new `cap=` memo.

## Bitrefill touchpoints, built vs reused

See README → "Bitrefill touchpoints used, built vs reused".

## Privacy and trust note

Paste PRIVACY.md (sections 1–4 answer the four questions).

## Next step (30 days)

Paste NEXT.md. Lead with what is already started: upstream issues [zcash/zcash-devtool#272](https://github.com/zcash/zcash-devtool/issues/272) and [bitrefill/agents#19](https://github.com/bitrefill/agents/issues/19), and the hosted, installable instance at https://munim.heneryshop.com running for the builder's household.

## Public URL (update)

https://munim.heneryshop.com — password-protected (purchases are real); judges who want to try it can ask in the mentor chat for the demo password. The read-only proof is in the video and README.

## Friction notes

Paste FEEDBACK.md (Zcash section tagged "Zcash", Bitrefill section tagged "Bitrefill", Tooling tagged "tooling").

---

# Demo video — shot list v2 (2–3 min; phone + laptop; every step real; never show a gift-card code)

Record the phone (installed app, https://munim.heneryshop.com) with the laptop screen beside it for the wallet/terminal shots. Order of shots:

0:00 Title: "Munim — fund it privately, it shops while you sleep." (5 s)
0:05 Phone · Timeline: cap, remaining, the timeline. "Nothing happens here without a shielded deposit and a cap." (8 s)
0:13 Laptop · funder wallet sends shielded TAZ with memo `fund cap=300 INR reply=…` (zcash-devtool command on screen; txid appears). Open the txid on zexplorer.app/testnet — nothing readable. (25 s)
0:38 Phone · Wallets: cap rises after the next pass (Fire now on any rule or wait). Point at the Funders card. (10 s)
0:48 Phone · Rules: "Add a rule in plain words" → type "when I say topup, buy a ₹250 Swiggy Money card" → Propose → readback → Confirm & save. (15 s)
1:03 Phone · Rules: Fire now on topup → "Agent working…" pill → Timeline: purchase delivered → "Swiggy Money +₹250" → Wallets: Swiggy Money balance. (25 s)
1:28 Phone · Rules: the daily-diet-coke rule — "daily at 19:05" — Edit shows the clock editor. Then the Timeline's Instamart order event from 19:05 (order id, paid with Swiggy Money). Swiggy app: the order in Orders. (25 s)
1:53 Phone · Approvals: the Dubai eSIM proposal that came from Google Calendar; tap Approve (buys only inside the cap). (12 s)
2:05 Phone · Rules: Fire now on treat → Timeline: ⛔ refused — "exceeds remaining cap". The guardrail is code. (12 s)
2:17 Laptop · funder wallet `list-tx` after sync+enhance: the receipt memos decrypted (`munim receipt inv=… code_sha256=…`). Then /verify: paste one → green ticks. (18 s)
2:35 Phone · Privacy page + Connections page, 5 s each; close on the README's evidence table and the repo URL. (12 s)

Old v1 shot list below for reference.

# Demo video — shot list v1 (superseded)

0:00 Title card: Munim — fund an agent privately, it shops while you sleep. (5 s)
0:05 Dashboard: purse address, cap ₹0, empty tables. "Nothing is authorised yet." (10 s)
0:15 Funder wallet terminal: `zcash-devtool wallet send … --memo "fund cap=100 INR reply=utest1…"`. Show the txid, open it in testnet.zcashexplorer.app — shielded, nothing readable. (25 s)
0:40 Agent terminal: `npm run agent -- --once` → "1 new deposit; cap ₹100". Dashboard refreshes: deposit row with the decrypted memo. (15 s)
0:55 Rule 1 (schedule): agent fires `airtel-talktime`; show Sonnet's tool calls: search → get_product → purse_check ✓ → buy. Bitrefill invoice id on screen, order status → delivered. Phone shows the Airtel top-up SMS (hold phone to camera or screenshot). (35 s)
1:30 Receipt: terminal prints receipt txid; funder wallet `list-tx` shows the decrypted memo `munim receipt inv=… inr=10 code_sha256=…`. (20 s)
1:50 Rule 2 (signal): click "Fire now" on treat-for-mom in the dashboard → agent buys ₹50 Swiggy card → invoice id; order page with code MASKED; receipt memo again. (30 s)
2:20 Cap refusal: fire treat again → `purse_check` refuses "exceeds remaining cap". Agent stops, explains. (15 s)
2:35 Accountant export: click "Download CSV" — from the view-only wallet, no spend key. (10 s)
2:45 Close: PRIVACY.md on screen — "what it reveals, to whom". Repo URL. (10 s)
