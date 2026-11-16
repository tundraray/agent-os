import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { toast } from "sonner";
import { afterEach, describe, expect, it } from "vitest";
import type { McpConnection } from "@agent-os/contracts";
import { Toaster } from "@/components/ui/sonner";
import { server } from "@/test/msw-server";
import { ConnectionsSection } from "./connections-section";

const API = "http://api.test";

const SENTRY: McpConnection = { server: "sentry", url: "https://mcp.sentry.dev/mcp", status: "needs_auth" };
const JIRA: McpConnection = { server: "jira", url: "https://jira.example.com/mcp", status: "connected" };

function serveConnections(list: McpConnection[]): void {
  server.use(http.get(`${API}/api/mcp/connections`, () => HttpResponse.json(list)));
}

function renderSection(): void {
  render(
    <>
      <ConnectionsSection />
      <Toaster />
    </>,
  );
}

const rowOf = (name: string): HTMLElement => screen.getByRole("listitem", { name });

describe("«Подключения» (MA-01): a row per server with its badge and action, the empty list and the OAuth return", () => {
  afterEach(() => {
    // sonner keeps its toasts in a module store: one test's toast must not reach the next.
    toast.dismiss();
    window.history.replaceState(null, "", "/");
  });

  // AC-14.1, AC-14.3, AC-14.4: «Подключить» is a link to the connect route; «Отключить» sends DELETE and flips the row.
  it("shows each server with its state and action; «Отключить» sends DELETE and the row turns to «Нужна аутентификация»", async () => {
    serveConnections([SENTRY, JIRA]);
    let deleted: string | undefined;
    server.use(
      http.delete(`${API}/api/mcp/connections/:server`, ({ params }) => {
        deleted = String(params.server);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderSection();

    const sentry = await screen.findByRole("listitem", { name: "sentry" });
    expect(within(sentry).getByText("mcp.sentry.dev")).toBeInTheDocument();
    expect(within(sentry).getByText("Нужна аутентификация")).toBeInTheDocument();
    expect(within(sentry).getByRole("link", { name: "Подключить" })).toHaveAttribute(
      "href",
      "http://api.test/api/mcp/connections/sentry/connect",
    );
    const jira = rowOf("jira");
    expect(within(jira).getByText("Подключено")).toBeInTheDocument();

    await user.click(within(jira).getByRole("button", { name: "Отключить" }));

    expect(await within(jira).findByText("Нужна аутентификация")).toBeInTheDocument();
    expect(deleted).toBe("jira");
    expect(within(jira).getByRole("link", { name: "Подключить" })).toHaveAttribute(
      "href",
      "http://api.test/api/mcp/connections/jira/connect",
    );
    expect(await screen.findByText("Аккаунт jira отключён")).toBeInTheDocument();
  });

  // AC-14.6.
  it("shows «Подключать пока нечего» without servers", async () => {
    serveConnections([]);
    renderSection();

    expect(await screen.findByText("Подключать пока нечего")).toBeInTheDocument();
    expect(
      screen.getByText("Когда администратор даст вам доступ к серверу с личным входом, он появится здесь."),
    ).toBeInTheDocument();
  });

  // AC-14.3, AC-14.5, UXRD Accessibility «Возврат на «Мой доступ» после подключения»: focus on the row's button.
  // A return without `server` has no row: no focus move, the alert stands above the list.
  it.each([
    {
      name: "connected → notice",
      search: "?connected=jira",
      focus: { row: "jira", role: "button", name: "Отключить" },
      notice: "Аккаунт jira подключён",
      alert: null,
    },
    {
      name: "error=connect_failed → MC-8 under the row",
      search: "?error=connect_failed&server=sentry",
      focus: { row: "sentry", role: "link", name: "Подключить" },
      notice: null,
      alert: {
        row: "sentry",
        text: "Не удалось подключить аккаунт sentry: вход отменён или не завершён. Попробуйте ещё раз.",
      },
    },
    {
      name: "error=connect_failed without a server → the section's alert",
      search: "?error=connect_failed",
      focus: null,
      notice: null,
      alert: { row: null, text: "Не удалось подключить аккаунт. Попробуйте ещё раз." },
    },
  ] as const)("return $name", async ({ search, focus, notice, alert }) => {
    window.history.replaceState(null, "", `/account${search}`);
    serveConnections([SENTRY, JIRA]);
    renderSection();

    await screen.findByRole("listitem", { name: "sentry" });
    if (focus !== null) {
      const target = within(rowOf(focus.row)).getByRole(focus.role, { name: focus.name });
      await waitFor(() => expect(target).toHaveFocus());
    }
    if (notice !== null) expect(await screen.findByText(notice)).toBeInTheDocument();
    if (alert === null) expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    else {
      const scope = alert.row === null ? screen : within(rowOf(alert.row));
      expect(scope.getByRole("alert")).toHaveTextContent(alert.text);
    }
    expect(window.location.pathname).toBe("/account");
    expect(window.location.search).toBe("");
  });
});
