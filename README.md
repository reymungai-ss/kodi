# Kodi: rent collection for Baraka Court

Kodi is the "back office" for a WhatsApp rent assistant. Chord (TSG Labs) does
the chatting. Whenever it needs a fact or an action (who is this? what do they
owe? make a payment link) it asks Kodi. Kodi reads and writes your Google Sheet
and talks to Paystack.

```
 Tenant on WhatsApp ──► Chord (the AI agent) ──► Kodi (this server, on Vercel)
                                                   │            │
                                                   ▼            ▼
                                     Google Sheet (via Apps   Paystack
                                     Script web app)          (test mode)
```

Kodi offers Chord six **tools**. Each one takes `from`, the sender's WhatsApp number:

| Tool | Who can use it | What it gives back |
|---|---|---|
| `whoami` | anyone | role (tenant / landlord / caretaker / unknown), unit, name, language |
| `balance` | tenants | month, rent, carried arrears, paid so far, amount due, open plan |
| `pay` | tenants | a Paystack payment link and its reference (optionally with a 2-part plan) |
| `check` | tenants (own unit), landlord, caretaker | did the payment go through? Records it if so |
| `report` | landlord, caretaker | how many units have paid, and who still owes what |
| `escalate` | anyone known | a ticket number. The issue is logged for a human |

When something goes wrong, every tool answers `{ ok: false, code, say }`. `say` is
a polite sentence in the person's language (English or Swahili) that Chord can
send as-is.

> **About the column layout.** Your message mentioned pasting the Data model and
> seed table, but they didn't come through. Kodi currently uses the layout in
> [src/schema.ts](src/schema.ts) and the sample data in [src/seedData.ts](src/seedData.ts).
> Send me your real columns and seed rows and I'll match them. Those two files
> are the only ones that should need to change.

---

## What's in this folder

| Path | What it is |
|---|---|
| `apps-script/Code.gs` | The small program that lives inside your Google Sheet and lets Kodi read/write it |
| `src/` | The Kodi server itself |
| `src/kodi.ts` | All the rent rules, in one place |
| `src/schema.ts` | The tabs and columns of the Sheet |
| `src/seedData.ts` | The sample Baraka Court data |
| `scripts/seed.ts` | Fills the Sheet with the sample data (`npm run seed`) |
| `scripts/reset.ts` | Clears test payments/plans/tickets (`npm run reset`) |
| `scripts/smoke.ts` | Live test against a running Kodi (`npm run smoke`) |
| `test/flow.test.ts` | Offline tests of every rule and error (`npm test`) |

---

## Step 1: Connect the Google Sheet (Apps Script)

You can't use a Google service account, so instead we put a tiny program
*inside* the Sheet. Google runs it under your account and gives it a web
address. Kodi calls that address, and a shared secret (like a password) stops
anyone else from using it.

1. **Open your Google Sheet** (an empty one is fine; the seed script creates the tabs).
2. Menu **Extensions → Apps Script**. A code editor opens in a new tab.
3. **Delete** everything in the `Code.gs` file there, then **paste** the whole
   contents of [apps-script/Code.gs](apps-script/Code.gs). Click the 💾 **Save** icon.
4. **Make the secret.** In your Mac's Terminal, run:
   ```bash
   openssl rand -hex 32
   ```
   Copy the long string it prints. That's your `SHEET_WEBAPP_SECRET`.
5. In Apps Script, click the ⚙️ **Project Settings** (left sidebar) → scroll to
   **Script Properties** → **Add script property**.
   Property: `SHEET_WEBAPP_SECRET`, Value: the string from step 4. **Save**.
6. Click **Deploy → New deployment**. Click the ⚙️ next to "Select type" → **Web app**.
   - Description: `Kodi`
   - Execute as: **Me**
   - Who has access: **Anyone**. (Kodi isn't logged in to Google, so it has to be
     "Anyone". The secret is what keeps strangers out.)
   - Click **Deploy**.
7. Google asks you to **Authorize access**. Choose your account. You'll see
   "Google hasn't verified this app". That's normal for a script you wrote
   yourself. Click **Advanced → Go to (project name) (unsafe) → Allow**.
8. Copy the **Web app URL** (it ends in `/exec`). That's your `SHEET_WEBAPP_URL`.
9. **Check it works:** paste that URL into your browser. You should see
   `{"ok":true,"service":"kodi-sheet-bridge"}`.

> ⚠️ **If you ever change the Apps Script code**, the live URL keeps running the
> *old* version until you go to **Deploy → Manage deployments → ✏️ (edit) →
> Version: New version → Deploy**. The URL stays the same.

