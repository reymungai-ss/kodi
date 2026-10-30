// Offline tests: the real Kodi rules, with an in-memory Sheet and a fake
// Paystack. Nothing touches the internet. Run: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { Kodi, normalizePhone } from "../src/kodi.js";
import { FakePaystack } from "../src/paystack.js";
import { TABS, type TabName } from "../src/schema.js";
import { seedRows } from "../src/seedData.js";
import { MemoryStore, RequestCache } from "../src/store.js";

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
      ok: true, role: "tenant", unit_id: "A1", name: "Amina Wanjiru", language: "en", latest_payment: null, open_tickets: [],
    });

    const bal = await kodi.balance(AMINA);
    assert.equal(bal.ok, true);
    assert.deepEqual(bal, {
      ok: true, unit_id: "A1", month: "2026-11", amount_kes: 18000, carried_kes: 0, paid_kes: 0, due_kes: 18000, due_date: "2026-11-05", open_plan: null,
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

  test("after a Sheet reset, references Paystack already knows are skipped", async () => {
    // Paystack still remembers -1 and -2 from before the reset; the ledger doesn't.
    await paystack.initialize({ amountKes: 1, reference: "KDI-A1-202611-1", email: "x@y.z", metadata: {} });
    await paystack.initialize({ amountKes: 1, reference: "KDI-A1-202611-2", email: "x@y.z", metadata: {} });
    const pay = await kodi.pay(AMINA, 7000);
    assert.ok(pay.ok);
    assert.equal(pay.reference, "KDI-A1-202611-3");
    const rows = store.tabs.payments.filter((p) => p.unit_id === "A1");
    // Taken references are skipped by asking Paystack first, without Sheet writes.
    assert.deepEqual(rows.map((r) => [r.reference, r.status]), [["KDI-A1-202611-3", "pending"]]);
  });

  test("with the per-request Sheet cache, writes are seen within the call and by the next call", async () => {
    let reads = 0;
    const counting = Object.assign(Object.create(store), { read: (t: TabName) => (reads++, store.read(t)) });
    const fresh = () => new Kodi({ store: new RequestCache(counting), payments: paystack, now: () => now, log: () => {} });
    const pay = await fresh().pay(AMINA, 18000);
    assert.ok(pay.ok);
    assert.equal(reads, 4); // tenants, charges, payments, plans: once each
    paystack.pay(pay.reference);
    const chk = await fresh().check(AMINA);
    assert.ok(chk.ok);
    assert.equal(chk.due_kes_after, 0); // computed from the cached copy after the write
    const bal = await fresh().balance(AMINA);
    assert.ok(bal.ok);
    assert.equal(bal.due_kes, 0);
    assert.equal(successRows(pay.reference), 1);
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

  test("whoami shows the latest link and open tickets, so earlier replies can be trusted", async () => {
    const pay = await kodi.pay(AMINA, 7000);
    assert.ok(pay.ok);
    const t = await kodi.escalate(AMINA, "wants_human", "Asked to talk to John.");
    assert.ok(t.ok);
    await kodi.escalate(FAITH, "repair", "Leaking tap."); // another unit: must not show for Amina
    const me = await kodi.whoami({ account: "A1", pin: "4821" });
    assert.ok(me.ok && "latest_payment" in me);
    assert.deepEqual(me.latest_payment, { reference: pay.reference, amount_kes: 7000, status: "pending", payment_url: pay.payment_url });
    assert.deepEqual(me.open_tickets.map((x) => x.ticket_id), [t.ticket_id]);
    const staff = await kodi.whoami(CARETAKER);
    assert.ok(staff.ok && "open_tickets" in staff);
    assert.equal(staff.open_tickets.length, 2);
    assert.equal(staff.latest_payment, null);
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

describe("house number + PIN sign-in", () => {
  const code = (r: { ok: boolean }) => (r.ok ? "ok" : (r as { code: string }).code);
  const failures = (unit: string) => store.tabs.tenants.find((t) => t.unit_id === unit)?.pin_failures;

  test("a tenant can do the whole flow with house number + PIN", async () => {
    const me = { account: "a1", pin: "4821" };
    assert.deepEqual(await kodi.whoami(me), {
      ok: true, role: "tenant", unit_id: "A1", name: "Amina Wanjiru", language: "en", latest_payment: null, open_tickets: [],
    });
    const bal = await kodi.balance(me);
    assert.ok(bal.ok);
    assert.equal(bal.due_kes, 18000);
    const pay = await kodi.pay(me, 18000);
    assert.ok(pay.ok);
    paystack.pay(pay.reference);
    const chk = await kodi.check(me);
    assert.ok(chk.ok);
    assert.equal(chk.due_kes_after, 0);
    // The payment row records the tenant's registered number, not anything typed.
    assert.equal(store.tabs.payments.at(-1)?.from, "254700000101");
  });

  test("'House A1' and spaces are accepted", async () => {
    const r = await kodi.whoami({ account: " House A1 ", pin: " 4821 " });
    assert.equal(r.ok && "unit_id" in r && r.unit_id, "A1");
  });

  test("staff sign in with their role name", async () => {
    const r = await kodi.report({ account: "Landlord", pin: "9001" });
    assert.ok(r.ok);
    assert.equal(code(await kodi.report({ account: "caretaker", pin: "9001" })), "unknown_sender");
  });

  test("a PIN only works for its own house", async () => {
    // B2's PIN with A1's house number is just a wrong PIN.
    const r = await kodi.balance({ account: "A1", pin: "7352" });
    assert.equal(code(r), "unknown_sender");
    assert.match((r as { say: string }).say, /don't match/);
  });

  test("wrong PIN, unknown house and inactive tenant all get the same answer", async () => {
    const a = await kodi.whoami({ account: "A1", pin: "0000" });
    const b = await kodi.whoami({ account: "Z9", pin: "1234" });
    const c = await kodi.whoami({ account: "B3", pin: "0000" });
    assert.deepEqual(a, b);
    assert.deepEqual(b, c);
  });

  test("no number and no PIN: ask for them", async () => {
    const r = await kodi.balance({});
    assert.equal(code(r), "unknown_sender");
    assert.match((r as { say: string }).say, /house number and your PIN/);
    assert.equal(code(await kodi.whoami({ account: "A1" })), "unknown_sender");
  });

  test("5 wrong PINs lock the account, even with the right PIN; clearing the count unlocks it", async () => {
    for (let i = 0; i < 5; i++) await kodi.whoami({ account: "A2", pin: "1111" });
    assert.equal(failures("A2"), "5");
    const locked = await kodi.balance({ account: "A2", pin: "3907" });
    assert.equal(code(locked), "not_allowed");
    assert.match((locked as { say: string }).say, /imefungwa/); // Brian prefers Swahili
    store.tabs.tenants.find((t) => t.unit_id === "A2")!.pin_failures = "0";
    assert.ok((await kodi.balance({ account: "A2", pin: "3907" })).ok);
  });

  test("a correct PIN resets earlier misses", async () => {
    await kodi.whoami({ account: "B1", pin: "1111" });
    assert.equal(failures("B1"), "1");
    await kodi.whoami({ account: "B1", pin: "2689" });
    assert.equal(failures("B1"), "0");
  });

  test("a tenant signed in by PIN still can't reach another unit", async () => {
    const me = { account: "A1", pin: "4821" };
    assert.equal(code(await kodi.check(me, "KDI-B1-202611-1")), "not_your_unit");
    assert.equal(code(await kodi.report(me)), "not_allowed");
  });
});

test("phone numbers in any common format", () => {
  for (const p of ["+254712345678", "254712345678", "0712345678", "712345678", "whatsapp:+254 712 345 678"]) {
    assert.equal(normalizePhone(p), "254712345678");
  }
  assert.equal(normalizePhone("123"), "");
});
