import { randomBytes } from "node:crypto";
import { fail, type Failure, type Lang } from "./errors.js";
import { PaystackError, type Payments, type Verified } from "./paystack.js";
import type { Row, TabName } from "./schema.js";
import type { Store } from "./store.js";

// The rent rules for Baraka Court. Each public method is one MCP tool.
// Nothing here knows about MCP or HTTP, so it can be tested on its own.

export type Role = "tenant" | "landlord" | "caretaker";

export interface Person {
  phone: string;
  name: string;
  role: Role;
  unit_id: string;
  language: Lang;
}

/** Who is calling: a WhatsApp number, or a house number + PIN. */
export type Caller = string | { from?: string; account?: string; pin?: string };

export interface Plan {
  second_amount_kes: number;
  second_date: string; // YYYY-MM-DD
}

export interface OpenPlan {
  plan_id: string;
  first_amount_kes: number;
  second_amount_kes: number;
  second_date: string;
}

interface Ledger {
  month: string; // YYYY-MM
  amount_kes: number;
  carried_kes: number;
  paid_kes: number;
  due_kes: number;
  due_date: string | null; // YYYY-MM-DD, from the charges tab
  open_plan: OpenPlan | null;
}

export interface KodiOptions {
  store: Store;
  payments: Payments;
  now?: () => Date;
  log?: (msg: string, extra?: unknown) => void;
  emailDomain?: string;
  /** Lets a write finish after the reply is sent (Vercel's waitUntil). */
  defer?: (work: Promise<unknown>) => void;
}

const PLAN_LAST_DAY = 20;
const MAX_PIN_FAILURES = 5;
// Paystack needs an email per payment. ".test" is rejected by Paystack's
// validator, so the default uses example.com, which is reserved and never
// delivers mail. Override with TENANT_EMAIL_DOMAIN.
const DEFAULT_EMAIL_DOMAIN = "tenants.baraka-court.example.com";

export class Kodi {
  private store: Store;
  private payments: Payments;
  private now: () => Date;
  private log: (msg: string, extra?: unknown) => void;
  private emailDomain: string;
  private defer: (work: Promise<unknown>) => void;

  constructor(opts: KodiOptions) {
    this.store = opts.store;
    this.payments = opts.payments;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((msg, extra) => console.error(`[kodi] ${msg}`, extra ?? ""));
    this.emailDomain = opts.emailDomain || DEFAULT_EMAIL_DOMAIN;
    this.defer = opts.defer ?? ((work) => void work);
  }

  /** Starts reading tabs in parallel if the store caches reads (see RequestCache). */
  private warm(...tabs: TabName[]) {
    (this.store as Store & { warm?: (...t: TabName[]) => void }).warm?.(...tabs);
  }

  // ---- whoami --------------------------------------------------------------

  async whoami(who: Caller) {
    this.warm("tenants", "payments", "plans_escalations");
    const me = await this.resolve(who);
    // An unknown phone number learns only that it's unknown. Wrong or missing
    // house number + PIN gets a sentence asking for them again.
    if ("ok" in me) return usesPin(who) || !callerPhone(who) ? me : { ok: true as const, role: "unknown" as const };

    // Chord shows the agent its earlier messages but not the tool results
    // behind them. Returning the latest link and open tickets here lets the
    // agent see, on every turn, that references it mentioned before are real.
    const [payments, tickets] = await Promise.all([this.store.read("payments"), this.store.read("plans_escalations")]);
    const isTenant = me.role === "tenant";
    const latest = isTenant ? payments.filter((p) => p.unit_id === me.unit_id && p.status !== "failed").at(-1) : undefined;
    const open = tickets
      .filter((t) => t.kind === "escalation" && t.status === "open" && (!isTenant || t.unit_id === me.unit_id))
      .slice(-5)
      .map((t) => ({ ticket_id: t.id, unit_id: t.unit_id || null, reason: t.reason, created_at: t.created_at }));

    return {
      ok: true as const,
      role: me.role,
      unit_id: me.unit_id || null,
      name: me.name,
      language: me.language,
      latest_payment: latest
        ? {
            reference: latest.reference,
            amount_kes: toInt(latest.amount_kes),
            status: latest.status,
            payment_url: latest.payment_url || null,
          }
        : null,
      open_tickets: open,
    };
  }

  // ---- balance -------------------------------------------------------------

