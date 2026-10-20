import Dexie, { type Table } from "dexie";
import {
  type Card,
  type Deck,
  type Entity,
  type Folder,
  type Operation,
  type Settings,
  type Snapshot,
  operationSchema,
  uid,
  nowISO,
  defaultSettings,
} from "./model";
import { canonical, entityHeads, materialize, unionOperations } from "./merge";
import { dayKey } from "./study";

export class CardsDB extends Dexie {
  operations!: Table<Operation, string>;
  state!: Table<Snapshot & { id: "current" }, string>;
  meta!: Table<{ key: string; value: string }, string>;
  syncReceipts!: Table<
    { account: string; operationId: string },
    [string, string]
  >;
  constructor(name = "flashcards-v1") {
    super(name);
    this.version(1).stores({
      operations: "id,entity,entityId,timestamp",
      state: "id",
      meta: "key",
      batches: "id",
    });
    this.version(2)
      .stores({
        operations: "id,entity,entityId,timestamp,[entity+entityId]",
        state: "id",
        meta: "key",
        batches: "id",
      })
      .upgrade(async (tx) => {
        await tx.table("state").put({
          ...materialize(await tx.table("operations").toArray()),
          id: "current",
        });
      });
    this.version(3).stores({
      syncReceipts: "[account+operationId],account,operationId",
    });
    // Retire the unused file-sync cache; the journal and Supabase state are independent.
    this.version(4)
      .stores({ batches: null })
      .upgrade(async (tx) => {
        await tx.table("meta").bulkDelete(["syncAccount", "lastSync"]);
        await tx.table("meta").where("key").startsWith("seen:").delete();
      });
    // Apply the 30-minute Good learning step to existing schedules as well.
    this.version(5)
      .stores({})
      .upgrade(async (tx) => {
        await tx.table("state").put({
          ...materialize(await tx.table("operations").toArray()),
          id: "current",
        });
      });
  }
}
export const db = new CardsDB();
export type Edit = {
  entity: Exclude<Entity, "review">;
  id: string;
  patch: Record<string, unknown>;
  expected?: Record<string, unknown>;
};
export async function deviceId(database = db) {
  return database.transaction("rw", database.meta, async () => {
    const existing = await database.meta.get("deviceId");
    if (existing) return existing.value;
    const id = uid();
    await database.meta.put({ key: "deviceId", value: id });
    return id;
  });
}
export async function initialize(database = db) {
  const device = await deviceId(database);
  await database.transaction(
    "rw",
    database.operations,
    database.state,
    async () => {
      if (!(await database.state.get("current"))) {
        if (!(await database.operations.count()))
          await database.operations.add(
            operationSchema.parse({
              id: uid(),
              schemaVersion: 1,
              deviceId: device,
              timestamp: nowISO(),
              parents: [],
              entity: "settings",
              entityId: "settings",
              patch: {
                ...defaultSettings,
                timeZone:
                  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
              },
            }),
          );
        await database.state.put({
          ...materialize(await database.operations.toArray()),
          id: "current",
        });
      }
    },
  );
}
export async function readSnapshot(database = db): Promise<Snapshot> {
  const stored = await database.state.get("current");
  if (!stored) return materialize(await database.operations.toArray());
  const { id, ...snapshot } = stored;
  void id;
  return snapshot;
}
export async function applyEdits(edits: Edit[], database = db) {
  const device = await deviceId(database);
  await database.transaction(
    "rw",
    database.operations,
    database.state,
    async () => {
      const ops = await database.operations.toArray();
      const snapshot = await readSnapshot(database);
      const objects = new Map<string, Record<string, unknown>>([
        ...snapshot.cards.map((c) => [`card:${c.id}`, { ...c }] as const),
        ...snapshot.decks.map((d) => [`deck:${d.id}`, { ...d }] as const),
        ...snapshot.folders.map((f) => [`folder:${f.id}`, { ...f }] as const),
        ["settings:settings", { ...snapshot.settings }],
      ]);
      for (const edit of edits) {
        const key = `${edit.entity}:${edit.id}`,
          current = objects.get(key);
        if (
          edit.expected &&
          Object.entries(edit.expected).some(
            ([field, value]) =>
              canonical(current?.[field]) !== canonical(value),
          )
        ) {
          throw new Error(
            "Эти поля изменились в другой вкладке или на другом устройстве. Ваш ввод не сохранён. Скопируйте его и откройте редактор заново, чтобы сравнить версии.",
          );
        }
        const op = operationSchema.parse({
          id: uid(),
          schemaVersion: 1,
          deviceId: device,
          timestamp: nowISO(),
          parents: entityHeads(ops, edit.entity, edit.id),
          entity: edit.entity,
          entityId: edit.id,
          patch: edit.patch,
        });
        ops.push(op);
        objects.set(key, { ...current, ...edit.patch });
        await database.operations.add(op);
      }
      await database.state.put({ ...materialize(ops), id: "current" });
    },
  );
}
export function editObject(
  entity: "folder" | "deck" | "card" | "settings",
  value: Folder | Deck | Card | Settings,
  original?: Folder | Deck | Card | Settings,
): Edit {
  const patch: Record<string, unknown> = {};
  const expected: Record<string, unknown> = {};
  const old = original as unknown as Record<string, unknown> | undefined;
  for (const [key, v] of Object.entries(value))
    if (
      key !== "id" &&
      key !== "lastStudiedAt" &&
      (!old || canonical(old[key]) !== canonical(v))
    ) {
      patch[key] = v;
      if (old && key !== "updatedAt") expected[key] = old[key];
    }
  if (entity !== "settings") patch.updatedAt = nowISO();
  if (old && entity !== "settings") expected.deletedAt = old.deletedAt;
  return { entity, id: value.id, patch, expected: old ? expected : undefined };
}
export async function mergeRemote(incoming: Operation[], database = db) {
  await database.transaction(
    "rw",
    database.operations,
    database.state,
    async () => {
      const ops = unionOperations(
        await database.operations.toArray(),
        incoming.map((o) => operationSchema.parse(o)),
      );
      const state = materialize(ops); // Validate before any writes; transaction rolls back on failure.
      await database.operations.bulkPut(ops);
      await database.state.put({ ...state, id: "current" });
    },
  );
}
export async function recordAnswer(
  cardId: string,
  direction: "forward" | "reverse",
  rating: number,
  answerId: string,
  expectedLastReview: string | undefined,
  database = db,
  time = new Date(),
) {
  const device = await deviceId(database);
  await database.transaction(
    "rw",
    database.operations,
    database.state,
    async () => {
      if (await database.operations.get(answerId)) return;
      const snapshot = await readSnapshot(database);
      const card = snapshot.cards.find((c) => c.id === cardId && !c.deletedAt);
      const deck = snapshot.decks.find(
        (d) => d.id === card?.deckId && !d.deletedAt,
      );
      if (!card || !deck) throw new Error("Карточка или колода удалена.");
      const answers = snapshot.reviews.filter((r) => r.kind === "answer");
      if (!answers.some((r) => r.cardId === cardId)) {
        const first = new Map<string, (typeof answers)[number]>();
        for (const answer of [...answers].sort(
          (a, b) =>
            a.reviewedAt.localeCompare(b.reviewedAt) ||
            a.id.localeCompare(b.id),
        ))
          if (!first.has(answer.cardId)) first.set(answer.cardId, answer);
        const today = dayKey(time, snapshot.settings.timeZone);
        const used = [...first.values()].filter(
          (r) =>
            r.deckId === deck.id &&
            dayKey(r.reviewedAt, snapshot.settings.timeZone) === today,
        ).length;
        if (used >= deck.newWordsPerDay)
          throw new Error(
            "Дневной лимит новых слов уже использован. Откройте очередь повторений или измените лимит колоды.",
          );
      }
      const schedule = snapshot.schedules.find(
        (s) => s.id === `${cardId}:${direction}`,
      );
      if (schedule?.fsrs.last_review !== expectedLastReview)
        throw new Error(
          "Карточка уже оценена в другой вкладке. Откройте сессию заново.",
        );
      const timestamp = time.toISOString();
      const op = operationSchema.parse({
        id: answerId,
        schemaVersion: 1,
        deviceId: device,
        timestamp,
        parents: [],
        entity: "review",
        entityId: answerId,
        patch: {
          id: answerId,
          cardId,
          deckId: deck.id,
          direction,
          rating,
          reviewedAt: timestamp,
          deviceId: device,
          retention: snapshot.settings.retention,
          schedulerVersion: "5",
          kind: "answer",
        },
      });
      const ops = [...(await database.operations.toArray()), op];
      await database.operations.add(op);
      await database.state.put({ ...materialize(ops), id: "current" });
    },
  );
}
export async function resetCard(card: Card, database = db) {
  const device = await deviceId(database),
    timestamp = nowISO();
  const ops = (["forward", "reverse"] as const).map((direction) => {
    const id = uid();
    return operationSchema.parse({
      id,
      schemaVersion: 1,
      deviceId: device,
      timestamp,
      parents: [],
      entity: "review",
      entityId: id,
      patch: {
        id,
        cardId: card.id,
        deckId: card.deckId,
        direction,
        rating: 1,
        reviewedAt: timestamp,
        deviceId: device,
        retention: 0.9,
        schedulerVersion: "5",
        kind: "reset",
      },
    });
  });
  await mergeRemote(ops, database);
}
export function validFolderMove(
  id: string,
  parentId: string | null,
  folders: Folder[],
) {
  const seen = new Set([id]);
  let cursor = parentId;
  while (cursor) {
    if (seen.has(cursor)) return false;
    seen.add(cursor);
    cursor = folders.find((f) => f.id === cursor)?.parentId || null;
  }
  return true;
}
