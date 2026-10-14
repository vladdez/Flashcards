// @vitest-environment node
import { readFileSync } from "node:fs";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { newDeck, newCard, uid, type Operation } from "../src/core/model";
import { orderedOperations } from "../src/sync/engine";
import { review, reviewOp } from "./fixtures";

let pg: PGlite;
let a: string, b: string;
function op(
  entity: "deck" | "card",
  value: ReturnType<typeof newDeck> | ReturnType<typeof newCard>,
): Operation {
  const { id, ...patch } = value;
  return {
    id: uid(),
    schemaVersion: 1,
    deviceId: uid(),
    timestamp: new Date().toISOString(),
    parents: [],
    entity,
    entityId: id,
    patch,
  } as Operation;
}
function library() {
  const deck = newDeck("Deutsch"),
    card = newCard(deck.id, "Wort", "Слово");
  const operations = [
    op("deck", deck),
    op("card", card),
    reviewOp(review(card.id, deck.id, "2026-01-01T12:00:00Z")),
  ];
  return { deck, card, operations };
}
async function asUser<T>(
  owner: string | null,
  fn: (tx: Transaction) => Promise<T>,
) {
  return pg.transaction(async (tx) => {
    await tx.exec(`set local role ${owner ? "authenticated" : "anon"}`);
    await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [
      owner || "",
    ]);
    return fn(tx);
  });
}
const push = (owner: string | null, operations: Operation[]) =>
  asUser(owner, (tx) =>
    tx.query("select public.flashcards_push($1::jsonb) as ids", [
      JSON.stringify(operations),
    ]),
  );
