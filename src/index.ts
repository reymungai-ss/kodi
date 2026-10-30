import { timingSafeEqual } from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { NextFunction, Request, Response } from "express";
import { loadConfig } from "./config.js";
import { Kodi } from "./kodi.js";
import { buildMcpServer } from "./mcp.js";

// Locally, settings can come from a .env file. On Railway/Render they come from the dashboard.
try {
  process.loadEnvFile();
} catch {
  /* no .env file */
}

const config = loadConfig();
const kodi = new Kodi({
  store: config.store,
  payments: config.payments,
  emailDomain: process.env.TENANT_EMAIL_DOMAIN?.trim(),
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
app.post("/mcp", requireToken, async (req, res) => {
  const server = buildMcpServer(kodi);
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
