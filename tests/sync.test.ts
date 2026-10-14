import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CardsDB,
  applyEdits,
  editObject,
  mergeRemote,
  readSnapshot,
  recordAnswer,
} from "../src/core/db";
import { canonical, unionOperations } from "../src/core/merge";
import { uid, type Operation } from "../src/core/model";
import {
  SyncEngine,
  bindingKey,
  enabledKey,
  cursorKey,
} from "../src/sync/engine";
import type { CloudTransport } from "../src/sync/transport";
import { fixture } from "./fixtures";
class MockCloud implements CloudTransport {
  operations: Operation[] = [];
  failUpload = false;
  lostAck = false;
  pageSize = 2;
  beforePull?: () => Promise<void>;
  async head() {
    return this.operations.length;
  }
  async pull(after: number, until: number) {
    await this.beforePull?.();
    return this.operations
      .slice(after, Math.min(until, after + this.pageSize))
      .map((operation, i) => ({ revision: after + i + 1, operation }));
  }
  async push(batch: Operation[]) {
    if (this.failUpload) throw new Error("Network unavailable");
    unionOperations(this.operations, batch); // Reject ID collision like PostgreSQL.
    for (const op of batch)
      if (!this.operations.some((old) => old.id === op.id))
        this.operations.push(structuredClone(op));
    if (this.lostAck) {
      this.lostAck = false;
      throw new Error("Lost acknowledgement");
    }
    return batch.map((op) => op.id);
  }
}
const databases: CardsDB[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of databases.splice(0)) await d.delete();
});
async function enable(database: CardsDB, account = "project:user") {
  await database.meta.bulkPut([
    { key: bindingKey, value: account },
    { key: enabledKey, value: account },
  ]);
}
describe("local-first Supabase sync protocol (mock transport)", () => {
  it("requires explicit account binding and approval before uploading a local library", async () => {
    const { database } = await fixture();
    databases.push(database);
    const cloud = new MockCloud(),
      engine = new SyncEngine(cloud, "project:user", database);
    await expect(engine.run()).rejects.toThrow(/Подтвердите/);
    expect(cloud.operations).toHaveLength(0);
    expect((await readSnapshot(database)).cards).toHaveLength(1);
  });
  it("durably queues offline changes and retries failure without duplicate answers", async () => {
    const { database, card } = await fixture();
    databases.push(database);
    await enable(database);
    await recordAnswer(card.id, "forward", 3, uid(), undefined, database);
    const cloud = new MockCloud(),
      engine = new SyncEngine(cloud, "project:user", database);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await engine.run();
    expect(cloud.operations).toHaveLength(0);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    cloud.failUpload = true;
    await expect(engine.run()).rejects.toThrow("Network");
    expect(await database.operations.count()).toBe(4);
    cloud.failUpload = false;
    await engine.run();
    await engine.run();
    expect((await readSnapshot(database)).reviews).toHaveLength(1);
    expect(
      cloud.operations.filter((op) => op.entity === "review"),
    ).toHaveLength(1);
    expect(await database.syncReceipts.count()).toBe(4);
  });
  it("recovers lost acknowledgement with stable IDs after closing and reopening IndexedDB", async () => {
    const { database } = await fixture();
    databases.push(database);
    await enable(database);
    const cloud = new MockCloud();
    cloud.lostAck = true;
    await expect(
      new SyncEngine(cloud, "project:user", database).run(),
    ).rejects.toThrow("Lost");
    database.close();
    await database.open();
    const engine = new SyncEngine(cloud, "project:user", database);
    await engine.run();
    await engine.run();
    expect(cloud.operations).toHaveLength(3);
    expect(await database.syncReceipts.count()).toBe(3);
  });
  it("retains both devices' reviews, forward/reverse schedules and conflicting text/tombstones", async () => {
    const { database: a, card } = await fixture(),
      b = new CardsDB(`sync-b-${uid()}`);
    databases.push(a, b);
    await mergeRemote(await a.operations.toArray(), b);
    await enable(a);
    await enable(b);
    const cloud = new MockCloud(),
      ea = new SyncEngine(cloud, "project:user", a),
      eb = new SyncEngine(cloud, "project:user", b);
    await recordAnswer(
      card.id,
      "forward",
      3,
      uid(),
      undefined,
      a,
      new Date("2026-01-01T12:00:00Z"),
    );
    await recordAnswer(
      card.id,
      "forward",
      4,
      uid(),
      undefined,
      b,
      new Date("2026-01-01T12:01:00Z"),
    );
    await recordAnswer(
      card.id,
      "reverse",
      4,
      uid(),
      undefined,
      b,
      new Date("2026-01-01T12:02:00Z"),
    );
    await applyEdits(
      [editObject("card", { ...card, back: "Device A" }, card)],
      a,
    );
    await applyEdits(
      [editObject("card", { ...card, back: "Device B" }, card)],
      b,
    );
    await ea.run();
    await eb.run();
    await ea.run();
    const sa = await readSnapshot(a),
      sb = await readSnapshot(b);
    expect(sa.reviews).toHaveLength(3);
    expect(sa.schedules).toEqual(sb.schedules);
    expect(sa.schedules.find((s) => s.direction === "forward")?.fsrs.reps).toBe(
      2,
    );
    expect(sa.schedules.find((s) => s.direction === "reverse")?.fsrs.reps).toBe(
      1,
    );
    expect(sa.conflicts.find((c) => c.field === "back")?.values).toHaveLength(
      2,
    );
    await applyEdits(
      [{ entity: "card", id: card.id, patch: { back: "Resolved" } }],
      a,
    );
    await ea.run();
    await eb.run();
    expect((await readSnapshot(b)).conflicts).toHaveLength(0);
    await applyEdits(
      [
        {
          entity: "card",
          id: card.id,
          patch: { deletedAt: new Date().toISOString() },
        },
      ],
      a,
    );
    await applyEdits(
      [{ entity: "card", id: card.id, patch: { back: "Offline edit" } }],
      b,
    );
    await ea.run();
    await eb.run();
    await ea.run();
    expect(
      (await readSnapshot(a)).conflicts.some((c) => c.field === "deletedAt"),
    ).toBe(true);
    expect((await readSnapshot(a)).reviews).toHaveLength(3);
  });
  it("does not advance a cursor or modify the library when remote validation fails", async () => {
    const { database } = await fixture();
    databases.push(database);
    await enable(database);
    const before = canonical(await readSnapshot(database));
    const cloud = new MockCloud();
    cloud.operations = [
      {
        ...(await database.operations.toArray())[0],
        id: uid(),
        parents: [uid()],
      },
    ];
    await expect(
      new SyncEngine(cloud, "project:user", database).run(),
    ).rejects.toThrow(/история/);
    expect(await database.meta.get(cursorKey("project:user"))).toBeUndefined();
    expect(await database.syncReceipts.count()).toBe(0);
    expect(canonical(await readSnapshot(database))).toBe(before);
  });
  it("rejects incomplete pagination and cloud history truncation", async () => {
    const { database } = await fixture();
    databases.push(database);
    await enable(database);
    const cloud = new MockCloud();
    cloud.operations = await database.operations.toArray();
    vi.spyOn(cloud, "pull").mockResolvedValue([]);
    await expect(
      new SyncEngine(cloud, "project:user", database).run(),
    ).rejects.toThrow(/Неполная/);
    await database.meta.put({ key: cursorKey("project:user"), value: "100" });
    await expect(
      new SyncEngine(cloud, "project:user", database).run(),
    ).rejects.toThrow(/короче/);
  });
  it("cancels an in-flight pull after sign-out without merging or uploading", async () => {
    const { database } = await fixture();
    databases.push(database);
    await enable(database);
    const cloud = new MockCloud();
    cloud.operations = await database.operations.toArray();
    const engine = new SyncEngine(cloud, "project:user", database);
    cloud.beforePull = async () => {
      engine.stop();
      await database.meta.delete(enabledKey);
    };
    await expect(engine.run()).rejects.toThrow(/остановлена/);
    expect(await database.syncReceipts.count()).toBe(0);
    expect(await database.meta.get(cursorKey("project:user"))).toBeUndefined();
  });
  it("refuses a different account even when a stale tab requests sync", async () => {
    const { database } = await fixture();
    databases.push(database);
    await enable(database, "project:userA");
    const cloud = new MockCloud();
    await expect(
      new SyncEngine(cloud, "project:userB", database).run(),
    ).rejects.toThrow(/Подтвердите/);
    expect(cloud.operations).toHaveLength(0);
  });
  it("coalesces concurrent triggers and safely retries changes made during a run", async () => {
    const { database, card } = await fixture();
    databases.push(database);
    await enable(database);
    const cloud = new MockCloud(),
      engine = new SyncEngine(cloud, "project:user", database);
    const p = engine.run();
    expect(engine.run()).toBe(p);
    await p;
    await applyEdits(
      [{ entity: "card", id: card.id, patch: { back: "Next edit" } }],
      database,
    );
    await engine.run();
    expect(cloud.operations).toHaveLength(4);
  });
});
