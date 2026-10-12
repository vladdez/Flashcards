import { describe, expect, it } from "vitest";
import { createEmptyCard, Rating, fsrs } from "ts-fsrs";
import {
  dayKey,
  deckProgress,
  preview,
  rebuildSchedules,
  serialize,
  streak,
  studyQueue,
} from "../src/core/study";
import {
  newCard,
  newDeck,
  defaultSettings,
  uid,
  type Snapshot,
  type Schedule,
} from "../src/core/model";
import { review } from "./fixtures";

describe("FSRS and independent directions", () => {
  const deck = newDeck("Test");
  deck.studyMode = "both";
  const card = newCard(deck.id, "Wort", "Слово");
  const date = new Date("2026-01-01T12:00:00Z");
  const snapshot = (): Snapshot => ({
    folders: [],
    decks: [deck],
    cards: [card],
    reviews: [],
    schedules: [],
    settings: defaultSettings,
    conflicts: [],
  });
  it("uses actual ts-fsrs previews and learning steps", () => {
    const actual = preview(undefined, 0.9, date),
      expected = fsrs({ request_retention: 0.9, enable_fuzz: false }).repeat(
        createEmptyCard(date),
        date,
      );
    for (const n of [
      Rating.Again,
      Rating.Hard,
      Rating.Good,
      Rating.Easy,
    ] as const)
      expect(actual[n]).toEqual(expected[n]);
    expect(actual[1].card.due.getTime()).toBeLessThan(
      actual[4].card.due.getTime(),
    );
  });
  it("replays all events deterministically and keeps directions independent", () => {
    const events = [
      review(card.id, deck.id, "2026-01-01T12:00:00Z", { rating: 4 }),
      review(card.id, deck.id, "2026-01-02T12:00:00Z", {
        direction: "reverse",
        rating: 1,
      }),
    ];
    const schedules = rebuildSchedules(events);
    expect(schedules).toHaveLength(2);
    expect(schedules[0].fsrs.scheduled_days).toBeGreaterThan(
      schedules[1].fsrs.scheduled_days,
    );
    expect(rebuildSchedules([...events].reverse())).toEqual(schedules);
  });
  it("requires 21 days in BOTH active directions, including exactly 21", () => {
    const schedule = (
      direction: "forward" | "reverse",
      days: number,
    ): Schedule => ({
      id: `${card.id}:${direction}`,
      cardId: card.id,
      direction,
      fsrs: { ...serialize(createEmptyCard(date)), scheduled_days: days },
    });
    expect(
      deckProgress(
        deck,
        [card],
        [schedule("forward", 21), schedule("reverse", 20)],
      ).learned,
    ).toBe(0);
    expect(
      deckProgress(
        deck,
        [card],
        [schedule("forward", 21), schedule("reverse", 21)],
      ).learned,
    ).toBe(1);
    expect(
      deckProgress(
        { ...deck, studyMode: "forward" },
        [card],
        [schedule("forward", 21)],
      ).learned,
    ).toBe(1);
  });
  it("counts one unique new word for both directions and does not cap reviews", () => {
    const s = snapshot();
    s.cards.push(newCard(deck.id, "B", "Б"));
    s.decks[0] = { ...deck, newWordsPerDay: 1 };
    expect(studyQueue(s.decks[0], s, date)).toHaveLength(2);
    s.reviews = [review(card.id, deck.id, date.toISOString(), { rating: 1 })];
    s.schedules = rebuildSchedules(s.reviews);
    const q = studyQueue(s.decks[0], s, new Date(+date + 120000));
    expect(q.map((i) => i.cardId)).toEqual([card.id, card.id]);
    expect(
      studyQueue(
        { ...deck, newWordsPerDay: 0 },
        s,
        new Date(+date + 120000),
        "due",
      ),
    ).toHaveLength(1);
    expect(
      studyQueue({ ...deck, newWordsPerDay: 0 }, snapshot(), date),
    ).toHaveLength(0);
  });
  it("reopens quota on next local calendar day after reload", () => {
    const s = snapshot();
    s.cards.push(newCard(deck.id, "B", "Б"));
    s.reviews = [review(card.id, deck.id, date.toISOString())];
    s.schedules = rebuildSchedules(s.reviews);
    expect(
      studyQueue(
        { ...deck, newWordsPerDay: 1 },
        s,
        new Date("2026-01-02T12:00:00Z"),
      ).some((i) => i.cardId === s.cards[1].id),
    ).toBe(true);
  });
  it("reset keeps old events while rebuilding both schedules from scratch", () => {
    const events = [
      review(card.id, deck.id, date.toISOString()),
      review(card.id, deck.id, "2026-01-02T12:00:00Z", { kind: "reset" }),
    ];
    expect(rebuildSchedules(events)).toHaveLength(0);
    expect(events).toHaveLength(2);
  });
});
describe("calendar streaks", () => {
  const c = uid(),
    d = uid();
  const logs = (...dates: string[]) => dates.map((t) => review(c, d, t));
  it("does not count page views or resets", () =>
    expect(
      streak(
        [review(c, d, "2026-01-01T10:00:00Z", { kind: "reset" })],
        "UTC",
        new Date("2026-01-01"),
      ).current,
    ).toBe(0));
  it("preserves yesterday until today ends, across a year boundary", () => {
    const s = streak(
      logs("2025-12-30T15:00:00Z", "2025-12-31T15:00:00Z"),
      "UTC",
      new Date("2026-01-01T22:00:00Z"),
    );
    expect(s.current).toBe(2);
    expect(s.best).toBe(2);
  });
  it("breaks after a missed day and keeps record", () => {
    const s = streak(
      logs("2026-01-30T15:00:00Z", "2026-01-31T15:00:00Z"),
      "UTC",
      new Date("2026-02-02T01:00:00Z"),
    );
    expect(s.current).toBe(0);
    expect(s.best).toBe(2);
  });
  it("uses selected timezone around midnight, DST and month boundaries", () => {
    expect(dayKey("2026-03-31T22:30:00Z", "Europe/Berlin")).toBe("2026-04-01");
    expect(
      streak(
        logs("2026-03-28T23:30:00Z", "2026-03-29T22:30:00Z"),
        "Europe/Berlin",
        new Date("2026-03-30T12:00:00Z"),
      ).current,
    ).toBe(2);
  });
  it("multiple answers in one day count once", () =>
    expect(
      streak(
        logs("2026-01-01T10:00:00Z", "2026-01-01T12:00:00Z"),
        "UTC",
        new Date("2026-01-01T13:00:00Z"),
      ).current,
    ).toBe(1));
});
