import { createInterface } from "node:readline/promises";
import { AppsScriptStore } from "../src/store.js";

try {
  process.loadEnvFile();
} catch {
  /* no .env file */
}

export function sheetFromEnv(): AppsScriptStore {
  const url = process.env.SHEET_WEBAPP_URL?.trim();
  const secret = process.env.SHEET_WEBAPP_SECRET?.trim();
  if (!url || !secret) {
    console.error("Set SHEET_WEBAPP_URL and SHEET_WEBAPP_SECRET in your .env file first (see README).");
    process.exit(1);
  }
  return new AppsScriptStore(url, secret, 60000);
}

/** Asks "type yes" unless --yes was passed. */
export async function confirm(question: string): Promise<boolean> {
  if (process.argv.includes("--yes")) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} Type "yes" to continue: `);
  rl.close();
  return answer.trim().toLowerCase() === "yes";
}
