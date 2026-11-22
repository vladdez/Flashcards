import { useMemo, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Review } from "../core/model";
import { addDay, dayKey } from "../core/study";

type Period = "week" | "month" | "year";
const periods: { value: Period; label: string }[] = [
  { value: "week", label: "Неделя" },
  { value: "month", label: "Месяц" },
  { value: "year", label: "Год" },
];
const weekdays = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];
const dateOf = (day: string) => new Date(`${day}T12:00:00Z`);
const format = (day: string, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("ru", { ...options, timeZone: "UTC" }).format(
    dateOf(day),
  );
const level = (count: number) =>
  count >= 100 ? 3 : count >= 30 ? 2 : count > 0 ? 1 : 0;

function monthDays(first: string) {
  const date = dateOf(first);
  const count = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return Array.from({ length: count }, (_, i) => addDay(first, i));
}

export function ActivityCalendar({
  reviews,
  timeZone,
  today,
  footer,
}: {
  reviews: Review[];
  timeZone: string;
  today: string;
  footer?: ReactNode;
}) {
  const [period, setPeriod] = useState<Period>("week");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const activity = useMemo(() => {
    const days = new Map<string, Set<string>>();
    for (const review of reviews) {
      if (review.kind !== "answer") continue;
      const day = dayKey(review.reviewedAt, timeZone);
      const words = days.get(day) ?? new Set<string>();
      words.add(review.cardId);
      days.set(day, words);
    }
    return days;
  }, [reviews, timeZone]);
  const countFor = (day: string) =>
    day > today ? 0 : (activity.get(day)?.size ?? 0);
  const date = dateOf(today);
  date.setUTCDate(1);
  if (period === "month") date.setUTCMonth(date.getUTCMonth() + offset);
  if (period === "year") {
    date.setUTCMonth(0);
    date.setUTCFullYear(date.getUTCFullYear() + offset);
  }
  const first = date.toISOString().slice(0, 10);
  const end = addDay(today, offset * 7);
  const days =
    period === "week"
      ? Array.from({ length: 7 }, (_, i) => addDay(end, i - 6))
      : monthDays(first);
  const months = Array.from(
    { length: 12 },
    (_, i) => `${first.slice(0, 4)}-${String(i + 1).padStart(2, "0")}-01`,
  );
  const visibleDays = period === "year" ? months.flatMap(monthDays) : days;
  const activeDays = visibleDays.filter((day) => countFor(day) > 0).length;
  const title =
    period === "year"
      ? first.slice(0, 4)
      : period === "month"
        ? format(first, { month: "long", year: "numeric" })
        : `${format(days[0], { day: "numeric", month: "short" })} — ${format(end, { day: "numeric", month: "short", year: "numeric" })}`;

  function changePeriod(value: Period) {
    setPeriod(value);
    setOffset(0);
    setSelected(null);
  }
  function move(delta: number) {
    setOffset(offset + delta);
    setSelected(null);
  }
  function dayCell(day: string, mini = false) {
    const count = countFor(day);
    const label = `${format(day, { day: "numeric", month: "long", year: "numeric" })}: ${day > today ? "предстоит" : `слов: ${count}`}`;
    const className = `activity-day intensity-${level(count)}${day === today ? " is-today" : ""}${day > today ? " is-future" : ""}`;
    return mini ? (
      <span key={day} className={className} title={label} />
    ) : (
      <button
        key={day}
        type="button"
        className={className}
        title={label}
        aria-label={label}
        aria-pressed={selected === day}
        aria-current={day === today ? "date" : undefined}
        disabled={day > today}
        onClick={() => setSelected((current) => (current === day ? null : day))}
      >
        {period === "week" && (
          <small>{format(day, { weekday: "short" })}</small>
        )}
        <span>{Number(day.slice(-2))}</span>
      </button>
    );
  }

  return (
    <div className="activity-calendar">
      <div
        className="activity-periods"
        role="group"
        aria-label="Период занятий"
      >
        {periods.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            aria-pressed={period === value}
            onClick={() => changePeriod(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="activity-navigation">
        <button
          type="button"
          className="icon-button"
          aria-label="Предыдущий период"
          onClick={() => move(-1)}
        >
          <ChevronLeft size={16} />
        </button>
        <span aria-live="polite">{title}</span>
        <button
          type="button"
          className="icon-button"
          aria-label="Следующий период"
          disabled={offset >= 0}
          onClick={() => move(1)}
        >
          <ChevronRight size={16} />
        </button>
      </div>
      {offset !== 0 && (
        <button
          type="button"
          className="activity-return"
          onClick={() => move(-offset)}
        >
          К текущему периоду
        </button>
      )}
      {period === "year" ? (
        <div className="activity-year">
          {months.map((month, index) => (
            <button
              type="button"
              key={month}
              className="activity-mini-month"
              disabled={month > today}
              aria-label={format(month, { month: "long", year: "numeric" })}
              onClick={() => {
                setOffset(
                  (Number(month.slice(0, 4)) - Number(today.slice(0, 4))) * 12 +
                    index -
                    Number(today.slice(5, 7)) +
                    1,
                );
                setPeriod("month");
                setSelected(null);
              }}
            >
              <span>{format(month, { month: "short" })}</span>
              <span className="activity-days activity-mini-days">
                {Array.from(
                  { length: (dateOf(month).getUTCDay() + 6) % 7 },
                  (_, i) => (
                    <span key={`blank-${i}`} />
                  ),
                )}
                {monthDays(month).map((day) => dayCell(day, true))}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className={`activity-days activity-${period}-days`}>
          {period === "month" && (
            <>
              {weekdays.map((day) => (
                <span key={day} className="activity-weekday">
                  {day}
                </span>
              ))}
              {Array.from(
                { length: (dateOf(first).getUTCDay() + 6) % 7 },
                (_, i) => (
                  <span key={`blank-${i}`} />
                ),
              )}
            </>
          )}
          {days.map((day) => dayCell(day))}
        </div>
      )}
      <div
        className="activity-legend"
        aria-label="Интенсивность: уникальных слов за день"
      >
        <span>Слов в день</span>
        {["0", "1–29", "30–99", "100+"].map((label, i) => (
          <span key={label}>
            <i className={`intensity-${i}`} />
            {label}
          </span>
        ))}
        <p className="activity-detail" aria-live="polite">
          {selected ? `Слов: ${countFor(selected)}` : "\u00a0"}
        </p>
      </div>
      <div className="activity-summary" aria-live="polite">
        {footer ?? (
          <span title="Количество дней хотя бы с одним ответом за выбранный период. Пропуски допустимы.">
            Дней с занятиями: {activeDays}
          </span>
        )}
      </div>
    </div>
  );
}