const tables = [
  "flashcards_libraries",
  "flashcards_entities",
  "flashcards_operations",
  "flashcards_operation_parents",
  "flashcards_entity_links",
];
const views = [
  "flashcards_folders",
  "flashcards_decks",
  "flashcards_cards",
  "flashcards_user_settings",
  "flashcards_review_logs",
  "flashcards_schedule_events",
];
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
    $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `);
  await pg.exec(
    readFileSync("supabase/migrations/202610130001_supabase_sync.sql", "utf8"),
  );
}, 30000);
afterAll(async () => {
  await pg?.close();
});
beforeEach(async () => {
  a = uid();
  b = uid();
  await pg.query("insert into auth.users(id) values($1),($2)", [a, b]);
});
describe("actual PostgreSQL migration and RLS (PGlite, not hosted Supabase)", () => {
  it("round trips immutable operations and independent schedule histories without duplicate reviews", async () => {
    const { operations, card, deck } = library();
    operations.push(
      reviewOp(
        review(card.id, deck.id, "2026-01-02T12:00:00Z", {
          direction: "reverse",
        }),
      ),
    );
    await push(a, operations);
    await push(a, operations);
    const data = await asUser(a, (tx) =>
      tx.query<{ revision: number; operation: Operation }>(
        "select * from public.flashcards_pull(0,100)",
      ),
    );
    expect(data.rows.map((r) => r.operation)).toEqual(operations);
    expect(
      (
        await asUser(a, (tx) =>
          tx.query("select * from public.flashcards_review_logs"),
        )
      ).rows,
    ).toHaveLength(2);
    expect(
      (
        await asUser(a, (tx) =>
          tx.query("select * from public.flashcards_schedule_events"),
        )
      ).rows,
    ).toHaveLength(2);
  });
  it("isolates all tables, security-invoker views and RPCs for two users", async () => {
    const first = library(),
      second = library();
    await push(a, first.operations);
    await push(b, second.operations);
    for (const table of [...tables, ...views]) {
      const result = await asUser(b, (tx) =>
        tx.query<{ owner_id: string }>(`select * from public.${table}`),
      );
      expect(result.rows.every((row) => row.owner_id === b)).toBe(true);
      expect(
        (
          await asUser(b, (tx) =>
            tx.query(`select * from public.${table} where owner_id = $1`, [a]),
          )
        ).rows,
      ).toEqual([]);
    }
    expect(
      (
        await asUser(b, (tx) =>
          tx.query<{ operation: Operation }>(
            "select * from public.flashcards_pull(0,100)",
          ),
        )
      ).rows.map((r) => r.operation),
    ).toEqual(second.operations);
  });
  it("denies anon reads and writes, and direct authenticated journal mutations", async () => {
    const { operations } = library();
    await push(a, operations);
    for (const table of [...tables, ...views])
      await expect(
        asUser(null, (tx) => tx.query(`select * from public.${table}`)),
      ).rejects.toThrow(/permission denied/);
    await expect(push(null, operations)).rejects.toThrow(/permission denied/);
    await expect(
      asUser(a, (tx) => tx.query("delete from public.flashcards_operations")),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(a, (tx) =>
        tx.query("update public.flashcards_operations set operation = '{}'"),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(a, (tx) =>
        tx.query(
          "insert into public.flashcards_libraries(owner_id) values($1)",
          [b],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });
  it("enforces owner WITH CHECK and immutable update/delete even if DML grants are added", async () => {
    await push(a, library().operations);
    // Test-only grants are revoked in finally; production keeps SELECT only.
    await pg.exec(
      "grant insert,update,delete on public.flashcards_libraries to authenticated",
    );
    try {
      await expect(
        asUser(b, (tx) =>
          tx.query(
            "insert into public.flashcards_libraries(owner_id) values($1)",
            [uid()],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
      expect(
        (
          await asUser(b, (tx) =>
            tx.query(
              "update public.flashcards_libraries set revision=0 where owner_id=$1 returning *",
              [a],
            ),
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await asUser(b, (tx) =>
            tx.query(
              "delete from public.flashcards_libraries where owner_id=$1 returning *",
              [a],
            ),
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await asUser(a, (tx) =>
            tx.query("delete from public.flashcards_libraries returning *"),
          )
        ).rows,
      ).toEqual([]);
    } finally {
      await pg.exec(
        "revoke insert,update,delete on public.flashcards_libraries from authenticated",
      );
    }
  });
  it("rejects references to another owner's deck and causal parent", async () => {
    const { operations, deck, card } = library();
    await push(a, operations);
    await expect(
      push(b, [op("card", newCard(deck.id, "Other", "Другой"))]),
    ).rejects.toThrow(/foreign key/);
    const foreignParent: Operation = {
      ...operations[1],
      entity: "card",
      id: uid(),
      parents: [operations[1].id],
      patch: { back: "Foreign" },
    };
    await expect(push(b, [foreignParent])).rejects.toThrow(/Missing entity/);
    expect(
      (
        await asUser(b, (tx) =>
          tx.query("select * from public.flashcards_operations"),
        )
      ).rows,
    ).toEqual([]);
    // Even matching entity identifiers do not make user A's operation a parent for B.
    await push(b, [op("deck", deck), op("card", card)]);
    await expect(push(b, [foreignParent])).rejects.toThrow(/causal parent/);
  });
  it("rolls back the whole batch on divergent UUID content and malformed review", async () => {
    const { operations } = library();
    await push(a, operations);
    const changed = structuredClone(operations[0]);
    changed.patch = { ...changed.patch, name: "Changed" };
    await expect(
      push(a, [op("deck", newDeck("Must roll back")), changed]),
    ).rejects.toThrow(/collision/);
    const invalid = { ...operations[2], id: uid() };
    await expect(push(a, [invalid])).rejects.toThrow(/Invalid/);
    expect(
      (
        await asUser(a, (tx) =>
          tx.query("select * from public.flashcards_operations"),
        )
      ).rows,
    ).toHaveLength(3);
  });
  it("keeps a frozen paginated pull and sorts clock-skewed causal dependencies", async () => {
    const { operations } = library();
    const edit: Operation = {
      ...operations[1],
      entity: "card",
      id: uid(),
      timestamp: "2020-01-01T00:00:00Z",
      parents: [operations[1].id],
      patch: { back: "Edit" },
    };
    const ordered = orderedOperations([...operations, edit]);
    expect(ordered.indexOf(edit)).toBeGreaterThan(
      ordered.indexOf(operations[1]),
    );
    await push(a, ordered);
    const result = await asUser(a, (tx) =>
      tx.query<{ operation: Operation }>(
        "select * from public.flashcards_pull(0,2)",
      ),
    );
    expect(result.rows).toHaveLength(2);
    expect(
      (
        await asUser(a, (tx) =>
          tx.query("select * from public.flashcards_pull(2,4)"),
        )
      ).rows,
    ).toHaveLength(2);
  });
});
