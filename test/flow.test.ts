// Offline tests: the real Kodi rules, with an in-memory Sheet and a fake
// Paystack. Nothing touches the internet. Run: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { Kodi, normalizePhone } from "../src/kodi.js";
import { FakePaystack } from "../src/paystack.js";
import { TABS, type TabName } from "../src/schema.js";
import { seedRows } from "../src/seedData.js";
import { MemoryStore } from "../src/store.js";

const AMINA = "+254 700 000 101"; // A1, en, owes 18,000
const BRIAN = "0700000102"; // A2, sw, owes 22,000 (18,000 + 4,000 carried)
const GRACE = "whatsapp:+254700000103"; // A3, fully paid
const HASSAN = "254700000104"; // B1, paid 10,000 of 22,000
const FAITH = "254700000105"; // B2, owes 25,000
const FORMER = "254700000199"; // inactive
const LANDLORD = "254700000901";
const CARETAKER = "254700000902";
const STRANGER = "254799999999";

let now = new Date("2026-11-10T06:00:00Z"); // 10 Nov, 09:00 in Nairobi
let store: MemoryStore;
let paystack: FakePaystack;
let kodi: Kodi;

beforeEach(() => {
  now = new Date("2026-11-10T06:00:00Z");
  store = new MemoryStore();
  const seed = seedRows(now);
  for (const tab of Object.keys(TABS) as TabName[]) store.tabs[tab] = seed[tab];
  paystack = new FakePaystack();
  kodi = new Kodi({ store, payments: paystack, now: () => now, log: () => {} });
});

const successRows = (ref: string) =>
  store.tabs.payments.filter((p) => p.reference === ref && p.status === "success").length;

