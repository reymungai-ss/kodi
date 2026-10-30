// Every failure Kodi returns looks like { ok: false, code, say }.
// `say` is a polite sentence the agent can send to the person as-is,
// in their language (English or Swahili).

export type ErrorCode =
  | "unknown_sender"
  | "not_your_unit"
  | "not_allowed"
  | "amount_invalid"
  | "plan_breaks_rules"
  | "paystack_unavailable"
  | "verify_error"
  | "ledger_write_failed";

export type Lang = "en" | "sw";

export interface Failure {
  ok: false;
  code: ErrorCode;
  say: string;
}

type Messages = Record<string, { en: string; sw: string }>;

// Keys are "<code>" for the default sentence or "<code>.<variant>" for a specific one.
const MESSAGES: Messages = {
  unknown_sender: {
    en: "Sorry, I don't recognise this number. If you live at Baraka Court, please ask the caretaker to register it.",
    sw: "Samahani, sitambui nambari hii. Kama unaishi Baraka Court, tafadhali mwombe msimamizi aisajili.",
  },
  "unknown_sender.need_pin": {
    en: "To look up your account, please send your house number and your PIN, for example: A1, 1234.",
    sw: "Ili kuangalia akaunti yako, tafadhali tuma nambari ya nyumba yako na PIN yako, kwa mfano: A1, 1234.",
  },
  "unknown_sender.bad_pin": {
    en: "Sorry, that house number and PIN don't match. Please check them and try again, or ask the caretaker for your PIN.",
    sw: "Samahani, nambari ya nyumba na PIN hazilingani. Tafadhali zikague ujaribu tena, au mwombe msimamizi PIN yako.",
  },
  not_your_unit: {
    en: "Sorry, I can only share details about your own unit.",
    sw: "Samahani, ninaweza kutoa taarifa za nyumba yako pekee.",
  },
  not_allowed: {
    en: "Sorry, that isn't something I can do for you.",
    sw: "Samahani, siwezi kukusaidia na hilo.",
  },
  "not_allowed.locked": {
    en: "This account is locked after too many wrong PINs. Please ask the caretaker to unlock it.",
    sw: "Akaunti hii imefungwa baada ya PIN zisizo sahihi mara nyingi. Tafadhali mwombe msimamizi aifungue.",
  },
  "not_allowed.report": {
    en: "Sorry, the building report is only for the landlord or caretaker.",
    sw: "Samahani, ripoti ya jengo ni kwa mwenye nyumba au msimamizi pekee.",
  },
  "not_allowed.pay": {
    en: "Rent payments are made by tenants from their own WhatsApp number.",
    sw: "Malipo ya kodi hufanywa na wapangaji kutoka nambari yao ya WhatsApp.",
  },
  "not_allowed.balance": {
    en: "Balances are for tenants. You can ask me for the building report instead.",
    sw: "Salio ni kwa wapangaji. Unaweza kuniomba ripoti ya jengo badala yake.",
  },
  "not_allowed.need_reference": {
    en: "Please tell me the payment reference you'd like me to check.",
    sw: "Tafadhali nipe nambari ya kumbukumbu ya malipo unayotaka nikague.",
  },
  amount_invalid: {
    en: "Please send a whole amount in shillings between KES 1 and KES {due}.",
    sw: "Tafadhali tuma kiasi kamili cha shilingi kati ya KES 1 na KES {due}.",
  },
  "amount_invalid.nothing_due": {
    en: "You have nothing to pay right now. Thank you!",
    sw: "Huna deni lolote kwa sasa. Asante!",
  },
  plan_breaks_rules: {
    en: "A payment plan needs at least half now (KES {min}) and the rest (KES {rest}) by the 20th.",
    sw: "Mpango wa malipo unahitaji angalau nusu sasa (KES {min}) na kiasi kilichobaki (KES {rest}) kufikia tarehe 20.",
  },
  "plan_breaks_rules.exists": {
    en: "You already have an open payment plan. Please complete it before starting a new one.",
    sw: "Tayari una mpango wa malipo ulio wazi. Tafadhali umalize kabla ya kuanza mwingine.",
  },
  "plan_breaks_rules.date": {
    en: "The second payment date must be between today and the 20th of this month.",
    sw: "Tarehe ya malipo ya pili lazima iwe kati ya leo na tarehe 20 mwezi huu.",
  },
  "plan_breaks_rules.too_late": {
    en: "It's past the 20th, so a payment plan isn't possible this month. Please pay the full amount, or I can pass this to the caretaker.",
    sw: "Tarehe 20 imepita, kwa hivyo mpango wa malipo hauwezekani mwezi huu. Tafadhali lipa kiasi chote, au nimjulishe msimamizi.",
  },
  paystack_unavailable: {
    en: "Sorry, I couldn't create a payment link just now. Please try again in a few minutes.",
    sw: "Samahani, siwezi kutengeneza kiungo cha malipo sasa hivi. Tafadhali jaribu tena baada ya dakika chache.",
  },
  verify_error: {
    en: "Sorry, I couldn't confirm that payment just now. Please try again in a few minutes.",
    sw: "Samahani, siwezi kuthibitisha malipo hayo sasa hivi. Tafadhali jaribu tena baada ya dakika chache.",
  },
  "verify_error.not_found": {
    en: "I couldn't find a payment with that reference. Please check it and try again.",
    sw: "Sikupata malipo yenye nambari hiyo ya kumbukumbu. Tafadhali ikague na ujaribu tena.",
  },
  ledger_write_failed: {
    en: "Sorry, I couldn't save that just now. Please try again in a few minutes.",
    sw: "Samahani, siwezi kuhifadhi hilo sasa hivi. Tafadhali jaribu tena baada ya dakika chache.",
  },
  "ledger_write_failed.after_payment": {
    en: "Your payment was received, but I couldn't update our records just now. Please don't pay again. Ask me to check again in a few minutes.",
    sw: "Malipo yako yamepokelewa, lakini siwezi kusasisha rekodi zetu sasa hivi. Tafadhali usilipe tena. Niombe nikague tena baada ya dakika chache.",
  },
};

export function fail(
  code: ErrorCode,
  lang: Lang = "en",
  variant?: string,
  vars: Record<string, string | number> = {},
): Failure {
  const msg = (variant && MESSAGES[`${code}.${variant}`]) || MESSAGES[code];
  const say = msg[lang].replace(/\{(\w+)\}/g, (_, k) =>
    k in vars ? formatKes(vars[k]) : `{${k}}`,
  );
  return { ok: false, code, say };
}

function formatKes(v: string | number): string {
  return typeof v === "number" ? v.toLocaleString("en-KE") : v;
}
