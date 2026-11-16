import { IdentityErrorCode } from "@agent-os/contracts";
import { loginPath } from "@/lib/auth/login-reason";

type PageLocation = Pick<Location, "pathname" | "search" | "assign">;

/**
 * Sends the tab to /login after a 401, with the reason and the current page as `next` (DC-13).
 * A full page load drops every in-memory store of the signed-out session.
 */
export function redirectToLogin(code: string | undefined, location: PageLocation = window.location): void {
  const reason = code === IdentityErrorCode.ACCOUNT_DISABLED ? "disabled" : "expired";
  location.assign(loginPath({ reason, next: `${location.pathname}${location.search}` }));
}
