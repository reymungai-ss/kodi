import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Kodi } from "./kodi.js";

// Who is asking. Pass `from` when the channel provides the sender's WhatsApp
// number; otherwise pass `account` + `pin`, as the person gave them in this chat.
const identity = {
  from: z
    .string()
    .optional()
    .describe("The sender's WhatsApp number from the channel, e.g. +254712345678. Only if the platform provides it; never a number typed in the chat."),
  account: z
    .string()
    .optional()
    .describe("The person's house number (e.g. A1), or 'landlord' / 'caretaker' for staff, exactly as they gave it in this conversation."),
  pin: z
    .string()
    .optional()
    .describe("The PIN the person gave in this conversation. Never guess or reuse another person's PIN."),
};
const who = (a: { from?: string; account?: string; pin?: string }) => ({ from: a.from, account: a.account, pin: a.pin });

/** Builds the MCP server and its six tools around one Kodi instance. */
export function buildMcpServer(kodi: Kodi): McpServer {
  const server = new McpServer(
    { name: "kodi", version: "1.0.0" },
    {
      instructions:
        "Kodi collects rent for Baraka Court. Identify the person on every call: pass `from` if the channel gives you their " +
        "WhatsApp number, otherwise ask for their house number and PIN and pass them as `account` and `pin`. " +
        "Call whoami first to check who they are. " +
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
      description: "Who is this person? Pass `from`, or `account` + `pin`. Returns role (tenant | landlord | caretaker | unknown), unit_id, name, language (en | sw), latest_payment (their most recent link: reference, amount_kes, status, payment_url) and open_tickets. Call it at the start of each reply to see what earlier messages referred to. A wrong house number/PIN returns ok:false with a `say` asking them to try again; 5 wrong PINs lock the account.",
      inputSchema: { ...identity },
      annotations: { readOnlyHint: true },
    },
    async (a) => reply(await kodi.whoami(who(a))),
  );

  server.registerTool(
    "balance",
    {
      description: "The sender's rent for the current month: month, amount_kes (this month's rent), carried_kes (arrears), paid_kes, due_kes, due_date (YYYY-MM-DD), open_plan. Tenants only.",
      inputSchema: { ...identity },
      annotations: { readOnlyHint: true },
    },
    async (a) => reply(await kodi.balance(who(a))),
  );

  server.registerTool(
    "pay",
    {
      description:
        "Create (or reuse) a Paystack payment link for the sender's unit. amount_kes must be a whole number no more than due_kes. " +
        "For a part-payment plan pass `plan`: amount_kes must be at least half of due_kes, second_amount_kes must be the rest, " +
        "and second_date (YYYY-MM-DD) no later than the 20th of this month. One open plan per unit. Returns reference and payment_url.",
      inputSchema: {
        ...identity,
        amount_kes: z.number().describe("Amount to pay now, in whole Kenyan shillings."),
        plan: z
          .object({
            second_amount_kes: z.number().describe("The remaining amount, in whole shillings."),
            second_date: z.string().describe("When the rest will be paid, YYYY-MM-DD."),
          })
          .optional(),
      },
    },
    async (a) => reply(await kodi.pay(who(a), a.amount_kes, a.plan)),
  );

  server.registerTool(
    "check",
    {
      description:
        "Check with Paystack whether a payment went through, and record it if it did. Without `reference`, checks the sender's latest payment. " +
        "Returns status (success, abandoned, failed, none, ...), amount_kes, due_kes_after and already_recorded.",
      inputSchema: {
        ...identity,
        reference: z.string().optional().describe("Payment reference like KDI-A1-202611-1."),
      },
    },
    async (a) => reply(await kodi.check(who(a), a.reference)),
  );

  server.registerTool(
    "report",
    {
      description: "Building rent report for a month: paid_count and the outstanding list. Landlord and caretaker only.",
      inputSchema: {
        ...identity,
        month: z
          .string()
          .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM")
          .optional()
          .describe("YYYY-MM. Defaults to the current month."),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => reply(await kodi.report(who(a), a.month)),
  );

  server.registerTool(
    "escalate",
    {
      description:
        "Hand a conversation to a human (the caretaker/landlord). Use for disputes, repairs, anything you can't resolve, or when the person asks for a human. Returns ticket_id.",
      inputSchema: {
        ...identity,
        reason: z.string().min(1).max(200).describe("Short label, e.g. 'dispute', 'repair', 'wants_human'."),
        summary: z.string().min(1).max(2000).describe("What the person needs, in a few sentences."),
        unit_id: z.string().optional().describe("Only needed when the landlord or caretaker escalates about a specific unit."),
      },
    },
    async (a) => reply(await kodi.escalate(who(a), a.reason, a.summary, a.unit_id)),
  );

  return server;
}
