import { timingSafeEqual } from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { NextFunction, Request, Response } from "express";
import { loadConfig } from "./config.js";
import { waitUntil } from "@vercel/functions";
import { Kodi } from "./kodi.js";
import { RequestCache } from "./store.js";
import { buildMcpServer } from "./mcp.js";

// Locally, settings can come from a .env file. On Railway/Render they come from the dashboard.
try {
  process.loadEnvFile();
} catch {
  /* no .env file */
}

const config = loadConfig();
// A fresh Kodi per request, with its own read cache: each Sheet tab is read
// at most once per tool call instead of once per step.
const kodiForRequest = () =>
  new Kodi({
    store: new RequestCache(config.store),
    payments: config.payments,
    emailDomain: process.env.TENANT_EMAIL_DOMAIN?.trim(),
    defer: (work) => waitUntil(work),
  });

// Bound to 0.0.0.0 so Railway/Render can route traffic in. Requests are
// protected by the bearer token below, not by the hostname.
const app = createMcpExpressApp({ host: "0.0.0.0" });

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "kodi", demo: config.demo });
});

const expected = Buffer.from(`Bearer ${config.token}`);
function requireToken(req: Request, res: Response, next: NextFunction) {
  const got = Buffer.from(req.headers.authorization ?? "");
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    res.status(401).set("WWW-Authenticate", 'Bearer realm="kodi"').json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
    return;
  }
  next();
}

// Stateless mode: each request gets a fresh MCP server + transport. Kodi keeps
// no memory between calls (everything lives in the Sheet), so this is simplest
// and survives restarts and multiple instances.
// One log line per MCP request: which tool, the `from`/`account` it was given
// (never the PIN), any
// `_meta` the client attached, and non-secret headers. This shows what the
// calling platform actually passes about the sender.
const SECRET_HEADERS = new Set(["authorization", "cookie", "x-api-key"]);
function logMcpRequest(req: Request) {
  const msgs = Array.isArray(req.body) ? req.body : [req.body];
  const headers = Object.fromEntries(
    Object.entries(req.headers).filter(
      ([k]) => !SECRET_HEADERS.has(k) && (k.startsWith("x-") || k === "user-agent" || k.startsWith("mcp-")) && !k.startsWith("x-vercel") && !k.startsWith("x-forwarded"),
    ),
  );
  for (const m of msgs) {
    if (!m || typeof m !== "object") continue;
    const p = m.params ?? {};
    const detail =
      m.method === "tools/call"
        ? { tool: p.name, from: p.arguments?.from, account: p.arguments?.account, pin_given: Boolean(p.arguments?.pin), _meta: p._meta }
        : m.method === "initialize"
          ? { client: p.clientInfo, _meta: p._meta }
          : { _meta: p._meta };
    console.log(`[kodi] mcp ${m.method} ${JSON.stringify(detail)} headers=${JSON.stringify(headers)}`);
  }
}

app.post("/mcp", requireToken, async (req, res) => {
  logMcpRequest(req);
  const server = buildMcpServer(kodiForRequest());
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[kodi] /mcp error", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

// Stateless servers don't offer the GET stream or session DELETE.
const notAllowed = (_req: Request, res: Response) => {
  res.status(405).set("Allow", "POST").json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
};
app.get("/mcp", requireToken, notAllowed);
app.delete("/mcp", requireToken, notAllowed);

// On Vercel the platform handles requests via the default export; elsewhere
// (your computer, Railway, Render) Kodi listens on a port itself.
if (!process.env.VERCEL) {
  app.listen(config.port, "0.0.0.0", () => {
    console.error(`[kodi] listening on :${config.port}/mcp${config.demo ? " (DEMO: fake Sheet + fake Paystack)" : ""}`);
  });
}

export default app;