  async balance(who: Caller) {
    this.warm("tenants", "charges", "payments", "plans_escalations");
    const me = await this.resolve(who);
    if ("ok" in me) return me;
    if (me.role !== "tenant") return fail("not_allowed", me.language, "balance");
    const ledger = await this.ledger(me.unit_id);
    return { ok: true as const, unit_id: me.unit_id, ...ledger, plan: this.planOffer(ledger) };
  }

  /**
   * Whether a part-payment plan is possible right now, and the exact amounts
   * to offer. The agent repeats this instead of doing date or rounding maths
   * itself (it once offered a plan on the 30th). `pay` enforces the same rules.
   */
  private planOffer(ledger: Ledger) {
    const today = nairobiDate(this.now());
    const lastDay = `${ledger.month}-${String(PLAN_LAST_DAY).padStart(2, "0")}`;
    const unavailable = (reason: "nothing_due" | "open_plan" | "past_20th") => ({
      available: false as const,
      reason,
      latest_second_date: lastDay,
    });
    if (ledger.due_kes < 2) return unavailable("nothing_due");
    if (ledger.open_plan) return unavailable("open_plan");
    if (today > lastDay) return unavailable("past_20th");
    const first = Math.ceil(ledger.due_kes / 2);
    return {
      available: true as const,
      min_first_kes: first,
      suggested_first_kes: first,
      suggested_second_kes: ledger.due_kes - first,
      earliest_second_date: today,
      latest_second_date: lastDay,
    };
  }

  // ---- pay -----------------------------------------------------------------

  async pay(who: Caller, amount_kes: number, plan?: Plan) {
    this.warm("tenants", "charges", "payments", "plans_escalations");
    const me = await this.resolve(who);
    if ("ok" in me) return me;
    if (me.role !== "tenant") return fail("not_allowed", me.language, "pay");
    const lang = me.language;
    const unit = me.unit_id;

    let ledger = await this.ledger(unit);
    if (!Number.isInteger(amount_kes) || amount_kes < 1) {
      return fail("amount_invalid", lang, undefined, { due: ledger.due_kes });
    }

    // Is there already an unpaid link for this unit and amount? Ask Paystack
    // about it first: if it was quietly paid, record it rather than reuse it.
    let reusable: Row | undefined;
    const payments = await this.store.read("payments");
    const candidates = payments.filter(
      (p) =>
        p.unit_id === unit &&
        p.month === ledger.month &&
        p.status === "pending" &&
        p.payment_url &&
        toInt(p.amount_kes) === amount_kes,
    );
    for (const p of candidates) {
      let v: Verified | null = null;
      try {
        v = await this.payments.verify(p.reference);
      } catch (err) {
        this.log(`verify before reuse failed for ${p.reference}`, String(err));
        reusable ??= p; // can't tell; reusing is safe, Paystack won't charge a reference twice
        continue;
      }
      if (v && v.status === "success" && v.reference === p.reference) {
        const rec = await this.recordSuccess(p, v);
        if (rec === "failed") return fail("ledger_write_failed", lang, "after_payment");
        ledger = await this.ledger(unit);
      } else if (v && ["failed", "reversed"].includes(v.status)) {
        await this.store.update("payments", { reference: p.reference }, { status: v.status }, { status: "success" }).catch(() => 0);
      } else {
        reusable ??= p;
      }
    }

    if (ledger.due_kes <= 0) return fail("amount_invalid", lang, "nothing_due");
    if (amount_kes > ledger.due_kes) return fail("amount_invalid", lang, undefined, { due: ledger.due_kes });

    if (plan) {
      const bad = this.checkPlan(ledger, amount_kes, plan, lang);
      if (bad) return bad;
    }

    let reference: string;
    let payment_url: string;
    let reused = false;

    if (reusable) {
      reference = reusable.reference;
      payment_url = reusable.payment_url;
      reused = true;
    } else {
      const created = await this.createLink(me, ledger.month, amount_kes, payments, Boolean(plan));
      if ("ok" in created) return created;
      ({ reference, payment_url } = created);
    }

    let plan_id: string | null = null;
    if (plan) {
      plan_id = `PLN-${reference.slice(4)}`;
      try {
        await this.store.append("plans_escalations", [
          {
            id: plan_id,
            kind: "plan",
            unit_id: unit,
            from: me.phone,
            month: ledger.month,
            status: "open",
            first_amount_kes: String(amount_kes),
            second_amount_kes: String(plan.second_amount_kes),
            second_date: plan.second_date,
            created_at: this.now().toISOString(),
          },
        ], "id");
        await this.store.update("payments", { reference }, { plan_id });
      } catch (err) {
        this.log("plan write failed", String(err));
        return fail("ledger_write_failed", lang);
      }
    }

    return { ok: true as const, reference, payment_url, amount_kes, reused, plan_id };
  }

