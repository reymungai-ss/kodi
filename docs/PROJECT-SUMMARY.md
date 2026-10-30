# Kodi: project summary

A complete summary of the Kodi build for the TSG Labs exercise, written on
30 October 2026. Use it as the source for the submission docs. For the
problem-by-problem detail (exact errors, evidence, timestamps), see
[BUILD-LOG.md](BUILD-LOG.md).

---

## 1. Overview

**The business:** Baraka Court, a small residential building in Kenya: six
flats (A1–A3, B1–B3), a landlord (Mr. Kamau) and an on-site caretaker (John
Njoroge).

**The problem:** rent is collected by chasing tenants on WhatsApp and matching
M-Pesa messages by hand. That's repetitive, error-prone and slow for the
caretaker, and tenants get no clear statement of what they owe.

**The solution:** **Kodi**, a Chord teammate that does the job on WhatsApp,
end to end. A tenant:
1. signs in with their house number and PIN
2. sees what they owe, with the working shown (this month, carried from
   earlier, already paid, due, due date)
3. gets a Paystack payment link (M-Pesa or card)
4. pays, says "I've paid", and Kodi confirms with Paystack and records it in
   the building's Google Sheet, exactly once

Tenants who are short can split the month (at least half now, the rest by the
20th) when the date allows. The landlord and caretaker can ask who hasn't paid.
Anything else becomes a ticket for John. Kodi works in English and Swahili.

