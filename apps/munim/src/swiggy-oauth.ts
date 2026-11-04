// OAuth 2.1 (PKCE, dynamic client registration) against Swiggy's MCP auth server.
// The human signs in with their Swiggy OTP once; tokens live in data/swiggy-tokens.json.
//   npm run swiggy:login   -> prints the URL to open; the dashboard's callback stores the token

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const AUTH = "https://mcp.swiggy.com/auth";
const DATA = path.resolve("data");
const CLIENT_FILE = path.join(DATA, "swiggy-client.json");
const PKCE_FILE = path.join(DATA, "swiggy-pkce.json");
const TOKEN_FILE = path.join(DATA, "swiggy-tokens.json");
// PUBLIC_BASE_URL (e.g. https://munim.henryshop.com) is set when the dashboard is hosted behind a domain.
const BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.DASHBOARD_PORT ?? "8788"}`).replace(/\/+$/, "");
export const REDIRECT_URI = `${BASE_URL}/oauth/swiggy/callback`;
const SCOPE = "mcp:tools mcp:resources mcp:prompts";

interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
}

function readJson<T>(f: string): T | null {
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as T) : null;
}

async function clientId(): Promise<string> {
  const c = readJson<{ client_id: string }>(CLIENT_FILE);
  if (c) return c.client_id;
  const res = await fetch(`${AUTH}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Munim household agent",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPE,
    }),
  });
  const j = (await res.json()) as { client_id?: string; error_description?: string };
  if (!j.client_id) throw new Error("swiggy client registration failed: " + (j.error_description ?? res.status));
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(CLIENT_FILE, JSON.stringify(j, null, 2));
  return j.client_id;
}

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Build the URL the human opens to sign in. Stores the PKCE verifier for the callback. */
export async function loginUrl(): Promise<string> {
  const id = await clientId();
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  fs.writeFileSync(PKCE_FILE, JSON.stringify({ verifier, state }));
  const q = new URLSearchParams({
    response_type: "code",
    client_id: id,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${AUTH}/authorize?${q}`;
}

/** Called by the dashboard with the ?code=&state= the browser brings back. */
export async function exchangeCode(code: string, state: string): Promise<void> {
  const pkce = readJson<{ verifier: string; state: string }>(PKCE_FILE);
  if (!pkce || pkce.state !== state) throw new Error("oauth state mismatch");
  const res = await fetch(`${AUTH}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: await clientId(),
      code_verifier: pkce.verifier,
    }),
  });
  const j = (await res.json()) as Tokens & { expires_in?: number; error_description?: string };
  if (!j.access_token) throw new Error("token exchange failed: " + (j.error_description ?? res.status));
  saveTokens(j);
  fs.unlinkSync(PKCE_FILE);
}

function saveTokens(t: Tokens & { expires_in?: number }) {
  const expires_at = t.expires_in ? Date.now() + t.expires_in * 1000 : undefined;
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ access_token: t.access_token, refresh_token: t.refresh_token, expires_at }, null, 2));
}

/** A valid bearer token, refreshing if needed; null when the human has not signed in. */
export async function accessToken(): Promise<string | null> {
  const t = readJson<Tokens>(TOKEN_FILE);
  if (!t) return null;
  if (!t.expires_at || t.expires_at - Date.now() > 60_000) return t.access_token;
  if (!t.refresh_token) return t.access_token;
  const res = await fetch(`${AUTH}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: await clientId() }),
  });
  const j = (await res.json()) as Tokens & { expires_in?: number };
  if (!j.access_token) return t.access_token;
  saveTokens({ ...j, refresh_token: j.refresh_token ?? t.refresh_token });
  return j.access_token;
}

export function isLoggedIn(): boolean {
  return fs.existsSync(TOKEN_FILE);
}