  private checkPlan(ledger: Ledger, amount: number, plan: Plan, lang: Lang): Failure | null {
    if (ledger.open_plan) return fail("plan_breaks_rules", lang, "exists");
    const min = Math.ceil(ledger.due_kes / 2);
    const rest = ledger.due_kes - amount;
    const vars = { min, rest: Math.max(ledger.due_kes - min, 0) };
    if (amount < min) return fail("plan_breaks_rules", lang, undefined, vars);
    if (rest <= 0 || plan.second_amount_kes !== rest) return fail("plan_breaks_rules", lang, undefined, vars);

    const today = nairobiDate(this.now());
    const lastDay = `${ledger.month}-${String(PLAN_LAST_DAY).padStart(2, "0")}`;
    if (today > lastDay) return fail("plan_breaks_rules", lang, "too_late");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(plan.second_date) || plan.second_date < today || plan.second_date > lastDay) {
      return fail("plan_breaks_rules", lang, "date");
    }
    return null;
  }

  private async createLink(
    me: Person,
    month: string,
    amount_kes: number,
    existing: Row[],
    isPlan: boolean,
  ): Promise<{ reference: string; payment_url: string } | Failure> {
    const lang = me.language;
    const unit = me.unit_id;
    const yyyymm = month.replace("-", "");
    let n = existing.filter((p) => p.unit_id === unit && p.month === month).length + 1;

    // Paystack remembers every reference forever, including ones from before a
    // Sheet reset, so a reference that's free in the ledger can still be taken
    // at Paystack. On "Duplicate Transaction Reference" we move to the next n.
    let reference = "";
    let payment_url = "";
    for (let attempt = 0; attempt < 8 && !payment_url; attempt++, n++) {
      reference = `KDI-${unit}-${yyyymm}-${n}`;
      // Asking Paystack is fast (~0.7s); a Sheet write is slow (~4s). Skip
      // references Paystack already holds before touching the Sheet.
      const known = await this.payments.verify(reference).catch(() => null);
      if (known) continue;

      // 1. Reserve the reference in the ledger first, so every Paystack link has a row.
      try {
        const res = await this.store.append("payments", [
          {
            reference,
            unit_id: unit,
            month,
            amount_kes: String(amount_kes),
            status: "pending",
            from: me.phone,
            created_at: this.now().toISOString(),
          },
        ], "reference");
        if (res === "duplicate") continue; // taken in the ledger; try the next n
      } catch (err) {
        this.log("could not reserve reference", String(err));
        return fail("ledger_write_failed", lang);
      }

      // 2. Ask Paystack for the link.
      try {
        const init = await this.payments.initialize({
          amountKes: amount_kes,
          reference,
          email: `${unit.toLowerCase()}@${this.emailDomain}`,
          metadata: { building: "Baraka Court", unit_id: unit, month, kind: isPlan ? "plan_first" : "rent" },
        });
        payment_url = init.authorization_url;
      } catch (err) {
        const duplicate = err instanceof PaystackError && /duplicate/i.test(err.message);
        this.log(`paystack initialize failed for ${reference}${duplicate ? " (reference taken at Paystack, trying next)" : ""}`, String(err));
        await this.store.update("payments", { reference }, { status: "failed" }).catch(() => 0);
        if (!duplicate) return fail("paystack_unavailable", lang);
      }
    }
    if (!payment_url) return fail("paystack_unavailable", lang);

    // 3. Save the link so it can be reused, after the reply goes out. If this
    //    write fails the link still works; it just won't be reused.
    this.defer(
      this.store.update("payments", { reference }, { payment_url }).catch((err) =>
        this.log(`could not save payment_url for ${reference}`, String(err)),
      ),
    );
    return { reference, payment_url };
  }

  // ---- check ---------------------------------------------------------------

  async check(who: Caller, reference?: string) {
    this.warm("tenants", "charges", "payments", "plans_escalations");
    const me = await this.resolve(who);
    if ("ok" in me) return me;
    const lang = me.language;
    const isStaff = me.role !== "tenant";

    const payments = await this.store.read("payments");
    let row: Row | undefined;
    if (reference) {
      reference = reference.trim().toUpperCase();
      row = payments.find((p) => p.reference.toUpperCase() === reference);
      const unitOfRef = row?.unit_id ?? reference.split("-")[1];
      if (!isStaff && unitOfRef !== me.unit_id) return fail("not_your_unit", lang);
      if (!row) return fail("verify_error", lang, "not_found");
    } else {
      if (isStaff) return fail("not_allowed", lang, "need_reference");
      // Rows are appended in time order, so the last one is the newest.
      row = payments.filter((p) => p.unit_id === me.unit_id && p.status !== "failed").at(-1);
      if (!row) {
        const ledger = await this.ledger(me.unit_id);
        return { ok: true as const, reference: null, status: "none", amount_kes: 0, due_kes_after: ledger.due_kes, already_recorded: false };
      }
    }

    const done = async (status: string, amount_kes: number, already_recorded: boolean) => {
      const ledger = await this.ledger(row!.unit_id);
      return { ok: true as const, reference: row!.reference, status, amount_kes, due_kes_after: ledger.due_kes, already_recorded };
    };

    if (row.status === "success") return done("success", toInt(row.paid_kes), true);

    let v: Verified | null;
    try {
      v = await this.payments.verify(row.reference);
    } catch (err) {
      this.log(`verify failed for ${row.reference}`, String(err));
      return fail("verify_error", lang);
    }
    if (!v) return fail("verify_error", lang, "not_found");
    if (v.reference && v.reference !== row.reference) {
      this.log(`verify returned a different reference`, { asked: row.reference, got: v.reference });
      return fail("verify_error", lang);
    }

    if (v.status === "success") {
      if (v.currency && v.currency !== "KES") {
        this.log(`unexpected currency ${v.currency} for ${row.reference}`);
        return fail("verify_error", lang);
      }
      const rec = await this.recordSuccess(row, v);
      if (rec === "failed") return fail("ledger_write_failed", lang, "after_payment");
      return done("success", v.amount / 100, rec === "already");
    }

    if (["failed", "reversed"].includes(v.status) && row.status !== v.status) {
      await this.store.update("payments", { reference: row.reference }, { status: v.status }, { status: "success" }).catch(() => 0);
    }
    return done(v.status, toInt(row.amount_kes), false);
  }

  /**
   * Marks a payment as paid, using the amount Paystack says was paid (data.amount),
   * never the amount we asked for. The `unless: success` guard in the Sheet means
   * the same reference can never be recorded twice, even if two checks race.
   */
  private async recordSuccess(row: Row, v: Verified): Promise<"recorded" | "already" | "failed"> {
    let changed: number;
    try {
      changed = await this.store.update(
        "payments",
        { reference: row.reference },
        {
          status: "success",
          paid_kes: String(v.amount / 100),
          verified_at: this.now().toISOString(),
          channel: v.channel,
        },
        { status: "success" },
      );
    } catch (err) {
      this.log(`ledger write failed for ${row.reference}`, String(err));
      return "failed";
    }
    if (changed === 0) return "already";

    // If that cleared the month, close any open plan.
    try {
      const ledger = await this.ledger(row.unit_id);
      if (ledger.due_kes <= 0 && ledger.open_plan) {
        await this.store.update("plans_escalations", { id: ledger.open_plan.plan_id }, { status: "done" });
      }
    } catch (err) {
      this.log("could not close plan", String(err));
    }
    return "recorded";
  }

  // ---- report --------------------------------------------------------------

  async report(who: Caller, month?: string) {
    this.warm("tenants", "units", "charges", "payments", "plans_escalations");
    const me = await this.resolve(who);
    if ("ok" in me) return me;
    if (me.role === "tenant") return fail("not_allowed", me.language, "report");

    const [units, tenants, charges, payments, plans] = await Promise.all([
      this.store.read("units"),
      this.store.read("tenants"),
      this.store.read("charges"),
      this.store.read("payments"),
      this.store.read("plans_escalations"),
    ]);
    const current = nairobiMonth(this.now());
    month ??= charges.map((c) => c.month).filter((m) => m <= current).sort().at(-1) ?? current;

    const billed = charges.filter((c) => c.month === month);
    let paid_count = 0;
    let collected_kes = 0;
    let outstanding_kes = 0;
    const outstanding: Array<Record<string, unknown>> = [];

    for (const c of billed.sort((a, b) => a.unit_id.localeCompare(b.unit_id))) {
      const paid = sumPaid(payments, c.unit_id, month);
      const due = Math.max(0, toInt(c.rent_kes) + toInt(c.carried_kes) - paid);
      collected_kes += paid;
      if (due <= 0) {
        paid_count++;
        continue;
      }
      outstanding_kes += due;
      const tenant = tenants.find((t) => t.unit_id.toUpperCase() === c.unit_id && t.role.trim().toLowerCase() === "tenant" && isActive(t));
      const plan = plans.find((p) => p.kind === "plan" && p.unit_id === c.unit_id && p.status === "open");
      outstanding.push({
        unit_id: c.unit_id,
        name: tenant?.name ?? null,
        due_kes: due,
        paid_kes: paid,
        open_plan: plan ? { second_amount_kes: toInt(plan.second_amount_kes), second_date: plan.second_date } : null,
      });
    }

    return {
      ok: true as const,
      month,
      units_total: units.length,
      units_billed: billed.length,
      paid_count,
      collected_kes,
      outstanding_kes,
      outstanding,
    };
  }

  // ---- escalate ------------------------------------------------------------

  async escalate(who: Caller, reason: string, summary: string, unit_id?: string) {
    this.warm("tenants");
    const me = await this.resolve(who);
    if ("ok" in me) return me;
    const lang = me.language;

    let unit = unit_id?.trim().toUpperCase() || "";
    if (me.role === "tenant") {
      if (unit && unit !== me.unit_id) return fail("not_your_unit", lang);
      unit = me.unit_id;
    }

    const now = this.now();
    const ticket_id = `ESC-${nairobiDate(now).replace(/-/g, "")}-${randomBytes(2).toString("hex").toUpperCase()}`;
    try {
      await this.store.append("plans_escalations", [
        {
          id: ticket_id,
          kind: "escalation",
          unit_id: unit,
          from: me.phone,
          month: nairobiMonth(now),
          status: "open",
          reason: reason.slice(0, 200),
          summary: summary.slice(0, 2000),
          created_at: now.toISOString(),
        },
      ], "id");
    } catch (err) {
      this.log("escalation write failed", String(err));
      return fail("ledger_write_failed", lang);
    }
    return { ok: true as const, ticket_id };
  }

  // ---- shared helpers ------------------------------------------------------

  /**
   * Works out who is asking. Two ways in:
   * - `from`: a WhatsApp number supplied by the channel (trusted when the
   *   platform provides it);
   * - `account` + `pin`: a house number (or "landlord"/"caretaker") plus the
   *   PIN from the tenants tab, for channels that don't reveal the number.
   * After MAX_PIN_FAILURES wrong PINs the account locks until someone clears
   * `pin_failures` in the Sheet.
   */
  async resolve(who: Caller): Promise<Person | Failure> {
    if (usesPin(who)) return this.byPin(who.account!, who.pin!);
    const phone = normalizePhone(callerPhone(who));
    if (!phone) return fail("unknown_sender", "en", "need_pin");
    const tenants = await this.store.read("tenants");
    const t = tenants.find((r) => normalizePhone(r.phone) === phone && isActive(r));
    return (t && toPerson(t)) || fail("unknown_sender");
  }

  private async byPin(accountRaw: string, pinRaw: string): Promise<Person | Failure> {
    const account = accountRaw.trim().toUpperCase().replace(/^(HOUSE|UNIT|FLAT)\s*/, "");
    const pin = pinRaw.trim();
    const tenants = await this.store.read("tenants");
    const candidates = tenants.filter((r) => {
      if (!isActive(r)) return false;
      const role = r.role.trim().toLowerCase();
      if (role === "tenant") return r.unit_id.trim().toUpperCase() === account;
      return role === account.toLowerCase() && (role === "landlord" || role === "caretaker");
    });
    const lang = candidates[0]?.language.trim().toLowerCase() === "sw" ? "sw" : "en";
    if (candidates.some((r) => toInt(r.pin_failures) >= MAX_PIN_FAILURES)) {
      return fail("not_allowed", lang, "locked");
    }

    const match = /^\d{4,8}$/.test(pin) ? candidates.find((r) => (r.pin ?? "").trim() === pin) : undefined;
    if (!match) {
      // Count the miss against every account it could have been for. Unknown
      // house numbers get the same answer, so nothing is revealed.
      for (const r of candidates) {
        await this.store
          .update("tenants", { phone: r.phone }, { pin_failures: String(toInt(r.pin_failures) + 1) })
          .catch((err) => this.log("could not count PIN failure", String(err)));
      }
      return fail("unknown_sender", lang, "bad_pin");
    }
    if (toInt(match.pin_failures) > 0) {
      await this.store.update("tenants", { phone: match.phone }, { pin_failures: "0" }).catch(() => 0);
    }
    return toPerson(match) ?? fail("unknown_sender", lang, "bad_pin");
  }

  private async ledger(unit: string): Promise<Ledger> {
    const [charges, payments, plans] = await Promise.all([
      this.store.read("charges"),
      this.store.read("payments"),
      this.store.read("plans_escalations"),
    ]);
    const current = nairobiMonth(this.now());
    const mine = charges.filter((c) => c.unit_id.toUpperCase() === unit).sort((a, b) => a.month.localeCompare(b.month));
    // The latest charge that isn't in the future; fall back to the latest of all.
    const charge = mine.filter((c) => c.month <= current).at(-1) ?? mine.at(-1);
    const month = charge?.month ?? current;
    const amount_kes = toInt(charge?.rent_kes);
    const carried_kes = toInt(charge?.carried_kes);
    const paid_kes = sumPaid(payments, unit, month);
    const plan = plans.find((p) => p.kind === "plan" && p.unit_id === unit && p.status === "open");
    return {
      month,
      amount_kes,
      carried_kes,
      paid_kes,
      due_kes: Math.max(0, amount_kes + carried_kes - paid_kes),
      due_date: charge?.due_date || null,
      open_plan: plan
        ? {
            plan_id: plan.id,
            first_amount_kes: toInt(plan.first_amount_kes),
            second_amount_kes: toInt(plan.second_amount_kes),
            second_date: plan.second_date,
          }
        : null,
    };
  }
}

