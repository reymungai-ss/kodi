// Sets up the Sheet from scratch: creates any missing tabs, writes the header
// rows, and fills every tab with the sample Baraka Court data.
// Run: npm run seed
import { TABS, type TabName } from "../src/schema.js";
import { seedRows } from "../src/seedData.js";
import { confirm, sheetFromEnv } from "./_sheet.js";

const sheet = sheetFromEnv();
const name = await sheet.ping();
console.log(`Connected to the Sheet "${name}".`);

if (!(await confirm(`This will ERASE all five tabs in "${name}" and fill them with sample data.`))) {
  console.log("Stopped. Nothing was changed.");
  process.exit(0);
}

const data = seedRows(new Date());
for (const tab of Object.keys(TABS) as TabName[]) {
  await sheet.replace(tab, data[tab]);
  console.log(`  ${tab}: ${data[tab].length} rows`);
}
console.log("Done. The Sheet now holds the sample data.");
