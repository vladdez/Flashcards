import {
  BasicLearningStepsStrategy,
  createEmptyCard,
  fsrs,
  Rating,
  State,
  StrategyMode,
  type Card as FSRSCard,
  type Grade,
} from "ts-fsrs";
import {
  directions,
  type Card,
  type Deck,
  type Direction,
  type Review,
  type Schedule,
  type SerializedFSRS,
  type Snapshot,
} from "./model";

export const serialize = (c: FSRSCard): SerializedFSRS => ({
  ...c,
  due: c.due.toISOString(),
  last_review: c.last_review?.toISOString(),
});
export const deserialize = (c: SerializedFSRS): FSRSCard => ({
  ...c,
  due: new Date(c.due),
  last_review: c.last_review ? new Date(c.last_review) : undefined,
});
export function scheduler(retention: number) {
  const instance = fsrs({ request_retention: retention, enable_fuzz: false });
  // Only the first Good learning step changes; Hard, graduation and
  // relearning keep FSRS defaults. The same rule also replays past answers.
  instance.useStrategy(StrategyMode.LEARNING_STEPS, (params, state, step) => {
    const steps = BasicLearningStepsStrategy(params, state, step);
    const good = steps[Rating.Good];
    if ((state === State.New || state === State.Learning) && good)
      steps[Rating.Good] = { ...good, scheduled_minutes: 30 };
    return steps;
  });
  return instance;
}
export function preview(
  schedule: Schedule | undefined,
  retention: number,
  now = new Date(),
) {
  return scheduler(retention).repeat(
    schedule ? deserialize(schedule.fsrs) : createEmptyCard(now),
    now,
  );
}
export function rebuildSchedules(reviews: Review[]): Schedule[] {
  const result = new Map<string, Schedule>();
  for (const review of [...reviews].sort(
    (a, b) =>
      a.reviewedAt.localeCompare(b.reviewedAt) || a.id.localeCompare(b.id),
  )) {
    const key = `${review.cardId}:${review.direction}`;
    if (review.kind === "reset") {
      result.delete(key);
      continue;
    }
    const date = new Date(review.reviewedAt);
    const before = result.get(key);
    const after = scheduler(review.retention).next(
      before ? deserialize(before.fsrs) : createEmptyCard(date),
      date,
      review.rating as Grade,
    );
    result.set(key, {
      id: key,
      cardId: review.cardId,
      direction: review.direction,
      fsrs: serialize(after.card),
    });
  }
  return [...result.values()];
}
export function dayKey(date: Date | string, timeZone: string) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(date));
}
export function addDay(day: string, delta: number) {
  const date = new Date(day + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}
export function streak(reviews: Review[], timeZone: string, now = new Date()) {
  const days = [
    ...new Set(
      reviews
        .filter((r) => r.kind === "answer")
        .map((r) => dayKey(r.reviewedAt, timeZone)),
    ),
  ].sort();
  const today = dayKey(now, timeZone);
  let best = 0,
    run = 0,
    previous = "";
  for (const day of days.filter((day) => day <= today)) {
    run = addDay(previous || day, 1) === day ? run + 1 : 1;
    best = Math.max(best, run);
    previous = day;
  }
  const daySet = new Set(days);
  let cursor = daySet.has(today) ? today : addDay(today, -1),
    current = 0;
  while (daySet.has(cursor)) {
    current++;
    cursor = addDay(cursor, -1);
  }
  return { current, best, days: daySet, today };
}
export type StudyItem = {
  cardId: string;
  direction: Direction;
  isNew: boolean;
};
export function studyQueue(
  deck: Deck,
  snapshot: Snapshot,
  now = new Date(),
  mode: "all" | "due" | "new" = "all",
): StudyItem[] {
  const cards = snapshot.cards.filter(
    (c) => c.deckId === deck.id && !c.deletedAt,
  );
  const schedules = new Map(snapshot.schedules.map((s) => [s.id, s]));
  const first = new Map<string, Review>();
  for (const r of snapshot.reviews
    .filter((r) => r.kind === "answer")
    .sort(
      (a, b) =>
        a.reviewedAt.localeCompare(b.reviewedAt) || a.id.localeCompare(b.id),
    ))
    if (!first.has(r.cardId)) first.set(r.cardId, r);
  const today = dayKey(now, snapshot.settings.timeZone);
  const used = [...first.values()].filter(
    (r) =>
      r.deckId === deck.id &&
      dayKey(r.reviewedAt, snapshot.settings.timeZone) === today,
  ).length;
  let remaining = Math.max(0, deck.newWordsPerDay - used);
  const due: { item: StudyItem; date: string }[] = [],
    fresh: StudyItem[] = [];
  for (const card of cards.sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  )) {
    const introduced = first.has(card.id);
    const allowNew = introduced || remaining > 0;
    let consumed = false;
    for (const direction of directions(deck.studyMode)) {
      const schedule = schedules.get(`${card.id}:${direction}`);
      if (schedule && new Date(schedule.fsrs.due) <= now)
        due.push({
          item: { cardId: card.id, direction, isNew: false },
          date: schedule.fsrs.due,
        });
      else if (!schedule && allowNew) {
        fresh.push({ cardId: card.id, direction, isNew: true });
        consumed = true;
      }
    }
    if (!introduced && consumed) remaining--;
  }
  const dueItems = due
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((x) => x.item);
  return mode === "due"
    ? dueItems
    : mode === "new"
      ? fresh
      : [...dueItems, ...fresh];
}
export const LEARNED_INTERVAL_DAYS = 3;
export function deckProgress(
  deck: Deck,
  cards: Card[],
  schedules: Schedule[],
  now = new Date(),
) {
  const active = cards.filter((c) => c.deckId === deck.id && !c.deletedAt);
  const map = new Map(schedules.map((s) => [s.id, s.fsrs]));
  let learned = 0,
    due = 0,
    fresh = 0;
  for (const card of active) {
    const states = directions(deck.studyMode).map((d) =>
      map.get(`${card.id}:${d}`),
    );
    if (states.every((s) => s && s.scheduled_days >= LEARNED_INTERVAL_DAYS))
      learned++;
    due += states.filter((s) => s && new Date(s.due) <= now).length;
    if (states.some((s) => !s)) fresh++;
  }
  return {
    total: active.length,
    learned,
    due,
    fresh,
    percent: active.length ? Math.round((learned / active.length) * 100) : 0,
  };
}
export function intervalLabel(due: Date, now: Date) {
  const minutes = Math.max(1, Math.round((+due - +now) / 60000));
  if (minutes < 60) return `${minutes} мин`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} ч`;
  return `${Math.round(minutes / 1440)} дн`;
}
