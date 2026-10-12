import { z } from "zod";
import type { Card as FSRSCard } from "ts-fsrs";

export const SCHEMA_VERSION = 1;
const uuid = z.uuid();
const iso = z.iso.datetime();
const text = z.string().max(20000);
const required = text.trim().min(1);
const base = {
  id: uuid,
  createdAt: iso,
  updatedAt: iso,
  deletedAt: iso.nullable().optional(),
};
export const folderSchema = z.object({
  ...base,
  parentId: uuid.nullable(),
  name: required,
  icon: text.optional(),
  sortOrder: z.number().finite(),
});
export const deckSchema = z.object({
  ...base,
  folderId: uuid.nullable(),
  name: required,
  languageCode: text,
  flagEmoji: required,
  flagIsManuallySet: z.boolean(),
  studyMode: z.enum(["forward", "reverse", "both"]),
  newWordsPerDay: z.number().int().min(0).max(10000),
});
export const cardSchema = z.object({
  ...base,
  deckId: uuid,
  front: required,
  back: required,
  examples: z.array(text).max(100),
  notes: text,
  tags: z.array(text).max(100),
});
export const settingsSchema = z.object({
  id: z.literal("settings"),
  retention: z.number().min(0.7).max(0.99),
  theme: z.enum(["system", "light", "dark"]),
  timeZone: z.string().refine((v) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: v });
      return true;
    } catch {
      return false;
    }
  }),
});
export const reviewSchema = z.object({
  id: uuid,
  cardId: uuid,
  deckId: uuid,
  direction: z.enum(["forward", "reverse"]),
  rating: z.number().int().min(1).max(4),
  reviewedAt: iso,
  deviceId: uuid,
  retention: z.number().min(0.7).max(0.99),
  schedulerVersion: z.literal("5"),
  kind: z.enum(["answer", "reset"]),
});
const envelope = {
  id: uuid,
  schemaVersion: z.literal(1),
  deviceId: uuid,
  timestamp: iso,
  parents: z.array(uuid).max(10000),
};
export const operationSchema = z.discriminatedUnion("entity", [
  z.object({
    ...envelope,
    entity: z.literal("folder"),
    entityId: uuid,
    patch: folderSchema.partial().omit({ id: true }),
  }),
  z.object({
    ...envelope,
    entity: z.literal("deck"),
    entityId: uuid,
    patch: deckSchema.partial().omit({ id: true }),
  }),
  z.object({
    ...envelope,
    entity: z.literal("card"),
    entityId: uuid,
    patch: cardSchema.partial().omit({ id: true }),
  }),
  z.object({
    ...envelope,
    entity: z.literal("settings"),
    entityId: z.literal("settings"),
    patch: settingsSchema.partial().omit({ id: true }),
  }),
  z.object({
    ...envelope,
    entity: z.literal("review"),
    entityId: uuid,
    patch: reviewSchema,
  }),
]);
export type Folder = z.infer<typeof folderSchema>;
export type Deck = z.infer<typeof deckSchema> & { lastStudiedAt?: string };
export type Card = z.infer<typeof cardSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export type Review = z.infer<typeof reviewSchema>;
export type Operation = z.infer<typeof operationSchema>;
export type Entity = Operation["entity"];
export type Direction = "forward" | "reverse";
export type SerializedFSRS = Omit<FSRSCard, "due" | "last_review"> & {
  due: string;
  last_review?: string;
};
export type Schedule = {
  id: string;
  cardId: string;
  direction: Direction;
  fsrs: SerializedFSRS;
};
export type Conflict = {
  id: string;
  entity: Exclude<Entity, "review">;
  entityId: string;
  field: string;
  values: {
    operationId: string;
    deviceId: string;
    timestamp: string;
    value: unknown;
  }[];
};
export type Snapshot = {
  folders: Folder[];
  decks: Deck[];
  cards: Card[];
  reviews: Review[];
  schedules: Schedule[];
  settings: Settings;
  conflicts: Conflict[];
};
export const defaultSettings: Settings = {
  id: "settings",
  retention: 0.9,
  theme: "system",
  timeZone: "UTC",
};
export const directions = (mode: Deck["studyMode"]): Direction[] =>
  mode === "both" ? ["forward", "reverse"] : [mode];
export const normalize = (value: string) =>
  value.normalize("NFC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("und");
export const uid = () => crypto.randomUUID();
export const nowISO = () => new Date().toISOString();
export const flags: Record<string, string> = {
  de: "🇩🇪",
  en: "🇬🇧",
  fr: "🇫🇷",
  es: "🇪🇸",
  it: "🇮🇹",
  ru: "🇷🇺",
  ja: "🇯🇵",
  zh: "🇨🇳",
  other: "🧠",
};
export function newDeck(name: string, folderId: string | null = null): Deck {
  const now = nowISO();
  return {
    id: uid(),
    name,
    folderId,
    languageCode: "de",
    flagEmoji: "🇩🇪",
    flagIsManuallySet: false,
    studyMode: "forward",
    newWordsPerDay: 80,
    createdAt: now,
    updatedAt: now,
  };
}
export function newCard(
  deckId: string,
  front = "",
  back = "",
  examples: string[] = [],
): Card {
  const now = nowISO();
  return {
    id: uid(),
    deckId,
    front,
    back,
    examples,
    notes: "",
    tags: [],
    createdAt: now,
    updatedAt: now,
  };
}
