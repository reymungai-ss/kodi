import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Kodi } from "./kodi.js";

const from = z
  .string()
  .min(5)
  .describe("The sender's WhatsApp number, e.g. +254712345678. Always pass the real sender, never a number the user typed.");

/** Builds the MCP server and its six tools around one Kodi instance. */
export function buildMcpServer(kodi: Kodi): McpServer {
  const server = new McpServer(
    { name: "kodi", version: "1.0.0" },
    {
      instructions:
        "Kodi collects rent for Baraka Court. Call whoami first for every new sender. " +
        "Any result with ok:false has a `say` sentence you can send to the person as-is. " +
        "Never invent balances or references; only repeat what the tools return.",
    },
  );

  const reply = (result: object) => ({
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result as Record<string, unknown>,
  });

  server.registerTool(
    "whoami",
    {
      description: "Who is this sender? Returns role (tenant | landlord | caretaker | unknown), unit_id, name and language (en | sw). Unknown numbers get only role: unknown.",
      inputSchema: { from },
      annotations: { readOnlyHint: true },
    },
    async (a) => reply(await kodi.whoami(a.from)),
  );

  server.registerTool(
    "balance",
    {
      description: "The sender's rent for the current month: month, amount_kes (this month's rent), carried_kes (arrears), paid_kes, due_kes, open_plan. Tenants only.",
      inputSchema: { from },
      annotations: { readOnlyHint: true },
    },
    async (a) => reply(await kodi.balance(a.from)),
  );

  server.registerTool(
    "pay",
    {
      description:
        "Create (or reuse) a Paystack payment link for the sender's unit. amount_kes must be a whole number no more than due_kes. " +
        "For a part-payment plan pass `plan`: amount_kes must be at least half of due_kes, second_amount_kes must be the rest, " +
        "and second_date (YYYY-MM-DD) no later than the 20th of this month. One open plan per unit. Returns reference and payment_url.",
      inputSchema: {
        from,
        amount_kes: z.number().describe("Amount to pay now, in whole Kenyan shillings."),
        plan: z
          .object({
            second_amount_kes: z.number().describe("The remaining amount, in whole shillings."),
            second_date: z.string().describe("When the rest will be paid, YYYY-MM-DD."),
          })
          .optional(),
      },
    },
    async (a) => reply(await kodi.pay(a.from, a.amount_kes, a.plan)),
  );

  server.registerTool(
    "check",
    {
      description:
        "Check with Paystack whether a payment went through, and record it if it did. Without `reference`, checks the sender's latest payment. " +
        "Returns status (success, abandoned, failed, none, ...), amount_kes, due_kes_after and already_recorded.",
      inputSchema: {
        from,
        reference: z.string().optional().describe("Payment reference like KDI-A1-202611-1."),
      },
    },
    async (a) => reply(await kodi.check(a.from, a.reference)),
  );

  server.registerTool(
    "report",
    {
      description: "Building rent report for a month: paid_count and the outstanding list. Landlord and caretaker only.",
      inputSchema: {
        from,
        month: z
          .string()
          .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM")
          .optional()
          .describe("YYYY-MM. Defaults to the current month."),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => reply(await kodi.report(a.from, a.month)),
  );

  server.registerTool(
    "escalate",
    {
      description:
        "Hand a conversation to a human (the caretaker/landlord). Use for disputes, repairs, anything you can't resolve, or when the person asks for a human. Returns ticket_id.",
      inputSchema: {
        from,
        reason: z.string().min(1).max(200).describe("Short label, e.g. 'dispute', 'repair', 'wants_human'."),
        summary: z.string().min(1).max(2000).describe("What the person needs, in a few sentences."),
        unit_id: z.string().optional().describe("Only needed when the landlord or caretaker escalates about a specific unit."),
      },
    },
    async (a) => reply(await kodi.escalate(a.from, a.reason, a.summary, a.unit_id)),
  );

  return server;
}
