import {
  CurrentUserSchema,
  ProviderButtonListSchema,
  type CurrentUser,
  type Language,
  type LanguageBody,
  type PasswordChangeBody,
  type PasswordSignInBody,
  type ProviderButtonList,
} from "@agent-os/contracts";
import { apiRequest } from "@/lib/api/api-request";

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

/** 204 with the `aos_locale` cookie of the choice; 400 `VALIDATION_FAILED` for a language outside the set. */
async function saveLanguage(language: Language): Promise<void> {
  const body: LanguageBody = { language };
  await apiRequest({ path: "/api/auth/me/language", method: "PUT", body });
}

/** The provider sign-in answers 302 to the provider, so the tab goes to this address instead of a request. */
function providerSignInUrl(providerId: string, next: string): string {
  const query = new URLSearchParams({ next }).toString();
  return `/api/auth/sign-in/${encodeURIComponent(providerId)}?${query}`;
}

export const authApi = { me, signOut, providers, signInWithPassword, changePassword, saveLanguage, providerSignInUrl };
