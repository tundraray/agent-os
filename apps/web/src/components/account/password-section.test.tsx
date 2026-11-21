import { render, screen } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { toast } from "sonner";
import { afterEach, describe, expect, it } from "vitest";
import { Toaster } from "@/components/ui/sonner";
import { server } from "@/test/msw-server";
import { PasswordSection } from "./password-section";

const API = "http://api.test";
const CURRENT = "old-password-123";
const NEXT = "new-password-456";

type Row = {
  name: string;
  status: number;
  reason?: string;
  /** Visible text after the answer. */
  text: string;
  /** The field that carries the error; none on success. */
  invalidField?: "Текущий пароль" | "Новый пароль";
};

// AC-33.3, AC-33.4, MC-35: success clears both fields with «Пароль изменён»; each server reason lands on its own field.
const ROWS: Row[] = [
  { name: "204", status: 204, text: "Пароль изменён" },
  {
    name: "400 wrong_current_password",
    status: 400,
    reason: "wrong_current_password",
    text: "Неверный текущий пароль",
    invalidField: "Текущий пароль",
  },
  {
    name: "400 weak_password",
    status: 400,
    reason: "weak_password",
    text: "Пароль — от 12 до 256 знаков",
    invalidField: "Новый пароль",
  },
];

describe("«Пароль» section follows hasPassword, clears the fields on success and shows the server reason on the right field", () => {
  afterEach(() => {
    // sonner keeps its toasts in a module store: one row's toast must not reach the next row.
    toast.dismiss();
  });

  it("is absent without a password (AC-33.3: only a local account)", () => {
    render(<PasswordSection hasPassword={false} />);

    expect(screen.queryByRole("heading", { name: "Пароль" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Текущий пароль")).not.toBeInTheDocument();
  });

  it.each(ROWS)("$name", async ({ status, reason, text, invalidField }) => {
    let sent: unknown;
    server.use(
      http.post(`${API}/api/auth/password/change`, async ({ request }) => {
        sent = await request.json();
        return status === 204
          ? new HttpResponse(null, { status: 204 })
          : HttpResponse.json(
              { statusCode: 400, message: "Validation failed", errorCode: "VALIDATION_FAILED", reason },
              { status: 400 },
            );
      }),
    );
    const user = userEvent.setup();
    render(
      <>
        <PasswordSection hasPassword />
        <Toaster />
      </>,
    );

    await user.type(screen.getByLabelText("Текущий пароль"), CURRENT);
    await user.type(screen.getByLabelText("Новый пароль"), NEXT);
    await user.click(screen.getByRole("button", { name: "Сменить пароль" }));

    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(sent).toEqual({ currentPassword: CURRENT, newPassword: NEXT });
    const current = screen.getByLabelText("Текущий пароль");
    const next = screen.getByLabelText("Новый пароль");
    if (invalidField === undefined) {
      expect(current).toHaveValue("");
      expect(next).toHaveValue("");
      return;
    }
    const [wrong, right] = invalidField === "Текущий пароль" ? [current, next] : [next, current];
    expect(wrong).toHaveAttribute("aria-invalid", "true");
    expect(wrong).toHaveAccessibleDescription(text);
    expect(right).toHaveAttribute("aria-invalid", "false");
  });
});
