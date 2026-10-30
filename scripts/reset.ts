// Undoes test activity: puts the `payments` and `plans_escalations` tabs back
// to the sample data, so you can run the tests again. Units, tenants and
// charges are left exactly as they are.
// Run: npm run reset
import { seedRows } from "../src/seedData.js";
import { confirm, sheetFromEnv } from "./_sheet.js";

const sheet = sheetFromEnv();
const name = await sheet.ping();
console.log(`Connected to the Sheet "${name}".`);

if (!(await confirm(`This will ERASE the payments and plans_escalations tabs in "${name}" and put back the sample rows.`))) {
  console.log("Stopped. Nothing was changed.");
  process.exit(0);
}

const data = seedRows(new Date());
for (const tab of ["payments", "plans_escalations"] as const) {
  await sheet.replace(tab, data[tab]);
  console.log(`  ${tab}: reset to ${data[tab].length} rows`);
}
console.log("Done.");
