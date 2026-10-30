# Kodi go-live note for Baraka Court

**What it does.** Kodi answers tenants on WhatsApp at any hour. After a tenant
gives their house number and PIN, it tells them what they owe, sends a Paystack
link (M-Pesa or card), confirms the payment and updates the rent sheet. It can
agree a two-part plan (half now, the rest by the 20th). You and the caretaker
can ask "who hasn't paid?" at any time. Repairs, disputes and anything else
become a ticket for a person.

**What it doesn't do.** It can't refund, waive, discount or move money, and it
never asks for M-Pesa PINs or card numbers. It doesn't chase late payers; tenants
message it first. It only knows what's in the Google Sheet.

**Before real tenants use it:**
1. **Paystack live mode.** Verify the business with Paystack and switch to live
   keys. Kodi refuses live keys today on purpose, so this is a deliberate change,
   followed by one real test payment.
2. **A real WhatsApp number** on the Chord teammate. If it passes the tenant's
   phone number, PINs can go. If not, hand PINs out in person and keep the
   Sheet private (PINs also sit in Chord's chat history).
3. **Someone gets told.** Tickets and locked accounts currently only appear in
   the Sheet. Set up a WhatsApp or email alert to the caretaker for each one, and
   an alert to whoever maintains Kodi if it stops responding.
4. **Unconfirmed payments.** A failed payment gets a fresh link. But if a tenant
   pays and never says so, the sheet waits until someone asks Kodi to check.
   Add automatic confirmation from Paystack and reconcile monthly.
5. **Monthly routine.** The caretaker enters each month's rent and arrears by
   the 1st. Keep a weekly backup copy of the Sheet.
