import type { ReactNode } from "react";
import { isApiRequestError } from "@/lib/api/api-request";
import type { ErrorsTranslator } from "./catalog";

/**
 * The API's own text inside a phrase of the interface: the API writes it in English, so it is marked as
 * English for screen readers in any interface language (UXRD Accessibility, WCAG 3.1.2; DC-6).
 */
function ServerText({ children }: { children: ReactNode }) {
  return <span lang="en">{children}</span>;
}

/** What the refused request was doing: it opens the phrase («Не удалось сохранить: …»). */
export type FailedAction = "save" | "copy" | "delete";

/**
 * The shared fallback of a refusal whose code has no message (design-web.md, «Отказы сервера»):
 * «Не удалось сохранить: {текст сервера}» with the server's text marked English, or «… нет связи с
 * сервером» when the request never got an answer. A node, so the language mark reaches the form or notice.
 */
export function failedText(t: ErrorsTranslator, action: FailedAction, cause: unknown): ReactNode {
  if (isApiRequestError(cause) && cause.kind === "network") return t(`noConnection.${action}`);
  const text = cause instanceof Error ? cause.message : String(cause);
  return t.rich(`failed.${action}`, { text, server: (chunks) => <ServerText>{chunks}</ServerText> });
}
