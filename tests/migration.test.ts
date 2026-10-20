import Dexie from "dexie";
import { createEmptyCard, fsrs, Rating } from "ts-fsrs";
import { afterEach, expect, it } from "vitest";
import { CardsDB, readSnapshot } from "../src/core/db";
import { canonical, materialize } from "../src/core/merge";
import { serialize } from "../src/core/study";
import { makeBackup, restoreBackup } from "../src/core/backup";
import { newCard, newDeck, uid, type Operation } from "../src/core/model";
import { review, reviewOp } from "./fixtures";
import { cursorKey, lastSyncKey } from "../src/sync/engine";
const databases: Dexie[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) await db.delete();
});
it.each([2, 3, 4])(
  "upgrades v%i to v5 and recalculates Good from 10 to 30 minutes",
  async (version) => {
    const name = `legacy-${uid()}`,
      legacy = new Dexie(name);
    legacy.version(version).stores({
      operations: "id,entity,entityId,timestamp,[entity+entityId]",
      state: "id",
      meta: "key",
      ...(version < 4 ? { batches: "id" } : {}),
      ...(version >= 3
        ? { syncReceipts: "[account+operationId],account,operationId" }
        : {}),
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
    const stored = structuredClone(snapshot);
    stored.schedules.find((s) => s.direction === "forward")!.fsrs = serialize(
      fsrs({ request_retention: 0.9, enable_fuzz: false }).next(
        createEmptyCard(new Date(now)),
        new Date(now),
        Rating.Good,
      ).card,
    );
    expect(
      stored.schedules.find((s) => s.direction === "forward")!.fsrs.due,
    ).toBe("2026-01-01T12:10:00.000Z");
    await legacy.table("state").put({ ...stored, id: "current" });
    await legacy.table("meta").bulkPut([
      { key: "deviceId", value: deviceId },
      ...(version < 4
        ? [
            { key: "syncAccount", value: "old-onedrive-account" },
            { key: "lastSync", value: now },
            { key: "seen:old-account:file-id", value: "old-etag" },
          ]
        : []),
      { key: "supabaseBinding", value: "project:user" },
      { key: "supabaseEnabled", value: "project:user" },
      { key: cursorKey("project:user"), value: "1" },
      { key: lastSyncKey("project:user"), value: now },
      { key: "old-token-marker", value: "never-export-me" },
    ]);
    if (version < 4) await legacy.table("batches").put(batch);
    const receipt = { account: "project:user", operationId: operations[0].id };
    if (version >= 3) await legacy.table("syncReceipts").put(receipt);
    legacy.close();
    const upgraded = new CardsDB(name);
    databases.push(upgraded);
    await upgraded.open();
    expect(upgraded.verno).toBe(5);
    expect(canonical(await readSnapshot(upgraded))).toBe(canonical(snapshot));
    expect(
      (await readSnapshot(upgraded)).schedules.find(
        (s) => s.direction === "forward",
      )!.fsrs.due,
    ).toBe("2026-01-01T12:30:00.000Z");
    expect(await upgraded.operations.count()).toBe(operations.length);
    expect(await upgraded.meta.get("deviceId")).toEqual({
      key: "deviceId",
      value: deviceId,
    });
    expect(upgraded.tables.map((table) => table.name)).not.toContain("batches");
    for (const key of ["syncAccount", "lastSync", "seen:old-account:file-id"])
      expect(await upgraded.meta.get(key)).toBeUndefined();
    expect(await upgraded.meta.get("supabaseBinding")).toEqual({
      key: "supabaseBinding",
      value: "project:user",
    });
    expect(await upgraded.meta.get("supabaseEnabled")).toEqual({
      key: "supabaseEnabled",
      value: "project:user",
    });
    expect(await upgraded.meta.get(cursorKey("project:user"))).toEqual({
      key: cursorKey("project:user"),
      value: "1",
    });
    expect(await upgraded.meta.get(lastSyncKey("project:user"))).toEqual({
      key: lastSyncKey("project:user"),
      value: now,
    });
    expect(await upgraded.syncReceipts.toArray()).toEqual(
      version >= 3 ? [receipt] : [],
    );
    const backup = await makeBackup(upgraded);
    expect(JSON.stringify(backup)).not.toContain("never-export-me");
    const restored = new CardsDB(`restored-${uid()}`);
    databases.push(restored);
    await restoreBackup(JSON.stringify(backup), restored);
    await restoreBackup(JSON.stringify(backup), restored);
    expect(canonical(await readSnapshot(restored))).toBe(canonical(snapshot));
    expect((await readSnapshot(restored)).reviews).toHaveLength(2);
    expect((await readSnapshot(restored)).schedules).toHaveLength(2);
  },
);
