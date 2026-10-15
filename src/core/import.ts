import Papa from "papaparse";
import {
  newCard,
  normalize,
  type Card,
  type Deck,
  type Snapshot,
} from "./model";
import {
  applyEdits,
  db,
  deviceId,
  editObject,
  readSnapshot,
  type CardsDB,
  type Edit,
} from "./db";

export type TableData = {
  headers: string[];
  rows: string[][];
  errors: string[];
};
export type Mapping = { front: number; back: number; examples: number[] };
export type Decision = "skip" | "update" | "merge" | "add";
export type ImportRow = {
  index: number;
  front: string;
  back: string;
  examples: string[];
  duplicate: boolean;
  error?: string;
  decision?: Decision;
};
function tableFromRows(input: string[][], errors: string[] = []): TableData {
  const rows = input.filter((row) => row.some((cell) => cell.trim()));
  if (!rows.length) throw new Error("Файл пуст.");
  if (rows.length > 20001)
    throw new Error("Импортируйте до 20 000 строк за один раз.");
  const headers = rows[0].map((h, i) => h.trim() || `Колонка ${i + 1}`);
  return { headers, rows: rows.slice(1), errors };
}
export function parseText(text: string): TableData {
  const result = Papa.parse<string[]>(text.replace(/^\uFEFF/, ""), {
    skipEmptyLines: "greedy",
  });
  return tableFromRows(
    result.data,
    result.errors.map((e) => `Строка ${(e.row ?? 0) + 1}: ${e.message}`),
  );
}
export async function parseFile(file: File): Promise<TableData> {
  if (file.size > 10 * 1024 * 1024)
    throw new Error("Максимальный размер файла — 10 МБ.");
  if (/\.xlsx$/i.test(file.name)) {
    const { readSheet } = await import("read-excel-file/browser");
    const rows = await readSheet(file, 1);
    return tableFromRows(
      rows.map((row) => row.map((cell) => (cell === null ? "" : String(cell)))),
    );
  }
  if (!/\.(csv|tsv|txt)$/i.test(file.name))
    throw new Error("Выберите CSV, TSV или XLSX.");
  return parseText(await file.text());
}
export function guessMapping(headers: string[]): Mapping {
  const keys = headers.map(normalize);
  const front = keys.findIndex((h) =>
    /^(word|front|слово|wort|vorderseite|expression|term|термин)$/.test(h),
  );
  const back = keys.findIndex((h) =>
    /^(translation|back|перевод|übersetzung|ruckseite|rückseite|definition|значение)$/.test(
      h,
    ),
  );
  return {
    front: front < 0 ? 0 : front,
    back: back < 0 ? Math.min(1, headers.length - 1) : back,
    examples: keys.flatMap((h, i) =>
      /^(example|пример|beispiel)/.test(h) ? [i] : [],
    ),
  };
}
export function previewImport(
  table: TableData,
  mapping: Mapping,
  cards: Card[],
  decisions: Record<number, Decision> = {},
): ImportRow[] {
  const seen = new Set(
    cards.filter((c) => !c.deletedAt).map((c) => normalize(c.front)),
  );
  return table.rows.map((row, index) => {
    const front = row[mapping.front]?.trim() || "",
      back = row[mapping.back]?.trim() || "";
    const examples = mapping.examples
      .flatMap((i) => (row[i] || "").split(/\r?\n/))
      .map((s) => s.trim())
      .filter(Boolean);
    const key = normalize(front),
      duplicate = seen.has(key);
    const error =
      mapping.front === mapping.back
        ? "Слово и перевод должны быть разными колонками"
        : !front || !back
          ? "Не заполнено слово или перевод"
          : undefined;
    if (!error) seen.add(key);
    return {
      index,
      front,
      back,
      examples,
      duplicate,
      error,
      decision: decisions[index],
    };
  });
}
function mergeText(values: string[]): string[] {
  // Keep distinct meanings (including case), while deduplicating repeated lines.
  return [
    ...new Set(
      values.map((value) => value.normalize("NFC").trim()).filter(Boolean),
    ),
  ];
}
export async function commitImport(
  rows: ImportRow[],
  deckId: string,
  createDeck?: Deck,
  database: CardsDB = db,
  expectedDuplicates?: string,
) {
  await deviceId(database);
  // Nested Dexie transactions share the outer transaction: deck, cards, outbox and view commit together.
  return database.transaction(
    "rw",
    database.operations,
    database.state,
    database.meta,
    async () => {
      const snapshot = await readSnapshot(database);
      const cards = snapshot.cards.filter(
        (c) => c.deckId === deckId && !c.deletedAt,
      );
      if (
        expectedDuplicates !== undefined &&
        cardFingerprint(cards) !== expectedDuplicates
      )
        throw new Error(
          "Колода изменилась в другой вкладке или при синхронизации. Проверьте обновлённый предпросмотр.",
        );
      if (
        !createDeck &&
        !snapshot.decks.some((d) => d.id === deckId && !d.deletedAt)
      )
        throw new Error("Выберите существующую колоду.");
      const edits: Edit[] = createDeck ? [editObject("deck", createDeck)] : [];
      const index = new Map(cards.map((c) => [normalize(c.front), c]));
      let added = 0,
        updated = 0,
        merged = 0,
        skipped = 0;
      for (const row of rows) {
        if (row.error) {
          skipped++;
          continue;
        }
        const key = normalize(row.front),
          existing = index.get(key);
        if (existing && !row.decision)
          throw new Error("Выберите действие для каждого дубликата.");
        if (existing && row.decision === "skip") {
          skipped++;
          continue;
        }
        if (
          existing &&
          (row.decision === "update" || row.decision === "merge")
        ) {
          const merge = row.decision === "merge";
          const next = {
            ...existing,
            front: merge ? existing.front : row.front,
            back: merge
              ? mergeText(
                  [existing.back, row.back].flatMap((text) =>
                    text.split(/\r?\n/),
                  ),
                ).join("\n")
              : row.back,
            examples: merge
              ? mergeText([...existing.examples, ...row.examples])
              : [...new Set([...existing.examples, ...row.examples])],
          };
          edits.push(editObject("card", next, existing));
          index.set(key, next);
          if (merge) merged++;
          else updated++;
        } else {
          const next = newCard(deckId, row.front, row.back, row.examples);
          edits.push(editObject("card", next));
          index.set(key, next);
          added++;
        }
      }
      if (!added && !updated && !merged)
        throw new Error("Нет карточек для импорта.");
      await applyEdits(edits, database);
      return { added, updated, merged, skipped };
    },
  );
}
export const cardFingerprint = (cards: Card[]) =>
  JSON.stringify(
    cards.map((c) => [c.id, c.front, c.back, c.examples, c.updatedAt]).sort(),
  );
export function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
export async function exportDeck(
  deck: Deck,
  snapshot: Snapshot,
  format: "csv" | "xlsx",
) {
  const cards = snapshot.cards.filter(
    (c) => c.deckId === deck.id && !c.deletedAt,
  );
  const rows = [
    ["word", "translation", "example"],
    ...cards.map((c) => [c.front, c.back, c.examples.join("\n")]),
  ];
  if (format === "csv") {
    download(
      `${deck.name}.csv`,
      "\uFEFF" + Papa.unparse(rows, { escapeFormulae: true }),
      "text/csv;charset=utf-8",
    );
  } else {
    const { default: writeXlsxFile } = await import("write-excel-file/browser");
    await writeXlsxFile(
      rows.map((row) => row.map((value) => ({ type: String, value }))),
    ).toFile(`${deck.name}.xlsx`);
  }
}
