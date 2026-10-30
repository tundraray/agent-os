import { z } from "zod";

// Next inlines NEXT_PUBLIC_* into the client bundle at build time only for the literal
// `process.env.NEXT_PUBLIC_API_URL` expression — no destructuring, no dynamic key.
const parsed = z.url({ protocol: /^https?$/ }).safeParse(process.env.NEXT_PUBLIC_API_URL);

if (!parsed.success) {
  throw new Error("NEXT_PUBLIC_API_URL must be an absolute http(s) URL");
}

/** Public API origin, without a trailing slash. Not a secret: it ships in the client bundle. */
export const apiBaseUrl = parsed.data.replace(/\/+$/, "");
