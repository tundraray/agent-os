import { z } from "zod";

// Next inlines NEXT_PUBLIC_* into the client bundle at build time only for the literal
// `process.env.NEXT_PUBLIC_API_URL` expression — no destructuring, no dynamic key.
const parsed = z.url({ protocol: /^https?$/ }).safeParse(process.env.NEXT_PUBLIC_API_URL);

if (!parsed.success) {
  throw new Error("NEXT_PUBLIC_API_URL must be an absolute http(s) URL");
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

// A production bundle must not send chat traffic in clear text; loopback stays allowed for local `next start`.
if (process.env.NODE_ENV === "production") {
  const { protocol, hostname } = new URL(parsed.data);
  if (protocol !== "https:" && !LOOPBACK_HOSTS.has(hostname)) {
    throw new Error("NEXT_PUBLIC_API_URL must use https in production (http is allowed only for localhost)");
  }
}

/** Public API origin, without a trailing slash. Not a secret: it ships in the client bundle. */
export const apiBaseUrl = parsed.data.replace(/\/+$/, "");

/**
 * Emergency switch for «Перегенерировать» in the reply error block (UXRD TH-08 Rollback). `true` ships;
 * `false` withdraws the action in one line — the block then reads only «Не удалось получить ответ.».
 */
export const regenerateAfterError: boolean = true;
