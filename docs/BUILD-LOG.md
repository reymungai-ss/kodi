# Kodi build log: issues, evidence and fixes

Source material for the TSG Labs submission (problem statement, field notes,
go-live note, README). Everything here happened during the build on
**30 October 2026**. Times are Nairobi time. Error messages are quoted exactly
from logs. Rewrite the field notes in your own words; this is the raw record.

---

## 1. The project in one paragraph

**Baraka Court** is a small residential building (6 flats, one landlord, one
on-site caretaker) that collects rent by chasing tenants on WhatsApp and
reconciling M-Pesa messages by hand. **Kodi** is a Chord teammate that does the
repetitive part. A tenant signs in with house number + PIN, sees what they owe
with the working shown, gets a Paystack link (M-Pesa or card), pays, and Kodi
confirms with Paystack and records it in the building's Google Sheet, exactly
once. Tenants who are short can split the month (at least half now, the rest
by the 20th). The landlord and caretaker can ask who hasn't paid. Anything else
becomes a ticket for John, the caretaker.

**Deliberately left out:** refunds and transfers (no code exists for them),
automatic reminders to late payers, Paystack webhooks (tenants say "I've paid"
and Kodi checks), live keys, a real WhatsApp number, and a real database.

---

## 2. What was built

| Part | What it is | Where |
|---|---|---|
| Chord skill | Instructions + building reference the agent follows | `skills/kodi-rent/` |
| Custom tool | MCP server, Streamable HTTP, bearer token, 6 tools | `src/`, live at `https://kodi-mcp.vercel.app/mcp` |
| Data | Google Sheet with 5 tabs (units, tenants, charges, payments, plans_escalations) | Apps Script bridge in `apps-script/Code.gs` |
| Payments | Paystack test mode: `POST /transaction/initialize`, `GET /transaction/verify/:ref` only | `src/paystack.ts` |
| Hosting | Vercel (Express preset, Node runtime) | `vercel.json`, `.vercelignore` |
| Tests | 29 offline tests (no network) + a live MCP smoke test | `test/flow.test.ts`, `scripts/smoke.ts` |
| Ops scripts | seed, reset | `scripts/` |

**Tools:** `whoami`, `balance`, `pay`, `check`, `report`, `escalate`. Every
failure returns `{ ok: false, code, say }`, where `say` is a polite sentence in
English or Swahili. The codes are `unknown_sender`, `not_your_unit`,
`not_allowed`, `amount_invalid`, `plan_breaks_rules`, `paystack_unavailable`,
`verify_error` and `ledger_write_failed`.

**Payment safety rules, and how each is enforced:**
- **Only Paystack's word counts.** Kodi reads `data.status`, never the
  top-level `status`, records only `success`, and records `data.amount`, not
  the amount requested.
- **Never twice.** A reference can only be marked paid once. The Sheet update
  carries an "unless already success" guard and runs under `LockService`. A
  test runs two simultaneous checks and gets exactly one recording.
- **Every link has a ledger row.** The reference is reserved in the Sheet
  before Paystack is called.
- **No duplicate links.** An open unpaid link for the same unit and amount is
  reused, after first asking Paystack whether it was quietly paid.
- **Test mode only.** Live keys (`sk_live_`) are refused at startup.

---

## 3. Timeline

