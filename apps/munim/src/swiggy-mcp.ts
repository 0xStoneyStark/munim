// Swiggy's official MCP servers (food / instamart / dineout) as a client.
// The agent uses these to *spend* what Bitrefill bought: a Swiggy Money gift
// card, redeemed once by the human, pays for an Instamart order the agent builds.
//   tsx apps/munim/src/swiggy-mcp.ts login            -> URL for the human to sign in
//   tsx apps/munim/src/swiggy-mcp.ts tools [instamart] -> list the server's tools

import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { accessToken, loginUrl, REDIRECT_URI } from "./swiggy-oauth.js";

export type SwiggyServer = "food" | "instamart" | "dineout";

export interface SwiggyTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export class SwiggyMcp {
  private client: Client | null = null;

  constructor(private server: SwiggyServer = "instamart") {}

  async connect(): Promise<void> {
    if (this.client) return;
    const token = await accessToken();
    if (!token) throw new Error("Swiggy not linked: open the dashboard and click 'Link Swiggy' (or run swiggy-mcp login)");
    const transport = new StreamableHTTPClientTransport(new URL(`https://mcp.swiggy.com/${this.server}`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "munim", version: "0.1.0" });
    await client.connect(transport);
    this.client = client;
  }

  async tools(): Promise<SwiggyTool[]> {
    await this.connect();
    const r = await this.client!.listTools();
    return r.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  }

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    await this.connect();
    const r = await this.client!.callTool({ name, arguments: args });
    const content = (r.content ?? []) as Array<{ type: string; text?: string }>;
    const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
    if (r.isError) throw new Error(`swiggy ${name}: ${text.slice(0, 500)}`);
    return text;
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }
}

// CLI
const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("swiggy-mcp.ts");
if (isMain) {
  const [cmd, which] = process.argv.slice(2);
  if (cmd === "login") {
    process.stdout.write(`Open this URL, sign in with your Swiggy OTP, and it will return to ${REDIRECT_URI} (dashboard must be running):\n${await loginUrl()}\n`);
  } else if (cmd === "tools") {
    const s = new SwiggyMcp((which as SwiggyServer) ?? "instamart");
    const tools = await s.tools();
    for (const t of tools) process.stdout.write(`- ${t.name}: ${(t.description ?? "").replace(/\s+/g, " ").slice(0, 160)}\n  schema: ${JSON.stringify(t.inputSchema).slice(0, 300)}\n`);
    await s.close();
  } else {
    process.stderr.write("usage: swiggy-mcp login | tools [food|instamart|dineout]\n");
    process.exit(1);
  }
}
