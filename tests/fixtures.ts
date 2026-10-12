import { CardsDB, applyEdits, editObject, initialize } from "../src/core/db";
import {
  newCard,
  newDeck,
  uid,
  type Review,
  type Operation,
} from "../src/core/model";
export async function fixture() {
  const database = new CardsDB(`test-${uid()}`);
  await initialize(database);
  const deck = newDeck("Deutsch");
  deck.studyMode = "both";
  const card = newCard(deck.id, "Grüße", "Приветствия", [
    "Liebe Grüße aus Berlin!",
  ]);
  await applyEdits(
    [editObject("deck", deck), editObject("card", card)],
    database,
  );
  return { database, deck, card };
}
export function review(
  cardId: string,
  deckId: string,
  time: string,
  overrides: Partial<Review> = {},
): Review {
  return {
    id: uid(),
    cardId,
    deckId,
    direction: "forward",
    rating: 3,
    reviewedAt: time,
    deviceId: uid(),
    retention: 0.9,
    schedulerVersion: "5",
    kind: "answer",
    ...overrides,
  };
}
export function reviewOp(r: Review): Operation {
  return {
    id: r.id,
    entity: "review",
    entityId: r.id,
    schemaVersion: 1,
    deviceId: r.deviceId,
    timestamp: r.reviewedAt,
    parents: [],
    patch: r,
  };
}