// ---- small pure helpers (exported for tests) --------------------------------

/** "+254 712 345 678", "0712345678", "whatsapp:+254712345678" → "254712345678". */
export function normalizePhone(raw: string | undefined): string {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (d.length === 10 && d.startsWith("0")) d = "254" + d.slice(1);
  if (d.length === 9 && /^[17]/.test(d)) d = "254" + d;
  return d.length >= 9 ? d : "";
}

function usesPin(who: Caller): who is { account: string; pin: string } {
  return typeof who === "object" && Boolean(who.account?.trim()) && Boolean(who.pin?.trim());
}

function callerPhone(who: Caller): string {
  return typeof who === "string" ? who : (who.from ?? "");
}

function toPerson(t: Row): Person | null {
  const role = t.role.trim().toLowerCase();
  if (role !== "tenant" && role !== "landlord" && role !== "caretaker") return null;
  if (role === "tenant" && !t.unit_id) return null;
  return {
    phone: normalizePhone(t.phone) || t.phone,
    name: t.name,
    role,
    unit_id: t.unit_id.trim().toUpperCase(),
    language: t.language.trim().toLowerCase() === "sw" ? "sw" : "en",
  };
}

function toInt(v: string | undefined): number {
  const n = Number(String(v ?? "").replace(/[,\s]|KES/gi, ""));
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function isActive(r: Row): boolean {
  return !/^(no|false|0|inactive)$/i.test((r.active ?? "").trim());
}

function sumPaid(payments: Row[], unit: string, month: string): number {
  return payments
    .filter((p) => p.unit_id === unit && p.month === month && p.status === "success")
    .reduce((s, p) => s + toInt(p.paid_kes), 0);
}

// Kenya is UTC+3 all year (no daylight saving), so a fixed offset is exact.
function nairobi(d: Date): Date {
  return new Date(d.getTime() + 3 * 3600 * 1000);
}
export function nairobiDate(d: Date): string {
  return nairobi(d).toISOString().slice(0, 10);
}
export function nairobiMonth(d: Date): string {
  return nairobi(d).toISOString().slice(0, 7);
}