**Deliberately left out:**
- refunds and transfers (no code for them exists)
- automatic reminders to late payers
- Paystack webhooks (payments are confirmed when the tenant says they've paid)
- live payment keys, a real WhatsApp number, and a real database

---

## 2. What was built

| Part | What it is | Where |
|---|---|---|
| **Chord skill** | The instructions the agent follows, plus a building reference file. Final published version: **v11** | `skills/kodi-rent/SKILL.md`, `skills/kodi-rent/references/building.md` |
| **Custom tool (MCP server)** | TypeScript, official MCP SDK, Streamable HTTP, bearer-token protected, stateless | `src/`, live at **https://kodi-mcp.vercel.app/mcp** |
| **Data** | A Google Sheet with five tabs: `units`, `tenants`, `charges`, `payments`, `plans_escalations` | Google Sheet "Kodi" |
| **Sheet bridge** | Google Apps Script deployed as a web app (no service account needed), protected by a shared secret, with locked writes | `apps-script/Code.gs` |
| **Payments** | Paystack test mode, using only `POST /transaction/initialize` and `GET /transaction/verify/:reference` | `src/paystack.ts` |
| **Hosting** | Vercel (Express preset, Node runtime), production domain `kodi-mcp.vercel.app` | `vercel.json`, `.vercelignore` |
| **Tests** | 31 offline tests (no network), plus a live MCP "smoke test" | `test/flow.test.ts`, `scripts/smoke.ts` |
| **Operations scripts** | `npm run seed` (fill the Sheet with sample data), `npm run reset` (clear test payments, plans and tickets) | `scripts/` |
| **Docs** | Reviewer README, go-live note for the owner, build log, this summary | `README.md`, `GO-LIVE.md`, `docs/` |

### The six tools

Every tool identifies the person by `account` + `pin` (house number, or
`landlord`/`caretaker`), or by `from` (a WhatsApp number) on channels that
provide one.

| Tool | Who | What it does |
|---|---|---|
| `whoami` | anyone | Who this is (role, unit, name, language), plus their **latest payment link** and **open tickets** |
| `balance` | tenants | Rent this month, carried arrears, paid, due, due date, open plan, and **whether a plan is possible right now, with the exact amounts** |
| `pay` | tenants | Creates or reuses a Paystack link and returns `payment_url` + `reference`. Optionally a two-part plan |
| `check` | tenants (own unit), staff | Asks Paystack whether a payment succeeded and records it, exactly once |
| `report` | landlord, caretaker | Paid count, total collected, and who owes what |
| `escalate` | anyone signed in | Creates a ticket for John and returns a `ticket_id` |

Every failure returns `{ ok: false, code, say }`, where `say` is a polite
sentence in English or Swahili. The codes are `unknown_sender`,
`not_your_unit`, `not_allowed`, `amount_invalid`, `plan_breaks_rules`,
`paystack_unavailable`, `verify_error` and `ledger_write_failed`.

### How correctness is guaranteed

- **Only Paystack's word counts.** Kodi records a payment only when Paystack's
  `data.status` is `success`, and it records `data.amount`, never the amount
  requested.
- **Never twice.** A reference can be marked paid only once. The Sheet enforces
  this under a lock, and a test proves two simultaneous checks record it once.
- **Every link has a ledger row.** The reference is written to the Sheet before
  Paystack is called.
- **No duplicate links.** An open unpaid link for the same unit and amount is
  reused, after first asking Paystack whether it was quietly paid.
- **Unique references even after a reset.** References follow
  `KDI-<unit>-<yyyymm>-<n>`, and numbers Paystack already holds are skipped
  automatically.
- **Plan rules are enforced by the server, not the model:** at least 50% now,
  the rest by the 20th, one open plan per unit. `balance` tells the agent
  exactly what's allowed.
- **PIN security:**
  - 5 wrong tries lock the account
  - a wrong PIN, an unknown house and an ex-tenant all get the same answer
  - PINs are never logged
  - tenants only ever see their own unit
- **No refunds or transfers,** and live Paystack keys are refused.

---

## 3. How the build went, phase by phase

### Phase 1: build and test locally (~10:50–11:05)
- Built the server, the six tools, the error messages (English and Swahili),
  the Apps Script bridge, and seed and reset scripts.
- The data model and seed table in the original brief were never pasted, so a
  sensible schema was chosen and kept in two files so it's easy to swap.
- 18 offline tests passed, and a demo mode with a fake Sheet and fake Paystack
  ran the full MCP flow.

### Phase 2: connect the real Sheet and Paystack (~11:05–11:15)
- Deployed the Apps Script and checked that it refuses a wrong secret.
- The first live run failed because Paystack rejected the spec's `.test` email
  addresses. Fixed by switching to `example.com` (issue 4.2).
- All live checks then passed, and a real test payment was recorded exactly
  once.

### Phase 3: deploy to Vercel (~11:20–11:35)
- Created the Vercel project, stored the four secrets encrypted, and adapted
  the server for Vercel.
- **The first deployment uploaded `.env`.** Caught it, confirmed it was never
  public, redeployed without it, and deleted the old deployment (issue 4.4).
- `kodi.vercel.app` was taken, so Kodi uses `kodi-mcp.vercel.app`, which follows
  every production deploy (issue 4.5).

### Phase 4: connect Chord (~11:45–12:00)
- Read the brief and Chord's docs, then wrote the first skill.
- Chord connected to Kodi with the token and listed the six tools.
- **In the simulator, the agent had no sender phone number** (issue 4.7).
  Request logging showed Chord's tool calls carry no sender information at all.

### Phase 5: redesign sign-in (~12:00–12:20)
- Built **house number + PIN** sign-in, with lockout, a uniform "doesn't match"
  answer, and no PINs in logs. Re-seeded the Sheet with PIN columns.
- **First full simulator run worked** (12:16–12:18): sign in, balance, pay,
  check, payment recorded once.
- Later, Chord's API showed the simulator gives every chat a new sender ID, so
  the PIN approach is required, not just a workaround.

### Phase 6: make the conversation good (12:20–15:30, skill v2 → v11)
- **Improvements you asked for:**
  - numbered options on every message
  - sign in once per conversation
  - clear sign-in failure messages that point to John
  - balance shown with its working and due date
  - plans offered before the tenant has to ask
  - follow the language the tenant writes in
- **Problems found in testing and fixed** (all in the build log):
  - Paystack "Duplicate Transaction Reference" after a reset (4.9)
  - the agent disowning its own real link (4.10)
  - Chord timeouts, because each Sheet call takes about 3.5 s. Fixed with a
    per-request cache, a Paystack pre-check and saving the link after the reply
    (4.11). `pay` dropped from 11.1 s to 7.9 s and `check` from 6.8 s to 3.8 s.
  - robotic, repetitive tone (4.12)
  - the agent copying example numbers from the skill instead of calling
    `balance` (4.13)
  - a Swahili chat switched to English (4.14)
  - the agent re-checking and narrating ("the figures are correct"), and
    disowning a real ticket (4.15)
  - a reply that ran with no tool calls and declared everything fake (4.16)
  - a plan offered on the 30th, plus backticks and a meta comment (4.17)
- **The root cause behind most conversation problems,** proven with Chord's
  API: **every reply is a fresh agent run that sees the chat text but not
  earlier tool results.**
- **What finally worked:**
  - putting facts back into a tool the agent calls every turn: `whoami`
    returns the latest link and tickets
  - moving computable rules (plan dates and amounts) into the server
  - placeholder-only examples in the skill
  - a direct "start with the new answer; never comment on earlier messages"
    rule instead of quoting banned phrases

### Phase 7: verification (15:26)
- Checked through Chord's API:
  - every reply ran skill **v11**
  - every reply that gave a figure, a plan answer or a link called the right
    tools (`whoami`, `balance`, `pay`)
  - the plan reply followed the server's "past the 20th" rule
  - no backticks, and no comments on earlier messages

---

## 4. Issues and fixes at a glance

Details, errors and evidence for each are in [BUILD-LOG.md](BUILD-LOG.md), section 4.

| # | Issue | Fix |
|---|---|---|
| 4.1 | Data model / seed table never pasted | Schema kept in two swappable files |
| 4.2 | Paystack rejects `.test` emails | `example.com` domain, configurable |
| 4.3 | Assistant safety checks blocked seed/deploy | Builder ran them; confirmation prompts kept |
| 4.4 | Vercel uploaded `.env` | `.vercelignore`, redeploy, old deployment deleted |
| 4.5 | `kodi.vercel.app` taken; protection warning confusing | `kodi-mcp.vercel.app` project domain |
| 4.6 | Wrong Vercel framework preset | `vercel.json` sets Express |
| 4.7 | **Chord passes no sender number to tools** | House number + PIN sign-in |
| 4.8 | Undocumented "external-customer tool restrictions" | Ruled out; flagged |
| 4.9 | Duplicate reference after a Sheet reset | Skip references Paystack holds (pre-check) |
| 4.10 | Agent disowned its own real link | Skill: trust earlier messages; always `check` on "paid" |
| 4.11 | "The agent didn't answer" timeout | Per-request cache, Paystack pre-check, deferred save |
| 4.12 | Robotic, repetitive replies | Tone rewrite, breakdown shown once |
| 4.13 | Agent copied example figures | Placeholders only; amounts from tools |
| 4.14 | Swahili chat switched to English | Follow the language the person writes in |
| 4.15 | Re-checking and narrating; disowned a real ticket | `whoami` returns latest link + tickets |
| 4.16 | A reply ran with no tools and called everything fake | Holding reply; missing evidence ≠ negative evidence |
| 4.17 | Plan offered on the 30th; backticks; meta comment | `balance.plan` from the server; plain-text options |
| 4.18 | Plans can't succeed after the 20th (demo date) | Covered by offline tests |

---

## 5. Evidence it works

- **Offline:** **31/31 tests** pass (`npm test`). They cover:
  - the main flow and every error code
  - Paystack outages and Sheet write failures
  - races: two simultaneous checks record once
  - plans and plan availability
  - every PIN rule
  - the cache, and the reset scenario
- **Live smoke test** against `kodi-mcp.vercel.app` with the real Sheet and
  Paystack: all checks pass.
- **In the simulator:**
  - full flows with sign-in, balance, pay, Paystack test payment and
    confirmation, each payment recorded once in the Sheet
  - e.g. KES 1,000 at 12:18; KES 8,000 at 12:58; KES 2,400 at 15:21
    (KES 9,100 left, correct)
- **Chord's own records** (`tools_used` per reply, plus the skill inspector)
  confirm v11 behaves as designed.

---

## 6. Running and deploying

| What | How |
|---|---|
| Live endpoint | `https://kodi-mcp.vercel.app/mcp` (health check: `/health`) |
| Settings (`.env`, also in Vercel) | `KODI_MCP_TOKEN`, `SHEET_WEBAPP_URL`, `SHEET_WEBAPP_SECRET`, `PAYSTACK_SECRET_KEY`; optional `TENANT_EMAIL_DOMAIN` |
| Run locally | `npm install`, `npm run dev`; demo without accounts: `npm run demo` |
| Tests | `npm test` (offline), `npm run smoke` (live) |
| Data | `npm run seed` (wipes and fills all tabs), `npm run reset` (clears payments, plans, tickets) |
| Deploy | `vercel deploy --prod` (production only, because Vercel locks previews behind a login Chord can't pass) |
| Chord connection | Remote MCP server, Streamable HTTP, Bearer `KODI_MCP_TOKEN` |
| Publish a skill change | Chord → Skills → Edit draft → Edit `SKILL.md` → paste → Review and publish → Publish skill |
| Test sign-ins | A1 `4821` · A2 `3907` · A3 `5164` · B1 `2689` · B2 `7352` · landlord `9001` · caretaker `9002` |
| Paystack test card | `4084 0840 8408 4081`, any future expiry, CVV `408` |

---

## 7. Feedback for Chord

1. **Pass sender identity to tools.** Tools receive no sender ID or phone
   number, and the simulator's sender ID changes every chat.
2. **Document sender context per channel:** what reaches the agent (the display
   name does) and what reaches tools (nothing).
3. **Include tool results in each run's history.** Every reply is a fresh run
   that sees only text, so agents doubt and disown their own earlier answers.
   Alternatively, offer a per-thread memory tools can write to.
4. **Document the tool timeout,** and show "still working" in the simulator
   instead of "The agent didn't answer".
5. **Make simulator chats inspectable in the app.** The API had `tools_used` and
   the skill inspector, but the app didn't list simulator conversations.
6. **Show tool calls per reply in the simulator,** so builders can see an
   answer that wasn't backed by a tool.
7. **Define "external-customer tool restrictions".**
8. **In-app test chat:** say it has no sender, or let builders set one.

---

## 8. Known limits before going live

See [GO-LIVE.md](../GO-LIVE.md) for the owner-facing version.

- **No alerts yet.** Tickets and lockouts only appear in the Sheet.
- **No Paystack webhook.** A payment is recorded when someone asks Kodi to check.
- **PINs are stored in plain text** in the Sheet, and are visible in Chord's chat
  history.
- **Google Sheet latency** (about 3.5 s per call). Use a database for real use.
- **Monthly charges** are entered by hand.
- **Going live needs:** a verified Paystack business, live keys (refused today by
  design), and a real WhatsApp number on Chord.

---

## 9. How AI tools were used (facts to adapt)

- **Claude Code (Anthropic)** wrote the server, Apps Script, tests, scripts,
  skill drafts and docs. It also:
  - ran tests
  - read Vercel logs and Chord's API
  - measured latency
  - proposed every fix
- **The builder:**
  - wrote the original spec (tools, payment rules, error codes, the Sheet +
    Apps Script approach)
  - deployed the Apps Script, provided keys, and ran the seed and deploys
  - created the Chord teammate, connected the MCP server and published every
    skill version (v1 → v11)
  - ran every simulator test
  - spotted the conversation problems (repetition, tone, language, the "figures
    are correct" narration) and directed the changes
- **Every issue in the build log was found by running the real system.**

---

## 10. Still to do

- [ ] Run `npm run reset`, then record the 3-minute screen recording (sign in →
      balance → pay → Paystack test payment → "I've paid" → confirmed).
- [ ] Problem statement: role preference plus 3–4 sentences (section 1 is a
      starting point).
- [ ] Field notes in your own words. The strongest candidates are 4.7, 4.10/4.15,
      4.11, 4.13 and 4.16.
- [ ] Review [GO-LIVE.md](../GO-LIVE.md) and the README's "How I used AI tools"
      section.
- [ ] Push the repo to a private GitHub repo if a link is needed.
- [ ] **Revoke the Chord API key** (`chord_live_…`): it was pasted in chat and
      isn't needed by Kodi.
- [ ] Tell your TSG Labs contact about the Chord-side findings (sections 7.1, 7.3, 7.5).
