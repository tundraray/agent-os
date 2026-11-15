import { IdentityErrorCode } from "@agent-os/contracts";

export type LoginReason = "expired" | "disabled";

type PageLocation = Pick<Location, "pathname" | "search" | "assign">;

/**
 * Sends the tab to /login after a 401, with the reason and the current page as `next` (DC-13).
 * A full page load drops every in-memory store of the signed-out session.
 */
export function redirectToLogin(code: string | undefined, location: PageLocation = window.location): void {
  const reason: LoginReason = code === IdentityErrorCode.ACCOUNT_DISABLED ? "disabled" : "expired";
  const query = new URLSearchParams({ reason, next: `${location.pathname}${location.search}` });
  location.assign(`/login?${query.toString()}`);
}