## Step 2: Get your Paystack test key

1. Log in to the Paystack dashboard and make sure the **Test Mode** toggle is on.
2. **Settings → API Keys & Webhooks** → copy the **Test Secret Key** (starts with `sk_test_`).
   That's `PAYSTACK_SECRET_KEY`.

Kodi will refuse to start with a live key (`sk_live_`). It is built for test
mode only. It has no refund or transfer code at all.

## Step 3: Run it on your computer

You need **Node.js 20 or newer** ([nodejs.org](https://nodejs.org), pick "LTS").
Open Terminal in this folder, then:

1. Install the building blocks (once):
   ```bash
   npm install
   ```
2. Make your settings file. Copy `.env.example` to `.env` and fill in the four values:
   ```bash
   cp .env.example .env
   ```
   For `KODI_MCP_TOKEN`, make another random string with `openssl rand -hex 32`.
   This is the password Chord will use to talk to Kodi. **Never share `.env` or commit it.**
3. Fill the Sheet with the sample Baraka Court data (it asks you to type `yes` first,
   because it wipes the tabs):
   ```bash
   npm run seed
   ```
4. Start Kodi:
   ```bash
   npm run dev
   ```
   You should see `[kodi] listening on :3000/mcp`. Leave this window open.
5. In a **second** Terminal window, run the live test:
   ```bash
   npm run smoke
   ```
   Each line should say `PASS`. To also test a real (test-mode) payment, run
   `npm run smoke -- --wait`, open the link it prints, and pay with one of
   Paystack's [test cards](https://paystack.com/docs/payments/test-payments/).
   Kodi then confirms it was recorded exactly once.
6. To clear the test payments and tickets afterwards:
   ```bash
   npm run reset
   ```

**Just want to look around without any accounts?** `npm run demo` starts Kodi
with a pretend Sheet and pretend Paystack held in memory. Then `npm run smoke`
in another window. Nothing is saved.

## Step 4: Put it online (Vercel)

Chord needs a public `https://` address to reach Kodi. Vercel hosts it. This
folder is already linked to the Vercel project **kodi** (team Suluhu Studio),
and the four secret settings are already stored there, encrypted.

1. Make sure the Vercel command-line tool is installed and logged in:
   ```bash
   vercel whoami
   ```
2. Publish Kodi:
   ```bash
   vercel deploy --prod
   ```
   Kodi's public address is **`https://kodi-mcp.vercel.app`** (it moves to each
   new production deploy automatically; `kodi-henna.vercel.app` also works).
   (Files listed in `.vercelignore`, including `.env`, are never uploaded.)
3. Check it: open `https://kodi-mcp.vercel.app/health` in a browser. It should show
   `{"ok":true,"service":"kodi","demo":false}`. Then from your computer:
   ```bash
   npm run smoke -- --url https://kodi-mcp.vercel.app/mcp
   ```

**Changing a setting later:** Vercel dashboard → project **kodi** → Settings →
Environment Variables (or `vercel env add NAME production`), then run
`vercel deploy --prod` again so the new value takes effect.

**Why production and not a "preview"?** Vercel locks preview addresses behind
a Vercel login, which Chord can't pass. The production address is public, and
Kodi's own token protects it.

### Alternative: Railway


1. **Put the code on GitHub.** Create a new *private* repository on github.com,
   then in this folder:
   ```bash
   git add -A && git commit -m "Kodi MCP server"
   ```
   and follow GitHub's "push an existing repository" instructions it shows you.
   (`.env` is excluded automatically, so your secrets don't go to GitHub.)
2. On [railway.com](https://railway.com): **New Project → Deploy from GitHub repo** → pick the repo.
   Railway reads `railway.json`, builds Kodi, and starts it.
3. Open the service → **Variables** tab → add the four variables from your `.env`:
   `KODI_MCP_TOKEN`, `SHEET_WEBAPP_URL`, `SHEET_WEBAPP_SECRET`, `PAYSTACK_SECRET_KEY`.
   Railway restarts Kodi with them.
4. **Settings → Networking → Generate Domain.** You get something like
   `https://kodi-production-1234.up.railway.app`.
5. Check it: open `https://<your-domain>/health` in a browser. It should show `{"ok":true,...}`.
   Then from your computer:
   ```bash
   npm run smoke -- --url https://<your-domain>/mcp
   ```

**Render instead?** New → Web Service → connect the repo. Build command:
`npm ci --include=dev && npm run build`. Start command: `npm start`. Health check
path: `/health`. Add the same four environment variables. Render gives you an
`https://….onrender.com` address. (Free Render services fall asleep when idle,
so the first message after a quiet spell can be slow. Railway or a paid Render
plan avoids that.)

## Step 5: Connect it to Chord

In Chord, add a **remote MCP server** with:

- **URL:** `https://kodi-mcp.vercel.app/mcp`
- **Authentication / header:** `Authorization: Bearer <your KODI_MCP_TOKEN>`
  (if Chord asks for a "bearer token", paste just the token)

Tell the Chord agent to always pass the real WhatsApp sender number as `from`,
never a number someone typed in the chat.

---

## Environment variables

| Name | Required | What it is | Where it comes from |
|---|---|---|---|
| `KODI_MCP_TOKEN` | yes | Password Chord must send (`Authorization: Bearer …`). At least 24 characters. | You make it: `openssl rand -hex 32` |
| `SHEET_WEBAPP_URL` | yes | Address of the Apps Script web app, ends in `/exec` | Step 1, item 8 |
| `SHEET_WEBAPP_SECRET` | yes | Shared secret between Kodi and the Apps Script | Step 1, item 4 (same value in Script Properties) |
| `PAYSTACK_SECRET_KEY` | yes | Paystack **test** secret key, `sk_test_…` | Step 2 |
| `TENANT_EMAIL_DOMAIN` | no | Domain for the email Paystack requires on each payment (`a1@<domain>`). Default `tenants.baraka-court.example.com`. Paystack rejects `.test` addresses, so the spec's `baraka-court.test` can't be used | Leave unset unless you want a different domain |
| `PORT` | no | Port to listen on (default 3000) | Railway/Render set it automatically (not used on Vercel) |
| `KODI_DEMO` | no | `1` = pretend Sheet + pretend Paystack, for trying things out | Only for local demos. **Never set on Vercel or Railway.** |

---

## How the rules are enforced

| Rule | Where / how |
|---|---|
| Only `data.status` is trusted; only `"success"` is recorded; the amount recorded is Paystack's `data.amount` | `check` → `recordSuccess` in `src/kodi.ts`; `Paystack.verify` in `src/paystack.ts` reads only `data.*` |
| Never record the same reference twice | The Sheet update has an "unless status is already success" guard, run under a lock inside Apps Script, so even two checks at the same instant can't double-count |
| Reuse an open unpaid link for the same unit + amount | `pay` looks for a `pending` row first. It asks Paystack about it, records it if it was actually paid, and otherwise hands back the same link |
| Reference format `KDI-<unit>-<yyyymm>-<n>` | Reserved in the Sheet *before* Paystack is called, so every link has a ledger row |
| Part-payment plan: ≥50% now, rest by the 20th, one open plan per unit | `checkPlan` in `src/kodi.ts`. The plan closes automatically when the month is fully paid |
| Tenants see only their own unit; unknown numbers get nothing | `identify` + role checks at the top of every tool |
| No refunds or transfers | No such code exists. Only `initialize` and `verify` are ever called |

A few choices I made where your spec left room (easy to change):
- **Month:** "this month" is the newest row in `charges` for the unit that isn't in the future (Nairobi time).
- **Partial payments without a plan** are allowed (any whole amount up to what's due). The 50% rule only applies when a plan is requested.
- **`check` with no reference** looks at the tenant's most recent payment. Landlord/caretaker must give a reference.
- **The plan's remainder** must exactly equal what's left after the first payment.
- **Tenant email:** the spec asked for `<unit>@tenants.baraka-court.test`, but Paystack rejects `.test` as an invalid email. Kodi uses `<unit>@tenants.baraka-court.example.com` instead (`example.com` is reserved, so no mail is ever delivered). Change it with `TENANT_EMAIL_DOMAIN`.

## Tests

- `npm test`: offline. Runs the full main flow plus every error code (including
  Paystack outages and Sheet write failures, which can't safely be caused for real)
  against a pretend Sheet and pretend Paystack. Takes about a second.
- `npm run smoke`: live. Talks to a running Kodi over MCP, exactly as Chord does.

## Changing the Sheet columns

1. Edit the column lists in [src/schema.ts](src/schema.ts) (and the sample rows in [src/seedData.ts](src/seedData.ts)).
2. If you renamed a column Kodi uses, update its name in `src/kodi.ts` too.
3. Run `npm test`, then `npm run seed` to rewrite the Sheet's header rows.
