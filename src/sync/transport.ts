import { z } from "zod";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { operationSchema, type Operation } from "../core/model";
import { getSupabase } from "./auth";
import { cloudConfig } from "./config";

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
export function cloudError(error: { code?: string; message?: string }): Error {
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
    const { data, error } = await this.client.rpc("flashcards_head");
    if (error) throw cloudError(error);
    return revision.parse(data);
  }
  async pull(after: number, until: number) {
    const { data, error } = await this.client.rpc("flashcards_pull", {
      after_revision: after,
      until_revision: until,
    });
    if (error) throw cloudError(error);
    return pageSchema.parse(data);
  }
  async push(operations: Operation[]) {
    const { data, error } = await this.client.rpc("flashcards_push", {
      incoming: operations,
    });
    if (error) throw cloudError(error);
    return z.array(z.uuid()).parse(data);
  }
}
