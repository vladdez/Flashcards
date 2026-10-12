import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from "react";
import { X, ArrowUpRight, Layers, ArrowRight } from "lucide-react";
import type { Deck, Snapshot } from "../core/model";
import { deckProgress } from "../core/study";

export function Modal({
  title,
  children,
  close,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? "modal wide" : "modal"}
      onCancel={close}
      onClick={(e) => {
        if (e.target === ref.current) {
          const r = ref.current.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            close();
        }
      }}
      aria-labelledby="dialog-title"
    >
      <div className="modal-head">
        <h2 id="dialog-title">{title}</h2>
        <button className="icon-button" onClick={close} aria-label="Закрыть">
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function AsyncForm({
  children,
  submit,
  label = "Сохранить",
  cancel,
  danger = false,
}: {
  children: ReactNode;
  submit: () => Promise<unknown>;
  label?: string;
  cancel?: () => void;
  danger?: boolean;
}) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const lock = useRef(false);
  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await submit();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <form onSubmit={onSubmit}>
      {children}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        {cancel && (
          <button type="button" className="button secondary" onClick={cancel}>
            Отмена
          </button>
        )}
        <button
          disabled={busy}
          className={`button ${danger ? "danger" : "primary"}`}
          type="submit"
        >
          {busy ? "Сохранение…" : label}
        </button>
      </div>
    </form>
  );
}
export function Confirm({
  title,
  description,
  action,
  close,
}: {
  title: string;
  description: string;
  action: () => Promise<unknown>;
  close: () => void;
}) {
  return (
    <Modal title={title} close={close}>
      <AsyncForm
        label="Подтвердить"
        danger
        cancel={close}
        submit={async () => {
          await action();
          close();
        }}
      >
        <p>{description}</p>
      </AsyncForm>
    </Modal>
  );
}
export const navigate = (route: string) => {
  location.hash = route;
};
export function DeckTile({
  deck,
  snapshot,
  featured = false,
}: {
  deck: Deck;
  snapshot: Snapshot;
  featured?: boolean;
}) {
  const progress = deckProgress(deck, snapshot.cards, snapshot.schedules);
  const folder = snapshot.folders.find((f) => f.id === deck.folderId);
  return (
    <article className={featured ? "deck-tile featured" : "deck-tile"}>
      {featured && <div className="eyebrow">ВАША ПОСЛЕДНЯЯ КОЛОДА</div>}
      <div className="deck-heading">
        <span className="flag">{deck.flagEmoji}</span>
        <button
          className="icon-button"
          onClick={() => navigate(`/deck/${deck.id}`)}
          aria-label={`Открыть ${deck.name}`}
        >
          <ArrowUpRight size={21} />
        </button>
      </div>
      <button
        className="title-button"
        onClick={() => navigate(`/deck/${deck.id}`)}
      >
        <h3>{deck.name}</h3>
      </button>
      <p className="muted deck-folder">
        {folder?.name || "Моя библиотека"} ·{" "}
        {deck.studyMode === "both"
          ? "В обе стороны"
          : deck.studyMode === "reverse"
            ? "Обратное направление"
            : "Прямое направление"}
      </p>
      <div className="progress-info">
        <span>
          {progress.learned} / {progress.total} выучено
        </span>
        <strong>{progress.percent}%</strong>
      </div>
      <div className="progress-track">
        <span style={{ width: `${progress.percent}%` }} />
      </div>
      <div className="deck-bottom">
        <span className="pill">
          {progress.due
            ? `${progress.due} к повторению`
            : progress.fresh
              ? `${progress.fresh} новых`
              : progress.total
                ? "Всё повторено"
                : "Пока нет карточек"}
        </span>
        <button
          className={featured ? "button light" : "text-button"}
          onClick={() => navigate(`/study/${deck.id}`)}
        >
          {featured ? "Продолжить" : "Учить"}
          <ArrowRight size={17} />
        </button>
      </div>
    </article>
  );
}
export function Empty({
  title,
  text,
  children,
}: {
  title: string;
  text: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Layers size={32} />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
      {children}
    </div>
  );
}
export const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : String(e);
