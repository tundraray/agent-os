import {
  CurrentUserSchema,
  ProviderButtonListSchema,
  type CurrentUser,
  type PasswordChangeBody,
  type PasswordSignInBody,
  type ProviderButtonList,
} from "@agent-os/contracts";
import { apiRequest } from "@/lib/api/api-request";
import { apiBaseUrl } from "@/lib/config";

async function me(): Promise<CurrentUser> {
  return apiRequest({ path: "/api/auth/me", schema: CurrentUserSchema });
}

/** 204 also without a session. */
async function signOut(): Promise<void> {
  await apiRequest({ path: "/api/auth/sign-out", method: "POST" });
}

async function providers(): Promise<ProviderButtonList> {
  return apiRequest({ path: "/api/auth/providers", schema: ProviderButtonListSchema });
}

/** 204 and the session cookie; 401 `INVALID_CREDENTIALS` or `ACCOUNT_DISABLED` surfaces as `http`. */
async function signInWithPassword(body: PasswordSignInBody): Promise<void> {
  await apiRequest({ path: "/api/auth/password", method: "POST", body });
}

/** 204; 400 `VALIDATION_FAILED` carries `reason` (`wrong_current_password`, `weak_password`, `not_local_account`). */
async function changePassword(body: PasswordChangeBody): Promise<void> {
  await apiRequest({ path: "/api/auth/password/change", method: "POST", body });
}

/** The provider sign-in answers 302 to the provider, so the tab goes to this address instead of a request. */
function providerSignInUrl(providerId: string, next: string): string {
  const query = new URLSearchParams({ next }).toString();
  return `${apiBaseUrl}/api/auth/sign-in/${encodeURIComponent(providerId)}?${query}`;
}

export const authApi = { me, signOut, providers, signInWithPassword, changePassword, providerSignInUrl };
