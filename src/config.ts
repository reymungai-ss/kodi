import { FakePaystack, Paystack, type Payments } from "./paystack.js";
import { seedRows } from "./seedData.js";
import { AppsScriptStore, MemoryStore, type Store } from "./store.js";
import { TABS, type TabName } from "./schema.js";

export interface Config {
  port: number;
  token: string;
  store: Store;
  payments: Payments;
  demo: boolean;
}

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing environment variable ${name}. See README.md → "Environment variables".`);
  return v;
}

/** Reads settings from environment variables. KODI_DEMO=1 runs with fake data and a fake Paystack. */
export function loadConfig(): Config {
  const demo = process.env.KODI_DEMO === "1";
  const port = Number(process.env.PORT ?? 3000);

  if (demo) {
    const store = new MemoryStore();
    const seed = seedRows(new Date());
    for (const tab of Object.keys(TABS) as TabName[]) store.tabs[tab] = seed[tab];
    return { port, token: process.env.KODI_MCP_TOKEN?.trim() || "demo-token", store, payments: new FakePaystack(), demo };
  }

  const token = need("KODI_MCP_TOKEN");
  if (token.length < 24) throw new Error("KODI_MCP_TOKEN is too short. Use at least 24 random characters.");
  return {
    port,
    token,
    store: new AppsScriptStore(need("SHEET_WEBAPP_URL"), need("SHEET_WEBAPP_SECRET")),
    payments: new Paystack(need("PAYSTACK_SECRET_KEY")),
    demo,
  };
}
