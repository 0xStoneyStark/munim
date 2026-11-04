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

export interface Package {
  package_id: string;
  value: number | string;
  price?: number; // USD, present on details
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
  meta?: Record<string, unknown>;
  data: T;
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
      throw new Error(`bitrefill ${method} ${path} -> ${res.status} ${json.error?.code ?? ""} ${json.error?.message ?? JSON.stringify(json).slice(0, 300)}`);
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
    const line: Record<string, unknown> = { product_id: opts.productId, quantity: 1 };
    if (opts.packageId) line.package_id = opts.packageId;
    if (opts.value !== undefined) line.value = opts.value;
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
