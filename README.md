# Kodi: WhatsApp rent collection for Baraka Court

Kodi is a Chord teammate that collects rent for a small residential building
over WhatsApp. A tenant signs in with their house number and PIN, asks what they
owe, gets a Paystack link (M-Pesa or card), pays, and Kodi confirms and records
it in the building's Google Sheet. The landlord and caretaker can ask who hasn't
paid. Anything Kodi can't handle becomes a ticket for a person.

```
 WhatsApp (simulator) ──► Chord teammate ──MCP──► Kodi server (Vercel)
   skill: skills/kodi-rent                          │              │
                                                    ▼              ▼
                                        Google Sheet via       Paystack
                                        Apps Script web app    (test mode)
```

- **Skill (the business logic the agent follows):** [skills/kodi-rent/SKILL.md](skills/kodi-rent/SKILL.md), plus [references/building.md](skills/kodi-rent/references/building.md)
- **Custom tool:** an MCP server at `https://kodi-mcp.vercel.app/mcp` (Streamable HTTP, bearer token)
- **Go-live note for the owner:** [GO-LIVE.md](GO-LIVE.md)

## Try it in the simulator

All data is made up, and Paystack runs in test mode.

| Sign in as | Send | Situation |
|---|---|---|
| Amina, tenant | `A1, 4821` | owes KES 18,000 |
| Brian, tenant (Swahili) | `A2, 3907` | owes KES 22,000 incl. 4,000 arrears |
| Grace, tenant | `A3, 5164` | fully paid |
| Hassan, tenant (Swahili) | `B1, 2689` | paid 10,000 of 22,000 |
| Faith, tenant | `B2, 7352` | owes KES 25,000 |
| Landlord | `landlord, 9001` | can ask for the collection report |
| Caretaker | `caretaker, 9002` | same |

A typical run: "How much do I owe?" → `A1, 4821` → "I'll pay 1000" → pay the link
with Paystack's test card `4084 0840 8408 4081` (any future expiry, CVV `408`) →
"I've paid" → Kodi confirms and shows the new balance.

## The tools

Every tool identifies the person by `account` + `pin` (house number, or
`landlord`/`caretaker`), or by `from` (a WhatsApp number) on channels that
provide one.

| Tool | Who | Returns |
|---|---|---|
| `whoami` | anyone | role, unit, name, language |
| `balance` | tenants | month, rent, arrears, paid, due, open plan |
| `pay` | tenants | Paystack `payment_url` + `reference`; optional plan (≥50% now, rest by the 20th) |
| `check` | tenants (own unit), staff | Paystack status; records the payment if it succeeded |
| `report` | landlord, caretaker | paid count and who owes what |
| `escalate` | anyone signed in | `ticket_id` |

Every failure returns `{ ok: false, code, say }`, where `say` is a polite
sentence in the person's language (English or Swahili). The codes are
`unknown_sender`, `not_your_unit`, `not_allowed`, `amount_invalid`,
`plan_breaks_rules`, `paystack_unavailable`, `verify_error` and
`ledger_write_failed`.

**How payments stay correct:**
- **Only Paystack's word counts.** Kodi records a payment only when Paystack's
  `data.status` is `success`, and records `data.amount`, not the amount asked for.
- **Never twice.** A reference can be marked paid only once. The Sheet enforces
  this under a lock, so two simultaneous checks can't double-count it.
- **No duplicate links.** An open unpaid link for the same unit and amount is
  reused, after first asking Paystack whether it was quietly paid.
- **Every link is logged.** The reference is written to the ledger *before*
  Paystack is called, so there's never a link without a ledger row.
- **No refunds or transfers.** That code doesn't exist; Kodi refuses live
  Paystack keys.
- **PIN protection.** Five wrong PINs lock the account. A wrong PIN, an unknown
  house and an ex-tenant all get the same answer.

## Run it yourself

Needs Node.js 20+, a Google Sheet, and a Paystack test secret key.

1. **Sheet bridge:** open the Sheet, then **Extensions → Apps Script**. Paste
   [apps-script/Code.gs](apps-script/Code.gs). Under **Project Settings →
   Script properties**, add `SHEET_WEBAPP_SECRET` (any long random string).
   Then **Deploy → New deployment → Web app**, with execute as *Me* and access
   *Anyone*, and copy the `/exec` URL. (After any code change: **Manage
   deployments → edit → New version**.)
