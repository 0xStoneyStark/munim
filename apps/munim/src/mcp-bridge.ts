// Generic bridge: every tool of a connected MCP server becomes an Anthropic
// tool-runner tool. Schemas come from the server as JSON Schema and pass through
// untouched; names are sanitised to what the Messages API accepts.

import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import type { SwiggyMcp } from "./swiggy-mcp.js";

export interface BridgeOptions {
  prefix?: string;
  allow?: (name: string) => boolean;
  log?: (line: string) => void;
  confirmBeforeCall?: (name: string, args: Record<string, unknown>) => Promise<boolean>;
}

// bridged tools plus anthropic-name -> original MCP name
export type BridgedTools = BetaRunnableTool<Record<string, unknown>>[] & { nameMap: Map<string, string> };

const MAX_RESULT_CHARS = 6000;
const MAX_NAME_LEN = 64;
const RISKY = /order|checkout|pay|place|confirm|book/i;
const EMPTY_SCHEMA = { type: "object" as const, properties: {} };

export function sanitiseName(raw: string, prefix = ""): string {
  const clean = `${prefix}${raw}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  return clean.slice(0, MAX_NAME_LEN) || "tool";
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function truncate(text: string): string {
  return text.length <= MAX_RESULT_CHARS ? text : `${text.slice(0, MAX_RESULT_CHARS)}\n...[truncated ${text.length - MAX_RESULT_CHARS} chars]`;
}

function asObjectSchema(schema: unknown): typeof EMPTY_SCHEMA {
  if (schema && typeof schema === "object" && (schema as { type?: unknown }).type === "object") return schema as typeof EMPTY_SCHEMA;
  return EMPTY_SCHEMA;
}

export async function bridgeTools(mcp: SwiggyMcp, opts: BridgeOptions = {}): Promise<BridgedTools> {
  const { prefix = "", allow, log, confirmBeforeCall } = opts;
  const nameMap = new Map<string, string>();
  const out: BetaRunnableTool<Record<string, unknown>>[] = [];

  for (const t of await mcp.tools()) {
    if (allow && !allow(t.name)) continue;

    // sanitised names must stay unique; suffix a counter if two collapse to the same string
    const base = sanitiseName(t.name, prefix);
    let name = base;
    for (let i = 2; nameMap.has(name); i++) {
      const suffix = `_${i}`;
      name = `${base.slice(0, MAX_NAME_LEN - suffix.length)}${suffix}`;
    }
    nameMap.set(name, t.name);
    const original = t.name;

    out.push(
      betaTool({
        name,
        description: (t.description ?? "").trim() || `MCP tool ${original}`,
        // JSON Schema from the server, passed through; the cast stops FromSchema inference from going deep
        inputSchema: asObjectSchema(t.inputSchema) as { type: "object"; properties: Record<string, never> },
        run: async (rawArgs) => {
          const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
          try {
            if (confirmBeforeCall && RISKY.test(original)) {
              if (!(await confirmBeforeCall(original, args))) {
                log?.(`guardrail declined ${original}`);
                return "ERROR: declined by guardrail";
              }
            }
            log?.(`mcp ${original} ${JSON.stringify(args).slice(0, 200)}`);
            return truncate(await mcp.call(original, args));
          } catch (e) {
            log?.(`mcp ${original} failed: ${errMsg(e)}`);
            return `ERROR: ${errMsg(e)}`;
          }
        },
      }) as unknown as BetaRunnableTool<Record<string, unknown>>,
    );
  }
  return Object.assign(out, { nameMap });
}
