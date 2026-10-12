import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  BookOpen,
  LayoutGrid,
  Upload,
  BarChart3,
  Settings,
  Cloud,
  WifiOff,
  ArrowUpRight,
  X,
} from "lucide-react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { db, initialize } from "./core/db";
import { Home } from "./pages/Home";
import { DeckPage } from "./pages/DeckPage";
import { Study } from "./pages/Study";
import { ImportPage } from "./pages/ImportPage";
import { Stats } from "./pages/Stats";
import { SettingsPage } from "./pages/SettingsPage";
import { useSync } from "./sync/useSync";
import { Empty, errorMessage, navigate } from "./components/Common";

export default function App() {
  const [route, setRoute] = useState(location.hash.slice(1) || "/"),
    [fatal, setFatal] = useState(""),
    [toast, setToast] = useState(""),
    [online, setOnline] = useState(navigator.onLine);
  const snapshot = useLiveQuery(() => db.state.get("current"));
  const sync = useSync();
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError: (e) =>
      setToast(`Офлайн-кэш пока недоступен: ${errorMessage(e)}`),
  });
  useEffect(() => {
    void initialize().catch((e) => setFatal(errorMessage(e)));
  }, []);
  useEffect(() => {
    const listener = () => setRoute(location.hash.slice(1) || "/");
    window.addEventListener("hashchange", listener);
    return () => window.removeEventListener("hashchange", listener);
  }, []);
  useEffect(() => {
    const listener = () => setOnline(navigator.onLine);
    window.addEventListener("online", listener);
    window.addEventListener("offline", listener);
    return () => {
      window.removeEventListener("online", listener);
      window.removeEventListener("offline", listener);
    };
  }, []);
  useEffect(() => {
    if (snapshot)
      document.documentElement.dataset.theme = snapshot.settings.theme;
  }, [snapshot?.settings.theme]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 7000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!offlineReady) return;
    const timer = setTimeout(() => setOfflineReady(false), 4500);
    return () => clearTimeout(timer);
  }, [offlineReady, setOfflineReady]);
  function report(p: Promise<unknown>, message?: string) {
    void p
      .then(() => {
        if (message) setToast(message);
      })
      .catch((e) => setToast(errorMessage(e)));
  }
  const [page, id] = route.split("/").filter(Boolean),
    study = page === "study";
  const deck = snapshot?.decks.find((d) => d.id === id && !d.deletedAt);
  const nav = [
    { id: "", label: "Моя библиотека", icon: LayoutGrid },
    { id: "import", label: "Импорт", icon: Upload },
    { id: "stats", label: "Статистика", icon: BarChart3 },
    { id: "settings", label: "Настройки", icon: Settings },
  ];
  return (
    <div className={`app-shell ${study ? "studying" : ""}`}>
      <aside className="sidebar">
        <a className="brand" href="#/">
          <span>
            <BookOpen size={23} />
          </span>
          flashcards<span className="brand-dot">.</span>
        </a>
        <div className="nav-caption">ВАШЕ ПРОСТРАНСТВО</div>
        <nav>
          {nav.map((item) => (
            <a
              key={item.id}
              href={`#/${item.id}`}
              className={(page || "") === item.id ? "active" : ""}
            >
              <item.icon size={20} />
              <span>{item.label}</span>
            </a>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-badge">
            <span className="status-dot" />
            <strong>Сначала — на устройстве</strong>
            <p>
              Ваши знания всегда с вами,
              <br />
              даже без интернета.
            </p>
          </div>
          <button className="sync-link" onClick={() => navigate("/settings")}>
            {online ? <Cloud size={18} /> : <WifiOff size={18} />}
            <span>{online ? sync.status : "Офлайн / ожидает"}</span>
            <ArrowUpRight size={16} />
          </button>
          <span className="version">FLASHCARDS · 1.0</span>
        </div>
      </aside>
      <header className="mobile-header">
        <a className="brand" href="#/">
          <BookOpen size={24} />
          flashcards.
        </a>
        <button
          className="icon-button"
          aria-label="Статус синхронизации"
          onClick={() => navigate("/settings")}
        >
          {online ? <Cloud size={22} /> : <WifiOff size={22} />}
        </button>
      </header>
      <main>
        {fatal ? (
          <div className="error" role="alert">
            <h1>Не удалось открыть хранилище</h1>
            <p>{fatal}</p>
            <p>
              Разрешите IndexedDB и хранение данных для этого сайта, затем
              перезагрузите страницу.
            </p>
          </div>
        ) : !snapshot ? (
          <p className="loading">Открываем вашу библиотеку…</p>
        ) : page === "deck" && deck ? (
          <DeckPage key={id} deck={deck} snapshot={snapshot} report={report} />
        ) : page === "study" && deck ? (
          <Study key={id} deck={deck} snapshot={snapshot} />
        ) : page === "import" ? (
          <ImportPage key={id} snapshot={snapshot} targetId={id} />
        ) : page === "stats" ? (
          <Stats snapshot={snapshot} />
        ) : page === "settings" ? (
          <SettingsPage snapshot={snapshot} sync={sync} report={report} />
        ) : page === "deck" || page === "study" ? (
          <Empty
            title="Колода не найдена"
            text="Возможно, она была удалена на другом устройстве."
          >
            <button className="button primary" onClick={() => navigate("/")}>
              В библиотеку
            </button>
          </Empty>
        ) : (
          <Home snapshot={snapshot} />
        )}
      </main>
      <nav className="mobile-nav">
        {nav.map((item) => (
          <a
            key={item.id}
            href={`#/${item.id}`}
            className={(page || "") === item.id ? "active" : ""}
          >
            <item.icon size={21} />
            <span>{item.label}</span>
          </a>
        ))}
      </nav>
      {(offlineReady || needRefresh) && (
        <div className="pwa-banner" role="status">
          <span>
            {needRefresh
              ? "Доступна новая версия приложения."
              : "Готово к работе офлайн."}
          </span>
          {needRefresh && (
            <button
              className="text-button"
              onClick={() => void updateServiceWorker(true)}
            >
              Обновить
            </button>
          )}
          <button
            className="icon-button"
            aria-label="Скрыть сообщение"
            onClick={() => {
              setOfflineReady(false);
              setNeedRefresh(false);
            }}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
          <button
            className="icon-button"
            aria-label="Закрыть уведомление"
            onClick={() => setToast("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
