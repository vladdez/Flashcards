import Dexie from "dexie";
import { afterEach, expect, it } from "vitest";
import { CardsDB, readSnapshot } from "../src/core/db";
import { canonical, materialize } from "../src/core/merge";
import { makeBackup, restoreBackup } from "../src/core/backup";
import { newCard, newDeck, uid, type Operation } from "../src/core/model";
import { review, reviewOp } from "./fixtures";
const databases: Dexie[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) await db.delete();
});
it("upgrades the exact legacy v2 stores additively, preserving IDs, FSRS, tombstones, folders and backups", async () => {
  const name = `legacy-${uid()}`,
    legacy = new Dexie(name);
  legacy
    .version(2)
    .stores({
      operations: "id,entity,entityId,timestamp,[entity+entityId]",
      state: "id",
      meta: "key",
      batches: "id",
    });
  const folderId = uid(),
    now = "2026-01-01T12:00:00.000Z",
    deviceId = uid();
  const deck = {
    ...newDeck("Old library", folderId),
    studyMode: "both" as const,
    flagEmoji: "🇨🇭",
    flagIsManuallySet: true,
  };
  const card = newCard(deck.id, "Grüße", "Приветствия", ["Liebe Grüße!"]),
    deleted = newCard(deck.id, "Archived", "Архив");
  const envelope = {
    schemaVersion: 1 as const,
    deviceId,
    timestamp: now,
    parents: [],
  };
  const { id: deckId, ...deckPatch } = deck,
    { id: cardId, ...cardPatch } = card,
    { id: deletedId, ...deletedPatch } = deleted;
  const operations: Operation[] = [
    {
      ...envelope,
      id: uid(),
      entity: "folder",
      entityId: folderId,
      patch: {
        name: "Folder",
        parentId: null,
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      },
    },
    {
      ...envelope,
      id: uid(),
      entity: "deck",
      entityId: deckId,
      patch: deckPatch,
    },
    {
      ...envelope,
      id: uid(),
      entity: "card",
      entityId: cardId,
      patch: cardPatch,
    },
    {
      ...envelope,
      id: uid(),
      entity: "card",
      entityId: deletedId,
      patch: { ...deletedPatch, deletedAt: now },
    },
    reviewOp(review(cardId, deckId, now)),
    reviewOp(
      review(cardId, deckId, "2026-02-01T12:00:00.000Z", {
        direction: "reverse",
        rating: 4,
      }),
    ),
  ];
  const snapshot = materialize(operations),
    batch = {
      id: uid(),
      operations,
      uploadedAccounts: ["old-onedrive-account"],
    };
  await legacy.table("operations").bulkPut(operations);
  await legacy.table("state").put({ ...snapshot, id: "current" });
  await legacy.table("meta").bulkPut([
    { key: "deviceId", value: deviceId },
    { key: "syncAccount", value: "old-onedrive-account" },
    { key: "old-token-marker", value: "never-export-me" },
  ]);
  await legacy.table("batches").put(batch);
  legacy.close();
  const upgraded = new CardsDB(name);
  databases.push(upgraded);
  await upgraded.open();
  expect(upgraded.verno).toBe(3);
  expect(canonical(await readSnapshot(upgraded))).toBe(canonical(snapshot));
  expect(await upgraded.operations.count()).toBe(operations.length);
  expect(await upgraded.meta.get("deviceId")).toEqual({
    key: "deviceId",
    value: deviceId,
  });
  expect(await upgraded.batches.toArray()).toEqual([batch]);
  expect(await upgraded.syncReceipts.count()).toBe(0);
  const backup = await makeBackup(upgraded);
  expect(JSON.stringify(backup)).not.toContain("never-export-me");
  const restored = new CardsDB(`restored-${uid()}`);
  databases.push(restored);
  await restoreBackup(JSON.stringify(backup), restored);
  await restoreBackup(JSON.stringify(backup), restored);
  expect(canonical(await readSnapshot(restored))).toBe(canonical(snapshot));
  expect((await readSnapshot(restored)).reviews).toHaveLength(2);
  expect((await readSnapshot(restored)).schedules).toHaveLength(2);
});
