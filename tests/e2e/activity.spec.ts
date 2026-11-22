import { expect, test } from "@playwright/test";

test("activity periods stay compact on home and statistics", async ({
  page,
}) => {
  await page.goto("./");
  const calendar = page.locator(".activity-calendar");
  await expect(
    calendar.getByRole("button", { name: "Неделя", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await calendar.getByRole("button", { name: "Месяц", exact: true }).click();
  await expect(calendar.locator(".activity-month-days")).toBeVisible();
  await calendar.getByRole("button", { name: "Предыдущий период" }).click();
  await expect(
    calendar.getByRole("button", { name: "К текущему периоду" }),
  ).toBeVisible();
  await calendar.getByRole("button", { name: "Год", exact: true }).click();
  await expect(calendar.locator(".activity-mini-month")).toHaveCount(12);
  await expect(page.locator("body")).toHaveJSProperty(
    "scrollWidth",
    await page.locator("body").evaluate((el) => el.clientWidth),
  );
  await page.screenshot({
    path: `test-results/activity-year-${test.info().project.name}.png`,
    fullPage: true,
  });
  await calendar.locator(".activity-mini-month").first().click();
  await expect(
    calendar.getByRole("button", { name: "Месяц", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page
    .getByRole("link", { name: "Статистика", exact: true })
    .filter({ visible: true })
    .click();
  await calendar.getByRole("button", { name: "Год", exact: true }).click();
  await expect(calendar.locator(".activity-mini-month")).toHaveCount(12);
  await expect(page.locator("body")).toHaveJSProperty(
    "scrollWidth",
    await page.locator("body").evaluate((el) => el.clientWidth),
  );
});