| Time | Milestone | Commit |
|---|---|---|
| ~10:50 | Project started (empty folder) | |
| ~11:00 | Server, Apps Script, tests passing offline (18/18); demo-mode smoke test passing | |
| ~11:05 | Sheet web app and Paystack key verified; Sheet seeded | |
| ~11:10 | First live run against real Sheet and Paystack: **2 failures** (issue 4.2) | |
| ~11:15 | All live checks pass; real test payment recorded exactly once | |
| 11:22 | Vercel project created, secrets added | |
| 11:27 | First commit; first production deploy (by you) | `ce4c08d` |
| ~11:30 | `.env` found in the deployment (issue 4.4); redeployed clean; old deployment deleted | |
| 11:34 | Moved to `kodi-mcp.vercel.app` (issue 4.5) | `3c6d369` |
| 11:45 | Chord skill written from the brief and Chord docs | `8fc42a1` |
| 11:53 | **Chord connects to Kodi**: initialize 200, initialized 202, tools/list 200 | |
| 11:57 | Simulator: agent has no sender number (issue 4.7) | |
| 11:59 | Request logging added to see what Chord sends | `f025258` |
| 12:07 | House number + PIN sign-in built, deployed; Sheet re-seeded | `960676c` |
| 12:16–12:18 | **First full simulator run works**: sign in, balance, pay, check, recorded once | |
| 12:22 | Go-live note + reviewer README | `55ee059` |
| 12:39 | Skill v2: numbered options, sign-in once, balance working, proactive plans | `51ddeee` |
| 12:47 | Simulator run breaks: duplicate reference + agent disowns its own link (issues 4.9, 4.10) | |
| 12:51 | Fixes for both | `ee93f26` |
| 12:56 | Simulator: "The agent didn't answer" timeout (issue 4.11); tone feedback (issue 4.12) | |
| 13:04 | Speed fixes (measured) + tone rewrite | `1aee164` |
| 13:22 | Agent shows figures without calling `balance`, copied from skill examples (issue 4.13) | |
| ~13:30 | Skill examples replaced with placeholders | see git log |
| 13:28 | Swahili chat switched to English after sign-in (issue 4.14) | |
| 13:31 | Agent disowns a real ticket; repeats "figures are correct" (issue 4.15) | |
| 14:59 | Reply produced with no tool calls; agent declares everything fake (issue 4.16) | |

---

## 4. Issues and fixes

Format for each: **what happened → how the cause was found → fix → what Chord
(or the tool) could change.**

### 4.1 Data model and seed table never arrived
- **What happened:** the original prompt said "paste the Data model section and
  seed table here", but nothing was pasted.
- **Found:** the placeholder text was still in the prompt.
- **Fix:** chose a column layout and sample data, kept in two files
  (`src/schema.ts`, `src/seedData.ts`) so they're easy to swap.
- **Lesson:** keep the schema in one place so a late change is cheap.

### 4.2 Paystack rejected the tenant email domain *(field-note candidate)*
- **What happened:** the first live `pay` against Paystack failed. The tenant
  received `paystack_unavailable` (handled correctly), but no link was created.
  The spec asked for emails like `a1@tenants.baraka-court.test`.
- **Error (server log):**
  `paystack initialize failed for KDI-A1-202610-1 Error: initialize HTTP 400: "email" must be a valid email`
- **Found:** Kodi logs the Paystack response on every failed initialize. One
  manual initialize with `a1@tenants.baraka-court.example.com` returned
  `"Authorization URL created"`.
- **Fix:** the default domain is now `tenants.baraka-court.example.com`.
  `example.com` is reserved, so no mail can be delivered. It's configurable via
  `TENANT_EMAIL_DOMAIN`.
- **Suggestion (Paystack):** document which email formats test mode accepts;
  `.test` is the obvious choice for test data and is rejected.

### 4.3 Seed and deploy blocked by the coding assistant's safety checks
- **What happened:** Claude Code's auto-mode safety check refused to run
  `npm run seed` ("Cloud Storage Mass Delete") and the first `vercel deploy --prod`
  ("Production Deploy").
- **Fix:** you ran those commands yourself. Later deploys went through once you
  had asked for them explicitly. Two small follow-ups: the token-copy command
  failed when run from the home folder (`grep: .env: No such file or directory`)
  and was fixed with an absolute path (`~/kodi/.env`), and the seed prompt waits
  for a typed `yes`.
- **Lesson:** keep destructive scripts interactive, with a confirmation step.

### 4.4 Vercel uploaded `.env` (all secrets) with the first deployment *(field-note candidate)*
- **What happened:** the first production deployment included the local `.env`
  file, which holds the MCP token, the Sheet secret and the Paystack test key.
- **Found:** before the first commit, `.vercelignore` was missing from
  `git status`. The command meant to create it had been blocked as part of the
  denied deploy. Listing the deployment's files through Vercel's API
  (`/v6/deployments/{id}/files`) showed `/src/.env`.
