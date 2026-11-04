# Stadium submission — paste-ready text

Program: https://stadium.joinwebzero.com/programs/free-society-hack-2026
Tracks: **both** (Privacy / Zcash + Agentic Commerce / Bitrefill)
Draft by Wed 4 Nov 20:00 IST · finalize by Thu 5 Nov 00:00 IST

## One-line pitch (both tracks)

Munim is a spending-capped shopping agent for a household: you fund it privately in shielded ZEC with the cap in the memo, it buys real Indian top-ups and gift cards through Bitrefill when a rule fires, and every receipt comes back to your wallet as an encrypted memo.

## Repo

https://github.com/0xStoneyStark/munim

## Public URL

None needed: Munim is an agent + CLI + MCP server (the brief says SDKs/CLIs/bots/agents skip it and show Zcash working in the video/README). The read-only dashboard runs locally (`npm run dashboard`, http://localhost:8788) and is shown in the video.

## Testnet transaction ID (shielded)

`TBD — funding tx from funder → purse` (Stadium checks it is a real shielded tx)

## Bitrefill invoice ID

`TBD`

## Which parts are for which track

- **Privacy track:** `packages/zcash-purse` — the capped shielded purse (memo-authorised budget, cap enforcement, receipt memos, view-only export) and its MCP server. Themes: private payment rails ("agent wallet with a spending cap", "MCP server so agents use Zcash") and privacy beyond the transaction ("read-only export from a viewing key", "invoices in encrypted memos").
- **Agentic Commerce track:** `apps/munim` — rules (schedule/signal triggers), the Sonnet 5.5 agent with tool-enforced guardrails, the Bitrefill REST integration, the dashboard. Lanes: Rails and guardrails, No prompt required, Private by default (with Zcash).

## Guardrails (Bitrefill form field)

Most an agent can spend: the smallest of the rule's ceiling (₹20 top-up / ₹60 treat in the demo), the remaining memo-authorised cap (₹100 in the demo) and the operator's Bitrefill balance. Nobody approves above that — over-cap spends are refused in code before an invoice exists; the only way to raise the cap is a funder sending a new shielded deposit with a new `cap=` memo.

## Bitrefill touchpoints, built vs reused

See README → "Bitrefill touchpoints used, built vs reused".

## Privacy and trust note

Paste PRIVACY.md (sections 1–4 answer the four questions).

## Next step (30 days)

Paste NEXT.md.

## Friction notes

Paste FEEDBACK.md (Zcash section tagged "Zcash", Bitrefill section tagged "Bitrefill", Tooling tagged "tooling").

---

# Demo video — shot list (2–3 min, screen recording, mask codes)

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
