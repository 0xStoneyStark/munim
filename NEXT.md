# Next 30 days

What we will do after the hack, in order. Links are added as each lands.

0. **Already started (4 Nov, during the hack):**
   - [zcash/zcash-devtool#272](https://github.com/zcash/zcash-devtool/issues/272) — memo decryption needs `enhance` after `sync`; `list-tx --json` lacks value/memo; unsigned `Amount` on sends. Offered a PR for the JSON shape.
   - [bitrefill/agents#19](https://github.com/bitrefill/agents/issues/19) — MCP docs still show the shut-down key-in-path URL; TOON vs JSON tool output; voucher code format in `instructions`.
   - Hosted at https://munim.heneryshop.com (installable PWA) so the household pilot in step 6 can start now.
1. **PR for `list-tx --json` in `zcash-devtool`** once the maintainers reply on #272 — value, fee, direction, per-output memo/address. This is the one thing every agent built on devtool needs and today has to scrape.
2. **Publish `@munim/zcash-purse` as a standalone npm package + MCP server**, with no dependency on the Munim app. Anyone building an agent on Claude Code / Cursor / Claude Desktop gets a capped, memo-receipting shielded purse in one `npx` command.
3. **Separate the signer.** Move the purse's spend key out of the agent process using devtool's PCZT flow: the agent proposes, a signer with its own policy signs. Then evaluate FROST 2-of-3 (funder + operator + recovery) so the cap is enforced by keys, not by trusting the operator.
4. **Network privacy.** Run the purse and the dashboard's view-only sync over Tor (`--connection tor` already exists in devtool) and test the Nym Zcash SDK as the alternative.
5. **Close the ZEC → USD gap.** Prototype the funder paying ZEC → USDC (NEAR Intents 1Click) → Bitrefill x402, so the operator holds no float. Needs mainnet; we will do it with pocket money.
6. **Pilot with one household** (the builder's own family: Airtel top-ups, Swiggy treats) for two weeks and write up what broke.
7. **ZecHub Friday Lounge** demo if selected for the Ecosystem Prize.
