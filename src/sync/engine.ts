import { db, mergeRemote, type CardsDB } from "../core/db";
import { uid, type Operation } from "../core/model";
import {
  cloudBatch,
  type CloudTransport,
  type RemoteFile,
  type CloudBatch,
} from "./graph";

export type SyncStatus =
  | "Не подключён"
  | "Синхронизация"
  | "Синхронизировано"
  | "Офлайн / ожидает"
  | "Конфликт"
  | "Ошибка";
export class SyncEngine {
  private busy?: Promise<void>;
  constructor(
    private transport: CloudTransport,
    private account: string,
    private database: CardsDB = db,
    private report: (status: SyncStatus, message?: string) => void = () => {},
  ) {}
  async inspect(): Promise<{
    files: RemoteFile[];
    batches: CloudBatch[];
    operations: Operation[];
  }> {
    const files = await this.transport.list(),
      batches: CloudBatch[] = [];
    for (const file of files) {
      const seen = await this.database.meta.get(
        `seen:${this.account}:${file.id}`,
      );
      if (seen?.value !== file.eTag)
        batches.push(await this.transport.read(file));
    }
    return { files, batches, operations: batches.flatMap((b) => b.operations) };
  }
  run(): Promise<void> {
    if (this.busy) return this.busy;
    this.busy = this.sync().finally(() => {
      this.busy = undefined;
    });
    return this.busy;
  }
  private async sync() {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      this.report("Офлайн / ожидает");
      return;
    }
    this.report("Синхронизация");
    try {
      const remote = await this.inspect();
      await mergeRemote(remote.operations, this.database);
      // Mark downloads only after successful merge; a failure cannot drop unseen events.
      await this.database.transaction(
        "rw",
        this.database.meta,
        this.database.batches,
        async () => {
          for (const batch of remote.batches) {
            const existing = await this.database.batches.get(batch.id);
            await this.database.batches.put({
              id: batch.id,
              operations: batch.operations,
              uploadedAccounts: [
                ...new Set([
                  ...(existing?.uploadedAccounts || []),
                  this.account,
                ]),
              ],
            });
          }
          for (const file of remote.files)
            await this.database.meta.put({
              key: `seen:${this.account}:${file.id}`,
              value: file.eTag,
            });
        },
      );
      await this.database.transaction(
        "rw",
        this.database.operations,
        this.database.batches,
        async () => {
          const covered = new Set(
            (await this.database.batches.toArray()).flatMap((b) =>
              b.operations.map((o) => o.id),
            ),
          );
          const pending = (await this.database.operations.toArray()).filter(
            (o) => !covered.has(o.id),
          );
          for (let i = 0; i < pending.length; i += 100)
            await this.database.batches.add({
              id: uid(),
              operations: pending.slice(i, i + 100),
              uploadedAccounts: [],
            });
        },
      );
      for (const batch of await this.database.batches.toArray()) {
        if (batch.uploadedAccounts.includes(this.account)) continue;
        await this.transport.upload(cloudBatch(batch.id, batch.operations));
        await this.database.transaction(
          "rw",
          this.database.batches,
          async () => {
            const latest = await this.database.batches.get(batch.id);
            if (latest)
              await this.database.batches.update(batch.id, {
                uploadedAccounts: [
                  ...new Set([...latest.uploadedAccounts, this.account]),
                ],
              });
          },
        );
      }
      await this.database.meta.put({
        key: "lastSync",
        value: new Date().toISOString(),
      });
      const snapshot = await this.database.state.get("current");
      this.report(snapshot?.conflicts.length ? "Конфликт" : "Синхронизировано");
    } catch (error) {
      this.report(
        navigator.onLine ? "Ошибка" : "Офлайн / ожидает",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }
}
