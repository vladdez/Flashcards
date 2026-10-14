# Codex: migrate existing `vladdez/Flashcards` from OneDrive to Supabase

Repository: https://github.com/vladdez/Flashcards
Published site: https://vladdez.github.io/Flashcards/
Branch: create a feature branch, e.g. `feat/supabase-sync`, and open a pull request. Do not rewrite the application from scratch.

## Goal

Replace only the current OneDrive / Microsoft Graph / MSAL cloud authentication and synchronization layer with Supabase Auth + PostgreSQL synchronization. Keep existing React + TypeScript + Vite, Dexie/IndexedDB, `ts-fsrs`, offline/PWA, importing CSV/XLSX, bilingual directions, examples, folder organization, streaks, styling, and all local user data. Preserve GitHub Pages path `/Flashcards/`.

## Existing architecture — inspect first

- `README.md` describes the existing implementation, and `CODEX_SPEC.md` is an older OneDrive specification; **do not use it as the authority for cloud architecture**.
- `src/core/model.ts`, `src/core/db.ts`, `src/core/merge.ts`, `src/core/study.ts`, `src/core/import.ts`, `src/core/backup.ts` implement models, durable operations, conflict resolution, FSRS, import and backups.
- `src/sync/` implements the Microsoft Entra/MSAL and Microsoft Graph transport; replace/adapt its transport/auth code while preserving stable operation identifiers and merge semantics.
- `.github/workflows/deploy.yml` deploys to Pages; preserve existing checks, and substitute Supabase build-time config for OneDrive config.
- Old cloud sync used immutable operation batches `fc1-<UUID>.json` and a durable IndexedDB operation journal. Do **not** replace this with a naive last-write-wins upload of the full state.
- Existing FSRS 5.4.2 review logs/replay need backward compatibility: never silently change how old logs are interpreted or reset them.

## Tasks

1. **Analyze and protect data.** Create a working branch. Inspect the codebase, current Dexie schema, operations, and backup compatibility. Preserve every existing locally stored folder/deck/card/review log. Before enabling a new cloud account, offer a full downloadable JSON backup. No destructive IndexedDB reset or silent clearing of existing local storage.

2. **Configure Supabase client.** Add `@supabase/supabase-js`. Support `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`, with `.env.example` and GitHub Actions Variables. Use the existing Supabase project (URL `https://lwcmazbqwbhfumjbbzcj.supabase.co`); DO NOT hard-code credentials in source or commit a private env file. A publishable key is public and permitted in a Vite frontend, but NEVER use `service_role`, secret key, database password, or private tokens in client code. Offline-only mode must work if cloud configuration is absent.

3. **Auth.** Replace Entra/MSAL sign-in/redirect handling with Supabase Auth email magic-link or OTP. Support email sign-in, session restoration/refresh, sign-out, understandable errors, a visible account/sync status and a clear choice to merge local data when signing in. Configure and document local and deployed redirect URLs; deployed app is `https://vladdez.github.io/Flashcards/`.

4. **Postgres schema with RLS.** Create versioned `supabase/migrations/*.sql`. Model per-user folders, decks, cards, per-direction FSRS schedule, immutable review logs, user settings, change operations/sync cursors or another carefully documented equivalent. Give every user-owned row a non-null `owner_id` related to `auth.uid()`. Enforce RLS policies for SELECT/INSERT/UPDATE/DELETE, including `WITH CHECK` for writes and referential integrity/ownership across parent-child rows. Do not expose private data to anonymous users or allow them to see another user's data. Ensure unique review-log/operation IDs for idempotency. Ensure Data API grants are explicit if auto-expose is disabled.

5. **Local-first sync with conflict safety.** Local changes and reviews commit to IndexedDB first and enqueue durable operations. Synced operation IDs must be stable, retries idempotent, and no review logs discarded or duplicated. Pull and merge remote edits when signing in, when online, when tab becomes active and after local changes; don't guarantee background sync when an iOS PWA is closed. Preserve conflict-resolution UI for concurrent text edits and tombstones for deletions. Don't regress multi-device/offline merging. Avoid storing OAuth access tokens in export/backup.

6. **Migration and old OneDrive data.** Leave existing local IndexedDB records intact. The initial Supabase sign-in must safely upload and merge those records (with explicit review and confirmation). If the user has existing operations only in OneDrive and not locally, do not claim they migrated; document the limitation and offer a separate import/backup pathway. Once local/cloud migration is tested, remove obsolete Graph/MSAL dependencies, UI copy, env variables and redirect bridge (`auth.html`) if no longer needed. Do not delete anything from the user's OneDrive account.

7. **UI + existing features.** Preserve all already implemented features: last studied deck highlighted, folders/nesting, custom flags, per-deck progress (`scheduled_days >=21` for active directions), independently scheduled forward/reverse review modes, 80 new words per day by default and configurable, always-visible italic examples on flip, quick editing, four pastel rating buttons, streaks, CSV/XLSX import with preview/duplicate user decision and editable decks. Fix any regressions found.

8. **GitHub Pages & tests.** Preserve GitHub Pages base `/Flashcards/`, deploy workflow and PWA service-worker scope. Set Actions Variables `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`; ensure they are injected at build time. Run `npm ci`, lint, typecheck, unit tests, build and Playwright e2e tests. Add meaningful Supabase RLS tests for two different users (read and write cross-user denied), auth/redirect tests, sync-offline-retry-idempotency/conflict tests. If access to a real Supabase project is unavailable, distinguish mocks from live integration tests; never claim to have verified live sync when it wasn't tested.

9. **Documentation and PR.** Update README and eliminate or mark obsolete OneDrive instructions. Update legacy `CODEX_SPEC.md` so future Codex sessions do not revert to OneDrive, and/or add an explicit migration decision record. Document migrations and project dashboard settings, exact redirect URL, deployment, rollback, and how to recover data. Open a pull request with a concise test report and a checklist of manual dashboard actions required.

## Acceptance criteria

- Existing local library remains visible and study/review works offline after upgrade.
- New email sign-in through Supabase works on both localhost and GitHub Pages.
- Edits and FSRS reviews sync safely between two signed-in devices, including offline concurrent work, without losing or doubling reviews.
- No other user's rows can be read or written by a signed-in user; anon does not expose private data.
- PWA still builds and deploys to `/Flashcards/`; core UI and imports work unchanged.
- No runtime dependency on OneDrive/Graph/MSAL remains; cloud data in users' OneDrive is not deleted automatically.

## Reference

- Supabase React: https://supabase.com/docs/guides/getting-started/quickstarts/reactjs
- Supabase Auth: https://supabase.com/docs/guides/auth/quickstarts/react
- Supabase RLS: https://supabase.com/docs/guides/database/postgres/row-level-security
- Redirects: https://supabase.com/docs/guides/auth/redirect-urls
