import { useState } from "react";
import {
  ArrowLeft,
  Plus,
  Pencil,
  Trash2,
  RotateCcw,
  Upload,
  Download,
  Play,
  Search,
} from "lucide-react";
import {
  newCard,
  nowISO,
  type Card,
  type Deck,
  type Snapshot,
} from "../core/model";
import { applyEdits, resetCard } from "../core/db";
import { deckProgress } from "../core/study";
import { exportDeck } from "../core/import";
import { CardEditor, DeckEditor } from "../components/Editors";
import { Confirm, Empty, navigate } from "../components/Common";

export function DeckPage({
  deck,
  snapshot,
  report,
}: {
  deck: Deck;
  snapshot: Snapshot;
  report: (p: Promise<unknown>, message?: string) => void;
}) {
  const [query, setQuery] = useState(""),
    [edit, setEdit] = useState(false),
    [card, setCard] = useState<Card | null>(null),
    [confirmation, setConfirmation] = useState<{
      title: string;
      description: string;
      action: () => Promise<unknown>;
    } | null>(null);
  const cards = snapshot.cards.filter(
      (c) => c.deckId === deck.id && !c.deletedAt,
    ),
    progress = deckProgress(deck, snapshot.cards, snapshot.schedules);
  return (
    <>
      <button className="text-button back" onClick={() => navigate("/")}>
        <ArrowLeft size={18} />
        Моя библиотека
      </button>
      <div className="page-title">
        <div>
          <span className="large-flag">{deck.flagEmoji}</span>
          <h1>{deck.name}</h1>
          <p className="muted">
            {progress.total} карточек · {deck.newWordsPerDay} новых слов в день
          </p>
        </div>
        <div className="actions">
          <button className="button secondary" onClick={() => setEdit(true)}>
            <Pencil size={17} />
            Настройки колоды
          </button>
          <button
            className="icon-button"
            aria-label="Удалить колоду"
            onClick={() =>
              setConfirmation({
                title: "Удалить колоду?",
                description:
                  "Колода и её карточки будут скрыты. История останется в резервной копии и журнале синхронизации.",
                action: async () => {
                  await applyEdits([
                    {
                      entity: "deck",
                      id: deck.id,
                      patch: { deletedAt: nowISO() },
                    },
                  ]);
                  navigate("/");
                },
              })
            }
          >
            <Trash2 size={19} />
          </button>
        </div>
      </div>
      <div className="deck-summary">
        <div>
          <strong>
            {progress.learned}
            <span> / {progress.total}</span>
          </strong>
          <p>выучено · интервал от 21 дня</p>
          <div className="progress-track">
            <span style={{ width: `${progress.percent}%` }} />
          </div>
        </div>
        <div>
          <strong>{progress.due}</strong>
          <p>повторений к сроку</p>
        </div>
        <button
          className="button primary"
          onClick={() => navigate(`/study/${deck.id}`)}
        >
          <Play size={18} />
          Начать занятие
        </button>
      </div>
      <div className="section-title">
        <h2>Карточки</h2>
        <div className="actions">
          <button
            className="button secondary"
            onClick={() => navigate(`/import/${deck.id}`)}
          >
            <Upload size={16} />
            Импорт карточек
          </button>
          <details className="dropdown">
            <summary className="button secondary">
              <Download size={16} />
              Экспорт
            </summary>
            <div>
              <button
                onClick={() =>
                  report(exportDeck(deck, snapshot, "csv"), "CSV сохранён")
                }
              >
                Скачать CSV
              </button>
              <button
                onClick={() =>
                  report(exportDeck(deck, snapshot, "xlsx"), "XLSX сохранён")
                }
              >
                Скачать XLSX
              </button>
            </div>
          </details>
          <button
            className="button primary"
            onClick={() => setCard(newCard(deck.id))}
          >
            <Plus size={17} />
            Карточка
          </button>
        </div>
      </div>
      <div className="search">
        <Search size={18} />
        <input
          aria-label="Поиск карточек"
          placeholder="Слово, перевод или пример…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="card-list">
        {cards
          .filter((c) =>
            `${c.front} ${c.back} ${c.examples.join(" ")} ${c.tags.join(" ")}`
              .toLocaleLowerCase()
              .includes(query.toLocaleLowerCase()),
          )
          .map((c) => (
            <article className="card-row" key={c.id}>
              <div>
                <h3>{c.front}</h3>
                <p>{c.back}</p>
                {c.examples.map((ex, i) => (
                  <p className="example" key={i}>
                    <em>{ex}</em>
                  </p>
                ))}
                {c.tags.length > 0 && (
                  <small className="muted">{c.tags.join(" · ")}</small>
                )}
              </div>
              <div className="row-actions">
                <button
                  className="icon-button"
                  aria-label={`Редактировать ${c.front}`}
                  onClick={() => setCard(c)}
                >
                  <Pencil size={17} />
                </button>
                <button
                  className="icon-button"
                  aria-label={`Сбросить прогресс ${c.front}`}
                  onClick={() =>
                    setConfirmation({
                      title: "Сбросить прогресс карточки?",
                      description:
                        "Оба направления начнутся заново. Предыдущие ответы сохранятся в истории.",
                      action: () => resetCard(c),
                    })
                  }
                >
                  <RotateCcw size={17} />
                </button>
                <button
                  className="icon-button"
                  aria-label={`Удалить ${c.front}`}
                  onClick={() =>
                    setConfirmation({
                      title: "Удалить карточку?",
                      description: `«${c.front}» будет удалена из обучения.`,
                      action: () =>
                        applyEdits([
                          {
                            entity: "card",
                            id: c.id,
                            patch: { deletedAt: nowISO() },
                          },
                        ]),
                    })
                  }
                >
                  <Trash2 size={17} />
                </button>
              </div>
            </article>
          ))}
      </div>
      {!cards.length && (
        <Empty
          title="Добавим первые слова?"
          text="Напишите карточку вручную или импортируйте CSV / XLSX с примерами."
        />
      )}
      {edit && (
        <DeckEditor
          initial={deck}
          original={deck}
          snapshot={snapshot}
          close={() => setEdit(false)}
        />
      )}
      {card && (
        <CardEditor
          initial={card}
          original={cards.find((c) => c.id === card.id)}
          snapshot={snapshot}
          close={() => setCard(null)}
        />
      )}
      {confirmation && (
        <Confirm {...confirmation} close={() => setConfirmation(null)} />
      )}
    </>
  );
}
