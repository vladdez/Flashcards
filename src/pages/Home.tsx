import { useState } from "react";
import {
  Plus,
  Search,
  FolderPlus,
  ChevronDown,
  Pencil,
  Trash2,
  Flame,
  Trophy,
  ArrowRight,
  Upload,
} from "lucide-react";
import type { Folder, Snapshot } from "../core/model";
import { newDeck, nowISO } from "../core/model";
import { addDay, deckProgress, streak } from "../core/study";
import { applyEdits } from "../core/db";
import { Confirm, DeckTile, Empty, navigate } from "../components/Common";
import { DeckEditor, FolderEditor } from "../components/Editors";

export function Home({ snapshot }: { snapshot: Snapshot }) {
  const [query, setQuery] = useState(""),
    [deckModal, setDeckModal] = useState(false),
    [folderModal, setFolderModal] = useState<Folder | "new" | null>(null),
    [remove, setRemove] = useState<Folder | null>(null);
  const decks = snapshot.decks.filter((d) => !d.deletedAt),
    folders = snapshot.folders.filter((f) => !f.deletedAt);
  const last = [...decks]
    .filter((d) => d.lastStudiedAt)
    .sort((a, b) => b.lastStudiedAt!.localeCompare(a.lastStudiedAt!))[0];
  const stats = streak(snapshot.reviews, snapshot.settings.timeZone);
  const due = decks.reduce(
    (n, d) => n + deckProgress(d, snapshot.cards, snapshot.schedules).due,
    0,
  );
  const filtered = decks.filter(
    (d) =>
      d.id !== last?.id &&
      (d.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()) ||
        snapshot.cards.some(
          (c) =>
            c.deckId === d.id &&
            !c.deletedAt &&
            `${c.front} ${c.back}`
              .toLocaleLowerCase()
              .includes(query.toLocaleLowerCase()),
        )),
  );
  function tree(parentId: string | null): React.ReactNode {
    return (
      <>
        {folders
          .filter(
            (f) =>
              (folders.some((p) => p.id === f.parentId) ? f.parentId : null) ===
              parentId,
          )
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((folder) => (
            <details className="folder" key={folder.id} open>
              <summary>
                <ChevronDown size={17} />
                <span>📁</span>
                <strong>{folder.name}</strong>
                <span className="muted">
                  {decks.filter((d) => d.folderId === folder.id).length}
                </span>
                <span className="spacer" />
                <button
                  className="icon-button"
                  onClick={(e) => {
                    e.preventDefault();
                    setFolderModal(folder);
                  }}
                  aria-label={`Редактировать папку ${folder.name}`}
                >
                  <Pencil size={16} />
                </button>
                <button
                  className="icon-button"
                  onClick={(e) => {
                    e.preventDefault();
                    setRemove(folder);
                  }}
                  aria-label={`Удалить папку ${folder.name}`}
                >
                  <Trash2 size={16} />
                </button>
              </summary>
              <div className="folder-contents">{tree(folder.id)}</div>
            </details>
          ))}
        <div className="deck-grid">
          {filtered
            .filter(
              (d) =>
                (folders.some((f) => f.id === d.folderId)
                  ? d.folderId
                  : null) === parentId,
            )
            .map((d) => (
              <DeckTile key={d.id} deck={d} snapshot={snapshot} />
            ))}
        </div>
      </>
    );
  }
  return (
    <>
      <div className="page-title">
        <div>
          <div className="eyebrow">МАЛЕНЬКИЕ ШАГИ. БОЛЬШИЕ ЗНАНИЯ.</div>
          <h1>Учить. Повторять. Помнить.</h1>
          <p className="muted">Пусть новое остаётся с вами надолго.</p>
        </div>
        <span className="date-label">
          {new Intl.DateTimeFormat("ru", {
            day: "numeric",
            month: "long",
          }).format(new Date())}
        </span>
      </div>
      <div className="overview-grid">
        <section className="continue-section">
          {last ? (
            <DeckTile deck={last} snapshot={snapshot} featured />
          ) : (
            <div className="welcome-card">
              <div>
                <span className="eyebrow">ВАША ПЕРВАЯ КОЛОДА</span>
                <h2>
                  Всё начинается
                  <br />с одного слова.
                </h2>
                <p>
                  Добавьте свои карточки — мы подберём
                  <br className="desktop-only" /> время для каждого повторения.
                </p>
                <button
                  className="button light"
                  onClick={() => setDeckModal(true)}
                >
                  Создать колоду
                  <ArrowRight size={18} />
                </button>
              </div>
              <div className="card-art" aria-hidden="true">
                <div />
                <div />
                <div>
                  А<span>↓</span>A
                </div>
              </div>
            </div>
          )}
        </section>
        <aside className="streak-card">
          <div className="streak-top">
            <span className="flame-icon">
              <Flame size={25} />
            </span>
            <span>Серия занятий</span>
            <Trophy size={18} />
          </div>
          <div className="streak-value">
            {stats.current}
            <span>дней подряд</span>
          </div>
          <div className="week">
            {Array.from({ length: 7 }, (_, i) =>
              addDay(stats.today, i - 6),
            ).map((day) => (
              <div key={day}>
                <span>
                  {new Intl.DateTimeFormat("ru", {
                    weekday: "short",
                    timeZone: "UTC",
                  }).format(new Date(day + "T12:00:00Z"))}
                </span>
                <span
                  className={`day-dot ${stats.days.has(day) ? "done" : ""} ${day === stats.today ? "today" : ""}`}
                >
                  {stats.days.has(day) ? "✓" : "·"}
                </span>
              </div>
            ))}
          </div>
          <p className="muted">
            Рекорд: {stats.best} дн. · Сегодня к повторению: {due}
          </p>
        </aside>
      </div>
      <div className="section-title">
        <div>
          <h2>
            Моя библиотека <span className="count">{decks.length}</span>
          </h2>
          <p className="muted">Свои слова. Свой темп.</p>
        </div>
        <div className="actions">
          <button
            className="button secondary"
            onClick={() => setFolderModal("new")}
          >
            <FolderPlus size={18} />
            Папка
          </button>
          <button className="button primary" onClick={() => setDeckModal(true)}>
            <Plus size={18} />
            Новая колода
          </button>
        </div>
      </div>
      <div className="search">
        <Search size={19} />
        <input
          aria-label="Поиск колод и карточек"
          placeholder="Найти колоду или слово…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="muted">{decks.length} колод</span>
      </div>
      {query ? (
        <div className="deck-grid">
          {filtered.map((d) => (
            <DeckTile key={d.id} deck={d} snapshot={snapshot} />
          ))}
          {last &&
            (last.name
              .toLocaleLowerCase()
              .includes(query.toLocaleLowerCase()) ||
              snapshot.cards.some(
                (c) =>
                  c.deckId === last.id &&
                  !c.deletedAt &&
                  `${c.front} ${c.back}`
                    .toLocaleLowerCase()
                    .includes(query.toLocaleLowerCase()),
              )) && (
              <p className="hint">
                Найдено в закреплённой колоде «{last.name}» выше.
              </p>
            )}
          {!filtered.length && <p className="muted">Других совпадений нет.</p>}
        </div>
      ) : (
        tree(null)
      )}
      {!decks.length && !folders.length && (
        <Empty
          title="Здесь будет ваша коллекция"
          text="Создайте колоду или перенесите слова из таблицы. Примеры предложений тоже сохранятся."
        >
          <button
            className="button secondary"
            onClick={() => navigate("/import")}
          >
            <Upload size={17} />
            Импортировать слова
          </button>
        </Empty>
      )}
      <div className="tip">
        <span>✦</span>
        <p>
          <strong>Немного каждый день — надолго в памяти.</strong>
          <br />
          Карточки возвращаются тогда, когда их пора повторить. Выученные слова
          тоже остаются в расписании.
        </p>
      </div>
      {deckModal && (
        <DeckEditor
          initial={newDeck("")}
          snapshot={snapshot}
          close={() => setDeckModal(false)}
          saved={(d) => navigate(`/deck/${d.id}`)}
        />
      )}
      {folderModal && (
        <FolderEditor
          original={folderModal === "new" ? undefined : folderModal}
          snapshot={snapshot}
          close={() => setFolderModal(null)}
        />
      )}
      {remove && (
        <Confirm
          title={`Удалить папку «${remove.name}»?`}
          description="Колоды и вложенные папки будут перенесены на уровень выше. Карточки и прогресс сохранятся."
          close={() => setRemove(null)}
          action={() =>
            applyEdits([
              {
                entity: "folder",
                id: remove.id,
                patch: { deletedAt: nowISO() },
              },
              ...snapshot.decks
                .filter((d) => d.folderId === remove.id)
                .map((d) => ({
                  entity: "deck" as const,
                  id: d.id,
                  patch: { folderId: remove.parentId },
                })),
              ...snapshot.folders
                .filter((f) => f.parentId === remove.id)
                .map((f) => ({
                  entity: "folder" as const,
                  id: f.id,
                  patch: { parentId: remove.parentId },
                })),
            ])
          }
        />
      )}
    </>
  );
}
