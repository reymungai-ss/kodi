// The shape of the Google Sheet. Each tab is listed with its columns, in order.
// If you rename or add a column in the Sheet, change it here too, then run
// `npm run seed` so the header row in the Sheet matches.

export const TABS = {
  // One row per flat in the building.
  units: ["unit_id", "floor", "monthly_rent_kes", "status"],

  // Everyone allowed to talk to Kodi: tenants, the landlord and the caretaker.
  // `phone` is the WhatsApp number in international form, digits only (2547...).
  tenants: ["phone", "name", "role", "unit_id", "language", "active"],

  // What each unit owes for a month. `carried_kes` is arrears brought forward.
  charges: ["unit_id", "month", "rent_kes", "carried_kes", "due_date"],

  // One row per Paystack payment link. Status starts as `pending` and becomes
  // `success` exactly once, with `paid_kes` taken from Paystack's data.amount.
  payments: [
    "reference",
    "unit_id",
    "month",
    "amount_kes",
    "status",
    "paid_kes",
    "payment_url",
    "plan_id",
    "from",
    "created_at",
    "verified_at",
    "channel",
  ],

  // Part-payment plans (kind = plan) and tickets for a human (kind = escalation).
  plans_escalations: [
    "id",
    "kind",
    "unit_id",
    "from",
    "month",
    "status",
    "first_amount_kes",
    "second_amount_kes",
    "second_date",
    "reason",
    "summary",
    "created_at",
  ],
} as const;

export type TabName = keyof typeof TABS;
export type Row = Record<string, string>;
