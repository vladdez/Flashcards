import { Flame, Trophy, CheckCheck, Layers } from "lucide-react";
import type { Snapshot } from "../core/model";
import {
  addDay,
  dayKey,
  deckProgress,
  LEARNED_INTERVAL_DAYS,
  streak,
} from "../core/study";
export function Stats({ snapshot }: { snapshot: Snapshot }) {
  const stats = streak(snapshot.reviews, snapshot.settings.timeZone),
    answers = snapshot.reviews.filter((r) => r.kind === "answer"),
    decks = snapshot.decks.filter((d) => !d.deletedAt);
  const learned = decks.reduce(
    (n, d) => n + deckProgress(d, snapshot.cards, snapshot.schedules).learned,
    0,
  );
  const metrics = [
    { icon: Flame, n: stats.current, label: "дней подряд" },
    { icon: Trophy, n: stats.best, label: "рекордная серия" },
    { icon: CheckCheck, n: answers.length, label: "ответов за всё время" },
    { icon: Layers, n: learned, label: "слов выучено" },
  ];
  return (
    <>
      <div className="page-title">
        <div>
          <div className="eyebrow">КАЖДОЕ ПОВТОРЕНИЕ ИМЕЕТ ЗНАЧЕНИЕ</div>
          <h1>Ваш прогресс</h1>
          <p className="muted">Знания растут с каждым возвращением.</p>
        </div>
      </div>
      <div className="stats-grid">
        {metrics.map((m) => (
          <article className="metric" key={m.label}>
            <m.icon size={23} />
            <strong>{m.n}</strong>
            <span>{m.label}</span>
          </article>
        ))}
      </div>
      <section className="panel">
        <h2>Последние семь дней</h2>
        <div className="activity-week">
          {Array.from({ length: 7 }, (_, i) => addDay(stats.today, i - 6)).map(
            (day) => {
              const count = answers.filter(
                (r) => dayKey(r.reviewedAt, snapshot.settings.timeZone) === day,
              ).length;
              return (
                <div key={day} className={count ? "active" : ""}>
                  <strong>{count}</strong>
                  <span>
                    {new Intl.DateTimeFormat("ru", {
                      weekday: "short",
                      day: "numeric",
                      timeZone: "UTC",
                    }).format(new Date(day + "T12:00:00Z"))}
                  </span>
                </div>
              );
            },
          )}
        </div>
        <p className="hint">
          День засчитывается только после сохранённого ответа. Временная зона:{" "}
          {snapshot.settings.timeZone}.
        </p>
      </section>
      <section className="panel">
        <h2>По колодам</h2>
        {decks.length ? (
          decks.map((d) => {
            const p = deckProgress(d, snapshot.cards, snapshot.schedules);
            return (
              <div className="stats-deck" key={d.id}>
                <span>
                  {d.flagEmoji} {d.name}
                </span>
                <div className="progress-track">
                  <span style={{ width: `${p.percent}%` }} />
                </div>
                <span>
                  {p.learned} / {p.total} · {p.percent}%
                </span>
              </div>
            );
          })
        ) : (
          <p className="muted">Добавьте первую колоду, чтобы начать.</p>
        )}
        <p className="hint">
          Слово выучено, когда интервал составляет не меньше{" "}
          {LEARNED_INTERVAL_DAYS} дней. В режиме «В обе стороны» условие должно
          выполняться в каждом направлении. При уменьшении интервала слово снова
          считается находящимся в процессе.
        </p>
      </section>
    </>
  );
}
