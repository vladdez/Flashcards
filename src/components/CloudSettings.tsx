import { useState } from "react";
import { Cloud, Download, RefreshCw } from "lucide-react";
import { exportBackup } from "../core/backup";
import type { SyncController } from "../sync/useSync";
import { cloudConfig } from "../sync/config";
import { AsyncForm, Confirm, Modal } from "./Common";

export function CloudSettings({
  sync,
  report,
}: {
  sync: SyncController;
  report: (p: Promise<unknown>, message?: string) => void;
}) {
  const [email, setEmail] = useState(sync.sentEmail);
  const [code, setCode] = useState("");
  const [link, setLink] = useState("");
  const [unlink, setUnlink] = useState(false);
  return (
    <>
      <section className="panel">
        <div className="section-title">
          <h2>
            <Cloud size={23} /> Облачная синхронизация
          </h2>
          <span className="pill">{sync.status}</span>
        </div>
        <p>
          Карточки и прогресс сохраняются на устройстве. После входа и
          подтверждения объединения изменения автоматически синхронизируются
          через Supabase, пока приложение открыто и есть сеть.
        </p>
        {!cloudConfig.configured ? (
          <div className="notice">
            <strong>Облако пока не настроено</strong>
            <p>
              Локальная библиотека и обучение доступны. Владельцу сайта нужно
              завершить настройку Supabase по инструкции в README.
            </p>
          </div>
        ) : !sync.user ? (
          <>
            <p className="notice">
              Пока синхронизация не подключена, изменения видны только на этом
              устройстве. На телефоне и компьютере войдите с одним email и
              подтвердите объединение данных на каждом устройстве.
            </p>
            <AsyncForm
              label="Получить письмо для входа"
              submit={() => sync.sendEmail(email)}
            >
              <label>
                Email
                <input
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
            </AsyncForm>
            {sync.sentEmail && (
              <div className="notice" role="status">
                <p>
                  Письмо отправлено на {sync.sentEmail}. Вернитесь сюда после
                  копирования ссылки или кода из письма.
                </p>
              </div>
            )}
            <div className="email-link-sign-in">
              <h3>Войти по ссылке из письма</h3>
              <p className="hint">
                На iPhone нажмите и удерживайте кнопку входа в новом письме,
                выберите «Скопировать ссылку» (Link kopieren). Вернитесь в
                Flashcards с главного экрана и вставьте ссылку ниже. Открывать
                её в почтовом браузере не нужно.
              </p>
              <AsyncForm
                label="Войти по ссылке"
                submit={async () => {
                  try {
                    await sync.verifyLink(link);
                  } finally {
                    setLink("");
                  }
                }}
              >
                <label>
                  Ссылка из письма
                  <textarea
                    rows={3}
                    inputMode="url"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    required
                    value={link}
                    onChange={(e) => setLink(e.target.value)}
                    placeholder="Вставьте скопированную ссылку входа"
                  />
                </label>
              </AsyncForm>
            </div>
            {sync.sentEmail && (
              <div className="notice">
                <p>
                  Если в письме есть цифровой код, можно ввести его вместо
                  ссылки.
                </p>
                <AsyncForm
                  label="Войти по коду"
                  submit={() => sync.verifyCode(code)}
                >
                  <label>
                    Код из письма
                    <input
                      autoComplete="one-time-code"
                      inputMode="numeric"
                      pattern="[0-9]{6,10}"
                      required
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                    />
                  </label>
                </AsyncForm>
              </div>
            )}
          </>
        ) : (
          <>
            <p>
              <strong>Аккаунт:</strong> {sync.user.email || sync.user.id}
            </p>
            {sync.wrongAccount ? (
              <div className="notice" role="alert">
                Эта локальная библиотека уже привязана к другому аккаунту.
                Выйдите и войдите в прежний аккаунт. Для другой библиотеки
                используйте отдельный профиль браузера. Данные не отправлены
                новому пользователю.
              </div>
            ) : !sync.connected ? (
              <>
                <p>
                  Перед подключением сохраните полную резервную копию. Вход сам
                  по себе не загружает вашу библиотеку в облако.
                </p>
                <div className="actions">
                  <button
                    className="button secondary"
                    onClick={() =>
                      report(exportBackup(), "Резервная копия сохранена")
                    }
                  >
                    <Download size={17} /> Скачать копию перед подключением
                  </button>
                  <button
                    className="button primary"
                    disabled={sync.connecting}
                    onClick={() => report(sync.prepareMerge())}
                  >
                    {sync.connecting
                      ? "Сравнение…"
                      : "Сравнить и объединить данные"}
                  </button>
                </div>
              </>
            ) : (
              <button
                className="button secondary"
                disabled={sync.status === "Синхронизация"}
                onClick={() => report(sync.run())}
              >
                <RefreshCw size={17} /> Синхронизировать сейчас
              </button>
            )}
            <button className="text-button" onClick={() => setUnlink(true)}>
              Выйти из аккаунта
            </button>
          </>
        )}
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
      {unlink && (
        <Confirm
          title="Выйти из аккаунта?"
          description="Локальные карточки, история и облачные данные сохранятся. Автоматическая синхронизация остановится на этом устройстве. Локальная библиотека останется доступна в этом браузере."
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
            В облаке: {sync.proposal.remote.cards.length} карточек,{" "}
            {sync.proposal.remote.reviews.length} событий.
          </p>
          <p>
            После объединения: {sync.proposal.merged.cards.length} карточек,{" "}
            {sync.proposal.merged.reviews.length} событий. Конфликтов:{" "}
            {sync.proposal.merged.conflicts.length}.
          </p>
          <p className="hint">
            Количество включает архивные записи удалённых карточек. Все версии и
            ответы сохранятся. Существующие локальные данные будут связаны с
            этим аккаунтом.
          </p>
          <button
            className="button secondary"
            onClick={() => report(exportBackup(), "Резервная копия сохранена")}
          >
            <Download size={17} /> Скачать полный JSON перед объединением
          </button>
          <AsyncForm
            label="Объединить и включить синхронизацию"
            cancel={() => sync.setProposal(null)}
            submit={sync.accept}
          >
            <label>
              <input type="checkbox" required /> Подтверждаю объединение
              локальной библиотеки с указанным аккаунтом.
            </label>
          </AsyncForm>
        </Modal>
      )}
    </>
  );
}
