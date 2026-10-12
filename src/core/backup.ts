import { z } from "zod";
import { db, mergeRemote, type CardsDB } from "./db";
import { materialize, canonical } from "./merge";
import { operationSchema } from "./model";
import { download } from "./import";

const backupSchema = z.object({
  format: z.literal("flashcards-backup"),
  schemaVersion: z.literal(1),
  exportedAt: z.iso.datetime(),
  operations: z.array(operationSchema).max(500000),
  snapshot: z.unknown(),
});
export async function makeBackup(database: CardsDB = db) {
  const operations = await database.operations.toArray();
  return {
    format: "flashcards-backup" as const,
    schemaVersion: 1 as const,
    exportedAt: new Date().toISOString(),
    operations,
    snapshot: materialize(operations),
  };
}
export async function exportBackup(database: CardsDB = db) {
  download(
    `flashcards-${new Date().toISOString().slice(0, 10)}.backup.json`,
    JSON.stringify(await makeBackup(database), null, 2),
    "application/json",
  );
}
export function validateBackup(text: string) {
  if (text.length > 100 * 1024 * 1024)
    throw new Error("Резервная копия слишком большая (лимит 100 МБ).");
  const backup = backupSchema.parse(JSON.parse(text));
  const snapshot = materialize(backup.operations);
  if (canonical(snapshot) !== canonical(backup.snapshot))
    throw new Error(
      "Содержимое копии не совпадает с журналом операций. Восстановление отменено.",
    );
  return { ...backup, snapshot };
}
export async function restoreBackup(text: string, database: CardsDB = db) {
  const backup = validateBackup(text);
  await mergeRemote(backup.operations, database); // Idempotent merge preserves all existing data.
  return backup.snapshot;
}
