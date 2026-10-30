import { TABS, type Row, type TabName } from "./schema.js";

// Everything Kodi needs from the Sheet. Two implementations: the real one
// (talks to the Apps Script web app) and an in-memory one for tests/demo.
export interface Store {
  read(tab: TabName): Promise<Row[]>;
  /** Appends rows. With uniqueKey, returns "duplicate" and writes nothing if the value exists. */
  append(tab: TabName, rows: Row[], uniqueKey?: string): Promise<"ok" | "duplicate">;
  /** Updates rows matching `match`, skipping rows that match any `unless`. Returns rows changed. */
  update(tab: TabName, match: Row, set: Row, unless?: Row): Promise<number>;
  replace(tab: TabName, rows: Row[]): Promise<void>;
}

export class StoreError extends Error {}

export class AppsScriptStore implements Store {
  constructor(
    private url: string,
    private secret: string,
    private timeoutMs = 20000,
  ) {}

  private async call(action: string, payload: Record<string, unknown>): Promise<any> {
    let res: Response;
    try {
      // Apps Script answers with a redirect; fetch follows it automatically.
      res = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ secret: this.secret, action, ...payload }),
        redirect: "follow",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new StoreError(`sheet unreachable: ${(err as Error).message}`);
    }
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new StoreError(`sheet returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    return json;
  }

  async read(tab: TabName): Promise<Row[]> {
    const r = await this.call("read", { tab });
    if (!r.ok) throw new StoreError(`read ${tab}: ${r.error}`);
    return r.rows as Row[];
  }

  async append(tab: TabName, rows: Row[], uniqueKey?: string) {
    const r = await this.call("append", { tab, rows, unique_key: uniqueKey });
    if (!r.ok && r.error === "duplicate") return "duplicate" as const;
    if (!r.ok) throw new StoreError(`append ${tab}: ${r.error}`);
    return "ok" as const;
  }

  async update(tab: TabName, match: Row, set: Row, unless?: Row) {
    const r = await this.call("update", { tab, match, set, unless });
    if (!r.ok) throw new StoreError(`update ${tab}: ${r.error}`);
    return Number(r.updated);
  }

  async replace(tab: TabName, rows: Row[]) {
    const r = await this.call("replace", { tab, headers: TABS[tab], rows });
    if (!r.ok) throw new StoreError(`replace ${tab}: ${r.error}`);
  }

  async ping(): Promise<string> {
    const r = await this.call("ping", {});
    if (!r.ok) throw new StoreError(`ping: ${r.error}`);
    return r.sheet;
  }
}

export class MemoryStore implements Store {
  tabs: Record<TabName, Row[]> = {
    units: [],
    tenants: [],
    charges: [],
    payments: [],
    plans_escalations: [],
  };
  /** Set to make the next writes fail, to test ledger_write_failed. */
  failWrites = false;

  private clean(tab: TabName, r: Row): Row {
    return Object.fromEntries(TABS[tab].map((h) => [h, r[h] == null ? "" : String(r[h])]));
  }

  async read(tab: TabName) {
    return this.tabs[tab].map((r) => ({ ...r }));
  }

  async append(tab: TabName, rows: Row[], uniqueKey?: string) {
    if (this.failWrites) throw new StoreError("simulated write failure");
    if (uniqueKey) {
      const seen = new Set(this.tabs[tab].map((r) => r[uniqueKey]));
      if (rows.some((r) => seen.has(r[uniqueKey]))) return "duplicate" as const;
    }
    this.tabs[tab].push(...rows.map((r) => this.clean(tab, r)));
    return "ok" as const;
  }

  async update(tab: TabName, match: Row, set: Row, unless?: Row) {
    if (this.failWrites) throw new StoreError("simulated write failure");
    const keys = Object.keys(match);
    if (!keys.length) return 0;
    let n = 0;
    for (const row of this.tabs[tab]) {
      if (!keys.every((k) => row[k] === String(match[k]))) continue;
      if (unless && Object.keys(unless).some((k) => row[k] === String(unless[k]))) continue;
      Object.assign(row, set);
      n++;
    }
    return n;
  }

  async replace(tab: TabName, rows: Row[]) {
    this.tabs[tab] = rows.map((r) => this.clean(tab, r));
  }
}

/**
 * Wraps a Store for the length of one tool call. Each tab is read from the
 * Sheet at most once (reads take ~3s each through Apps Script), and writes
 * made during the call are applied to the cached copy so later reads in the
 * same call see them. Never share one across calls: it would serve stale data.
 */
export class RequestCache implements Store {
  private tabs = new Map<TabName, Promise<Row[]>>();

  constructor(private inner: Store) {}

  /** Start reading these tabs now, in parallel. */
  warm(...tabs: TabName[]) {
    for (const t of tabs) this.load(t).catch(() => {}); // errors resurface on the real read
  }

  private load(tab: TabName): Promise<Row[]> {
    let p = this.tabs.get(tab);
    if (!p) {
      p = this.inner.read(tab);
      this.tabs.set(tab, p);
      p.catch(() => this.tabs.delete(tab)); // let a later read retry
    }
    return p;
  }

  async read(tab: TabName) {
    return (await this.load(tab)).map((r) => ({ ...r }));
  }

  async append(tab: TabName, rows: Row[], uniqueKey?: string) {
    const res = await this.inner.append(tab, rows, uniqueKey);
    if (res === "ok" && this.tabs.has(tab)) {
      const cached = await this.load(tab);
      cached.push(...rows.map((r) => ({ ...r })));
    }
    return res;
  }

  async update(tab: TabName, match: Row, set: Row, unless?: Row) {
    const n = await this.inner.update(tab, match, set, unless);
    if (n > 0 && this.tabs.has(tab)) {
      const keys = Object.keys(match);
      for (const row of await this.load(tab)) {
        if (!keys.every((k) => row[k] === String(match[k]))) continue;
        if (unless && Object.keys(unless).some((k) => row[k] === String(unless[k]))) continue;
        Object.assign(row, set);
      }
    }
    return n;
  }

  async replace(tab: TabName, rows: Row[]) {
    await this.inner.replace(tab, rows);
    this.tabs.set(tab, Promise.resolve(rows.map((r) => ({ ...r }))));
  }
}
