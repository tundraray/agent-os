import type { ReactNode } from "react";
import type { ErrorsTranslator } from "@/lib/agents/format";
import { isApiRequestError } from "@/lib/api/api-request";

/**
 * The API's own text inside a phrase of the interface: the API writes it in English, so it is marked as
 * English for screen readers in any interface language (UXRD Accessibility, WCAG 3.1.2; DC-6).
 */
export function ServerText({ children }: { children: ReactNode }) {
  return <span lang="en">{children}</span>;
}

/**
 * The shared fallback of a refusal whose code has no message (design-web.md, «Отказы сервера»):
 * «Не удалось сохранить: {текст сервера}» with the server's text marked English, or «… нет связи с
 * сервером» when the request never got an answer. A node, so the language mark reaches the form or notice.
 */
export function saveFailedText(t: ErrorsTranslator, cause: unknown): ReactNode {
  if (isApiRequestError(cause) && cause.kind === "network") return t("noConnection");
  const text = cause instanceof Error ? cause.message : String(cause);
  return t.rich("saveFailed", { text, server: (chunks) => <ServerText>{chunks}</ServerText> });
}