- **Impact checked:** not public. `https://kodi-henna.vercel.app/.env` and
  similar paths returned **404**. Deployment source is visible only to team
  members, and the team has one member.
- **Fix:** added `.vercelignore` (`.env`, `.env.*`, `!.env.example`,
  `node_modules`, `dist`), redeployed, and confirmed the new deployment's 24
  files contain only `.env.example`. Repointed all aliases, then deleted the old
  deployment (`vercel remove`).
- **Suggestion (Vercel):** ignore `.env` by default, as `.env.local` already
  is, or warn when a deploy contains one.

### 4.5 `kodi.vercel.app` was taken; Deployment Protection warning was confusing
- **What happened:** `kodi.vercel.app` already serves another account's site
  (HTTP 200, not in our team's aliases). The deploy also printed
  "Deployment Protection is on (Vercel Authentication)".
- **Found:** `vercel alias ls` and curl. Several candidate names returned
  `x-vercel-error: DEPLOYMENT_NOT_FOUND`, meaning free.
- **Fix:** added `kodi-mcp.vercel.app` as a project domain, so it follows every
  production deploy. Checked that protection applies only to per-deployment URLs
  (HTTP 302 to login); the production alias is public (HTTP 200), and Kodi's
  bearer token protects it.
- **Note:** Chord can't pass Vercel's login, so only production URLs work as
  MCP endpoints.

### 4.6 Vercel guessed the wrong framework
- **What happened:** the new project's framework preset showed "Services".
- **Fix:** `vercel.json` sets `"framework": "express"`. The server exports the
  Express app and calls `listen()` only when not running on Vercel.

### 4.7 Chord's simulator gives the agent no sender phone number *(main field note)*
- **What happened:** the whole design keyed people by WhatsApp number (`from`).
  - In Chord's in-app test chat (Operator), the agent replied: "I can't look up
    your rent from this console… this session doesn't give me one."
  - In the WhatsApp simulator, the first message got Kodi's "Sorry, I don't
    recognise this number". Asked "What phone number do you have for me?", the
    agent replied: "I can't see a phone number for you. No number came through
    with this chat."
- **Found:**
  1. Kodi's log showed one tool call at 11:57:18, made with a placeholder, so
     the agent was guessing.
  2. Request logging (commit `f025258`) recorded what Chord sends on every MCP
     call. Chord's tool calls carry only `user-agent: Java-http-client/23.0.2`
     and `x-real-ip`. There is no sender ID, no phone number, and no MCP
     `_meta`.
  3. The Chord docs (`/docs/chat`) describe `sender_id` as a "stable identifier
     of the person", for example "a phone number", and say `display_name`
     "reaches the teammate as the customer's name".
     Nothing says what reaches tools.
- **Correction to an earlier note:** in a later simulator chat the agent greeted
  the tester as "Hello Rey!", so the **display name does reach the agent**.
  Only the number or sender ID doesn't.
- **Fix:** **house number + PIN** sign-in (commit `960676c`):
  - every tool accepts `account` (house number, or `landlord`/`caretaker`) and
    `pin`, or `from` where a channel supplies a number
  - new `pin` and `pin_failures` columns in the tenants tab
  - 5 wrong tries lock the account until the caretaker sets `pin_failures` to 0
  - a wrong PIN, an unknown house and an ex-tenant all get the identical answer,
    so nothing can be enumerated
  - PINs are never logged (the log records `pin_given: true` only)
  - this also settles the "three tenants called John" question: identity is
    unit + secret, never name
  - 9 new tests
- **Trade-off:** PINs appear in Chord's stored chat history. That's acceptable
  for test data and is flagged in the go-live note.
- **Suggestions for Chord:**
  1. Pass the channel sender ID or phone number to MCP tools, as a header or
     MCP `_meta`, signed or trusted, so tools can identify the person without
     asking for a PIN.
  2. Document per channel exactly what sender context reaches the agent and
     what reaches tools.
  3. Show a placeholder sender in the in-app test chat, or document that it
     has none.

### 4.8 Undocumented "external-customer tool restrictions"
- **What happened:** the Partner OAuth docs say the simulator "retains the
  external-customer tool restrictions" without defining them.
- **Outcome:** this didn't block MCP tools in practice, but it cost time to
  rule out.
- **Suggestion:** define the term or link to it.

### 4.9 Paystack "Duplicate Transaction Reference" after a Sheet reset *(field-note candidate)*
- **What happened:** after `npm run reset` cleared the payments tab, a tenant
  asked to pay KES 7,000 and got "Sorry, I couldn't create a payment link just
  now."
- **Error (server log, 12:47:24):**
  `paystack initialize failed for KDI-A1-202610-1 Error: initialize HTTP 400: Duplicate Transaction Reference`
- **Found:** references are `KDI-<unit>-<yyyymm>-<n>`, with `n` counted from
  the ledger. The reset emptied the ledger, so `n` restarted at 1, but Paystack
  keeps every reference forever, including the earlier test's `-1`.
- **Fix:**
  - commit `ee93f26`: on a duplicate, mark that row failed and try the next `n`
  - commit `1aee164`: ask Paystack first (`verify`, about 0.7 s) whether a
    reference exists, before reserving it in the Sheet (about 4 s), so skipping
    is cheap
  - a test reproduces the reset scenario
- **Lesson:** never derive unique IDs from a table you can wipe; check against
  the system of record.

### 4.10 The agent disowned its own real payment link *(field-note candidate)*
- **What happened:** in the same chat, Kodi created a real link at 12:47:58
  (`KDI-A1-202610-2`). When the tenant said "paid", the agent replied: "I can't
  see that a payment check has been run… The link and reference I gave you,
  KDI-A1-202610-2, were not generated by the system, so please don't use that
  link." It also apologised for earlier, correct, balance figures.
- **Found:** Kodi's log showed **no `check` call** after "paid", and the link
  had been created at 12:47:58. Chord's docs say each call "replays that
  thread's recent turns as context"; the agent's own words show that later
  turns don't include earlier **tool results**. The skill rule "if a tool did
  not tell you, you don't know it" then made the agent distrust its own earlier
  messages.
- **Fix (skill):**
  - earlier messages were based on real tool results; never retract them
  - if a fact is needed again, call the tool again
  - always call `check` when someone says they've paid
  - never narrate internal process
- **Suggestions for Chord:**
  1. Document whether tool calls and results are part of the replayed context.
  2. Ideally, include them (or a summary), so agents don't contradict
     themselves across turns.

### 4.11 "The agent didn't answer. Try sending again." (timeout) *(field-note candidate)*
- **What happened:** the tenant sent "8000" and the simulator showed the
  timeout message. Resending worked, but the agent then said "I need to correct
  myself… the link I sent earlier is genuine", which was confusing.
- **Found:**
  - Timing the dependencies directly: an Apps Script Sheet read took **5.4 s,
    3.6 s and 3.3 s**, and a Paystack verify took **0.7 s**.
  - `pay` made about six Sheet round trips in sequence, plus a write, a
    Paystack call and an update for each skipped reference.
  - The log shows two skips in that call (`-3`, `-4`), which pushed it past
    Chord's wait. Kodi finished in the background, so the resend reused link
    `-5` (`reused: true`), and the agent described that as a correction.
- **Fix (commit `1aee164`):**
  - **Per-request Sheet cache:** each tab is read once per tool call, all tabs
    in parallel, and writes are applied to the cached copy. A test asserts
    exactly 4 reads for a `pay`.
  - **Paystack pre-check** before reserving a reference.
  - **Link saved after the reply,** using Vercel's `waitUntil`.
  - **The skill calls `whoami` once per conversation,** not every turn.
  - **The skill doesn't comment on `reused`.**
- **Measured** on the real Sheet and Paystack:

  | Tool | Before | After |
  |---|---|---|
  | `balance` | 5.0 s | 4.0 s |
  | `pay` | 11.1 s | 7.9 s |
  | `check` | 6.8 s | 3.8 s |
  | each skipped reference | about +10 s | about +0.7 s |

- **Suggestions for Chord:**
  1. Document the tool-call timeout.
  2. Show "tool still running" in the simulator rather than "didn't answer".
  3. Let a tool return early and update later.
- **Go-live implication:** Apps Script adds 3–4 s per call. A real deployment
  should move to a proper database.

### 4.12 Replies were robotic and repetitive
- **What happened:** feedback after the first working run.
  - The agent repeated the full balance breakdown every turn.
  - It narrated its own process ("Thanks for your patience… your sign-in is
    confirmed and the figures are now checked against your account").
  - It offered a plan with amounts and then said plans weren't possible
    (30 October is past the 20th).
- **Fix (skill, commit `1aee164`):**
  - banned phrases listed explicitly
  - full breakdown shown once per conversation, then just the amount
  - "was due 5 October" once the date has passed
  - before offering a plan, check whether today is after the 20th, and if so
    ask "How much can you pay today?" instead
  - 2–3 short option labels
  - name used only in the greeting and payment confirmation
  - good and bad example replies

### 4.13 The agent copied example numbers from the skill instead of calling the tool *(field-note candidate)*
- **What happened:** even after the tone rewrite, replies kept saying "I've now
  checked your account, and the figures I gave earlier were right", and offered
  "KES 9,000 now and KES 9,000 by 20 November" before withdrawing it.
- **Found:** Kodi's log for that chat:
  - 13:22:01, after "A1, 4821": **only `whoami` was called**, yet the agent
    showed a full balance breakdown.
  - 13:23:06: the first `balance` call.

  The skill's example breakdown used *exactly* Amina's figures (KES 18,000, 0,
  0, "was due 5 October"), and the plan example was "KES 9,000 now and KES 9,000
  by 20 November". The agent pasted the examples as if they were data, then
  "confirmed" them once it really called the tool.
- **Fix:**
  - every example in the skill now uses placeholders (`<due_kes>`,
    `<due_date>`), with no figure matching any tenant
  - new hard rule: every amount or date must come from a tool called while
    writing that reply; call `balance` before stating any amount
  - after sign-in, act on what the person already asked for in the same reply
- **Lessons:**
  - Never put realistic data in prompt examples; models treat it as facts.
  - The tool-call log was the only way to see that the "correct" figures had
    never been fetched.
- **Suggestion for Chord:** show tool calls per reply in the simulator, or in
  "Why this reply", so builders can see when the agent answered without calling
  a tool.

### 4.14 The agent switched a Swahili conversation to English
- **What happened:** the tenant opened with "Nataka kulipa". The agent asked
  for house number and PIN in Swahili, then after sign-in said "Language on
  file is English, so I'll continue in English."
- **Found:** the skill said "Once signed in, reply in their `language`", the
  saved preference from the tenants tab (Amina = `en`). The log confirmed
  `whoami` and `balance` were both called (13:28:14), so the figures were real
  this time and issue 4.13 was fixed.
- **Fix (skill):**
  - reply in the language the person writes in, and follow switches and mixes
  - messages with no clear language (PINs, numbers) don't change it
  - the saved language is only a fallback
  - never announce the language or ask which they prefer
  - translate a tool's `say` if the conversation is in the other language
- **Lesson:** a stored preference is a default, not an override; in chat, what
  the person does right now wins.

### 4.15 Prompt rules alone couldn't stop the agent re-checking and narrating *(field-note candidate)*
- **What happened:** even with banned phrases in the skill, replies said "The
  figures are correct, Amina", repeated the balance each turn, and once said
  "The ticket number I gave earlier isn't confirmed, so please don't rely on
  it". That ticket was real.
- **Found:** Kodi's log for the chat:
  - 13:30:33–38: `whoami`, `balance` and **`escalate`**, so ticket
    `ESC-20261030-4EA0` was really created.
  - 13:31:00: `whoami` and `balance` only, then the agent disowned the ticket.
  - Every turn called `whoami` + `balance`, despite "don't call whoami again".

  Same root cause as 4.10: earlier tool results aren't replayed, so the agent
  sees its own claims without evidence. The rule added in 4.13 ("every amount
  must come from a tool called in this reply") pushed it to re-check and then
  comment on the check.
- **Fix (server + skill), working with how Chord behaves rather than against it:**
  - `whoami` now also returns `latest_payment` (reference, amount, status, link)
    and `open_tickets`. The agent calls it every turn anyway, so it now *sees*,
    every turn, that the earlier link and ticket are real.
  - The skill now says: call `whoami` first each reply; earlier messages are true;
    answer only the latest message.
  - A short hard list of phrases it must never write.
  - No duplicate tickets when one is already open.
  - The rule from 4.13 is relaxed to "amounts come from tool results, this
    reply's or ones already stated".
  - New test.
- **Lessons:**
  - When the platform drops context, put the context back through a tool the
    model already calls, instead of adding more instructions.
  - Rules that demand proof make a model narrate its proof.
- **Suggestion for Chord:** include tool results (or a compact summary) in
  replayed history, or offer per-thread memory that tools can write to.

### 4.16 Chord ran a reply without the tools, and the agent declared everything fake *(field-note candidate, possibly Chord-side)*
- **What happened:** after a successful flow (sign-in, balance with KES 6,500
  already paid, part-payment link for KES 9,876), the tenant sent "PAID". The
  agent replied: "I never ran the sign-in or the payment tools in this chat, so
  the account details, the balance and the payment link I gave you were not
  real… Your house number and PIN also didn't match our records on any attempt."
- **Found:** every claim is contradicted by Kodi's records:
  - `whoami` succeeded on every turn (14:56:51–14:58:44), and A1's
    `pin_failures` is 0
  - `pay` at 14:58:44 created `KDI-A1-202610-7` (KES 9,876), which is in the
    Sheet as `pending`
  - **For the "PAID" turn (14:59), Kodi received no request at all.** No tool
    call, no `check`. In every earlier turn the agent called `whoami` first,
    as instructed.

  Chord's skill docs describe a "tool loop" and a "router fallback" that puts
  the reference text inline. Our hypothesis is that this turn ran on the
  fallback without tools, so the model saw no tool results anywhere and
  reasoned that nothing had happened. To confirm, open **Why this reply** on
  that message (look for `reference_delivery: inline` / no tools).
- **Couldn't confirm from Chord's side:**
  - "Why this reply" couldn't be found. Per the docs it's admin-only, and the
    simulator's conversations don't appear in the Chord app (the teammate page
    shows "Customers · 0" after many simulator chats).
  - The API route (`GET /v1/threads/{id}/turns`, which exposes
    `metadata.tools_used`) needs a scoped API key, and the builder account
    couldn't create one.
  - So the only evidence available was Kodi's own request log, which is why
    logging every MCP call (4.7) turned out to be essential.
- **Fix (skill):**
  - if the tools can't be called, send a short holding message ("I can't reach
    the rent records right this moment, please send that again") with
    `1 Try again · 2 Talk to John`
  - never conclude something didn't happen just because no tool result is
    visible
  - more banned phrases
- **Reported to TSG Labs:** *(fill in when you contact them)*
- **Suggestions for Chord:**
  1. Never answer a turn of a tool-using teammate without its tools, or tell
     the model explicitly that tools are temporarily unavailable.
  2. Surface in the simulator when a reply used the fallback path.
  3. Include tool results in replayed history (see 4.10 and 4.15).
  4. Make simulator conversations visible in the app (with "Why this reply") to
     the teammate's owner, or let builders create a read-only API key, so they
     can debug a reply without asking the platform team.

### 4.17 Demo date caveat
- Plans are only possible on or before the 20th, and the build day was the 30th,
  so a plan can't be shown succeeding live until the next month. Plans are
  covered by offline tests that use a mid-month clock. In the simulator, the
  agent now explains the rule and offers a part payment.

---

## 5. Evidence that it works

- **Offline:** 29/29 tests (`npm test`). They cover the main flow, every error
  code, Paystack outages, Sheet write failures, races, plans, PIN rules, the
  cache and the reset scenario.
- **Live smoke test** against `kodi-mcp.vercel.app` and the real Sheet and
  Paystack: 19/19 checks.
- **Recorded once:** a real test payment was recorded with `already_recorded:
  false`, then `true` on the second check, and appears once in the Sheet.
- **First full simulator run** (12:16–12:18): `whoami`/`balance` as A1 with a
  PIN, then `pay`, then `check`. In the Sheet: `KDI-A1-202610-1 success 1000`,
  once.
- **Run after the fixes:** pay KES 8,000 (`KDI-A1-202610-5`), "I've paid" →
  "Your payment of KES 8,000 has gone through. Your balance now is KES 10,000."

---

## 6. Design decisions and trade-offs

| Decision | Why | Trade-off |
|---|---|---|
| Google Sheet via Apps Script (no service account) | Owner-friendly, and no Google Cloud project was allowed | 3–4 s per call; needs caching |
| Stateless MCP server (new server per request) | Survives restarts and multiple Vercel instances | No session state, so identity is checked on every call |
| Reserve the ledger row before calling Paystack | Every link has a row, and nothing is lost if Paystack fails | One extra write per link |
| Record `data.amount`, never the requested amount | The ledger matches what was actually paid | — |
| House number + PIN | The channel gives no sender ID | PIN appears in chat history; PINs stored in plain text in the Sheet |
| Partial payments allowed without a plan | Collecting something beats collecting nothing | The 50% rule applies only to plans |
| `example.com` tenant emails | Paystack rejects `.test` | Receipts go nowhere (fine for tests) |
| No refunds or transfers | Scope and safety | Refunds are done by a person in the Paystack dashboard |

---

## 7. Chord product feedback (all in one place)

1. **Sender identity for tools:** pass the channel sender ID or phone number to
   MCP tools (a header or `_meta`). Today tools get nothing, so every builder
   has to invent sign-in.
2. **Document sender context per channel:** what reaches the agent (the display
   name does) and what reaches tools (nothing).
3. **Tool results in replayed history:** document whether they're included.
   They appear not to be, which led the agent to disown its own real link.
4. **Tool timeout:** document it, and show "still working" in the simulator
   instead of "The agent didn't answer".
5. **Define "external-customer tool restrictions".**
6. **In-app test chat:** say it has no sender, or let builders set one.
7. **Include tool results in replayed history**, or a per-thread memory tools
   can write to; without it agents doubt their own earlier replies.
8. **Never run a tool-using teammate's reply without its tools** (or say so to
   the model); one such reply told a tenant their real link was fake.
9. **Let builders inspect simulator replies:** simulator chats don't appear in
   the app, and builder accounts can't create an API key to read them.
10. **Show tool calls per reply** in the simulator, so builders can see when an
   answer wasn't backed by a tool call.

---

## 8. Known limits and next steps

- **No alerts.** Escalations and lockouts are only rows in the Sheet; nobody is
  told. Add WhatsApp or email alerts, perhaps via Chord escalation rules.
- **No Paystack webhook.** A payment is only recorded when someone asks Kodi to
  check.
- **PINs in plain text** in the Sheet and visible in chat history. Hash them
  and hand them out in person.
- **Apps Script latency.** Move to a database for real use.
- **Monthly charges are entered by hand** in the Sheet.
- **No proactive reminders** to tenants who haven't paid.
- **Live mode needs:** a verified Paystack business, live keys (Kodi refuses
  them today by design), and a real WhatsApp number on Chord.

---

## 9. How AI tools were used (facts to adapt)

- The spec (tools, rules, error codes, Sheet + Apps Script approach) came from
  the builder's prompt.
- Claude Code (Anthropic) wrote the server, Apps Script, tests, scripts, skill
  drafts and docs. It also:
  - ran local and live tests
  - read Vercel logs and listed deployment files
  - measured latency
  - proposed fixes
- The builder:
  - deployed the Apps Script
  - provided keys
  - ran the seed and the first deploys (the assistant's safety checks blocked
    them)
  - created the Chord teammate, connected the MCP server and published skills
  - ran every simulator test
  - spotted the tone problems and drove the skill changes
- Every issue in section 4 was found by running the real system, not in
  planning.
