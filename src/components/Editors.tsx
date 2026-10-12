import { useState } from "react";
import { applyEdits, editObject, validFolderMove } from "../core/db";
import {
  flags,
  nowISO,
  uid,
  type Card,
  type Deck,
  type Folder,
  type Snapshot,
} from "../core/model";
import { AsyncForm, Modal } from "./Common";

export function FolderOptions({
  snapshot,
  exclude,
}: {
  snapshot: Snapshot;
  exclude?: string;
}) {
  function path(id: string): string {
    const folder = snapshot.folders.find((f) => f.id === id);
    return folder
      ? (folder.parentId ? path(folder.parentId) + " / " : "") + folder.name
      : "";
  }
  return (
    <>
      <option value="">Без папки</option>
      {snapshot.folders
        .filter(
          (f) =>
            !f.deletedAt &&
            (!exclude || validFolderMove(exclude, f.id, snapshot.folders)),
        )
        .map((f) => (
          <option key={f.id} value={f.id}>
            {path(f.id)}
          </option>
        ))}
    </>
  );
}
export function DeckEditor({
  initial,
  original,
  snapshot,
  close,
  saved,
}: {
  initial: Deck;
  original?: Deck;
  snapshot: Snapshot;
  close: () => void;
  saved?: (deck: Deck) => void;
}) {
  const [value, setValue] = useState(initial);
  const [baseline] = useState(original);
  return (
    <Modal title={original ? "Настройки колоды" : "Новая колода"} close={close}>
      <AsyncForm
        cancel={close}
        submit={async () => {
          await applyEdits([editObject("deck", value, baseline)]);
          saved?.(value);
          close();
        }}
      >
        <label>
          Название
          <input
            autoFocus
            required
            maxLength={200}
            value={value.name}
            onChange={(e) => setValue({ ...value, name: e.target.value })}
            placeholder="Например, немецкий для жизни"
          />
        </label>
        <div className="form-grid">
          <label>
            Язык
            <select
              value={value.languageCode}
              onChange={(e) =>
                setValue({
                  ...value,
                  languageCode: e.target.value,
                  flagEmoji: value.flagIsManuallySet
                    ? value.flagEmoji
                    : flags[e.target.value] || "🧠",
                })
              }
            >
              {Object.entries({
                de: "Немецкий",
                en: "Английский",
                fr: "Французский",
                es: "Испанский",
                it: "Итальянский",
                ru: "Русский",
                ja: "Японский",
                zh: "Китайский",
                other: "Неязыковая колода",
              }).map(([key, name]) => (
                <option key={key} value={key}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Флаг / эмодзи
            <input
              required
              maxLength={32}
              value={value.flagEmoji}
              onChange={(e) =>
                setValue({
                  ...value,
                  flagEmoji: e.target.value,
                  flagIsManuallySet: true,
                })
              }
            />
          </label>
        </div>
        <label>
          Папка
          <select
            value={value.folderId || ""}
            onChange={(e) =>
              setValue({ ...value, folderId: e.target.value || null })
            }
          >
            <FolderOptions snapshot={snapshot} />
          </select>
        </label>
        <label>
          Направление изучения
          <select
            value={value.studyMode}
            onChange={(e) =>
              setValue({
                ...value,
                studyMode: e.target.value as Deck["studyMode"],
              })
            }
          >
            <option value="forward">Слово → перевод</option>
            <option value="reverse">Перевод → слово</option>
            <option value="both">В обе стороны · независимый прогресс</option>
          </select>
        </label>
        <label>
          Новых слов в день
          <input
            type="number"
            min="0"
            max="10000"
            required
            value={value.newWordsPerDay}
            onChange={(e) =>
              setValue({ ...value, newWordsPerDay: Number(e.target.value) })
            }
          />
          <small>
            Рекомендуемое значение — 80. При 0 остаются только повторения уже
            введённых слов.
          </small>
        </label>
      </AsyncForm>
    </Modal>
  );
}
export function CardEditor({
  initial,
  original,
  snapshot,
  close,
}: {
  initial: Card;
  original?: Card;
  snapshot: Snapshot;
  close: () => void;
}) {
  const [baseline] = useState(original);
  const [value, setValue] = useState(initial),
    [examples, setExamples] = useState(initial.examples.join("\n")),
    [tags, setTags] = useState(initial.tags.join(", "));
  return (
    <Modal
      title={original ? "Редактировать карточку" : "Новая карточка"}
      close={close}
    >
      <AsyncForm
        cancel={close}
        submit={async () => {
          await applyEdits([
            editObject(
              "card",
              {
                ...value,
                examples: examples
                  .split("\n")
                  .map((x) => x.trim())
                  .filter(Boolean),
                tags: tags
                  .split(",")
                  .map((x) => x.trim())
                  .filter(Boolean),
              },
              baseline,
            ),
          ]);
          close();
        }}
      >
        <label>
          Слово / выражение
          <textarea
            autoFocus
            required
            value={value.front}
            onChange={(e) => setValue({ ...value, front: e.target.value })}
            rows={2}
          />
        </label>
        <label>
          Перевод / ответ
          <textarea
            required
            value={value.back}
            onChange={(e) => setValue({ ...value, back: e.target.value })}
            rows={2}
          />
        </label>
        <label>
          Примеры · каждый с новой строки
          <textarea
            value={examples}
            onChange={(e) => setExamples(e.target.value)}
            rows={3}
            placeholder="Ich lerne jeden Tag ein bisschen."
          />
        </label>
        <label>
          Заметки
          <textarea
            value={value.notes}
            onChange={(e) => setValue({ ...value, notes: e.target.value })}
            rows={2}
          />
        </label>
        <label>
          Теги · через запятую
          <input value={tags} onChange={(e) => setTags(e.target.value)} />
        </label>
        <label>
          Колода
          <select
            value={value.deckId}
            onChange={(e) => setValue({ ...value, deckId: e.target.value })}
          >
            {snapshot.decks
              .filter((d) => !d.deletedAt)
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.flagEmoji} {d.name}
                </option>
              ))}
          </select>
        </label>
        {original && (
          <p className="hint">История ответов и расписание сохранятся.</p>
        )}
      </AsyncForm>
    </Modal>
  );
}
export function FolderEditor({
  original,
  parentId = null,
  snapshot,
  close,
}: {
  original?: Folder;
  parentId?: string | null;
  snapshot: Snapshot;
  close: () => void;
}) {
  const [baseline] = useState(original);
  const [value, setValue] = useState<Folder>(
    original || {
      id: uid(),
      name: "",
      parentId,
      icon: "📁",
      sortOrder: snapshot.folders.length,
      createdAt: nowISO(),
      updatedAt: nowISO(),
    },
  );
  return (
    <Modal
      title={original ? "Редактировать папку" : "Новая папка"}
      close={close}
    >
      <AsyncForm
        cancel={close}
        submit={async () => {
          if (!validFolderMove(value.id, value.parentId, snapshot.folders))
            throw new Error("Нельзя переместить папку внутрь самой себя.");
          await applyEdits([editObject("folder", value, baseline)]);
          close();
        }}
      >
        <label>
          Название папки
          <input
            autoFocus
            required
            maxLength={200}
            value={value.name}
            onChange={(e) => setValue({ ...value, name: e.target.value })}
          />
        </label>
        <label>
          Родительская папка
          <select
            value={value.parentId || ""}
            onChange={(e) =>
              setValue({ ...value, parentId: e.target.value || null })
            }
          >
            <FolderOptions snapshot={snapshot} exclude={value.id} />
          </select>
        </label>
      </AsyncForm>
    </Modal>
  );
}
