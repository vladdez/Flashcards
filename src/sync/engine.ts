import { db, type CardsDB } from "../core/db";
import { materialize, unionOperations } from "../core/merge";
import { type Operation } from "../core/model";
import type { CloudTransport } from "./transport";

export const bindingKey = "supabaseBinding";
export const enabledKey = "supabaseEnabled";
export type SyncStatus =
  | "Не подключён"
  | "Требуется объединение"
  | "Синхронизация"
  | "Синхронизировано"
  | "Офлайн / ожидает"
  | "Конфликт"
  | "Ошибка";
export const cursorKey = (account: string) => `supabase:${account}:cursor`;
export const lastSyncKey = (account: string) => `supabase:${account}:lastSync`;

// Parent operations and referenced entity creations precede dependent events,
// even when device clocks disagree. Every committed upload is a valid prefix.
export function orderedOperations(input: Operation[]) {
  const ops = unionOperations(input);
  const byId = new Map(ops.map((op) => [op.id, op]));
  const roots = new Map<string, string>();
  for (const op of ops)
    if (
      op.entity !== "review" &&
      !op.parents.length &&
      !roots.has(`${op.entity}:${op.entityId}`)
    )
      roots.set(`${op.entity}:${op.entityId}`, op.id);
  const visited = new Set<string>(),
    visiting = new Set<string>(),
    result: Operation[] = [];
  function visit(op: Operation) {
    if (visited.has(op.id)) return;
    if (visiting.has(op.id)) throw new Error("Цикл зависимостей операций.");
    visiting.add(op.id);
    const links: [string, unknown][] = [];
    if (op.entity === "folder") links.push(["folder", op.patch.parentId]);
    if (op.entity === "deck") links.push(["folder", op.patch.folderId]);
    if (op.entity === "card" || op.entity === "review")
      links.push(["deck", op.patch.deckId]);
    if (op.entity === "review") links.push(["card", op.patch.cardId]);
    const ownRoot = roots.get(`${op.entity}:${op.entityId}`);
    const dependencies = [
      ...op.parents,
      ...links
        .filter(([, id]) => id)
        .map(([kind, id]) => roots.get(`${kind}:${id}`)),
      ownRoot,
    ];
    for (const id of dependencies) {
      if (!id || id === op.id) continue;
      const parent = byId.get(id);
      if (!parent) throw new Error("Неполная история изменений.");
      visit(parent);
    }
    visiting.delete(op.id);
    visited.add(op.id);
    result.push(op);
  }
  ops.forEach(visit);
  return result;
}
export class SyncEngine {
  private busy?: Promise<void>;
  private rerun = false;
  private stopped = false;
  constructor(
    private transport: CloudTransport,
    readonly account: string,
    private database: CardsDB = db,
    private report: (status: SyncStatus, message?: string) => void = () => {},
    private sessionCurrent: () => boolean = () => true,
  ) {}
  stop() {
    this.stopped = true;
  }
  private async assertActive() {
    if (
      this.stopped ||
      !this.sessionCurrent() ||
      (await this.database.meta.get(bindingKey))?.value !== this.account ||
      (await this.database.meta.get(enabledKey))?.value !== this.account
    )
      throw new Error(
        "Синхронизация остановлена. Подтвердите подключение аккаунта.",
      );
    if (this.stopped || !this.sessionCurrent())
      throw new Error("Аккаунт изменился.");
  }
  async inspect(after = 0) {
    const until = await this.transport.head();
    if (until < after)
      throw new Error(
        "Облачная история стала короче. Синхронизация остановлена; сохраните JSON-копию.",
      );
    const operations: Operation[] = [];
    let cursor = after;
    while (cursor < until) {
      const page = await this.transport.pull(cursor, until);
      if (!page.length)
        throw new Error("Неполная облачная история. Повторите синхронизацию.");
      for (const row of page) {
        if (row.revision !== cursor + 1 || row.revision > until)
          throw new Error("Нарушен порядок облачной истории.");
        operations.push(row.operation);
        cursor = row.revision;
      }
      if (operations.length > 500000)
        throw new Error("Облачная история превышает поддерживаемый размер.");
    }
    return { operations, revision: until };
  }
  run(): Promise<void> {
    if (this.busy) {
      this.rerun = true;
      return this.busy;
    }
    this.busy = (async () => {
      do {
        this.rerun = false;
        await this.sync();
      } while (this.rerun && !this.stopped);
    })().finally(() => {
      this.busy = undefined;
    });
    return this.busy;
  }
  private async pullAndCommit() {
    await this.assertActive();
    const cursor = Number(
      (await this.database.meta.get(cursorKey(this.account)))?.value || 0,
    );
    if (!Number.isSafeInteger(cursor) || cursor < 0)
      throw new Error(
        "Повреждён локальный курсор синхронизации. Сохраните JSON-копию перед восстановлением.",
      );
    const remote = await this.inspect(cursor);
    await this.assertActive();
    await this.database.transaction(
      "rw",
      [
        this.database.meta,
        this.database.operations,
        this.database.state,
        this.database.syncReceipts,
      ],
      async () => {
        await this.assertActive();
        const ops = unionOperations(
          await this.database.operations.toArray(),
          remote.operations,
        );
        const state = materialize(ops);
        // Merge + receipts + cursor commit together. No cursor skips failed writes.
        await this.database.operations.bulkPut(remote.operations);
        await this.database.state.put({ ...state, id: "current" });
        await this.database.syncReceipts.bulkPut(
          remote.operations.map((op) => ({
            account: this.account,
            operationId: op.id,
          })),
        );
        const latest = Number(
          (await this.database.meta.get(cursorKey(this.account)))?.value || 0,
        );
        await this.database.meta.put({
          key: cursorKey(this.account),
          value: String(Math.max(latest, remote.revision)),
        });
      },
    );
  }
  private async sync() {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      this.report("Офлайн / ожидает");
      return;
    }
    try {
      await this.assertActive();
      this.report("Синхронизация");
      await this.pullAndCommit();
      const acknowledged = new Set(
        (
          await this.database.syncReceipts
            .where("account")
            .equals(this.account)
            .toArray()
        ).map((r) => r.operationId),
      );
      const pending = orderedOperations(
        await this.database.operations.toArray(),
      ).filter((op) => !acknowledged.has(op.id));
      while (pending.length) {
        await this.assertActive();
        const batch: Operation[] = [];
        let bytes = 0;
        while (pending.length && batch.length < 100) {
          const size = new TextEncoder().encode(
            JSON.stringify(pending[0]),
          ).length;
          if (batch.length && bytes + size > 8 * 1024 * 1024) break;
          batch.push(pending.shift()!);
          bytes += size;
        }
        const accepted = await this.transport.push(batch);
        if (
          accepted.length !== batch.length ||
          batch.some((op) => !accepted.includes(op.id))
        )
          throw new Error(
            "Облако не подтвердило все операции. Безопасный повтор будет выполнен позже.",
          );
        await this.database.transaction(
          "rw",
          [this.database.meta, this.database.syncReceipts],
          async () => {
            await this.assertActive();
            await this.database.syncReceipts.bulkPut(
              batch.map((op) => ({
                account: this.account,
                operationId: op.id,
              })),
            );
          },
        );
      }
      // Pull other devices' events committed during upload; never advance the
      // cursor from a push response (it could skip concurrent remote events).
      await this.pullAndCommit();
      await this.assertActive();
      await this.database.meta.put({
        key: lastSyncKey(this.account),
        value: new Date().toISOString(),
      });
      const snapshot = await this.database.state.get("current");
      this.report(snapshot?.conflicts.length ? "Конфликт" : "Синхронизировано");
    } catch (error) {
      if (!this.stopped && this.sessionCurrent())
        this.report(
          navigator.onLine ? "Ошибка" : "Офлайн / ожидает",
          error instanceof Error ? error.message : String(error),
        );
      throw error;
    }
  }
}
