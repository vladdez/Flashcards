import { z } from "zod";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { operationSchema, type Operation } from "../core/model";
import { getSupabase } from "./auth";
import { cloudConfig, cloudUnavailableMessage } from "./config";

export interface CloudTransport {
  head(): Promise<number>;
  pull(
    after: number,
    until: number,
  ): Promise<{ revision: number; operation: Operation }[]>;
  push(operations: Operation[]): Promise<string[]>;
}
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const pageSchema = z
  .array(z.object({ revision, operation: operationSchema }))
  .max(500);
export function cloudError(
  error: { code?: string; message?: string },
  status?: number,
): Error {
  // Status 0 is a failed fetch; our own thrown errors (e.g. account changed)
  // also arrive with status 0, so only browser/Auth network errors match.
  const networkFailure =
    status === 0 &&
    /^(TypeError|AuthRetryableFetchError)\b/.test(error.message || "");
  if (
    status === 540 ||
    /project.*paused|paused.*project/i.test(error.message || "") ||
    ((networkFailure ||
      (status !== undefined && status >= 500 && !error.code)) &&
      (typeof navigator === "undefined" || navigator.onLine))
  )
    return new Error(cloudUnavailableMessage);
  if (["PGRST202", "42P01", "42883"].includes(error.code || ""))
    return new Error(
      "Схема синхронизации ещё не установлена. Примените SQL-миграцию из supabase/migrations.",
    );
  if (["PGRST301", "PGRST303", "401"].includes(error.code || ""))
    return new Error(
      "Сессия истекла. Войдите по email повторно; локальная библиотека сохранена.",
    );
  if (error.code === "42501")
    return new Error(
      "Доступ к синхронизации запрещён. Проверьте SQL-миграцию и права проекта.",
    );
  return new Error(
    error.message || "Нет связи с облаком. Изменения остаются на устройстве.",
  );
}
export class SupabaseTransport implements CloudTransport {
  private client: SupabaseClient;
  constructor(ownerId: string, authClient = getSupabase()) {
    // Each HTTP request captures a token for this owner. A different session
    // must never silently upload the previous account's local journal.
    this.client = createClient(cloudConfig.url, cloudConfig.key, {
      accessToken: async () => {
        const { data, error } = await authClient.auth.getSession();
        if (error) throw error;
        if (data.session?.user.id !== ownerId)
          throw new Error("Аккаунт изменился. Синхронизация остановлена.");
        return data.session.access_token;
      },
    });
  }
  async head() {
    const { data, error, status } = await this.client.rpc("flashcards_head");
    if (error) throw cloudError(error, status);
    return revision.parse(data);
  }
  async pull(after: number, until: number) {
    const { data, error, status } = await this.client.rpc("flashcards_pull", {
      after_revision: after,
      until_revision: until,
    });
    if (error) throw cloudError(error, status);
    return pageSchema.parse(data);
  }
  async push(operations: Operation[]) {
    const { data, error, status } = await this.client.rpc("flashcards_push", {
      incoming: operations,
    });
    if (error) throw cloudError(error, status);
    return z.array(z.uuid()).parse(data);
  }
}
