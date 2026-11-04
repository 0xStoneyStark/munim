# FEEDBACK.md — what broke, confused us, or slowed us down

Team of one human + Claude (Fable 5.1 driving the build, Sonnet 5.5 inside the agent). Hacking remotely from a hotel after check-in. Timestamps are IST, 4 Nov 2026.

## Zcash side

- **The resources page's "doesn't work on NU7" list saved us an hour** — but it should be at the *top* of the page, not the bottom. We nearly started with WebZjs.
- **No Docker on the laptop → ZPay and the WebZjs gRPC-web proxy were out.** A hosted gRPC-web proxy for testnet would make web-app entries possible for teams without Docker.
- **`zcash-devtool` is the only thing that just worked**, and it worked first time on Windows: clone, `cargo build --release` (6 min 17 s), `wallet init`, `sync` (1 s with a current birthday), `list-addresses`. It deserves to be the headline recommendation for CLI/bot/agent teams. Two gaps:
  - `list-tx` has no documented output format; we wrote a tolerant parser blind and had to wait for a real transaction to validate it. A `--json` that includes value, memo and height (not only txid/mined_height) would remove that.
  - `send` prints logs to stderr and the txid to stdout in a format we had to guess (regex for 64 hex chars).
- **Faucets:** Valar is 0.125 TAZ/day, Fauzec 1 TAZ/day. A remote team has no "walk up to a mentor" option; a faucet with a 2–5 TAZ event allowance keyed to Luma check-in would help.
- **Memo grammar.** There is no convention for machine-readable memos (we invented `fund cap=100 INR reply=utest1…`). A tiny ZIP-style recommendation ("key=value, space-separated, first token is the app name") would let wallets render agent memos nicely.

## Bitrefill side

- (filled in as we go; see the bottom of this file)

## Tooling

- `@anthropic-ai/sdk`'s `betaZodTool` requires **zod v4**; `@modelcontextprotocol/sdk` examples still show zod v3. Both installed side by side fine once we pinned `zod@^4`, but the type errors (`$ZodTypeInternals` missing) do not say "upgrade zod".
- Notion public pages render lazily; reading the builder pack programmatically needed scrolling tricks. A plain markdown export of the pack would be kinder to AI-assisted teams.

## Running log

<!-- appended during the hack -->
