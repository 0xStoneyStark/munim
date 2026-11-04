// Bitrefill REST API v2 client (https://docs.bitrefill.com). Bearer API key,
// pays from account balance with auto_pay. Codes are cash: this module never
// logs redemption info.

const BASE_URL = "https://api.bitrefill.com/v2";

export interface Product {
  id: string;
  name: string;
  type: string; // gift_card | phone_refill | esim | bill_payment
  country: string;
  currency: string;
}

/** Live shape (Nov 2026) differs from the docs: `id` not `package_id`, `amount` is the INR face value,
 *  `price` is in minor units of the account's balance currency (satoshis for a BTC account). */
export interface Package {
  id: string;
  value: number | string;
  amount?: number;
  price?: number;
}

export interface ProductDetails extends Product {
  packages?: Package[];
  range?: { min: number; max: number; step: number; price_rate?: number };
}

export interface Invoice {
  id: string;
  status: string;
  payment?: { method: string; price: number; currency: string };
  orders: Array<{ id: string; status: string }>;
}

export interface Order {
  id: string;
  status: string;
  product: { id: string; name: string; value: number | string };
  phone_number?: string;
  redemption_info?: { code?: string; link?: string; pin?: string; instructions?: string };
  error?: string;
}

interface Envelope<T> {
  meta?: Record<string, unknown>; // on errors, echoes the request (incl. phone number) — never surface it
  data: T;
  message?: string; // top-level on 4xx, e.g. "Balance too low"
  error?: { code?: string; message?: string };
}

export class Bitrefill {
  constructor(private apiKey: string) {
    if (!apiKey) throw new Error("BITREFILL_API_KEY not configured");
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(BASE_URL + path, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as Envelope<T>;
    if (!res.ok) {
      const msg = json.message ?? json.error?.message ?? `HTTP ${res.status}`;
      throw new Error(`bitrefill ${method} ${path} -> ${res.status} ${json.error?.code ?? ""} ${msg}`.trim());
    }
    return json.data;
  }

  ping() {
    return this.call<{ message: string }>("GET", "/ping");
  }

  balance() {
    return this.call<{ balance: number; currency: string }>("GET", "/accounts/balance");
  }

  async search(query: string, country = "IN", type?: string): Promise<Product[]> {
    const q = new URLSearchParams({ q: query, country, limit: "25" });
    if (type) q.set("type", type);
    const data = await this.call<Product[] | { products: Product[] }>("GET", `/products/search?${q}`);
    return Array.isArray(data) ? data : data.products ?? [];
  }

  product(id: string) {
    return this.call<ProductDetails>("GET", `/products/${encodeURIComponent(id)}`);
  }

  /** Create and pay an invoice from balance. */
  buy(opts: { productId: string; packageId?: string; value?: number | string; phoneNumber?: string }) {
    // Bitrefill rejects a line that carries both package_id and value; package_id wins
    const line: Record<string, unknown> = { product_id: opts.productId, quantity: 1 };
    if (opts.packageId) line.package_id = opts.packageId;
    else if (opts.value !== undefined) line.value = opts.value;
    if (opts.phoneNumber) line.phone_number = opts.phoneNumber;
    return this.call<Invoice>("POST", "/invoices", { products: [line], payment_method: "balance", auto_pay: true });
  }

  invoice(id: string) {
    return this.call<Invoice>("GET", `/invoices/${encodeURIComponent(id)}`);
  }

  order(id: string) {
    return this.call<Order>("GET", `/orders/${encodeURIComponent(id)}`);
  }

  /** Poll until the order is delivered or failed. Paid is not delivered. */
  async waitDelivered(orderId: string, timeoutMs = 120_000): Promise<Order> {
    const start = Date.now();
    let last: Order | null = null;
    while (Date.now() - start < timeoutMs) {
      last = await this.order(orderId);
      if (last.status === "delivered" || last.status === "failed" || last.status === "refunded") return last;
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (!last) throw new Error("order never fetched");
    return last;
  }
}
