/**
 * The outcome of an OAuth connection the API hands back on `/account` (design-mcp-connect.md, Contract
 * «Подключения сотрудника»): `?connected=<server>` or `?error=connect_failed[&server=<server>]`. The server
 * is absent when the return matched no connection request.
 */
export type ConnectReturn =
  | { readonly kind: "connected"; readonly server: string }
  | { readonly kind: "failed"; readonly server: string | null };

const RETURN_PARAMS = ["connected", "error", "server"] as const;

function parseConnectReturn(search: string): ConnectReturn | null {
  const params = new URLSearchParams(search);
  const connected = params.get("connected");
  if (connected !== null && connected !== "") return { kind: "connected", server: connected };
  if (params.get("error") === "connect_failed") {
    const server = params.get("server");
    return { kind: "failed", server: server === null || server === "" ? null : server };
  }
  return null;
}

/** Reads the outcome from the address once and removes its parameters, so a reload does not repeat it. */
export function takeConnectReturn(): ConnectReturn | null {
  const outcome = parseConnectReturn(window.location.search);
  if (outcome === null) return null;
  const url = new URL(window.location.href);
  for (const name of RETURN_PARAMS) url.searchParams.delete(name);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  return outcome;
}
