import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Pencil, RotateCw, Check, ArrowRight } from "lucide-react";
import type { Grade } from "ts-fsrs";
import { type Deck, type Snapshot, uid } from "../core/model";
import {
  intervalLabel,
  preview,
  studyQueue,
  type StudyItem,
} from "../core/study";
import { readSnapshot, recordAnswer } from "../core/db";
import { CardEditor } from "../components/Editors";
import { errorMessage, navigate } from "../components/Common";

export function Study({ deck, snapshot }: { deck: Deck; snapshot: Snapshot }) {
  const [mode, setMode] = useState<"all" | "due" | "new">("all");
  const makeTurn = (item: StudyItem | undefined, state: Snapshot) =>
    item
      ? {
          ...item,
          answerId: uid(),
          schedule: state.schedules.find(
            (s) => s.id === `${item.cardId}:${item.direction}`,
          ),
          time: new Date(),
        }
      : undefined;
  const [turn, setTurn] = useState(() =>
      makeTurn(studyQueue(deck, snapshot)[0], snapshot),
    ),
    [revealed, setRevealed] = useState(false),
    [editing, setEditing] = useState(false),
    [answered, setAnswered] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false);
  const card = snapshot.cards.find(
    (c) => c.id === turn?.cardId && !c.deletedAt,
  );
  const outcomes = turn
    ? preview(turn.schedule, snapshot.settings.retention, turn.time)
    : undefined;
  async function grade(rating: Grade) {
    if (!turn || !card || !revealed || editing || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await recordAnswer(
        card.id,
        turn.direction,
        rating,
        turn.answerId,
        turn.schedule?.fsrs.last_review,
      );
      const state = await readSnapshot();
      setAnswered((a) => a + 1);
      setRevealed(false);
      setTurn(makeTurn(studyQueue(deck, state, new Date(), mode)[0], state));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        editing ||
        e.repeat ||
        (e.target instanceof HTMLElement &&
          /INPUT|TEXTAREA|SELECT|BUTTON/.test(e.target.tagName))
      )
        return;
      if (e.code === "Space") {
        e.preventDefault();
        if (card) setRevealed(true);
      }
      if (["1", "2", "3", "4"].includes(e.key) && revealed) {
        e.preventDefault();
        void grade(Number(e.key) as Grade);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
  const remaining = studyQueue(deck, snapshot, new Date(), mode).length;
  const earliest = snapshot.schedules
    .filter((s) =>
      snapshot.cards.some(
        (c) => c.id === s.cardId && c.deckId === deck.id && !c.deletedAt,
      ),
    )
    .map((s) => s.fsrs.due)
    .sort()[0];
  return (
    <div className="study-page">
      <div className="study-header">
        <button
          className="text-button"
          onClick={() => navigate(`/deck/${deck.id}`)}
        >
          <ArrowLeft size={18} />
          Завершить
        </button>
        <span>
          {deck.flagEmoji} {deck.name}
        </span>
        <span className="muted">Ответов: {answered}</span>
      </div>
      <div className="study-toolbar">
        <select
          aria-label="Режим сессии"
          value={mode}
          disabled={busy}
          onChange={(e) => {
            const next = e.target.value as typeof mode;
            setMode(next);
            setTurn(
              makeTurn(
                studyQueue(deck, snapshot, new Date(), next)[0],
                snapshot,
              ),
            );
            setRevealed(false);
          }}
        >
          <option value="all">Повторения и новые</option>
          <option value="due">Только повторения</option>
          <option value="new">Только новые</option>
        </select>
        <span className="muted">{remaining} заданий доступно</span>
      </div>
      {turn && card ? (
        <>
          <div className="study-progress">
            <span
              style={{
                width: `${(answered / Math.max(1, answered + remaining)) * 100}%`,
              }}
            />
          </div>
          <div
            className={`study-card ${revealed ? "revealed" : ""}`}
            onClick={() => setRevealed(true)}
          >
            <div className="study-card-top">
              <span className="pill">
                {turn.direction === "forward"
                  ? "Слово → перевод"
                  : "Перевод → слово"}{" "}
                · {turn.isNew ? "Новое" : "Повторение"}
              </span>
              <button
                className="icon-button"
                aria-label="Редактировать текущую карточку"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditing(true);
                }}
              >
                <Pencil size={19} />
              </button>
            </div>
            <div className="study-content">
              <span className="eyebrow">
                {revealed ? "ПРОВЕРЬТЕ СЕБЯ" : "ВСПОМНИТЕ ОТВЕТ"}
              </span>
              <h1 className={revealed ? "question-small" : ""}>
                {turn.direction === "forward" ? card.front : card.back}
              </h1>
              {revealed && (
                <div className="answer" aria-live="polite">
                  <div className="answer-divider" />
                  <h2>
                    {turn.direction === "forward" ? card.back : card.front}
                  </h2>
                  {card.examples.length > 0 && (
                    <div className="examples">
                      {card.examples.map((example, i) => (
                        <p key={i}>
                          <em>{example}</em>
                        </p>
                      ))}
                    </div>
                  )}
                  {card.notes && (
                    <p className="muted study-notes">{card.notes}</p>
                  )}
                </div>
              )}
            </div>
            {!revealed && (
              <span className="flip-hint">
                <RotateCw size={15} />
                Нажмите на карточку, чтобы перевернуть
              </span>
            )}
          </div>
          {!revealed ? (
            <button
              className="button primary show-answer"
              onClick={() => setRevealed(true)}
            >
              Показать ответ<span className="key">пробел</span>
            </button>
          ) : (
            <div className="ratings">
              {(
                [
                  { n: 1, label: "Снова", class: "again" },
                  { n: 2, label: "Трудно", class: "hard" },
                  { n: 3, label: "Хорошо", class: "good" },
                  { n: 4, label: "Легко", class: "easy" },
                ] as const
              ).map((r) => (
                <button
                  key={r.n}
                  className={`rating ${r.class}`}
                  disabled={busy}
                  onClick={() => void grade(r.n)}
                >
                  <strong>{r.label}</strong>
                  <span>
                    {outcomes &&
                      intervalLabel(outcomes[r.n].card.due, turn.time)}
                  </span>
                  <kbd>{r.n}</kbd>
                </button>
              ))}
            </div>
          )}
          <p className="study-help muted">
            {revealed
              ? "Насколько легко удалось вспомнить?"
              : "Не торопитесь. Попробуйте вспомнить до переворота."}
          </p>
        </>
      ) : (
        <div className="session-complete">
          <span>
            <Check size={40} />
          </span>
          <h1>
            {answered ? "На сегодня — ещё один шаг." : "Сейчас всё повторено"}
          </h1>
          <p>
            {answered
              ? `Сохранено ответов: ${answered}. Ваш прогресс уже на устройстве.`
              : "Добавьте карточки или возвращайтесь, когда наступит время повторения."}
          </p>
          {earliest && (
            <p className="muted">
              Ближайшее повторение: {new Date(earliest).toLocaleString("ru")}
            </p>
          )}
          <button
            className="button primary"
            onClick={() => {
              setTurn(
                makeTurn(
                  studyQueue(deck, snapshot, new Date(), mode)[0],
                  snapshot,
                ),
              );
              setRevealed(false);
            }}
          >
            Проверить очередь
            <RotateCw size={17} />
          </button>
          <button className="text-button" onClick={() => navigate("/")}>
            В библиотеку
            <ArrowRight size={17} />
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {editing && card && (
        <CardEditor
          initial={card}
          original={card}
          snapshot={snapshot}
          close={() => setEditing(false)}
        />
      )}
    </div>
  );
}