describe("main flow", () => {
  test("whoami → balance → pay → check (unpaid) → pay at Paystack → check → recorded once", async () => {
    assert.deepEqual(await kodi.whoami(AMINA), {
      ok: true, role: "tenant", unit_id: "A1", name: "Amina Wanjiru", language: "en",
    });

    const bal = await kodi.balance(AMINA);
    assert.equal(bal.ok, true);
    assert.deepEqual(bal, {
      ok: true, unit_id: "A1", month: "2026-11", amount_kes: 18000, carried_kes: 0, paid_kes: 0, due_kes: 18000, open_plan: null,
    });

    const pay = await kodi.pay(AMINA, 18000);
    assert.ok(pay.ok);
    assert.equal(pay.reference, "KDI-A1-202611-1");
    assert.match(pay.payment_url, /^https:\/\//);
    assert.equal(pay.reused, false);

    // Asking again for the same amount reuses the open link.
    const again = await kodi.pay(AMINA, 18000);
    assert.ok(again.ok);
    assert.equal(again.reference, pay.reference);
    assert.equal(again.reused, true);
    assert.equal(paystack.initializeCalls, 1);

    // Not paid yet: Paystack says "abandoned", nothing recorded.
    const pending = await kodi.check(AMINA);
    assert.ok(pending.ok);
    assert.equal(pending.status, "abandoned");
    assert.equal(pending.due_kes_after, 18000);
    assert.equal(successRows(pay.reference), 0);

    paystack.pay(pay.reference);
    const paid = await kodi.check(AMINA, pay.reference);
    assert.deepEqual(paid, {
      ok: true, reference: "KDI-A1-202611-1", status: "success", amount_kes: 18000, due_kes_after: 0, already_recorded: false,
    });

    const twice = await kodi.check(AMINA, pay.reference);
    assert.ok(twice.ok);
    assert.equal(twice.already_recorded, true);
    assert.equal(successRows(pay.reference), 1);

    const after = await kodi.balance(AMINA);
    assert.ok(after.ok);
    assert.equal(after.due_kes, 0);
  });

  test("records Paystack's data.amount, not the amount asked for", async () => {
    const pay = await kodi.pay(BRIAN, 22000);
    assert.ok(pay.ok);
    paystack.pay(pay.reference, 21000);
    const res = await kodi.check(BRIAN, pay.reference);
    assert.ok(res.ok);
    assert.equal(res.amount_kes, 21000);
    assert.equal(res.due_kes_after, 1000);
    assert.equal(store.tabs.payments.find((p) => p.reference === pay.reference)?.paid_kes, "21000");
  });

  test("only data.status == success is recorded", async () => {
    const pay = await kodi.pay(AMINA, 18000);
    assert.ok(pay.ok);
    paystack.pay(pay.reference, undefined, "failed");
    const res = await kodi.check(AMINA, pay.reference);
    assert.ok(res.ok);
    assert.equal(res.status, "failed");
    assert.equal(successRows(pay.reference), 0);
    assert.equal(store.tabs.payments.find((p) => p.reference === pay.reference)?.status, "failed");
    // A new pay creates a fresh link instead of reusing the failed one.
    const next = await kodi.pay(AMINA, 18000);
    assert.ok(next.ok);
    assert.equal(next.reference, "KDI-A1-202611-2");
  });

  test("two checks at the same moment record the payment only once", async () => {
    const pay = await kodi.pay(AMINA, 18000);
    assert.ok(pay.ok);
    paystack.pay(pay.reference);
    const [a, b] = await Promise.all([kodi.check(AMINA, pay.reference), kodi.check(AMINA, pay.reference)]);
    assert.ok(a.ok && b.ok);
    assert.equal(successRows(pay.reference), 1);
    assert.equal([a.already_recorded, b.already_recorded].filter(Boolean).length, 1);
  });

  test("a paid-but-unchecked link is recorded, not reused", async () => {
    const first = await kodi.pay(AMINA, 9000);
    assert.ok(first.ok);
    paystack.pay(first.reference);
    const second = await kodi.pay(AMINA, 9000);
    assert.ok(second.ok);
    assert.notEqual(second.reference, first.reference);
    assert.equal(successRows(first.reference), 1);
  });

  test("part-payment plan: half now, rest by the 20th, closes when paid", async () => {
    const pay = await kodi.pay(FAITH, 12500, { second_amount_kes: 12500, second_date: "2026-11-18" });
    assert.ok(pay.ok);
    assert.equal(pay.plan_id, "PLN-B2-202611-1");

    const bal = await kodi.balance(FAITH);
    assert.ok(bal.ok);
    assert.deepEqual(bal.open_plan, {
      plan_id: "PLN-B2-202611-1", first_amount_kes: 12500, second_amount_kes: 12500, second_date: "2026-11-18",
    });

    const another = await kodi.pay(FAITH, 12500, { second_amount_kes: 12500, second_date: "2026-11-19" });
    assert.equal(another.ok, false);
    assert.equal(!another.ok && another.code, "plan_breaks_rules");

    paystack.pay(pay.reference);
    await kodi.check(FAITH);
    const second = await kodi.pay(FAITH, 12500);
    assert.ok(second.ok);
    paystack.pay(second.reference);
    const done = await kodi.check(FAITH);
    assert.ok(done.ok);
    assert.equal(done.due_kes_after, 0);
    assert.equal(store.tabs.plans_escalations.find((p) => p.id === "PLN-B2-202611-1")?.status, "done");
  });

  test("report for landlord and caretaker", async () => {
    const r = await kodi.report(LANDLORD);
    assert.ok(r.ok);
    assert.equal(r.month, "2026-11");
    assert.equal(r.paid_count, 1); // A3
    assert.deepEqual(
      r.outstanding.map((o) => [o.unit_id, o.due_kes]),
      [["A1", 18000], ["A2", 22000], ["B1", 12000], ["B2", 25000]],
    );
    const c = await kodi.report(CARETAKER, "2026-11");
    assert.ok(c.ok);
  });

  test("escalate creates a ticket", async () => {
    const t = await kodi.escalate(HASSAN, "repair", "Water leaking in the bathroom.");
    assert.ok(t.ok);
    assert.match(t.ticket_id, /^ESC-20261110-[0-9A-F]{4}$/);
    const row = store.tabs.plans_escalations.find((p) => p.id === t.ticket_id);
    assert.equal(row?.unit_id, "B1");
    assert.equal(row?.kind, "escalation");
    const staff = await kodi.escalate(CARETAKER, "dispute", "B2 disputes the carried amount.", "b2");
    assert.ok(staff.ok);
  });
});

describe("error cases", () => {
  const code = (r: { ok: boolean }) => (r.ok ? "ok" : (r as { code: string }).code);
  const say = (r: { ok: boolean }) => (r as { say: string }).say;

  test("unknown_sender: strangers and inactive tenants get nothing", async () => {
    assert.deepEqual(await kodi.whoami(STRANGER), { ok: true, role: "unknown" });
    assert.deepEqual(await kodi.whoami(FORMER), { ok: true, role: "unknown" });
    for (const r of [
      await kodi.balance(STRANGER),
      await kodi.pay(STRANGER, 1000),
      await kodi.check(STRANGER, "KDI-A1-202611-1"),
      await kodi.report(STRANGER),
      await kodi.escalate(STRANGER, "x", "y"),
    ]) {
      assert.equal(code(r), "unknown_sender");
      assert.ok(say(r).length > 10);
    }
  });

  test("not_your_unit: a tenant can't see another unit", async () => {
    const r = await kodi.check(AMINA, "KDI-B1-202611-1");
    assert.equal(code(r), "not_your_unit");
    assert.equal(code(await kodi.check(AMINA, "KDI-B2-202611-9")), "not_your_unit");
    assert.equal(code(await kodi.escalate(AMINA, "x", "y", "B2")), "not_your_unit");
  });

  test("not_allowed: tenants can't see the report; staff can't pay", async () => {
    assert.equal(code(await kodi.report(AMINA)), "not_allowed");
    assert.equal(code(await kodi.pay(LANDLORD, 1000)), "not_allowed");
    assert.equal(code(await kodi.balance(CARETAKER)), "not_allowed");
    assert.equal(code(await kodi.check(LANDLORD)), "not_allowed");
  });

  test("amount_invalid: zero, fractions, more than due, nothing due", async () => {
    assert.equal(code(await kodi.pay(AMINA, 0)), "amount_invalid");
    assert.equal(code(await kodi.pay(AMINA, 100.5)), "amount_invalid");
    const over = await kodi.pay(AMINA, 18001);
    assert.equal(code(over), "amount_invalid");
    assert.match(say(over), /18,000/);
    assert.equal(code(await kodi.pay(GRACE, 100)), "amount_invalid");
    assert.equal(store.tabs.payments.length, 2); // nothing new written
  });

  test("plan_breaks_rules: under half, wrong remainder, late date, past the 20th", async () => {
    assert.equal(code(await kodi.pay(FAITH, 12000, { second_amount_kes: 13000, second_date: "2026-11-18" })), "plan_breaks_rules");
    assert.equal(code(await kodi.pay(FAITH, 15000, { second_amount_kes: 5000, second_date: "2026-11-18" })), "plan_breaks_rules");
    assert.equal(code(await kodi.pay(FAITH, 15000, { second_amount_kes: 10000, second_date: "2026-11-21" })), "plan_breaks_rules");
    assert.equal(code(await kodi.pay(FAITH, 15000, { second_amount_kes: 10000, second_date: "2026-11-09" })), "plan_breaks_rules");
    now = new Date("2026-11-21T06:00:00Z");
    const late = await kodi.pay(FAITH, 15000, { second_amount_kes: 10000, second_date: "2026-11-25" });
    assert.equal(code(late), "plan_breaks_rules");
    assert.match(say(late), /past the 20th/);
    assert.equal(paystack.initializeCalls, 0);
  });

  test("paystack_unavailable: link can't be created", async () => {
    paystack.down = true;
    const r = await kodi.pay(AMINA, 18000);
    assert.equal(code(r), "paystack_unavailable");
    assert.equal(store.tabs.payments.find((p) => p.reference === "KDI-A1-202611-1")?.status, "failed");
    paystack.down = false;
    const retry = await kodi.pay(AMINA, 18000);
    assert.ok(retry.ok);
    assert.equal(retry.reference, "KDI-A1-202611-2");
  });

  test("verify_error: Paystack down during check, or reference not found", async () => {
    const pay = await kodi.pay(AMINA, 18000);
    assert.ok(pay.ok);
    paystack.down = true;
    assert.equal(code(await kodi.check(AMINA, pay.reference)), "verify_error");
    paystack.down = false;
    assert.equal(code(await kodi.check(AMINA, "KDI-A1-202611-77")), "verify_error");
  });

  test("ledger_write_failed: can't reserve a reference, or can't record a payment", async () => {
    store.failWrites = true;
    assert.equal(code(await kodi.pay(AMINA, 18000)), "ledger_write_failed");
    assert.equal(paystack.initializeCalls, 0); // no link without a ledger row
    store.failWrites = false;

    const pay = await kodi.pay(AMINA, 18000);
    assert.ok(pay.ok);
    paystack.pay(pay.reference);
    store.failWrites = true;
    const r = await kodi.check(AMINA, pay.reference);
    assert.equal(code(r), "ledger_write_failed");
    assert.match(say(r), /don't pay again/);
    store.failWrites = false;
    const retry = await kodi.check(AMINA, pay.reference);
    assert.ok(retry.ok);
    assert.equal(retry.already_recorded, false);
    assert.equal(successRows(pay.reference), 1);
  });

  test("errors are in the sender's language", async () => {
    const r = await kodi.report(BRIAN);
    assert.equal(code(r), "not_allowed");
    assert.match(say(r), /Samahani/);
  });
});

test("phone numbers in any common format", () => {
  for (const p of ["+254712345678", "254712345678", "0712345678", "712345678", "whatsapp:+254 712 345 678"]) {
    assert.equal(normalizePhone(p), "254712345678");
  }
  assert.equal(normalizePhone("123"), "");
});
