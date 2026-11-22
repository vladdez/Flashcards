import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ActivityCalendar } from "../src/components/ActivityCalendar";
import { review } from "./fixtures";

describe("activity calendar", () => {
  it("counts distinct words in the configured day, excluding resets and duplicate directions", () => {
    const reviews = [
      review("one", "deck", "2024-02-28T23:30:00Z"),
      review("one", "deck", "2024-02-29T08:00:00Z", { direction: "reverse" }),
      review("one", "deck", "2024-02-29T09:00:00Z"),
      review("two", "deck", "2024-02-29T09:00:00Z", { kind: "reset" }),
    ];
    render(
      <ActivityCalendar
        reviews={reviews}
        timeZone="Europe/Berlin"
        today="2024-02-29"
      />,
    );
    const day = screen.getByRole("button", {
      name: "29 февраля 2024 г.: слов: 1",
    });
    expect(day).toHaveClass("intensity-1", "is-today");
    expect(
      screen.getByRole("button", { name: "28 февраля 2024 г.: слов: 0" }),
    ).toHaveClass("intensity-0");
    expect(document.querySelector(".activity-detail")).toBeInTheDocument();
    fireEvent.click(day);
    expect(screen.getByText("Слов: 1")).toBeVisible();
    expect(day).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(day);
    expect(screen.queryByText("Слов: 1")).not.toBeInTheDocument();
    expect(day).toHaveAttribute("aria-pressed", "false");
  });

  it("uses the 30 and 100 word thresholds without inflating repeated answers", () => {
    const reviews = [29, 30, 99, 100].flatMap((count, index) =>
      Array.from({ length: count }, (_, i) =>
        review(`word-${i}`, "deck", `2024-02-${25 + index}T12:00:00Z`),
      ),
    );
    reviews.push(review("word-0", "deck", "2024-02-25T13:00:00Z"));
    render(
      <ActivityCalendar reviews={reviews} timeZone="UTC" today="2024-02-29" />,
    );
    for (const [date, count, level] of [
      [25, 29, 1],
      [26, 30, 2],
      [27, 99, 2],
      [28, 100, 3],
    ]) {
      expect(
        screen.getByRole("button", {
          name: `${date} февраля 2024 г.: слов: ${count}`,
        }),
      ).toHaveClass(`intensity-${level}`);
    }
    expect(screen.getByText("Дней с занятиями: 4")).toBeVisible();
  });

  it("navigates leap years, past periods and year-to-month drilldown without future navigation", () => {
    const { container } = render(
      <ActivityCalendar reviews={[]} timeZone="UTC" today="2024-03-15" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Месяц" }));
    expect(
      screen.getByRole("button", { name: "Следующий период" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "16 марта 2024 г.: предстоит" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Предыдущий период" }));
    expect(
      screen.getByRole("button", { name: "29 февраля 2024 г.: слов: 0" }),
    ).toBeVisible();
    expect(
      container.querySelectorAll(".activity-month-days button"),
    ).toHaveLength(29);
    fireEvent.click(screen.getByRole("button", { name: "Год" }));
    expect(container.querySelectorAll(".activity-day")).toHaveLength(366);
    fireEvent.click(screen.getByRole("button", { name: "Предыдущий период" }));
    expect(container.querySelectorAll(".activity-day")).toHaveLength(365);
    fireEvent.click(screen.getByRole("button", { name: "декабрь 2023 г." }));
    expect(
      screen.getByRole("button", { name: "31 декабря 2023 г.: слов: 0" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Следующий период" }));
    expect(
      screen.getByRole("button", { name: "1 января 2024 г.: слов: 0" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "К текущему периоду" }));
    expect(
      screen.getByRole("button", { name: "15 марта 2024 г.: слов: 0" }),
    ).toHaveAttribute("aria-current", "date");
  });
});
