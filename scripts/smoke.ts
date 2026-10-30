// Live test: talks to a running Kodi server over MCP, exactly like Chord will.
//
//   npm run smoke                                  # against http://localhost:3000/mcp
//   npm run smoke -- --url https://xxx.up.railway.app/mcp
//   npm run smoke -- --wait                        # also waits while you pay the test link
//
// It uses the sample phone numbers from the seed data, so run `npm run seed`
// (or `npm run reset`) on the Sheet first. The token comes from KODI_MCP_TOKEN.
//
// Outage errors (paystack_unavailable, verify_error, ledger_write_failed)
// can't be caused safely on a live system; `npm test` covers those.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

try {
  process.loadEnvFile();
} catch {
  /* no .env file */
}

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const url = arg("--url") ?? `http://localhost:${process.env.PORT ?? 3000}/mcp`;
const token = process.env.KODI_MCP_TOKEN?.trim() || "demo-token";
const wait = process.argv.includes("--wait");

const AMINA = "+254700000101"; // tenant, A1
const GRACE = "+254700000103"; // tenant, A3, already paid
const FAITH = "+254700000105"; // tenant, B2
const LANDLORD = "+254700000901";
const STRANGER = "+254799999999";

let failures = 0;
function expect(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) {
    failures++;
    if (detail !== undefined) console.log("      got:", JSON.stringify(detail));
  }
}

async function main() {
  console.log(`Testing ${url}\n`);

  // 1. Without the token the server must refuse.
  const noAuth = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect("request without token is refused (401)", noAuth.status === 401, noAuth.status);

  const client = new Client({ name: "kodi-smoke", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    return JSON.parse((r.content as Array<{ text: string }>)[0].text);
  };

  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  expect("lists the six tools", tools.join(",") === "balance,check,escalate,pay,report,whoami", tools);

  // 2. Main flow.
  const who = await call("whoami", { from: AMINA });
  expect("whoami: tenant A1", who.role === "tenant" && who.unit_id === "A1", who);

  const bal = await call("balance", { from: AMINA });
  expect("balance: has due_kes", bal.ok && typeof bal.due_kes === "number", bal);
  console.log(`      A1 owes KES ${bal.due_kes} for ${bal.month}`);

  let reference = "";
  if (bal.ok && bal.due_kes > 0) {
    const amount = Math.min(bal.due_kes, 1000);
    const pay = await call("pay", { from: AMINA, amount_kes: amount });
    expect("pay: returns reference and payment_url", pay.ok && /^KDI-A1-\d{6}-\d+$/.test(pay.reference) && pay.payment_url, pay);
    reference = pay.reference;
    console.log(`      payment link: ${pay.payment_url}`);

    const again = await call("pay", { from: AMINA, amount_kes: amount });
    expect("pay again (same amount): reuses the same link", again.ok && again.reference === reference, again);

    const chk = await call("check", { from: AMINA, reference });
    expect("check: not paid yet, nothing recorded", chk.ok && chk.status !== "success" && !chk.already_recorded, chk);

    if (wait) {
      console.log("\n      Open the link above and pay with a Paystack TEST card or test mobile money.");
      console.log("      Waiting up to 5 minutes...");
      let paid: any = null;
      for (let i = 0; i < 30 && !paid; i++) {
        await new Promise((r) => setTimeout(r, 10000));
        const c = await call("check", { from: AMINA, reference });
        if (c.ok && c.status === "success") paid = c;
      }
      expect("check after paying: success and recorded", paid && paid.already_recorded === false, paid);
      const twice = await call("check", { from: AMINA, reference });
      expect("check again: already_recorded (no double counting)", twice.ok && twice.already_recorded === true, twice);
    }
  } else {
    console.log("      (A1 owes nothing — run `npm run reset` to test pay)");
  }

  const rep = await call("report", { from: LANDLORD });
  expect("report: landlord sees paid_count and outstanding", rep.ok && Array.isArray(rep.outstanding), rep);

  const esc = await call("escalate", { from: AMINA, reason: "smoke_test", summary: "Automated smoke test ticket. Safe to close." });
  expect("escalate: returns ticket_id", esc.ok && /^ESC-/.test(esc.ticket_id), esc);

  // 3. Error cases.
  const isErr = (r: any, code: string) => r.ok === false && r.code === code && typeof r.say === "string" && r.say.length > 0;

  const stranger = await call("whoami", { from: STRANGER });
  expect("whoami: stranger gets role unknown and nothing else", stranger.role === "unknown" && !stranger.name, stranger);
  const sb = await call("balance", { from: STRANGER });
  expect("unknown_sender", isErr(sb, "unknown_sender"), sb);

  const nyu = await call("check", { from: AMINA, reference: "KDI-B1-202601-1" });
  expect("not_your_unit", isErr(nyu, "not_your_unit"), nyu);

  const na = await call("report", { from: AMINA });
  expect("not_allowed (tenant asks for report)", isErr(na, "not_allowed"), na);

  const ai = await call("pay", { from: AMINA, amount_kes: 99999999 });
  expect("amount_invalid (more than due)", isErr(ai, "amount_invalid"), ai);
  const nd = await call("pay", { from: GRACE, amount_kes: 100 });
  expect("amount_invalid (nothing due)", isErr(nd, "amount_invalid"), nd);

  const fb = await call("balance", { from: FAITH });
  if (fb.ok && fb.due_kes > 1) {
    const tooSmall = Math.floor(fb.due_kes / 2) - 1;
    const pb = await call("pay", {
      from: FAITH,
      amount_kes: tooSmall,
      plan: { second_amount_kes: fb.due_kes - tooSmall, second_date: `${fb.month}-15` },
    });
    expect("plan_breaks_rules (less than half now)", isErr(pb, "plan_breaks_rules"), pb);
  }

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}`);
  if (reference) console.log(`(This run created payment ${reference}. Run \`npm run reset\` to clear test activity.)`);
  await client.close();
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
