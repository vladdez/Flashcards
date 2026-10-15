import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  db,
  initialize,
  applyEdits,
  editObject,
  readSnapshot,
  recordAnswer,
} from "../src/core/db";
import { newCard, newDeck, nowISO, uid, type Folder } from "../src/core/model";
import { DeckEditor } from "../src/components/Editors";
import { Study } from "../src/pages/Study";
import { Home } from "../src/pages/Home";
afterEach(async () => {
  await db.delete();
});
beforeEach(async () => {
  await db.open();
});
async function setup() {
  await initialize();
  const deck = newDeck("Deutsch"),
    card = newCard(deck.id, "Grüße", "Приветствия", ["Liebe Grüße!"]);
  await applyEdits([editObject("deck", deck), editObject("card", card)]);
  return { deck, card, snapshot: await readSnapshot() };
}
describe("important screens", () => {
  it("keeps a manually overridden flag when changing language", async () => {
    const { deck, snapshot } = await setup();
    deck.flagEmoji = "🇺🇸";
    deck.flagIsManuallySet = true;
    render(
      <DeckEditor
        initial={deck}
        original={deck}
        snapshot={snapshot}
        close={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText("Язык"), {
      target: { value: "fr" },
    });
    expect(screen.getByLabelText("Флаг / эмодзи")).toHaveValue("🇺🇸");
  });
  it("hides ratings before reveal; examples appear immediately in italics", async () => {
    const { deck, snapshot } = await setup();
    render(<Study deck={deck} snapshot={snapshot} />);
    expect(screen.queryByText("Liebe Grüße!")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Хорошо/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Показать ответ/ }));
    expect(screen.getByText("Liebe Grüße!").tagName).toBe("EM");
    expect(screen.getByRole("button", { name: /Хорошо/ })).toBeEnabled();
  });
  it("quick edit preserves the active turn and schedule", async () => {
    const { deck, card, snapshot } = await setup();
    render(<Study deck={deck} snapshot={snapshot} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Редактировать текущую карточку" }),
    );
    fireEvent.change(screen.getByLabelText("Перевод / ответ"), {
      target: { value: "Новый перевод" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("heading", { name: card.front }),
    ).toBeInTheDocument();
    expect((await readSnapshot()).cards[0].back).toBe("Новый перевод");
    expect((await readSnapshot()).schedules).toHaveLength(0);
  });
  it("pins the actually studied deck once, instead of most recently edited", async () => {
    const { deck, card } = await setup();
    await recordAnswer(card.id, "forward", 4, uid(), undefined);
    await applyEdits([editObject("deck", newDeck("Another"))]);
    render(<Home snapshot={await readSnapshot()} />);
    expect(screen.getByText("ВАША ПОСЛЕДНЯЯ КОЛОДА")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: deck.name })).toHaveLength(1);
  });
  it("keeps the pinned deck visible inside its actual nested folder after a move", async () => {
    const { deck, card } = await setup();
    await recordAnswer(
      card.id,
      "forward",
      3,
      uid(),
      undefined,
      db,
      new Date("2026-01-01T10:00:00Z"),
    );
    const parent: Folder = {
      id: uid(),
      parentId: null,
      name: "Языки",
      sortOrder: 0,
      createdAt: nowISO(),
      updatedAt: nowISO(),
    };
    const folder: Folder = {
      ...parent,
      id: uid(),
      parentId: parent.id,
      name: "Немецкий",
    };
    await applyEdits([
      editObject("folder", parent),
      editObject("folder", folder),
      editObject("deck", { ...deck, folderId: folder.id }, deck),
    ]);
    const { container, rerender } = render(
      <Home snapshot={await readSnapshot()} />,
    );
    const contents = screen
      .getByText("Немецкий", { selector: "strong" })
      .closest("details")!;
    expect(
      within(contents).getByRole("heading", { name: deck.name }),
    ).toBeVisible();
    expect(
      within(contents).getByRole("button", { name: `Открыть ${deck.name}` }),
    ).toBeVisible();
    expect(container.querySelectorAll(".featured")).toHaveLength(1);
    expect(
      container.querySelectorAll(".featured .eyebrow")[0],
    ).toHaveTextContent("ВАША ПОСЛЕДНЯЯ КОЛОДА");
    expect(contents.querySelectorAll(".deck-tile")).toHaveLength(1);
    const second = newDeck("Вторая колода", folder.id);
    const secondCard = newCard(second.id, "Wort", "Слово");
    await applyEdits([
      editObject("deck", second),
      editObject("card", secondCard),
    ]);
    await recordAnswer(
      secondCard.id,
      "forward",
      3,
      uid(),
      undefined,
      db,
      new Date("2026-01-02T10:00:00Z"),
    );
    rerender(<Home snapshot={await readSnapshot()} />);
    expect(
      within(container.querySelector<HTMLElement>(".featured")!).getByRole(
        "heading",
        { name: second.name },
      ),
    ).toBeVisible();
    expect(contents.querySelectorAll(".deck-tile")).toHaveLength(2);
    expect(
      within(contents).getByRole("heading", { name: deck.name }),
    ).toBeVisible();
    expect(
      within(contents).getByRole("heading", { name: second.name }),
    ).toBeVisible();
    fireEvent.click(
      within(contents).getByRole("button", { name: `Открыть ${deck.name}` }),
    );
    expect(location.hash).toBe(`#/deck/${deck.id}`);
  });
});
