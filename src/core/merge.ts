import {
  cardSchema,
  deckSchema,
  defaultSettings,
  folderSchema,
  settingsSchema,
  type Conflict,
  type Operation,
  type Snapshot,
} from "./model";
import { rebuildSchedules } from "./study";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export function unionOperations(...sets: Operation[][]): Operation[] {
  const map = new Map<string, Operation>();
  for (const op of sets.flat()) {
    const previous = map.get(op.id);
    if (previous && canonical(previous) !== canonical(op))
      throw new Error(
        "Повреждение данных: один ID операции имеет разное содержимое.",
      );
    map.set(op.id, op);
  }
  return [...map.values()].sort(
    (a, b) =>
      a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id),
  );
}
export function entityHeads(
  ops: Operation[],
  entity: Operation["entity"],
  id: string,
) {
  const matching = ops.filter((o) => o.entity === entity && o.entityId === id);
  const parents = new Set(matching.flatMap((o) => o.parents));
  return matching.filter((o) => !parents.has(o.id)).map((o) => o.id);
}
export function materialize(input: Operation[]): Snapshot {
  const operations = unionOperations(input);
  const byId = new Map(operations.map((o) => [o.id, o]));
  const ancestors = new Map<string, Set<string>>();
  const visiting = new Set<string>();
  function ancestry(id: string): Set<string> {
    const cached = ancestors.get(id);
    if (cached) return cached;
    if (visiting.has(id)) throw new Error("Цикл в истории изменений.");
    visiting.add(id);
    const op = byId.get(id)!;
    const result = new Set<string>();
    for (const parent of op.parents) {
      const p = byId.get(parent);
      if (!p || p.entity !== op.entity || p.entityId !== op.entityId)
        throw new Error("Неполная история изменений.");
      result.add(parent);
      for (const a of ancestry(parent)) result.add(a);
    }
    visiting.delete(id);
    ancestors.set(id, result);
    return result;
  }
  operations.forEach((o) => ancestry(o.id));
  const snapshot: Snapshot = {
    folders: [],
    decks: [],
    cards: [],
    reviews: [],
    schedules: [],
    settings: { ...defaultSettings },
    conflicts: [],
  };
  const groups = new Map<string, Operation[]>();
  for (const op of operations) {
    if (op.entity === "review") {
      if (
        op.patch.id !== op.entityId ||
        op.id !== op.entityId ||
        op.deviceId !== op.patch.deviceId ||
        op.parents.length
      )
        throw new Error("Некорректное событие ответа.");
      snapshot.reviews.push(op.patch);
      continue;
    }
    const key = `${op.entity}:${op.entityId}`;
    groups.set(key, [...(groups.get(key) || []), op]);
  }
  for (const ops of groups.values()) {
    const first = ops[0];
    const fields = new Set(ops.flatMap((o) => Object.keys(o.patch)));
    const object: Record<string, unknown> = { id: first.entityId };
    for (const field of fields) {
      const writers = ops.filter((o) => field in o.patch);
      const tips = writers.filter(
        (o) => !writers.some((other) => ancestry(other.id).has(o.id)),
      );
      const variants = new Map(
        tips.map((o) => [
          canonical((o.patch as Record<string, unknown>)[field]),
          o,
        ]),
      );
      const chosen = tips[tips.length - 1];
      object[field] = (chosen.patch as Record<string, unknown>)[field];
      if (variants.size > 1 && field !== "updatedAt") {
        snapshot.conflicts.push({
          id: `${first.entity}:${first.entityId}:${field}`,
          entity: first.entity as Conflict["entity"],
          entityId: first.entityId,
          field,
          values: tips.map((o) => ({
            operationId: o.id,
            deviceId: o.deviceId,
            timestamp: o.timestamp,
            value: (o.patch as Record<string, unknown>)[field],
          })),
        });
      }
    }
    // A delete concurrent with a text/move edit must also be explicitly resolved.
    // Tombstones remain in the log even when the user chooses to keep the item.
    if (
      object.deletedAt &&
      !snapshot.conflicts.some(
        (c) => c.entityId === first.entityId && c.field === "deletedAt",
      )
    ) {
      const deleteWriters = ops.filter(
        (o) =>
          (o.patch as Record<string, unknown>).deletedAt === object.deletedAt,
      );
      const deletions = deleteWriters.filter(
        (o) => !deleteWriters.some((other) => ancestry(other.id).has(o.id)),
      );
      const concurrent = ops.find(
        (o) =>
          !("deletedAt" in o.patch) &&
          deletions.some(
            (d) => !ancestry(d.id).has(o.id) && !ancestry(o.id).has(d.id),
          ),
      );
      if (concurrent) {
        const deletion = deletions[deletions.length - 1];
        snapshot.conflicts.push({
          id: `${first.entity}:${first.entityId}:deletedAt`,
          entity: first.entity as Conflict["entity"],
          entityId: first.entityId,
          field: "deletedAt",
          values: [
            {
              operationId: deletion.id,
              deviceId: deletion.deviceId,
              timestamp: deletion.timestamp,
              value: object.deletedAt,
            },
            {
              operationId: concurrent.id,
              deviceId: concurrent.deviceId,
              timestamp: concurrent.timestamp,
              value: null,
            },
          ],
        });
      }
    }
    if (first.entity === "folder")
      snapshot.folders.push(folderSchema.parse(object));
    if (first.entity === "deck") snapshot.decks.push(deckSchema.parse(object));
    if (first.entity === "card") snapshot.cards.push(cardSchema.parse(object));
    if (first.entity === "settings")
      snapshot.settings = settingsSchema.parse({
        ...defaultSettings,
        ...object,
      });
  }
  const folderIds = new Set(snapshot.folders.map((f) => f.id)),
    deckIds = new Set(snapshot.decks.map((d) => d.id)),
    cardIds = new Set(snapshot.cards.map((c) => c.id));
  if (
    snapshot.folders.some((f) => f.parentId && !folderIds.has(f.parentId)) ||
    snapshot.decks.some((d) => d.folderId && !folderIds.has(d.folderId)) ||
    snapshot.cards.some((c) => !deckIds.has(c.deckId)) ||
    snapshot.reviews.some(
      (r) => !cardIds.has(r.cardId) || !deckIds.has(r.deckId),
    )
  )
    throw new Error("Нарушены ссылки между папками, колодами и карточками.");
  // Concurrent folder moves can form a cycle even though each local move was valid.
  // Keep operations intact, expose the conflict, and render the affected folder at root.
  const folderMap = new Map(snapshot.folders.map((f) => [f.id, f]));
  for (const folder of snapshot.folders) {
    const seen = new Set([folder.id]);
    let cursor = folder.parentId;
    while (cursor) {
      if (seen.has(cursor)) {
        snapshot.conflicts.push({
          id: `folder:${folder.id}:cycle`,
          entity: "folder",
          entityId: folder.id,
          field: "parentId",
          values: [
            {
              operationId: "",
              deviceId: "",
              timestamp: folder.updatedAt,
              value: null,
            },
          ],
        });
        folder.parentId = null;
        break;
      }
      seen.add(cursor);
      cursor = folderMap.get(cursor)?.parentId || null;
    }
  }
  for (const deck of snapshot.decks)
    deck.lastStudiedAt = snapshot.reviews
      .filter((r) => r.deckId === deck.id && r.kind === "answer")
      .map((r) => r.reviewedAt)
      .sort()
      .at(-1);
  snapshot.schedules = rebuildSchedules(snapshot.reviews);
  return snapshot;
}
