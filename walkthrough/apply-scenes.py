import json, re

# ---- walk-lap.cjs: three new lap scenes before finish
p = "walk-lap.cjs"; s = open(p, encoding="utf-8").read()
new_scenes = r'''
  // 19 · triggers, desktop rules page (live)
  await scene(19, 'Rules carry their own triggers.', async () => {
    await page.goto(L.FRONTEND + '/rules', { waitUntil: 'networkidle' }).catch(() => {});
    await L.injectOverlay(page);
    await L.hold(page, 1500);
    const cells = page.locator('#rules td');
    const n = await cells.count();
    for (const i of [1, 5, 9, 13, 17]) { if (i < n) { await L.moveTo(page, cells.nth(i)); await L.hold(page, 1100); } }
    await page.mouse.wheel(0, 420); await L.hold(page, 2500);
    await page.mouse.wheel(0, 420); await L.hold(page, 2500);
  });

  // 20 · a rule in plain words (local instance, nothing fires)
  await scene(20, 'New rules are plain words.', async () => {
    await page.goto('http://localhost:8788/rules', { waitUntil: 'networkidle' }).catch(() => {});
    await L.injectOverlay(page);
    await page.locator('#ruleText').scrollIntoViewIfNeeded();
    await L.hold(page, 600);
    await L.typeInto(page, '#ruleText', 'Every Sunday at 9 am, order the weekly groceries on Instamart, never more than ₹1500.');
    await L.hold(page, 400);
    await L.clickEl(page, '#proposeBtn', { settle: 500 });
    await page.waitForSelector('#proposeOut:not([hidden])', { timeout: 40000 }).catch(() => {});
    await page.locator('#proposeOut').scrollIntoViewIfNeeded().catch(() => {});
    await L.hold(page, 3500);
    await L.clickEl(page, '#proposeOut [data-do=commit]', { settle: 800 }).catch(() => {});
    await L.hold(page, 2500);
  });

  // 21 · the Dubai proposal, desktop approvals (live)
  await scene(21, 'A calendar trip became an eSIM proposal by itself.', async () => {
    await page.goto(L.FRONTEND + '/approvals', { waitUntil: 'networkidle' }).catch(() => {});
    await L.injectOverlay(page);
    await L.hold(page, 1200);
    const card = page.locator('#view-approvals article, #view-approvals .pcard, #view-approvals .card').first();
    await L.moveTo(page, card).catch(() => {});
    await L.hold(page, 4500);
  });

  const out = await rec.finish('''
assert "\n  const out = await rec.finish(" in s
if "await scene(19," not in s:
    s = s.replace("\n  const out = await rec.finish(", new_scenes, 1)
open(p, "w", encoding="utf-8").write(s); print("walk-lap scenes:", s.count("await scene("))

# ---- merge-timeline.cjs: lap map, drop phone scene 7, new final order
p = "merge-timeline.cjs"; s = open(p, encoding="utf-8").read()
s = s.replace("const LAP_MAP = { 1: 1, 2: 2, 3: 3, 12: 12, 17: 17, 18: 18 };", "const LAP_MAP = { 1: 1, 2: 2, 3: 3, 12: 12, 17: 17, 18: 18, 19: 19, 20: 20, 21: 21 };")
s = re.sub(r"\n  \{ scene: 7,[^\n]*", "", s)
ORDER = [1, 2, 3, 4, 5, 6, 19, 20, 8, 9, 10, 11, 21, 12, 13, 14, 15, 16, 17, 18]
NEW = {str(o): i + 1 for i, o in enumerate(ORDER)}
s = re.sub(r"const NEW_ID = \{[^}]*\};", "const NEW_ID = " + json.dumps(NEW) + ";", s)
open(p, "w", encoding="utf-8").write(s); print("merge: scene7 removed:", "scene: 7," not in s, "| NEW_ID has 21:", '"21"' in s)

