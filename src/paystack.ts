// Paystack, test mode. Only two calls are used: initialize (make a payment
// link) and verify (ask whether it was paid). There is deliberately no refund
// or transfer code anywhere in Kodi.

export interface InitializeInput {
  amountKes: number;
  reference: string;
  email: string;
  metadata: Record<string, unknown>;
}

export interface Initialized {
  authorization_url: string;
  reference: string;
}

/** The parts of Paystack's verify `data` object that Kodi uses. */
export interface Verified {
  /** data.status: "success", "abandoned", "failed", "ongoing", "pending", "reversed", ... */
  status: string;
  /** data.amount, in subunits (cents). */
  amount: number;
  currency: string;
  reference: string;
  channel: string;
}

export interface Payments {
  initialize(input: InitializeInput): Promise<Initialized>;
  /** Returns null if Paystack has never heard of this reference. */
  verify(reference: string): Promise<Verified | null>;
}

export class PaystackError extends Error {}

export class Paystack implements Payments {
  constructor(
    private secretKey: string,
    private baseUrl = "https://api.paystack.co",
    private timeoutMs = 15000,
  ) {
    if (secretKey.startsWith("sk_live_")) {
      throw new Error("PAYSTACK_SECRET_KEY is a LIVE key. Kodi is set up for test mode only (sk_test_...).");
    }
  }

  private async request(method: string, path: string, body?: unknown) {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new PaystackError(`network: ${(err as Error).message}`);
    }
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON body */
    }
    return { httpStatus: res.status, json };
  }

  async initialize(input: InitializeInput): Promise<Initialized> {
    const { httpStatus, json } = await this.request("POST", "/transaction/initialize", {
      amount: Math.round(input.amountKes * 100), // subunits
      currency: "KES",
      channels: ["mobile_money", "card"],
      reference: input.reference,
      email: input.email,
      metadata: input.metadata,
    });
    const data = json?.data;
    if (httpStatus >= 400 || !data?.authorization_url) {
      throw new PaystackError(`initialize HTTP ${httpStatus}: ${json?.message ?? "no data"}`);
    }
    return { authorization_url: data.authorization_url, reference: data.reference ?? input.reference };
  }

  async verify(reference: string): Promise<Verified | null> {
    const { httpStatus, json } = await this.request(
      "GET",
      `/transaction/verify/${encodeURIComponent(reference)}`,
    );
    // Paystack answers 400/404 "Transaction reference not found" for unknown references.
    if ((httpStatus === 400 || httpStatus === 404) && /not found/i.test(json?.message ?? "")) return null;
    const data = json?.data;
    if (httpStatus >= 400 || !data || typeof data.status !== "string") {
      throw new PaystackError(`verify HTTP ${httpStatus}: ${json?.message ?? "no data"}`);
    }
    // Only data.* is trusted. The top-level json.status just means "the API call worked".
    return {
      status: data.status,
      amount: Number(data.amount),
      currency: String(data.currency ?? ""),
      reference: String(data.reference ?? ""),
      channel: String(data.channel ?? ""),
    };
  }
}

/** Stand-in for Paystack used by tests and demo mode. Nothing leaves the machine. */
export class FakePaystack implements Payments {
  txns = new Map<string, { amount: number; status: string; channel: string; metadata: any }>();
  down = false;
  initializeCalls = 0;

  async initialize(input: InitializeInput): Promise<Initialized> {
    if (this.down) throw new PaystackError("simulated outage");
    if (this.txns.has(input.reference)) throw new PaystackError("Duplicate Transaction Reference");
    this.initializeCalls++;
    this.txns.set(input.reference, {
      amount: Math.round(input.amountKes * 100),
      status: "abandoned",
      channel: "",
      metadata: input.metadata,
    });
    return { authorization_url: `https://checkout.paystack.test/${input.reference}`, reference: input.reference };
  }

  async verify(reference: string): Promise<Verified | null> {
    if (this.down) throw new PaystackError("simulated outage");
    const t = this.txns.get(reference);
    if (!t) return null;
    return { status: t.status, amount: t.amount, currency: "KES", reference, channel: t.channel };
  }

  /** Pretend the tenant completed checkout. `paidKes` lets a test pay a different amount. */
  pay(reference: string, paidKes?: number, status = "success") {
    const t = this.txns.get(reference);
    if (!t) throw new Error(`no such fake txn ${reference}`);
    t.status = status;
    t.channel = "mobile_money";
    if (paidKes !== undefined) t.amount = paidKes * 100;
  }
}
