import { z } from "zod";
import { operationSchema, type Operation } from "../core/model";
import { canonical } from "../core/merge";

export const cloudBatchSchema = z.object({
  format: z.literal("flashcards-operations"),
  schemaVersion: z.literal(1),
  id: z.uuid(),
  operations: z.array(operationSchema).max(1000),
});
export type CloudBatch = z.infer<typeof cloudBatchSchema>;
export type RemoteFile = {
  id: string;
  name: string;
  eTag: string;
  size: number;
};
export class GraphError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface CloudTransport {
  list(): Promise<RemoteFile[]>;
  read(file: RemoteFile): Promise<CloudBatch>;
  upload(batch: CloudBatch): Promise<void>;
}
const graphRoot = "https://graph.microsoft.com/v1.0";
export class GraphTransport implements CloudTransport {
  constructor(
    private token: () => Promise<string>,
    private fetcher: typeof fetch = fetch,
  ) {}
  private async request(path: string, init: RequestInit = {}) {
    const url = path.startsWith("https://") ? path : graphRoot + path;
    if (!url.startsWith(graphRoot + "/"))
      throw new Error("Некорректный адрес Microsoft Graph.");
    const response = await this.fetcher(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        ...init.headers,
      },
      signal: AbortSignal.timeout(45000),
    });
    if (!response.ok)
      throw new GraphError(
        response.status,
        response.status === 401
          ? "Сессия Microsoft истекла. Подключите аккаунт повторно."
          : `OneDrive: HTTP ${response.status}. Изменения сохранены на устройстве.`,
      );
    return response;
  }
  async list(): Promise<RemoteFile[]> {
    // Resolves/creates only this application's folder, never the user's drive root.
    const root = (await (
      await this.request("/me/drive/special/approot")
    ).json()) as { id: string };
    let path = `/me/drive/items/${encodeURIComponent(root.id)}/children?$select=id,name,eTag,size&$top=200`;
    const files: RemoteFile[] = [];
    while (path) {
      const page = (await (await this.request(path)).json()) as {
        value: RemoteFile[];
        "@odata.nextLink"?: string;
      };
      files.push(
        ...page.value.filter((f) => /^fc1-[0-9a-f-]+\.json$/.test(f.name)),
      );
      path = page["@odata.nextLink"] || "";
    }
    return files;
  }
  async read(file: RemoteFile): Promise<CloudBatch> {
    if (file.size > 10 * 1024 * 1024)
      throw new Error("Облачный пакет превышает допустимый размер.");
    const batch = cloudBatchSchema.parse(
      await (
        await this.request(
          `/me/drive/items/${encodeURIComponent(file.id)}/content`,
        )
      ).json(),
    );
    if (file.name !== `fc1-${batch.id}.json`)
      throw new Error("Имя облачного пакета не совпадает с его ID.");
    return batch;
  }
  async upload(batch: CloudBatch): Promise<void> {
    const filename = `fc1-${batch.id}.json`;
    const path = `/me/drive/special/approot:/${filename}`;
    const bytes = new TextEncoder().encode(canonical(batch));
    try {
      // The server rejects name conflicts. Immutable batches have no shared mutable manifest.
      const session = (await (
        await this.request(`${path}:/createUploadSession`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            item: {
              "@microsoft.graph.conflictBehavior": "fail",
              name: filename,
            },
          }),
        })
      ).json()) as { uploadUrl: string };
      if (!session.uploadUrl.startsWith("https://"))
        throw new Error("Некорректный URL загрузки.");
      const chunkSize = 320 * 1024;
      for (let start = 0; start < bytes.length; start += chunkSize) {
        const end = Math.min(start + chunkSize, bytes.length);
        // Upload URL is pre-authenticated. Never attach the Graph bearer token here.
        const response = await this.fetcher(session.uploadUrl, {
          method: "PUT",
          headers: {
            "Content-Range": `bytes ${start}-${end - 1}/${bytes.length}`,
            "Content-Type": "application/octet-stream",
          },
          body: bytes.slice(start, end),
          signal: AbortSignal.timeout(45000),
        });
        if (!response.ok)
          throw new GraphError(
            response.status,
            `Загрузка OneDrive: HTTP ${response.status}`,
          );
        if (end === bytes.length && response.status === 202)
          throw new Error(
            "OneDrive не подтвердил завершение загрузки. Повторим пакет позже.",
          );
      }
    } catch (error) {
      if (!(error instanceof GraphError) || ![409, 412].includes(error.status))
        throw error;
      // Lost acknowledgement or ETag/name race: acknowledge only identical persisted content.
      const existing = cloudBatchSchema.parse(
        await (await this.request(`${path}:/content`)).json(),
      );
      if (canonical(existing) !== canonical(batch))
        throw new Error(
          "Конфликт облачного пакета. Ни одна версия не перезаписана.",
          { cause: error },
        );
    }
  }
}
export const cloudBatch = (
  id: string,
  operations: Operation[],
): CloudBatch => ({
  format: "flashcards-operations",
  schemaVersion: 1,
  id,
  operations,
});
