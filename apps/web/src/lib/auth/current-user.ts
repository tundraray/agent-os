import type { CurrentUser } from "@agent-os/contracts";
import { createStore, type StoreApi } from "zustand/vanilla";
import { describeApiError } from "@/lib/api/api-request";
import { loginPath } from "@/lib/auth/login-reason";
import type { logger as appLogger } from "@/lib/logger";

/** `user` is `null` while the employee is not read yet. */
export type CurrentUserState = { user: CurrentUser | null };

export type CurrentUserStore = StoreApi<CurrentUserState> & {
  /** Reads `GET /api/auth/me` on the first call; later calls do nothing (one read per page load). */
  load: () => void;
  /** Ends the session, then loads the login page in full, so no store of this session survives. */
  signOut: () => Promise<void>;
  /**
   * The API answered 403 `ADMIN_REQUIRED`: the read employee loses `isAdmin`. The only write after the
   * read; idempotent, because several requests in flight may get the 403 at once.
   */
  revokeAdmin: () => void;
};

type CurrentUserDeps = {
  read: () => Promise<CurrentUser>;
  endSession: () => Promise<void>;
  /** Defaults to `window.location`, read at sign-out: the store is also built during server rendering. */
  location?: Pick<Location, "assign">;
  logger: Pick<typeof appLogger, "warn">;
};

export function createCurrentUserStore({ read, endSession, location, logger }: CurrentUserDeps): CurrentUserStore {
  const state = createStore<CurrentUserState>()(() => ({ user: null }));
  let requested = false;

  return Object.assign(state, {
    load: (): void => {
      if (requested) return;
      requested = true;
      // A 401 has already sent the tab to /login through the unauthorized handler; any other failure
      // leaves the block in its skeleton until the next page load.
      read().then(
        (user) => state.setState({ user }),
        (error: unknown) => logger.warn("current user read failed", describeApiError(error)),
      );
    },
    signOut: async (): Promise<void> => {
      await endSession();
      (location ?? window.location).assign(loginPath({ reason: "signed_out" }));
    },
    revokeAdmin: (): void => {
      const { user } = state.getState();
      if (user === null || !user.isAdmin) return;
      state.setState({ user: { ...user, isAdmin: false } });
    },
  });
}

/** UXRD UM-01: the name, or the email up to «@» when the name is empty (`CurrentUser` carries no login). */
export function displayName(user: CurrentUser): string {
  const name = user.name.trim();
  return name === "" ? (user.email.split("@")[0] ?? user.email) : name;
}

/** Avatar letters: the first letters of the first two words, upper-cased. */
export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter((word) => word !== "")
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
}
