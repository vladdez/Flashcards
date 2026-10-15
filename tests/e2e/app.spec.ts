import { expect, test } from "@playwright/test";
import path from "node:path";
test("CSV/XLSX → study → quick edit → reload → backup → offline PWA", async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("./");
  await expect(
    page.getByRole("heading", { name: "Учить. Повторять. Помнить." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Импортировать слова" }).click();
  await page
    .getByLabel("Файл для импорта")
    .setInputFiles(path.resolve("public/examples/german.xlsx"));
  await expect(
    page.getByText("Liebe Grüße aus Berlin!", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Импортировать: 3 новых/ }).click();
  await expect(
    page.getByRole("heading", { name: "Слова на месте" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Открыть колоду" }).click();
  await expect(
    page.getByRole("heading", { name: "german", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Настройки колоды" }).click();
  await page.getByLabel("Флаг / эмодзи").fill("🇺🇸");
  await page.getByLabel("Направление изучения").selectOption("both");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await page.getByRole("button", { name: "Начать занятие" }).click();
  await expect(page.getByRole("button", { name: /Хорошо/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Показать ответ" }).click();
  await expect(page.locator(".examples em").first()).toBeVisible();
  const question = await page.locator(".study-content h1").textContent();
  await page
    .getByRole("button", { name: "Редактировать текущую карточку" })
    .click();
  await page.getByLabel("Заметки").fill("Проверено");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.locator(".study-content h1")).toHaveText(question!);
  await page.getByRole("button", { name: /Легко/ }).click();
  await expect(page.getByText("Ответов: 1", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Ответов: 0", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Завершить", exact: true }).click();
  await page
    .getByRole("button", { name: "Моя библиотека", exact: true })
    .click();
  await expect(page.getByText("ВАША ПОСЛЕДНЯЯ КОЛОДА")).toBeVisible();
  await page
    .getByRole("link", { name: "Статистика", exact: true })
    .filter({ visible: true })
    .click();
  await expect(
    page.locator(".metric").filter({ hasText: "ответов за всё время" }),
  ).toContainText("1");
  await page
    .getByRole("link", { name: "Настройки", exact: true })
    .filter({ visible: true })
    .click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Скачать полный JSON" }).click();
  expect((await downloadPromise).suggestedFilename()).toMatch(/backup.json$/);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Настройки", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Моя библиотека", exact: true })
    .filter({ visible: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "german", exact: true }),
  ).toBeVisible();
  await expect(page.locator("body")).toHaveJSProperty(
    "scrollWidth",
    await page.locator("body").evaluate((el) => el.clientWidth),
  );
  await page.screenshot({
    path: `test-results/library-${test.info().project.name}.png`,
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
test("CSV preview blocks unresolved duplicates; per-row update retains one card", async ({
  page,
}) => {
  await page.goto("./#/import");
  await page.getByLabel("Файл для импорта").setInputFiles({
    name: "duplicate.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "word;translation;example\nGrüße;Привет;Hallo!\n GRÜßE ;Приветствия;Guten Tag!",
    ),
  });
  await page.getByRole("button", { name: /Импортировать: 1 новых/ }).click();
  await expect(page.getByRole("alert")).toContainText("Выберите действие");
  await page.getByLabel("Дубликат в строке 3").selectOption("update");
  await page
    .getByRole("button", { name: /Импортировать: 1 новых, 1 обновлений/ })
    .click();
  await page.getByRole("button", { name: "Открыть колоду" }).click();
  await expect(page.locator(".card-row")).toHaveCount(1);
  await expect(page.locator(".card-row")).toContainText("Hallo!");
  await expect(page.locator(".card-row")).toContainText("Guten Tag!");
});
test("visible duplicates can be merged together or imported as separate cards", async ({
  page,
}) => {
  const file = {
    name: "meanings.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "word;translation;example\nBank;банк;Die Bank ist offen.\n BANK ;скамейка;Eine Bank im Park.\nBank;банк;Die Bank ist offen.",
    ),
  };
  await page.goto("./#/import");
  await page.getByLabel("Файл для импорта").setInputFiles(file);
  await expect(page.getByText("Дубликат", { exact: true })).toHaveCount(2);
  await expect(
    page.getByText("Дубликат", { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Объединить все дубликаты" }).click();
  await expect(page.getByLabel("Действие для всех дубликатов")).toHaveValue(
    "merge",
  );
  await expect(page.getByLabel("Дубликат в строке 3")).toHaveValue("merge");
  await expect(page.getByLabel("Дубликат в строке 4")).toHaveValue("merge");
  // A per-row override must clear the bulk selection, and bulk selection can be reapplied.
  await page.getByLabel("Дубликат в строке 4").selectOption("add");
  await expect(page.getByLabel("Действие для всех дубликатов")).toHaveValue("");
  await page.getByRole("button", { name: "Объединить все дубликаты" }).click();
  await page.locator(".duplicate-actions").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `test-results/duplicates-light-${test.info().project.name}.png`,
    fullPage: true,
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.getByRole("heading", { name: "Импорт слов" })).toHaveCSS(
    "color",
    "rgb(227, 233, 223)",
  );
  await page.screenshot({
    path: `test-results/duplicates-dark-${test.info().project.name}.png`,
    fullPage: true,
    animations: "disabled",
  });
  await expect(page.locator("body")).toHaveJSProperty(
    "scrollWidth",
    await page.locator("body").evaluate((el) => el.clientWidth),
  );
  await page
    .getByRole("button", {
      name: /Импортировать: 1 новых, 0 обновлений, 2 объединений/,
    })
    .click();
  await expect(page.getByText(/объединено строк: 2/)).toBeVisible();
  await page.getByRole("button", { name: "Открыть колоду" }).click();
  await expect(page.locator(".card-row")).toHaveCount(1);
  await expect(page.locator(".card-row")).toContainText("банк");
  await expect(page.locator(".card-row")).toContainText("скамейка");
  await expect(page.locator(".card-row")).toContainText("Die Bank ist offen.");
  await expect(page.locator(".card-row")).toContainText("Eine Bank im Park.");
  await page.reload();
  await expect(page.locator(".card-row")).toHaveCount(1);

  await page.goto("./#/import");
  await page
    .getByLabel("Файл для импорта")
    .setInputFiles({ ...file, name: "separate.csv" });
  await page
    .getByRole("button", { name: "Добавить все, включая дубликаты" })
    .click();
  await expect(page.getByLabel("Действие для всех дубликатов")).toHaveValue(
    "add",
  );
  await page.getByRole("button", { name: /Импортировать: 3 новых/ }).click();
  await page.getByRole("button", { name: "Открыть колоду" }).click();
  await expect(page.locator(".card-row")).toHaveCount(3);
});
