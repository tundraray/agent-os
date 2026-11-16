import { render, screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { MyModels } from "@agent-os/contracts";
import { server } from "@/test/msw-server";
import { ModelsSection } from "./models-section";

const API = "http://api.test";

function serveModels(body: MyModels): void {
  server.use(http.get(`${API}/api/access/models`, () => HttpResponse.json(body)));
}

const cellsOf = (row: HTMLElement): string[] =>
  within(row)
    .getAllByRole("cell")
    .map((cell) => cell.textContent ?? "");

describe("«Модели и расход» (MA-02)", () => {
  // AC-23.1, DC-9: remaining never below zero, «без предела» without a quota, the exhausted label.
  it("shows a row per allowed model with spend, quota and remaining, «без предела» without a quota and «Квота исчерпана» with remaining 0,00 $", async () => {
    serveModels({
      month: "2026-11",
      models: [
        { model: "anthropic/haiku", name: "Haiku", spentUsd: 3.1, quotaUsd: null, remainingUsd: null, exhausted: false },
        { model: "anthropic/opus", name: "Opus", spentUsd: 12.5, quotaUsd: 50, remainingUsd: 37.5, exhausted: false },
        { model: "anthropic/sonnet", name: "Sonnet", spentUsd: 100.4, quotaUsd: 100, remainingUsd: 0, exhausted: true },
      ],
    });
    render(<ModelsSection />);

    expect(await screen.findByRole("heading", { name: "Модели и расход за ноябрь" })).toBeInTheDocument();
    const table = screen.getByRole("table");
    const header = within(table)
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);
    expect(header).toEqual(["Модель", "Расход", "Квота", "Остаток"]);
    const [, haiku, opus, sonnet] = within(table).getAllByRole("row");
    expect(cellsOf(haiku!)).toEqual(["Haiku", "3,10 $", "без предела", "—"]);
    expect(cellsOf(opus!)).toEqual(["Opus", "12,50 $", "50 $", "37,50 $"]);
    expect(cellsOf(sonnet!)).toEqual(["Sonnet", "100,40 $", "100 $", "0,00 $Квота исчерпана"]);
  });

  // AC-23.1: an employee with no allowed model reads MC-9 instead of an empty table.
  it("shows MC-9 when the list is empty", async () => {
    serveModels({ month: "2026-11", models: [] });
    render(<ModelsSection />);

    expect(
      await screen.findByText("Вам не разрешена ни одна модель. Обратитесь к администратору Agent OS."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
