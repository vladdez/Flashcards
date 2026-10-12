import { useState } from "react";
import {
  Cloud,
  Download,
  Upload,
  RefreshCw,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import type { Snapshot } from "../core/model";
import { applyEdits, editObject } from "../core/db";
import { exportBackup, restoreBackup, validateBackup } from "../core/backup";
import { AsyncForm, Confirm, Modal } from "../components/Common";
import type { SyncController } from "../sync/useSync";
import { clientId } from "../sync/auth";

export function SettingsPage({
  snapshot,
  sync,
  report,
}: {
  snapshot: Snapshot;
  sync: SyncController;
  report: (p: Promise<unknown>, message?: string) => void;
}) {
  const [settings, setSettings] = useState(snapshot.settings),
    [restore, setRestore] = useState<{ text: string; count: number } | null>(
      null,
    ),
    [unlink, setUnlink] = useState(false),
    [storage, setStorage] = useState("");
  const [baseline, setBaseline] = useState(snapshot.settings);
  return (
    <>
      <div className="page-title">
        <div>
          <div className="eyebrow">ВАШ ТЕМП И ВАШИ ДАННЫЕ</div>
          <h1>Настройки</h1>
          <p className="muted">Всё необходимое для спокойного обучения.</p>
        </div>
      </div>
      <section className="panel">
        <h2>Обучение и оформление</h2>
        <AsyncForm
          label="Сохранить настройки"
          submit={async () => {
            await applyEdits([editObject("settings", settings, baseline)]);
            setBaseline(settings);
            report(Promise.resolve(), "Настройки сохранены");
          }}
        >
          <div className="form-grid">
            <label>
              Целевое запоминание, %
              <input
                type="number"
                min="70"
                max="99"
                required
                value={Math.round(settings.retention * 100)}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    retention: Number(e.target.value) / 100,
                  })
                }
              />
              <small>
                По умолчанию 90%. Изменение применяется к следующим ответам.
              </small>
            </label>
            <label>
              Тема
              <select
                value={settings.theme}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    theme: e.target.value as typeof settings.theme,
                  })
                }
              >
                <option value="system">Как в системе</option>
                <option value="light">Светлая</option>
                <option value="dark">Тёмная</option>
              </select>
            </label>
          </div>
          <label>
            Часовой пояс
            <input
              list="timezones"
              required
              value={settings.timeZone}
              onChange={(e) =>
                setSettings({ ...settings, timeZone: e.target.value })
              }
            />
            <datalist id="timezones">
              {[
                "Europe/Berlin",
                "Europe/Moscow",
                "Europe/London",
                "America/New_York",
                "Asia/Tokyo",
                "UTC",
              ].map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
            <small>Календарные дни определяют серию и дневной лимит.</small>
          </label>
        </AsyncForm>
      </section>
      <section className="panel">
        <div className="section-title">
          <h2>
            <Cloud size={23} /> OneDrive
          </h2>
          <span className="pill">{sync.status}</span>
        </div>
        <p>
          Объединяйте карточки и прогресс на своих устройствах. После
          подключения изменения отправляются автоматически, когда приложение
          открыто и есть сеть.
        </p>
        {!clientId && (
          <div className="notice">
            <strong>Нужен Microsoft Entra client ID</strong>
            <p>
              Интеграция готова к настройке. Укажите{" "}
              <code>VITE_MS_CLIENT_ID</code> и redirect URI при сборке, затем
              опубликуйте приложение заново. Пошаговая инструкция находится в
              README репозитория.
            </p>
          </div>
        )}
        <div className="actions">
          <button
            className="button primary"
            disabled={!clientId || sync.connecting}
            onClick={() => void sync.beginConnect()}
          >
            <Cloud size={17} />
            {sync.connecting ? "Подключение…" : "Подключить OneDrive"}
          </button>
          {sync.connected && (
            <>
              <button
                className="button secondary"
                disabled={sync.status === "Синхронизация"}
                onClick={() => report(sync.run())}
              >
                <RefreshCw size={17} />
                Синхронизировать сейчас
              </button>
              <button className="text-button" onClick={() => setUnlink(true)}>
                Отключить
              </button>
            </>
          )}
        </div>
        {sync.lastSync && (
          <p className="hint">
            Последняя синхронизация:{" "}
            {new Date(sync.lastSync).toLocaleString("ru")}
          </p>
        )}
        {sync.error && (
          <p className="error" role="alert">
            {sync.error}
          </p>
        )}
      </section>
      {snapshot.conflicts.length > 0 && (
        <section className="panel">
          <h2>Конфликты изменений</h2>
          <p>
            Обе версии сохранены. Выберите значение, которое будет
            использоваться на всех устройствах.
          </p>
          {snapshot.conflicts.map((conflict) => (
            <div className="conflict" key={conflict.id}>
              <strong>
                {snapshot.cards.find((c) => c.id === conflict.entityId)
                  ?.front ||
                  snapshot.decks.find((d) => d.id === conflict.entityId)
                    ?.name ||
                  snapshot.folders.find((f) => f.id === conflict.entityId)
                    ?.name ||
                  "Настройки"}{" "}
                · {conflict.field}
              </strong>
              {conflict.values.map((v, i) => (
                <div key={i}>
                  <pre>
                    {typeof v.value === "string"
                      ? conflict.field === "deletedAt"
                        ? "Удалить (изменения остаются в истории)"
                        : v.value
                      : conflict.field === "deletedAt" && v.value === null
                        ? "Сохранить и восстановить элемент"
                        : JSON.stringify(v.value, null, 2)}
                  </pre>
                  <small>
                    {v.timestamp && new Date(v.timestamp).toLocaleString("ru")}{" "}
                    · устройство {v.deviceId.slice(0, 8)}
                  </small>
                  <button
                    className="button secondary"
                    onClick={() =>
                      report(
                        applyEdits([
                          {
                            entity: conflict.entity,
                            id: conflict.entityId,
                            patch: { [conflict.field]: v.value },
                          },
                        ]),
                        "Конфликт разрешён",
                      )
                    }
                  >
                    Выбрать эту версию
                  </button>
                </div>
              ))}
            </div>
          ))}
        </section>
      )}
      <section className="panel">
        <h2>
          <ShieldCheck size={23} /> Резервная копия
        </h2>
        <p>
          Полный JSON сохраняет папки, карточки, расписания и всю историю
          ответов. CSV и XLSX подходят для обмена словами, но не содержат
          прогресс.
        </p>
        <div className="actions">
          <button
            className="button secondary"
            onClick={() => report(exportBackup(), "Резервная копия сохранена")}
          >
            <Download size={17} />
            Скачать полный JSON
          </button>
          <label className="button secondary file-button">
            <Upload size={17} />
            Восстановить из JSON
            <input
              aria-label="Резервная копия JSON"
              type="file"
              accept=".json"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file)
                  report(
                    (async () => {
                      if (file.size > 100 * 1024 * 1024)
                        throw new Error("Копия больше 100 МБ.");
                      const text = await file.text();
                      const copy = validateBackup(text);
                      setRestore({
                        text,
                        count: copy.snapshot.cards.filter((c) => !c.deletedAt)
                          .length,
                      });
                    })(),
                  );
                e.target.value = "";
              }}
            />
          </label>
        </div>
        <p className="hint">
          Восстановление объединяет данные с текущей библиотекой. Повторный
          импорт той же копии не создаёт дубликаты.
        </p>
      </section>
      <section className="panel">
        <h2>
          <Smartphone size={23} /> Офлайн и установка
        </h2>
        <p>
          После первого открытия дождитесь сообщения «Готово к работе офлайн».
          На iPhone: Safari → Поделиться → На экран «Домой». В Chrome: меню →
          Установить приложение.
        </p>
        <button
          className="button secondary"
          onClick={() =>
            report(
              (async () => {
                const granted = await navigator.storage?.persist?.();
                const estimate = await navigator.storage?.estimate?.();
                setStorage(
                  `${granted ? "Постоянное хранение разрешено." : "Браузер управляет сроком хранения."} Занято: ${((estimate?.usage || 0) / 1024 / 1024).toFixed(1)} МБ.`,
                );
              })(),
            )
          }
        >
          Защитить локальное хранилище
        </button>
        {storage && <p className="hint">{storage}</p>}
        <p className="hint">
          Очистка данных сайта удаляет локальную библиотеку. Храните JSON-копию
          или подключите OneDrive. Закрытая iOS PWA не гарантирует фоновую
          синхронизацию.
        </p>
      </section>
      {restore && (
        <Confirm
          title="Восстановить резервную копию?"
          description={`В копии ${restore.count} карточек. Сначала будет скачана копия текущих данных, затем журналы объединятся. Конфликтующие версии сохранятся для выбора.`}
          close={() => setRestore(null)}
          action={async () => {
            await exportBackup();
            await restoreBackup(restore.text);
            report(Promise.resolve(), "Копия восстановлена");
          }}
        />
      )}
      {unlink && (
        <Confirm
          title="Отключить OneDrive?"
          description="Все локальные карточки, история и облачные данные сохранятся. Автоматическая синхронизация остановится."
          close={() => setUnlink(false)}
          action={sync.unlink}
        />
      )}
      {sync.proposal && (
        <Modal
          title="Первое подключение: сравнение"
          close={() => sync.setProposal(null)}
        >
          <p>Аккаунт: {sync.proposal.label}</p>
          <p>
            На устройстве: {sync.proposal.local.cards.length} карточек,{" "}
            {sync.proposal.local.reviews.length} событий.
          </p>
          <p>
            После объединения: {sync.proposal.merged.cards.length} карточек,{" "}
            {sync.proposal.merged.reviews.length} событий. Конфликтов:{" "}
            {sync.proposal.merged.conflicts.length}.
          </p>
          <p className="hint">
            Сохранятся изменения с обоих устройств. Ничего не заменяется пустой
            базой. Если нужен отдельный аккаунт без этих данных, отмените
            подключение.
          </p>
          <AsyncForm
            label="Объединить и включить синхронизацию"
            cancel={() => sync.setProposal(null)}
            submit={sync.accept}
          >
            <></>
          </AsyncForm>
        </Modal>
      )}
    </>
  );
}
