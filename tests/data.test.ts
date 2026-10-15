import { afterEach, describe, expect, it } from "vitest";
import {
  applyEdits,
  CardsDB,
  editObject,
  initialize,
  mergeRemote,
  readSnapshot,
  recordAnswer,
  validFolderMove,
} from "../src/core/db";
import { makeBackup, restoreBackup, validateBackup } from "../src/core/backup";
import {
  commitImport,
  guessMapping,
  parseText,
  previewImport,
} from "../src/core/import";
import { canonical, materialize } from "../src/core/merge";
import {
  newCard,
  newDeck,
  uid,
  nowISO,
  normalize,
  type Folder,
} from "../src/core/model";
import { fixture } from "./fixtures";

const databases: CardsDB[] = [];
async function setup() {
  const f = await fixture();
  databases.push(f.database);
  return f;
}
afterEach(async () => {
  for (const d of databases.splice(0)) await d.delete();
});
describe("imports and IndexedDB transactions", () => {
  it("parses UTF-8, semicolons, escaped quotes, TSV and multiline examples", () => {
    const t = parseText(
      '\uFEFFword;translation;example_1;example_2\n"Straße";"улица";"Er sagt ""Hallo"".";"Zeile 1\nZeile 2"',
    );
    const rows = previewImport(t, guessMapping(t.headers), []);
    expect(rows[0].front).toBe("Straße");
    expect(rows[0].examples).toEqual([
      'Er sagt "Hallo".',
      "Zeile 1",
      "Zeile 2",
    ]);
    expect(parseText("word\ttranslation\nGrüße\tПриветствия").rows[0]).toEqual([
      "Grüße",
      "Приветствия",
    ]);
  });
  it("detects normalized duplicates in the target deck and in the file", () => {
    const deck = newDeck("A");
    const card = newCard(deck.id, "  GRÜßE ", "A");
    const t = parseText(
      "word,translation\nGrüße,Б\nNeue   Straße,В\n neue straße ,Г",
    );
    const rows = previewImport(t, guessMapping(t.headers), [card]);
    expect(rows.map((r) => r.duplicate)).toEqual([true, false, true]);
    expect(normalize("a  b")).toBe("a b");
  });
  it("requires explicit duplicate decisions, commits nothing on error", async () => {
    const { database, deck } = await setup();
    const before = await database.operations.count();
    const t = parseText("word,translation\nNeu,новый\nGrüße,Привет");
    const rows = previewImport(
      t,
      guessMapping(t.headers),
      (await readSnapshot(database)).cards,
    );
    await expect(
      commitImport(rows, deck.id, undefined, database),
    ).rejects.toThrow("Выберите действие");
    expect(await database.operations.count()).toBe(before);
    expect((await readSnapshot(database)).cards).toHaveLength(1);
  });
  it("update preserves card ID, FSRS and existing examples; add and skip stay separate", async () => {
    const { database, deck, card } = await setup();
    await recordAnswer(card.id, "forward", 4, uid(), undefined, database);
    const before = await readSnapshot(database);
    const t = parseText(
      "word,translation,example\nGrüße,Привет,Новый пример\nGrüße,Отдельная,\nGrüße,Пропустить,",
    );
    const rows = previewImport(t, guessMapping(t.headers), before.cards, {
      0: "update",
      1: "add",
      2: "skip",
    });
    expect(await commitImport(rows, deck.id, undefined, database)).toEqual({
      added: 1,
      updated: 1,
      merged: 0,
      skipped: 1,
    });
    const after = await readSnapshot(database);
    expect(after.cards).toHaveLength(2);
    expect(after.cards.find((c) => c.id === card.id)?.examples).toEqual([
      ...card.examples,
      "Новый пример",
    ]);
    expect(after.schedules).toEqual(before.schedules);
    expect(after.reviews).toEqual(before.reviews);
  });
  it("merges all meanings and examples into a studied card without changing either FSRS direction", async () => {
    const { database, deck, card } = await setup();
    await recordAnswer(card.id, "forward", 4, uid(), undefined, database);
    await recordAnswer(card.id, "reverse", 3, uid(), undefined, database);
    const before = await readSnapshot(database);
    const table = parseText(
      'word;translation;example\n GRÜßE ;"Приветствия\nПривет";Hallo!\nGrüße;"US\nus";Liebe Grüße aus Berlin!\nGrüße;"Привет\nUS\nGrüße\nGrüße";Hallo!',
    );
    const decisions = { 0: "merge", 1: "merge", 2: "merge" } as const;
    const rows = previewImport(
      table,
      guessMapping(table.headers),
      before.cards,
      decisions,
    );
    expect(await commitImport(rows, deck.id, undefined, database)).toEqual({
      added: 0,
      updated: 0,
      merged: 3,
      skipped: 0,
    });
    const after = await readSnapshot(database);
    expect(after.cards).toHaveLength(1);
    expect(after.cards[0]).toMatchObject({
      id: card.id,
      front: card.front,
      back: "Приветствия\nПривет\nUS\nus\nGrüße",
      examples: [...card.examples, "Hallo!"],
    });
    expect(after.schedules).toEqual(before.schedules);
    expect(after.reviews).toEqual(before.reviews);
    // Re-importing does not duplicate a meaning or example, including Unicode variants.
    await commitImport(
      previewImport(table, guessMapping(table.headers), after.cards, decisions),
      deck.id,
      undefined,
      database,
    );
    const repeated = await readSnapshot(database);
    expect(repeated.cards[0].back).toBe(after.cards[0].back);
    expect(repeated.cards[0].examples).toEqual(after.cards[0].examples);
    expect(repeated.schedules).toEqual(before.schedules);
    expect(repeated.reviews).toEqual(before.reviews);
  });
  it("merges repeated rows into one new card while preserving other words and skipped rows", async () => {
    const { database } = await setup();
    const deck = newDeck("Merged import");
    const table = parseText(
      "word;translation;example\nBank;банк;Die Bank ist offen.\nBANK;скамейка;Eine Bank im Park.\nBank;банк;Die Bank ist offen.\nHallo;Привет;Hallo!\nBank;Пропустить;Не добавлять",
    );
    const rows = previewImport(table, guessMapping(table.headers), [], {
      1: "merge",
      2: "merge",
      4: "skip",
    });
    expect(await commitImport(rows, deck.id, deck, database)).toEqual({
      added: 2,
      updated: 0,
      merged: 2,
      skipped: 1,
    });
    const cards = (await readSnapshot(database)).cards.filter(
      (c) => c.deckId === deck.id,
    );
    expect(cards).toHaveLength(2);
    expect(cards.find((c) => c.front === "Bank")).toMatchObject({
      back: "банк\nскамейка",
      examples: ["Die Bank ist offen.", "Eine Bank im Park."],
    });
    expect(cards.find((c) => c.front === "Hallo")?.back).toBe("Привет");
  });
  it("new deck import is atomic and reports invalid skipped rows", async () => {
    const { database } = await setup();
    const deck = newDeck("Import");
    const t = parseText("word,translation\nHallo,Привет\nBroken,");
    const rows = previewImport(t, guessMapping(t.headers), []);
    expect(await commitImport(rows, deck.id, deck, database)).toEqual({
      added: 1,
      updated: 0,
      merged: 0,
      skipped: 1,
    });
    expect((await readSnapshot(database)).decks).toHaveLength(2);
  });
  it("rejects stale import preview without overwriting later changes", async () => {
    const { database, deck } = await setup();
    const t = parseText("word,translation\nNeu,Новый");
    await expect(
      commitImport(
        previewImport(t, guessMapping(t.headers), []),
        deck.id,
        undefined,
        database,
        "stale",
      ),
    ).rejects.toThrow("изменилась");
  });
  it("deduplicates retried answers and rejects stale parallel-tab answers", async () => {
    const { database, card } = await setup();
    const id = uid();
    await Promise.all([
      recordAnswer(card.id, "forward", 3, id, undefined, database),
      recordAnswer(card.id, "forward", 3, id, undefined, database),
    ]);
    expect((await readSnapshot(database)).reviews).toHaveLength(1);
    await expect(
      recordAnswer(card.id, "forward", 4, uid(), undefined, database),
    ).rejects.toThrow("другой вкладке");
  });
  it("persists actual last-studied deck and preserves progress through edits and moves", async () => {
    const { database, card, deck } = await setup();
    await recordAnswer(card.id, "forward", 3, uid(), undefined, database);
    const before = await readSnapshot(database);
    const folder: Folder = {
      id: uid(),
      parentId: null,
      name: "Deep",
      sortOrder: 0,
      createdAt: nowISO(),
      updatedAt: nowISO(),
    };
    await applyEdits(
      [
        editObject("folder", folder),
        editObject("deck", { ...deck, folderId: folder.id }, deck),
        editObject("card", { ...card, front: "Changed" }, card),
      ],
      database,
    );
    const after = await readSnapshot(database);
    expect(after.schedules).toEqual(before.schedules);
    expect(after.decks[0].lastStudiedAt).toBe(before.reviews[0].reviewedAt);
    database.close();
    await database.open();
    expect((await readSnapshot(database)).cards[0].front).toBe("Changed");
  });
  it("protects against folder cycles", () => {
    const a = uid(),
      b = uid();
    const folders = [
      { id: a, parentId: null },
      { id: b, parentId: a },
    ] as Folder[];
    expect(validFolderMove(a, b, folders)).toBe(false);
    expect(validFolderMove(b, null, folders)).toBe(true);
  });
});
describe("backup and causal merge", () => {
  it("round trips every entity, schedules and history; restoring twice is idempotent", async () => {
    const { database, card } = await setup();
    await recordAnswer(card.id, "reverse", 4, uid(), undefined, database);
    const copy = await makeBackup(database);
    const target = new CardsDB(`restore-${uid()}`);
    databases.push(target);
    await restoreBackup(JSON.stringify(copy), target);
    await restoreBackup(JSON.stringify(copy), target);
    expect(canonical(await readSnapshot(target))).toBe(
      canonical(copy.snapshot),
    );
    expect(await target.operations.count()).toBe(copy.operations.length);
  });
  it("rejects altered, future-version and incomplete backup before writing", async () => {
    const { database } = await setup();
    const copy = await makeBackup(database);
    expect(() =>
      validateBackup(JSON.stringify({ ...copy, schemaVersion: 99 })),
    ).toThrow();
    expect(() =>
      validateBackup(JSON.stringify({ ...copy, snapshot: {} })),
    ).toThrow("не совпадает");
    const op = copy.operations.find((o) => o.entity === "card")!;
    expect(() => materialize([op])).toThrow("ссылки");
  });
  it("merges disjoint edits and surfaces concurrent same-field edits with both values", async () => {
    const { database, card } = await setup();
    const original = await database.operations.toArray();
    await applyEdits(
      [editObject("card", { ...card, front: "LOCAL" }, card)],
      database,
    );
    const local = await database.operations.toArray();
    const other = new CardsDB(`other-${uid()}`);
    databases.push(other);
    await initialize(other);
    await mergeRemote(original, other);
    await applyEdits(
      [
        editObject(
          "card",
          { ...card, front: "REMOTE", back: "NEW BACK" },
          card,
        ),
      ],
      other,
    );
    await mergeRemote(await other.operations.toArray(), database);
    const state = await readSnapshot(database);
    expect(state.cards[0].back).toBe("NEW BACK");
    const conflict = state.conflicts.find((c) => c.field === "front")!;
    expect(conflict.values.map((v) => v.value).sort()).toEqual([
      "LOCAL",
      "REMOTE",
    ]);
    expect(
      materialize([...(await database.operations.toArray())].reverse()),
    ).toEqual(materialize(await database.operations.toArray()));
    await applyEdits(
      [{ entity: "card", id: card.id, patch: { front: "RESOLVED" } }],
      database,
    );
    expect(
      (await readSnapshot(database)).conflicts.some((c) => c.field === "front"),
    ).toBe(false);
    expect(local.length).toBeGreaterThan(original.length);
  });
  it("rejects mismatched operation IDs rather than silently dropping content", async () => {
    const { database } = await setup();
    const op = (await database.operations.toArray()).find(
      (o) => o.entity === "card",
    )!;
    await expect(
      mergeRemote(
        [{ ...op, patch: { ...op.patch, front: "tampered" } }],
        database,
      ),
    ).rejects.toThrow("разное содержимое");
  });
});
