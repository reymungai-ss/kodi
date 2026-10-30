import type { Row, TabName } from "./schema.js";
import { nairobiMonth } from "./kodi.js";

// Sample data for Baraka Court. All phone numbers are fake (2547000001xx).
// Charges and sample payments are dated to the month you run the seed in.
// Replace this with the real seed table when you have it.
export function seedRows(now: Date): Record<TabName, Row[]> {
  const month = nairobiMonth(now);
  const yyyymm = month.replace("-", "");
  const at = now.toISOString();

  return {
    units: [
      { unit_id: "A1", floor: "Ground", monthly_rent_kes: "18000", status: "occupied" },
      { unit_id: "A2", floor: "Ground", monthly_rent_kes: "18000", status: "occupied" },
      { unit_id: "A3", floor: "1st", monthly_rent_kes: "22000", status: "occupied" },
      { unit_id: "B1", floor: "1st", monthly_rent_kes: "22000", status: "occupied" },
      { unit_id: "B2", floor: "2nd", monthly_rent_kes: "25000", status: "occupied" },
      { unit_id: "B3", floor: "2nd", monthly_rent_kes: "25000", status: "vacant" },
    ],
    tenants: [
      { phone: "254700000101", name: "Amina Wanjiru", role: "tenant", unit_id: "A1", language: "en", active: "yes" },
      { phone: "254700000102", name: "Brian Otieno", role: "tenant", unit_id: "A2", language: "sw", active: "yes" },
      { phone: "254700000103", name: "Grace Muthoni", role: "tenant", unit_id: "A3", language: "en", active: "yes" },
      { phone: "254700000104", name: "Hassan Ali", role: "tenant", unit_id: "B1", language: "sw", active: "yes" },
      { phone: "254700000105", name: "Faith Chebet", role: "tenant", unit_id: "B2", language: "en", active: "yes" },
      { phone: "254700000199", name: "Former Tenant", role: "tenant", unit_id: "B3", language: "en", active: "no" },
      { phone: "254700000901", name: "Mr. Kamau", role: "landlord", unit_id: "", language: "en", active: "yes" },
      { phone: "254700000902", name: "Joseph Njoroge", role: "caretaker", unit_id: "", language: "sw", active: "yes" },
    ],
    charges: [
      { unit_id: "A1", month, rent_kes: "18000", carried_kes: "0", due_date: `${month}-05` },
      { unit_id: "A2", month, rent_kes: "18000", carried_kes: "4000", due_date: `${month}-05` },
      { unit_id: "A3", month, rent_kes: "22000", carried_kes: "0", due_date: `${month}-05` },
      { unit_id: "B1", month, rent_kes: "22000", carried_kes: "0", due_date: `${month}-05` },
      { unit_id: "B2", month, rent_kes: "25000", carried_kes: "0", due_date: `${month}-05` },
    ],
    payments: [
      // A3 has paid in full; B1 has paid part.
      { reference: `KDI-A3-${yyyymm}-1`, unit_id: "A3", month, amount_kes: "22000", status: "success", paid_kes: "22000", payment_url: "", plan_id: "", from: "254700000103", created_at: at, verified_at: at, channel: "mobile_money" },
      { reference: `KDI-B1-${yyyymm}-1`, unit_id: "B1", month, amount_kes: "10000", status: "success", paid_kes: "10000", payment_url: "", plan_id: "", from: "254700000104", created_at: at, verified_at: at, channel: "mobile_money" },
    ],
    plans_escalations: [],
  };
}
