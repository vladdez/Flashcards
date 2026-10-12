import { afterEach, expect, it } from "vitest";
import {
  applyEdits,
  CardsDB,
  editObject,
  mergeRemote,
  readSnapshot,
  recordAnswer,
} from "../src/core/db";
import { newCard, nowISO, uid } from "../src/core/model";
import { fixture } from "./fixtures";
const databases: CardsDB[] = [];
afterEach(async () => {
  for (const d of databases.splice(0)) await d.delete();
});
it("rejects stale form edits to changed fields while preserving unrelated changes", async () => {
  const { database, card } = await fixture();
  databases.push(database);
  const stale = editObject("card", { ...card, back: "Unsaved" }, card);
  await applyEdits(
    [editObject("card", { ...card, back: "Other tab" }, card)],
    database,
  );
  await expect(applyEdits([stale], database)).rejects.toThrow("другой вкладке");
  await applyEdits(
    [editObject("card", { ...card, notes: "Different field" }, card)],
    database,
  );
  const c = (await readSnapshot(database)).cards[0];
  expect(c.back).toBe("Other tab");
  expect(c.notes).toBe("Different field");
});
it("reports concurrent deletion/edit and accepts either keep or delete resolution", async () => {
  const { database, card } = await fixture();
  const other = new CardsDB(`delete-${uid()}`);
  databases.push(database, other);
  await mergeRemote(await database.operations.toArray(), other);
  await applyEdits(
    [{ entity: "card", id: card.id, patch: { deletedAt: nowISO() } }],
    database,
  );
  await applyEdits(
    [editObject("card", { ...card, back: "Remote edit" }, card)],
    other,
  );
  await mergeRemote(await other.operations.toArray(), database);
  expect(
    (await readSnapshot(database)).conflicts.some(
      (c) => c.field === "deletedAt",
    ),
  ).toBe(true);
  const deletedAt = (await readSnapshot(database)).cards[0].deletedAt;
  await applyEdits(
    [{ entity: "card", id: card.id, patch: { deletedAt } }],
    database,
  );
  expect((await readSnapshot(database)).conflicts).toHaveLength(0);
  await applyEdits(
    [{ entity: "card", id: card.id, patch: { deletedAt: null } }],
    database,
  );
  expect((await readSnapshot(database)).cards[0].back).toBe("Remote edit");
});
it("enforces the daily quota atomically when two tabs introduce different words", async () => {
  const { database, deck, card } = await fixture();
  databases.push(database);
  const second = newCard(deck.id, "Zwei", "Два");
  await applyEdits(
    [
      editObject("deck", { ...deck, newWordsPerDay: 1 }, deck),
      editObject("card", second),
    ],
    database,
  );
  const results = await Promise.allSettled([
    recordAnswer(card.id, "forward", 3, uid(), undefined, database),
    recordAnswer(second.id, "forward", 3, uid(), undefined, database),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect((await readSnapshot(database)).reviews).toHaveLength(1);
});