2. **Settings:** run `cp .env.example .env` and fill in the four values
   (see [.env.example](.env.example)).
3. **Install, seed, test:**
   ```bash
   npm install
   npm run seed     # creates the 5 tabs with sample data (asks for "yes"; wipes them)
   npm test         # 27 offline tests: every rule and error code, no network
   npm run dev      # Kodi on http://localhost:3000/mcp
   npm run smoke    # in a second terminal: live MCP test against the server
   npm run reset    # clears test payments, plans and tickets
   ```
   `npm run demo` runs Kodi with an in-memory Sheet and a fake Paystack, so no
   accounts are needed.
4. **Deploy:**
   ```bash
   vercel deploy --prod
   ```
   Add the same four variables in the Vercel project first. Use production, not
   a preview: Vercel puts a login in front of previews, which Chord can't pass.
   `.vercelignore` keeps `.env` out of the upload.
5. **Connect Chord:** in the teammate settings, add a remote MCP server with your
   `/mcp` URL, Streamable HTTP, and Bearer `KODI_MCP_TOKEN`. Then upload
   `skills/kodi-rent` as the teammate's skill (zip the folder).

| Variable | What it is |
|---|---|
| `KODI_MCP_TOKEN` | Bearer token Chord sends; ≥24 characters (`openssl rand -hex 32`) |
| `SHEET_WEBAPP_URL` | Apps Script web app URL (`…/exec`) |
| `SHEET_WEBAPP_SECRET` | Same value as the Apps Script property |
| `PAYSTACK_SECRET_KEY` | Paystack **test** key `sk_test_…` (live keys are refused) |
| `TENANT_EMAIL_DOMAIN` | Optional. Paystack needs an email per payment. The default is `tenants.baraka-court.example.com`, because Paystack rejects `.test` addresses |
| `KODI_DEMO` | Optional. `1` = in-memory Sheet + fake Paystack. Local use only |

## Repo layout

| Path | What |
|---|---|
| `skills/kodi-rent/` | Chord skill: instructions + building reference |
| `src/kodi.ts` | All rent rules (identity, balance, pay, check, plans, report, escalate) |
| `src/mcp.ts` | The six MCP tools and their schemas |
| `src/index.ts` | HTTP server: `/mcp` (bearer-protected, stateless), `/health`, request logging (never logs PINs) |
| `src/paystack.ts` | Paystack initialize + verify only; plus a fake for tests |
| `src/store.ts` | Sheet access via the Apps Script web app; plus an in-memory store for tests |
| `src/schema.ts`, `src/seedData.ts` | Sheet tabs/columns and sample data |
| `apps-script/Code.gs` | Runs inside the Sheet: read / append / update / replace, secret-protected, locked writes |
| `test/flow.test.ts` | Offline tests: main flow, all error codes, outages, PIN rules |
| `scripts/` | `seed`, `reset`, and `smoke` (a live MCP client) |

## What I'd build next

1. **Automatic receipts via Paystack webhooks.** Record a payment the moment
   Paystack confirms it, and send the tenant a receipt without waiting for
   them to say "I've paid".
2. **An M-Pesa prompt sent straight to the tenant's phone,** so they approve
   the payment with their PIN instead of opening a link.
3. **Drop the PIN once Chord passes verified sender identity to tools,** and
   identify tenants by their WhatsApp number instead.
4. **A monthly reminder** via Chord schedules and an approved WhatsApp template.
5. **An SMS fallback** for tenants who don't reply on WhatsApp.
6. **A weekly landlord digest:** who has paid, who owes, and open tickets.

## How I used AI tools

> **Edit this to describe how you actually worked.** A factual starting point:
>
> I used Claude Code (Anthropic) as a pair programmer. I wrote the
> specification (tools, payment rules, error codes, and the Sheet + Apps Script
> approach), and Claude Code wrote most of the server, the Apps Script, the
> tests and the first draft of the skill. I ran every deploy, seed and
> simulator test myself, and debugged with it: reading Vercel logs, adding
> request logging to see what Chord actually sends, and redesigning sign-in
> (house number + PIN) when the simulator turned out not to pass the sender's
> number. The field notes are my own account of those problems.
