import { useMemo, useState } from "react";
import { Upload, FileSpreadsheet, Check, ArrowRight } from "lucide-react";
import { type Snapshot, newDeck } from "../core/model";
import {
  cardFingerprint,
  commitImport,
  guessMapping,
  parseFile,
  parseText,
  previewImport,
  type Decision,
  type Mapping,
  type TableData,
} from "../core/import";
import { FolderOptions } from "../components/Editors";
import { AsyncForm, errorMessage, navigate } from "../components/Common";

export function ImportPage({
  snapshot,
  targetId,
}: {
  snapshot: Snapshot;
  targetId?: string;
}) {
  const [mode, setMode] = useState<"cards" | "deck">(
      targetId ? "cards" : "deck",
    ),
    [target, setTarget] = useState(
      targetId || snapshot.decks.find((d) => !d.deletedAt)?.id || "",
    ),
    [name, setName] = useState(""),
    [folder, setFolder] = useState(""),
    [table, setTable] = useState<TableData | null>(null),
    [mapping, setMapping] = useState<Mapping>({
      front: 0,
      back: 1,
      examples: [],
    }),
    [paste, setPaste] = useState(""),
    [decisions, setDecisions] = useState<Record<number, Decision>>({}),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState<{
      added: number;
      updated: number;
      merged: number;
      skipped: number;
      id: string;
    } | null>(null);
  const cards = useMemo(
    () =>
      mode === "cards"
        ? snapshot.cards.filter((c) => c.deckId === target && !c.deletedAt)
        : [],
    [snapshot.cards, mode, target],
  );
  const preview = table ? previewImport(table, mapping, cards, decisions) : [];
  const duplicates = preview.filter((r) => r.duplicate && !r.error),
    invalid = preview.filter((r) => r.error).length,
    unresolved = duplicates.filter((r) => !r.decision).length;
  const added = preview.filter(
      (r) => !r.error && (!r.duplicate || r.decision === "add"),
    ).length,
    updated = duplicates.filter((r) => r.decision === "update").length,
    merged = duplicates.filter((r) => r.decision === "merge").length;
  const bulkDecision = duplicates.every(
    (r) => r.decision === duplicates[0]?.decision,
  )
    ? duplicates[0]?.decision || ""
    : "";
  function loaded(data: TableData, fileName?: string) {
    setTable(data);
    setMapping(guessMapping(data.headers));
    setDecisions({});
    setDone(null);
    if (fileName) setName(fileName.replace(/\.[^.]+$/, ""));
  }
  async function fileSelected(file?: File) {
    if (!file) return;
    setError("");
    setBusy(true);
    try {
      loaded(await parseFile(file), file.name);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const changeDecision = (value: string) => {
    const next: Record<number, Decision> = {};
    for (const r of duplicates) if (value) next[r.index] = value as Decision;
    setDecisions(next);
  };
  return (
    <>
      <div className="page-title">
        <div>
          <div className="eyebrow">ИЗ ТАБЛИЦЫ — В ПАМЯТЬ</div>
          <h1>Импорт слов</h1>
          <p className="muted">CSV, XLSX или таблица из буфера обмена.</p>
        </div>
        <FileSpreadsheet size={35} />
      </div>
      {done ? (
        <div className="session-complete">
          <span>
            <Check size={35} />
          </span>
          <h2>Слова на месте</h2>
          <p>
            Добавлено: {done.added} · обновлено: {done.updated} · объединено
            строк: {done.merged} · пропущено: {done.skipped}
          </p>
          <button
            className="button primary"
            onClick={() => navigate(`/deck/${done.id}`)}
          >
            Открыть колоду
            <ArrowRight size={18} />
          </button>
          <button
            className="text-button"
            onClick={() => {
              setDone(null);
              setTable(null);
            }}
          >
            Импортировать ещё
          </button>
        </div>
      ) : (
        <>
          <div className="segmented">
            <button
              className={mode === "deck" ? "active" : ""}
              onClick={() => {
                setMode("deck");
                setDecisions({});
              }}
            >
              Импорт колоды
            </button>
            <button
              className={mode === "cards" ? "active" : ""}
              onClick={() => {
                setMode("cards");
                setDecisions({});
              }}
            >
              Импорт карточек
            </button>
          </div>
          <section className="panel">
            <h2>1. Куда добавить</h2>
            {mode === "cards" ? (
              <label>
                Существующая колода
                <select
                  value={target}
                  onChange={(e) => {
                    setTarget(e.target.value);
                    setDecisions({});
                  }}
                >
                  <option value="">Выберите колоду</option>
                  {snapshot.decks
                    .filter((d) => !d.deletedAt)
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.flagEmoji} {d.name}
                      </option>
                    ))}
                </select>
                <small>Для новой колоды выберите «Импорт колоды».</small>
              </label>
            ) : (
              <div className="form-grid">
                <label>
                  Название новой колоды
                  <input
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Подставим имя файла"
                  />
                </label>
                <label>
                  Папка
                  <select
                    value={folder}
                    onChange={(e) => setFolder(e.target.value)}
                  >
                    <FolderOptions snapshot={snapshot} />
                  </select>
                </label>
              </div>
            )}
          </section>
          <section className="panel">
            <h2>2. Выберите файл</h2>
            <label className="upload-area">
              <Upload size={30} />
              <strong>{busy ? "Читаем файл…" : "Выбрать CSV или XLSX"}</strong>
              <span>UTF-8 · до 10 МБ · до 20 000 строк</span>
              <input
                aria-label="Файл для импорта"
                type="file"
                accept=".csv,.xlsx,.tsv,.txt"
                disabled={busy}
                onChange={(e) => void fileSelected(e.target.files?.[0])}
              />
            </label>
            <div className="example-downloads">
              <span className="muted">Попробовать формат:</span>
              <a
                href={`${import.meta.env.BASE_URL}examples/german.csv`}
                download
              >
                Пример CSV
              </a>
              <a
                href={`${import.meta.env.BASE_URL}examples/german.xlsx`}
                download
              >
                Пример XLSX
              </a>
            </div>
            <details className="paste">
              <summary>Или вставить таблицу</summary>
              <label>
                TSV / CSV с заголовками
                <textarea
                  rows={5}
                  value={paste}
                  onChange={(e) => setPaste(e.target.value)}
                  placeholder={
                    "word\ttranslation\texample\nHallo\tПривет\tHallo, wie geht es dir?"
                  }
                />
              </label>
              <button
                className="button secondary"
                onClick={() => {
                  try {
                    setError("");
                    loaded(parseText(paste));
                  } catch (e) {
                    setError(errorMessage(e));
                  }
                }}
              >
                Разобрать текст
              </button>
            </details>
          </section>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {table && (
            <section className="panel">
              <h2>3. Проверьте карточки</h2>
              <div className="form-grid">
                <label>
                  Слово / лицевая сторона
                  <select
                    value={mapping.front}
                    onChange={(e) => {
                      setMapping({ ...mapping, front: Number(e.target.value) });
                      setDecisions({});
                    }}
                  >
                    {table.headers.map((h, i) => (
                      <option key={i} value={i}>
                        {h}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Перевод / ответ
                  <select
                    value={mapping.back}
                    onChange={(e) =>
                      setMapping({ ...mapping, back: Number(e.target.value) })
                    }
                  >
                    {table.headers.map((h, i) => (
                      <option key={i} value={i}>
                        {h}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <fieldset className="example-columns">
                <legend>Колонки с примерами</legend>
                {table.headers.map((h, i) => (
                  <label key={i}>
                    <input
                      type="checkbox"
                      checked={mapping.examples.includes(i)}
                      onChange={(e) =>
                        setMapping({
                          ...mapping,
                          examples: e.target.checked
                            ? [...mapping.examples, i]
                            : mapping.examples.filter((x) => x !== i),
                        })
                      }
                    />
                    {h}
                  </label>
                ))}
              </fieldset>
              <p className="hint">
                Несколько примеров: отдельные колонки или переносы строк внутри
                одной ячейки. При обновлении новые примеры добавятся к
                существующим.
              </p>
              {table.errors.length > 0 && (
                <div className="error" role="alert">
                  Файл содержит ошибки. Исправьте их перед импортом.
                  <ul>
                    {table.errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="import-summary">
                <span>
                  Строк: <strong>{preview.length}</strong>
                </span>
                <span>
                  Новых: <strong>{added}</strong>
                </span>
                <span>
                  Дубликатов: <strong>{duplicates.length}</strong>
                </span>
                <span>
                  Неполных: <strong>{invalid}</strong>
                </span>
              </div>
              {duplicates.length > 0 && (
                <div className="duplicate-actions">
                  <p className="hint">
                    Красным отмечены повторные слова в файле или выбранной
                    колоде. Регистр и лишние пробелы не учитываются. Объединение
                    сохранит все переводы и примеры в одной карточке, без сброса
                    её прогресса. Обновление заменит перевод.
                  </p>
                  <div className="actions">
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => changeDecision("merge")}
                    >
                      Объединить все дубликаты
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => changeDecision("add")}
                    >
                      Добавить все, включая дубликаты
                    </button>
                  </div>
                  <label>
                    Применить ко всем дубликатам
                    <select
                      aria-label="Действие для всех дубликатов"
                      value={bulkDecision}
                      onChange={(e) => changeDecision(e.target.value)}
                    >
                      <option value="">Выберите действие</option>
                      <option value="merge">
                        Объединить переводы и примеры
                      </option>
                      <option value="skip">Пропустить</option>
                      <option value="update">Обновить существующие</option>
                      <option value="add">Добавить отдельные</option>
                    </select>
                  </label>
                  <p className="hint" aria-live="polite">
                    Осталось выбрать действие: {unresolved}. Выбор применится
                    после нажатия «Импортировать».
                  </p>
                </div>
              )}
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>№</th>
                      <th>Слово</th>
                      <th>Перевод и примеры</th>
                      <th>Действие</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((r) => (
                      <tr
                        key={r.index}
                        className={
                          r.error ? "invalid" : r.duplicate ? "duplicate" : ""
                        }
                      >
                        <td>{r.index + 2}</td>
                        <td>
                          {r.front || "—"}
                          {r.duplicate && !r.error && (
                            <span className="duplicate-badge">Дубликат</span>
                          )}
                        </td>
                        <td>
                          {r.back || "—"}
                          {r.examples.map((ex, i) => (
                            <em key={i}>{ex}</em>
                          ))}
                        </td>
                        <td>
                          {r.error ? (
                            <span className="error-text">
                              {r.error} · пропустим
                            </span>
                          ) : r.duplicate ? (
                            <select
                              aria-label={`Дубликат в строке ${r.index + 2}`}
                              value={r.decision || ""}
                              onChange={(e) =>
                                setDecisions({
                                  ...decisions,
                                  [r.index]: e.target.value as Decision,
                                })
                              }
                            >
                              <option value="">Выберите…</option>
                              <option value="merge">Объединить</option>
                              <option value="skip">Пропустить</option>
                              <option value="update">Обновить</option>
                              <option value="add">Добавить отдельную</option>
                            </select>
                          ) : (
                            <span className="pill">Новая</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <AsyncForm
                label={`Импортировать: ${added} новых, ${updated} обновлений${merged ? `, ${merged} объединений` : ""}`}
                submit={async () => {
                  if (table.errors.length)
                    throw new Error("Исправьте ошибки файла.");
                  if (unresolved)
                    throw new Error(
                      `Выберите действие для дубликатов: ${unresolved}.`,
                    );
                  if (mode === "deck" && !name.trim())
                    throw new Error("Введите название колоды.");
                  if (mode === "cards" && !target)
                    throw new Error("Выберите колоду.");
                  const deck =
                    mode === "deck"
                      ? newDeck(name.trim(), folder || null)
                      : undefined;
                  const id = deck?.id || target;
                  const result = await commitImport(
                    preview,
                    id,
                    deck,
                    undefined,
                    cardFingerprint(cards),
                  );
                  setDone({ ...result, id });
                }}
              >
                <p className="hint">
                  Будет добавлено {added}, обновлено {updated}, объединено строк{" "}
                  {merged}, пропущено{" "}
                  {invalid +
                    duplicates.filter((r) => r.decision === "skip").length}
                  . Импорт сохранится целиком одной операцией. История
                  обновляемых и объединяемых карточек останется.
                </p>
              </AsyncForm>
            </section>
          )}
        </>
      )}
    </>
  );
}
