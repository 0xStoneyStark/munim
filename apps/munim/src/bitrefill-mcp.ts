// Bitrefill's official MCP server (https://api.bitrefill.com/mcp) as a second
// catalog surface. The agent only gets its discovery tools; `buy` stays on REST
// behind the purse cap. Auth: Bearer header (the key-in-path form was shut down
// server-side: "Connect to /mcp and send your API key in the Authorization header").
//   tsx apps/munim/src/bitrefill-mcp.ts tools          -> list the server's tools
//   tsx apps/munim/src/bitrefill-mcp.ts search <query> -> product ids and names

import "dotenv/config";
import { McpHttp } from "./mcp-client.js";

const ENDPOINT = "https://api.bitrefill.com/mcp";
const SEARCH_INTENT = "catalog discovery for a household purchasing agent";
const SEARCH_COUNTRY = "IN";

export function bitrefillMcp(apiKey: string = process.env.BITREFILL_API_KEY ?? ""): McpHttp {
  if (!apiKey) throw new Error("BITREFILL_API_KEY not configured");
  return new McpHttp({ name: "bitrefill", url: ENDPOINT, headers: { Authorization: `Bearer ${apiKey}` } });
}

interface SchemaShape {
  properties?: Record<string, unknown>;
}

/** Build search-products arguments from the tool's live inputSchema, keeping only properties it declares. */
function searchArgs(schema: unknown, query: string): Record<string, unknown> {
  const props = Object.keys((schema as SchemaShape | undefined)?.properties ?? {});
  const wanted: Record<string, unknown> = { query, country: SEARCH_COUNTRY, intent: SEARCH_INTENT };
  if (props.length === 0) return wanted;
  const queryKey = ["query", "q", "keyword", "search"].find((k) => props.includes(k));
  const args: Record<string, unknown> = {};
  if (queryKey) args[queryKey] = query;
  for (const k of ["country", "intent"]) if (props.includes(k)) args[k] = wanted[k];
  return args;
}

/** search-products answers in TOON: each `- _id:` block has `name:` before `slug:`. Falls back to raw lines. */
export function productLines(text: string): string[] {
  const out: string[] = [];
  const rawLines = text.split("\n");
  let name: string | null = null;
  for (const line of rawLines) {
    const n = /^\s*name:\s*(.+?)\s*$/.exec(line);
    if (n) name = n[1];
    const s = /^\s*slug:\s*(.+?)\s*$/.exec(line);
    if (s && name) {
      out.push(`${s[1]} | ${name}`);
      name = null;
    }
  }
  return out.length > 0 ? out : rawLines.filter((l) => l.trim()).slice(0, 25);
}

async function runCli(cmd: string | undefined, rest: string[]): Promise<void> {
  const mcp = bitrefillMcp();
  try {
    const tools = await mcp.tools();
    if (cmd === "tools") {
      for (const t of tools) process.stdout.write(`- ${t.name}: ${(t.description ?? "").replace(/\s+/g, " ").slice(0, 120)}\n`);
    } else if (cmd === "search" && rest.length > 0) {
      const tool = tools.find((t) => t.name === "search-products");
      if (!tool) throw new Error("server exposes no search-products tool");
      const args = searchArgs(tool.inputSchema, rest.join(" "));
      process.stderr.write(`search-products args: ${JSON.stringify(args)}\n`);
      for (const l of productLines(await mcp.call(tool.name, args))) process.stdout.write(`${l}\n`);
    } else {
      process.stderr.write("usage: bitrefill-mcp tools | search <query>\n");
      process.exitCode = 1;
    }
  } finally {
    await mcp.close();
  }
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("bitrefill-mcp.ts");
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  await runCli(cmd, rest).catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}