# ---- scenes.json in final numbering
old = json.load(open("scenes.json", encoding="utf-8")); byn = {e["n"]: e["text"] for e in old}
PREV = [1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 17, 10, 11, 13, 14, 15, 16, 18]
by_old = {PREV[i]: byn[i + 1] for i in range(18)}
by_old[19] = "Rules carry their own triggers. Every twenty-eight days, the Jio plan. Every month, the medicines. Daily at seven-oh-five, Diet Coke on Instamart. On a signal, a treat. And the calendar rule watches for trips."
by_old[20] = "New rules are plain words. Every Sunday at nine, order the weekly groceries on Instamart, never more than fifteen hundred. Munim reads it back as an exact rule, and nothing is saved until I confirm."
by_old[21] = "Fifteen minutes before this take, a Dubai flight went into my Google Calendar. The next pass turned it into an eSIM proposal: U A E, five days, three dollars seventy-seven. Nothing is bought until I approve, and even then only inside the cap."
by_old[12] = "Same proposal on the phone. One tap approves it, nothing more."
final = [{"n": i + 1, "text": by_old[o]} for i, o in enumerate(ORDER)]
json.dump(final, open("scenes.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2); print("scenes:", len(final))

# ---- config crop -> shade is final 19
c = json.load(open("config.json", encoding="utf-8")); c["crop"] = {"19": "498:335:0:398"}; json.dump(c, open("config.json", "w", encoding="utf-8"), indent=2)

# ---- director META in final numbering
p = "director.cjs"; s = open(p, encoding="utf-8").read()
a = s.index("const META = ["); b = s.index("];", a) + 2
META = """const META = [
  { n: 1,  kind: 'title' },
  { n: 2,  kind: 'lap',   eyebrow: 'FUNDER WALLET',      head: 'ONE SHIELDED DEPOSIT',          sub: 'the spending cap rides inside the encrypted memo' },
  { n: 3,  kind: 'lap',   eyebrow: 'PUBLIC EXPLORER',    head: 'NOTHING TO READ',               sub: 'amount and memo are shielded on-chain' },
  { n: 4,  kind: 'phone', eyebrow: 'ON THE PHONE',       head: 'INSTALLS LIKE AN APP',          sub: 'Chrome → Install. That’s it.' },
  { n: 5,  kind: 'phone', eyebrow: 'NO APP STORE',       head: 'NO TERMINAL',                   sub: 'the household runs it from the home screen' },
  { n: 6,  kind: 'phone', eyebrow: 'TIMELINE',           head: 'CAP ₹300 · ₹389 LEFT',          sub: 'the deposit, decrypted by the purse' },
  { n: 7,  kind: 'lap',   eyebrow: 'TRIGGERS',           head: 'SCHEDULE · SIGNAL · CLOCK · CALENDAR', sub: 'every 28 days · monthly · daily at 19:05 · on a word · on a trip' },
  { n: 8,  kind: 'lap',   eyebrow: 'NEW RULE',           head: 'PLAIN WORDS → EXACT RULE',      sub: '“every Sunday at 9, weekly groceries, max ₹1500”' },
  { n: 9,  kind: 'phone', eyebrow: 'TOPUP RULE',         head: 'FIRE NOW →',                    sub: '₹250 Swiggy Money, when I say so' },
  { n: 10, kind: 'phone', eyebrow: '30 SECONDS LATER',   head: 'BOUGHT. DELIVERED.',            sub: 'Bitrefill invoice · ₹139 left under the cap' },
  { n: 11, kind: 'lap',   eyebrow: 'RECEIPTS',           head: 'ENCRYPTED MEMO → VERIFIED',     sub: 'a hash of the code, never the code' },
  { n: 12, kind: 'lap',   eyebrow: 'PRIVACY NOTE',       head: 'WHO SEES WHAT',                 sub: 'and what nobody can' },
  { n: 13, kind: 'lap',   eyebrow: 'CALENDAR → PROPOSAL', head: 'DUBAI eSIM, BY ITSELF',        sub: 'a flight in Google Calendar became a proposal on the next pass' },
  { n: 14, kind: 'phone', eyebrow: 'APPROVALS',          head: 'ONE TAP TO APPROVE',            sub: 'buys only after approval, only inside the cap' },
  { n: 15, kind: 'phone', eyebrow: 'WALLETS',            head: 'SWIGGY MONEY, AUTO-REDEEMED',   sub: 'the same balance paid this evening’s Instamart order' },
  { n: 16, kind: 'phone', eyebrow: 'CONNECTIONS',        head: 'EVERY LINK, LIVE',              sub: 'Swiggy MCP · Bitrefill · Calendar · wallets' },
  { n: 17, kind: 'phone', eyebrow: 'PUSH',               head: 'ALLOW ONCE',                    sub: '' },
  { n: 18, kind: 'phone', eyebrow: 'PUSH',               head: 'ONE TAP',                       sub: '' },
  { n: 19, kind: 'wide',  eyebrow: 'DELIVERED',          head: 'NEXT TO SWIGGY’S OWN SMS',      sub: 'the ₹250 credit, confirmed by Swiggy' },
  { n: 20, kind: 'end' },
];"""
s = s[:a] + META + s[b:]
open(p, "w", encoding="utf-8").write(s); print("director META:", s.count("{ n:"))

# ---- rebuild.sh: merge before speeds
p = "rebuild.sh"; s = open(p, encoding="utf-8").read()
s = s.replace("node merge-timeline.cjs > /dev/null\nnode stitch.cjs", "node stitch.cjs")
if "merge-timeline" not in s.split("speeds set")[0]:
    s = s.replace('cd "$(dirname "$0")"\n', 'cd "$(dirname "$0")"\nnode merge-timeline.cjs > /dev/null\n', 1)
open(p, "w", encoding="utf-8").write(s); print("rebuild order ok:", s.index("merge-timeline") < s.index("speeds set"))
