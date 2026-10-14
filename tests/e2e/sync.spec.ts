import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import type { Operation } from "../../src/core/model";
import { canonical } from "../../src/core/merge";

// These are browser integration tests with intercepted HTTP, NOT live Supabase.
function cloud() {
  const operations: Operation[] = [];
  let loseAck = false;
  const userId = "4b0a3804-7c4c-4a5b-9e34-62a00a08ef00";
  function session(id = userId) {
    const payload = Buffer.from(
      JSON.stringify({
        sub: id,
        role: "authenticated",
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString("base64url");
    return {
      access_token: `eyJhbGciOiJIUzI1NiJ9.${payload}.test-signature`,
      refresh_token: "synthetic-refresh-token",
      token_type: "bearer",
      expires_in: 3600,
      user: {
        id,
        email: "learner@example.test",
        aud: "authenticated",
        role: "authenticated",
        app_metadata: { provider: "email", providers: ["email"] },
        user_metadata: {},
        created_at: "2026-01-01T00:00:00Z",
      },
    };
  }
  async function intercept(context: BrowserContext) {
    await context.route("https://*.supabase.co/**", async (route) => {
      const url = new URL(route.request().url()),
        body = route.request().postDataJSON() || {};
      const reply = (data: unknown, status = 200) =>
        route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(data),
        });
      if (url.pathname === "/auth/v1/otp") return reply({});
      if (
        url.pathname === "/auth/v1/verify" ||
        url.pathname === "/auth/v1/token"
      )
        return reply(
          session(
            body.token === "999999"
              ? "b6b7ffbf-fdc0-4a1c-bcbf-3f7c6e7439f5"
              : userId,
          ),
        );
      if (url.pathname === "/auth/v1/logout") return reply({});
      if (url.pathname.endsWith("/flashcards_head"))
        return reply(operations.length);
      if (url.pathname.endsWith("/flashcards_pull"))
        return reply(
          operations
            .slice(body.after_revision, body.until_revision)
            .map((operation, i) => ({
              revision: body.after_revision + i + 1,
              operation,
            })),
        );
      if (url.pathname.endsWith("/flashcards_push")) {
        for (const op of body.incoming as Operation[]) {
          const previous = operations.find((o) => o.id === op.id);
          if (previous && canonical(previous) !== canonical(op))
            return reply({ code: "P0001", message: "ID collision" }, 400);
          if (!previous) operations.push(op);
        }
        if (loseAck) {
          loseAck = false;
          return route.abort("failed");
        }
        return reply(body.incoming.map((op: Operation) => op.id));
      }
      return reply({ message: "Unexpected mocked endpoint" }, 500);
    });
  }
  return {
    operations,
    intercept,
    dropNextAck: () => {
      loseAck = true;
    },
  };
}
async function settings(page: Page) {
  await page.evaluate(() => {
    location.hash = "/settings";
  });
  await expect(
    page.getByRole("heading", { name: "Настройки", exact: true }),
  ).toBeVisible();
}
async function login(page: Page, code = "123456") {
  await settings(page);
  await page.getByLabel("Email", { exact: true }).fill("learner@example.test");
  await page.getByRole("button", { name: "Получить письмо для входа" }).click();
  await page.getByLabel("Код из письма").fill(code);
  await page.getByRole("button", { name: "Войти по коду" }).click();
  await expect(page.getByText("Аккаунт:", { exact: true })).toBeVisible();
}
async function approve(page: Page) {
  await page
    .getByRole("button", { name: "Сравнить и объединить данные" })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("После объединения");
  await dialog.getByRole("checkbox").check();
  await dialog
    .getByRole("button", { name: "Объединить и включить синхронизацию" })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".panel .pill")).toHaveText("Синхронизировано");
}
async function importCard(page: Page) {
  await page.goto("./#/import");
  await page.getByLabel("Файл для импорта").setInputFiles({
    name: "Sync.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("word,translation,example\nWort,Слово,Ein Wort."),
  });
  await page.getByRole("button", { name: /Импортировать: 1 новых/ }).click();
  await page.getByRole("button", { name: "Открыть колоду" }).click();
  await expect(
    page.getByRole("heading", { name: "Sync", exact: true }),
  ).toBeVisible();
  return new URL(page.url()).hash;
}
test("two devices: explicit merge, offline conflicting edits/reviews, retry and convergence", async ({
  page,
  context,
  browser,
}) => {
  test.setTimeout(90000);
  const remote = cloud();
  await remote.intercept(context);
  const deckHash = await importCard(page);
  await settings(page);
  test.skip(
    await page
      .getByText("Облако пока не настроено", { exact: true })
      .isVisible(),
    "Build without public Supabase configuration: offline tests still run.",
  );
  await login(page);
  expect(remote.operations).toHaveLength(0);
  await expect(
    page.getByRole("button", { name: "Скачать копию перед подключением" }),
  ).toBeVisible();
  await approve(page);
  const second = await browser.newContext({
    baseURL: "http://127.0.0.1:4173/Flashcards/",
    serviceWorkers: "allow",
  });
  try {
    await remote.intercept(second);
    const b = await second.newPage();
    await b.goto("./#/settings");
    await login(b);
    await approve(b);
    for (const p of [page, b]) {
      await p.evaluate(() => navigator.serviceWorker.ready.then(() => true));
      await p.reload();
      await p.waitForFunction(
        () => !!navigator.serviceWorker.controller,
        undefined,
        { timeout: 10000 },
      );
    }
    await context.setOffline(true);
    await second.setOffline(true);
    for (const [p, translation] of [
      [page, "Device A"],
      [b, "Device B"],
    ] as const) {
      await p.evaluate((hash) => {
        location.hash = hash;
      }, deckHash);
      await p
        .getByRole("button", { name: "Редактировать Wort", exact: true })
        .click();
      await p.getByLabel("Перевод / ответ").fill(translation);
      await p.getByRole("button", { name: "Сохранить", exact: true }).click();
      await p.getByRole("button", { name: "Начать занятие" }).click();
      await p.getByRole("button", { name: "Показать ответ" }).click();
      await p.getByRole("button", { name: /Легко/ }).click();
      await settings(p);
    }
    expect(remote.operations.filter((o) => o.entity === "review")).toHaveLength(
      0,
    );
    remote.dropNextAck();
    await context.setOffline(false);
    await expect
      .poll(() => remote.operations.filter((o) => o.entity === "review").length)
      .toBe(1);
    // First acknowledgement was lost. Retrying must keep one review event.
    await page.getByRole("button", { name: "Синхронизировать сейчас" }).click();
    await expect(page.locator(".panel .pill")).toHaveText("Синхронизировано");
    await second.setOffline(false);
    await expect
      .poll(() => remote.operations.filter((o) => o.entity === "review").length)
      .toBe(2);
    await page.getByRole("button", { name: "Синхронизировать сейчас" }).click();
    for (const p of [page, b])
      await expect(
        p.getByRole("heading", { name: "Конфликты изменений" }),
      ).toBeVisible();
    await page
      .locator(".conflict")
      .filter({ hasText: "Device A" })
      .getByRole("button", { name: "Выбрать эту версию" })
      .first()
      .click();
    await expect(page.locator(".panel .pill")).toHaveText("Синхронизировано", {
      timeout: 10000,
    });
    await b.getByRole("button", { name: "Синхронизировать сейчас" }).click();
    await expect(
      b.getByRole("heading", { name: "Конфликты изменений" }),
    ).toHaveCount(0);
    await page.reload();
    await expect(page.getByText("Аккаунт:", { exact: true })).toBeVisible();
    expect(remote.operations.filter((o) => o.entity === "review")).toHaveLength(
      2,
    );
    await page
      .getByRole("button", { name: "Выйти из аккаунта", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Подтвердить" })
      .click();
    await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
    const count = remote.operations.length;
    await login(page, "999999");
    await expect(page.getByRole("alert")).toContainText(
      "привязана к другому аккаунту",
    );
    expect(remote.operations).toHaveLength(count);
    await page.evaluate((hash) => {
      location.hash = hash;
    }, deckHash);
    await expect(page.locator(".card-row")).toHaveCount(1);
  } finally {
    await second.close().catch(() => {});
  }
});
test("GitHub Pages root magic-link callback restores a session and requires merge confirmation", async ({
  page,
  context,
}) => {
  const remote = cloud();
  await remote.intercept(context);
  await page.goto("./#/settings");
  test.skip(
    await page
      .getByText("Облако пока не настроено", { exact: true })
      .isVisible(),
    "Build without public Supabase configuration.",
  );
  await page.getByLabel("Email", { exact: true }).fill("learner@example.test");
  await page.getByRole("button", { name: "Получить письмо для входа" }).click();
  await expect(page.getByLabel("Код из письма")).toBeVisible();
  await page.goto("./?code=synthetic-pkce-code");
  await expect(page.getByText("Аккаунт:", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/Flashcards\/#\/settings$/);
  expect(remote.operations).toHaveLength(0);
  await page.reload();
  await expect(page.getByText("Аккаунт:", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Сравнить и объединить данные" }),
  ).toBeVisible();
  expect(remote.operations).toHaveLength(0);
});
