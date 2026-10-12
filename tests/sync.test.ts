import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CardsDB,
  applyEdits,
  editObject,
  mergeRemote,
  readSnapshot,
  recordAnswer,
} from "../src/core/db";
import { uid } from "../src/core/model";
import { SyncEngine } from "../src/sync/engine";
import {
  GraphTransport,
  cloudBatch,
  type CloudBatch,
  type CloudTransport,
  type RemoteFile,
} from "../src/sync/graph";
import { fixture } from "./fixtures";
class MockCloud implements CloudTransport {
  batches = new Map<string, CloudBatch>();
  failUpload = false;
  lostAck = false;
  reads = 0;
  async list() {
    return [...this.batches].map(([id, b]) => ({
      id,
      name: `fc1-${id}.json`,
      eTag: `etag-${id}`,
      size: JSON.stringify(b).length,
    }));
  }
  async read(file: RemoteFile) {
    this.reads++;
    return this.batches.get(file.id)!;
  }
  async upload(batch: CloudBatch) {
    if (this.failUpload) throw new Error("Network unavailable");
    this.batches.set(batch.id, structuredClone(batch));
    if (this.lostAck) {
      this.lostAck = false;
      throw new Error("Lost acknowledgement");
    }
  }
}
const databases: CardsDB[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of databases.splice(0)) await d.delete();
});
describe("automatic append-only sync", () => {
  it("durably queues offline changes and retries network failure without duplicate answers", async () => {
    const { database, card } = await fixture();
    databases.push(database);
    await recordAnswer(card.id, "forward", 3, uid(), undefined, database);
    const cloud = new MockCloud();
    const engine = new SyncEngine(cloud, "account", database);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await engine.run();
    expect(cloud.batches.size).toBe(0);
    expect((await readSnapshot(database)).reviews).toHaveLength(1);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    cloud.failUpload = true;
    await expect(engine.run()).rejects.toThrow("Network");
    expect(await database.batches.count()).toBeGreaterThan(0);
    cloud.failUpload = false;
    await engine.run();
    await engine.run();
    expect((await readSnapshot(database)).reviews).toHaveLength(1);
    expect(
      (await database.batches.toArray()).every((b) =>
        b.uploadedAccounts.includes("account"),
      ),
    ).toBe(true);
  });
  it("recovers lost acknowledgement, never overwrites batches and skips unchanged ETags", async () => {
    const { database } = await fixture();
    databases.push(database);
    const cloud = new MockCloud();
    cloud.lostAck = true;
    const engine = new SyncEngine(cloud, "account", database);
    await expect(engine.run()).rejects.toThrow("Lost");
    await engine.run();
    const count = cloud.batches.size;
    const reads = cloud.reads;
    await engine.run();
    expect(cloud.batches.size).toBe(count);
    expect(cloud.reads).toBe(reads);
  });
  it("retains reviews from two devices and exposes both simultaneous text edits", async () => {
    const { database: a, card } = await fixture();
    const b = new CardsDB(`sync-b-${uid()}`);
    databases.push(a, b);
    await mergeRemote(await a.operations.toArray(), b);
    const cloud = new MockCloud(),
      ea = new SyncEngine(cloud, "account", a),
      eb = new SyncEngine(cloud, "account", b);
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
    expect(sa.reviews).toHaveLength(2);
    expect(sa.schedules).toEqual(sb.schedules);
    expect(sa.schedules[0].fsrs.reps).toBe(2);
    expect(sa.conflicts.find((c) => c.field === "back")?.values).toHaveLength(
      2,
    );
    await applyEdits(
      [{ entity: "card", id: card.id, patch: { back: "Resolved" } }],
      a,
    );
    await ea.run();
    await eb.run();
    expect((await readSnapshot(b)).cards[0].back).toBe("Resolved");
    expect((await readSnapshot(b)).conflicts).toHaveLength(0);
  });
  it("shares the same active run across concurrent sync triggers", async () => {
    const { database } = await fixture();
    databases.push(database);
    const engine = new SyncEngine(new MockCloud(), "account", database);
    const p = engine.run();
    expect(engine.run()).toBe(p);
    await p;
  });
});
describe("Microsoft Graph transport", () => {
  it("uses appfolder and pagination, handles expired token and forbidden consent", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "root" })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [],
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/next",
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: [] })));
    await new GraphTransport(async () => "test-token", fetcher).list();
    expect(fetcher.mock.calls[0][0]).toContain("/special/approot");
    expect(fetcher.mock.calls[2][0]).toContain("/next");
    const expired = new GraphTransport(
      async () => "expired",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("", { status: 401 })),
    );
    await expect(expired.list()).rejects.toThrow("истекла");
    const denied = new GraphTransport(async () => {
      throw new Error("interaction_required");
    });
    await expect(denied.list()).rejects.toThrow("interaction_required");
  });
  it.each([409, 412])(
    "handles conflict HTTP %s by verifying immutable content before acknowledging",
    async (status) => {
      const batch = cloudBatch(uid(), []);
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response("", { status }))
        .mockResolvedValueOnce(new Response(JSON.stringify(batch)));
      await new GraphTransport(async () => "token", fetcher).upload(batch);
      expect(
        JSON.parse(fetcher.mock.calls[0][1]?.body as string).item[
          "@microsoft.graph.conflictBehavior"
        ],
      ).toBe("fail");
      expect(fetcher.mock.calls[1][0]).toContain(":/content");
    },
  );
  it("rejects divergent content during an ETag conflict", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 412 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(cloudBatch(uid(), []))),
      );
    await expect(
      new GraphTransport(async () => "token", fetcher).upload(
        cloudBatch(uid(), []),
      ),
    ).rejects.toThrow("Ни одна версия");
  });
  it("uses preauthenticated upload URL without sending bearer tokens", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ uploadUrl: "https://upload.example.test/session" }),
        ),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 201 }));
    await new GraphTransport(async () => "secret", fetcher).upload(
      cloudBatch(uid(), []),
    );
    expect(fetcher.mock.calls[1][1]?.headers).not.toHaveProperty(
      "Authorization",
    );
    expect(fetcher.mock.calls[1][1]?.headers).toHaveProperty("Content-Range");
  });
});
