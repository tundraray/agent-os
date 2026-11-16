/**
 * The outcome of an OAuth connection the API hands back on `/account` (design-mcp-connect.md, Contract
 * «Подключения сотрудника»): `?connected=<server>` or `?error=connect_failed[&server=<server>]`. The server
 * is absent when the return matched no connection request.
 */
export type ConnectReturn =
  | { readonly kind: "connected"; readonly server: string }
  | { readonly kind: "failed"; readonly server: string | null };

/**
 * The outcome of the administrator's own connection, handed back on `/admin/servers/<name>` (design-admin.md,
 * DC-9): `?connected=1`, `?error=connect_failed` or `?error=tools_failed`.
 */
export type AdminConnectReturn = "connected" | "connect_failed" | "tools_failed";

const RETURN_PARAMS = ["connected", "error", "server"] as const;

function parseConnectReturn(params: URLSearchParams): ConnectReturn | null {
  const connected = params.get("connected");
  if (connected !== null && connected !== "") return { kind: "connected", server: connected };
  if (params.get("error") === "connect_failed") {
    const server = params.get("server");
    return { kind: "failed", server: server === null || server === "" ? null : server };
  }
  return null;
}

function parseAdminConnectReturn(params: URLSearchParams): AdminConnectReturn | null {
  if (params.get("connected") === "1") return "connected";
  const error = params.get("error");
  if (error === "connect_failed" || error === "tools_failed") return error;
  return null;
}

/**
 * Reads the outcome from the address once and removes the return parameters, so a reload does not repeat it.
 * The address is left as it was when it carries no outcome.
 */
function takeReturn<Outcome>(parse: (params: URLSearchParams) => Outcome | null): Outcome | null {
  const outcome = parse(new URLSearchParams(window.location.search));
  if (outcome === null) return null;
  const url = new URL(window.location.href);
  for (const name of RETURN_PARAMS) url.searchParams.delete(name);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  return outcome;
}

/** The employee's return on `/account`. */
export function takeConnectReturn(): ConnectReturn | null {
  return takeReturn(parseConnectReturn);
}

/** The administrator's return on the server's page. */
export function takeAdminConnectReturn(): AdminConnectReturn | null {
  return takeReturn(parseAdminConnectReturn);
}
