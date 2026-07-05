import { api } from "./api-client";

// Personal API tokens (jnt_…) let an agent / MCP client pipe notes onto your
// canvas. Thin wrapper over /api/tokens using the shared client so the
// cookie-vs-bearer transport switch is handled for us.

export type ApiToken = {
  id: string;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
};

export async function listTokens(): Promise<ApiToken[]> {
  const res = await api.api.tokens.$get();
  if (!res.ok) throw new Error(`list tokens failed (${res.status})`);
  const { tokens } = await res.json();
  return tokens;
}

// Returns the created token AND its raw secret — the secret is only ever
// returned here, at creation, and can't be retrieved again.
export async function createToken(name: string): Promise<{ token: ApiToken; secret: string }> {
  const res = await api.api.tokens.$post({ json: { name } });
  if (!res.ok) throw new Error(`create token failed (${res.status})`);
  return res.json();
}

export async function revokeToken(id: string): Promise<void> {
  const res = await api.api.tokens[":id"].$delete({ param: { id } });
  if (!res.ok && res.status !== 204) throw new Error(`revoke token failed (${res.status})`);
}
