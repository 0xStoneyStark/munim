// Generic HTTP MCP client (Streamable HTTP). Same public shape as SwiggyMcp
// (connect / tools / call / close) so mcp-bridge can wrap either one.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface McpHttpTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface McpHttpOptions {
  url: string;
  headers?: Record<string, string>;
  name?: string;
}

const MAX_ERROR_CHARS = 500;

export class McpHttp {
  private client: Client | null = null;
  private pending: Promise<void> | null = null;

  constructor(private opts: McpHttpOptions) {}

  private fail(prefix: string, e: unknown): Error {
    const msg = e instanceof Error ? e.message : String(e);
    return new Error(`${prefix}: ${msg}`.slice(0, MAX_ERROR_CHARS));
  }

  async connect(): Promise<void> {
    if (this.client) return;
    this.pending ??= this.open().finally(() => {
      this.pending = null;
    });
    await this.pending;
  }

  private async open(): Promise<void> {
    const transport = new StreamableHTTPClientTransport(new URL(this.opts.url), { requestInit: { headers: this.opts.headers ?? {} } });
    const client = new Client({ name: this.opts.name ?? "munim", version: "0.1.0" });
    try {
      await client.connect(transport);
    } catch (e) {
      throw this.fail(`mcp ${this.opts.name ?? "server"} connect failed`, e);
    }
    this.client = client;
  }

  async tools(): Promise<McpHttpTool[]> {
    await this.connect();
    try {
      const r = await this.client!.listTools();
      return r.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    } catch (e) {
      throw this.fail("mcp listTools failed", e);
    }
  }

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    await this.connect();
    let r;
    try {
      r = await this.client!.callTool({ name, arguments: args });
    } catch (e) {
      throw this.fail(`mcp ${name} failed`, e);
    }
    const content = (r.content ?? []) as Array<{ type: string; text?: string }>;
    const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
    if (r.isError) throw new Error(`mcp ${name}: ${text.slice(0, MAX_ERROR_CHARS)}`);
    return text;
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    await c?.close();
  }
}
