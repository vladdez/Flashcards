# Codex: migrate existing `vladdez/Flashcards` from OneDrive to Supabase

**Scope clarification, 2026-10-14:** there are no real user cards, decks, or FSRS reviews in the previous cloud. Do not implement OneDrive import, cloud-history migration, or preservation of old cloud files. Preserve the existing application's functionality and future FSRS correctness. This clarification replaces the former legacy-data migration requirements.

Repository: https://github.com/vladdez/Flashcards
Published site: https://vladdez.github.io/Flashcards/
Branch: create a feature branch, e.g. `feat/supabase-sync`, and open a pull request. Do not rewrite the application from scratch.

## Goal

Replace only the current OneDrive / Microsoft Graph / MSAL cloud authentication and synchronization layer with Supabase Auth + PostgreSQL synchronization. Keep existing React + TypeScript + Vite, Dexie/IndexedDB, `ts-fsrs`, offline/PWA, importing CSV/XLSX, bilingual directions, examples, folder organization, streaks, styling, and all local user data. Preserve GitHub Pages path `/Flashcards/`.

## Existing architecture — inspect first

- `README.md` describes the existing implementation; `CODEX_SPEC.md` retains product requirements and now specifies Supabase.
- `src/core/model.ts`, `src/core/db.ts`, `src/core/merge.ts`, `src/core/study.ts`, `src/core/import.ts`, `src/core/backup.ts` implement models, durable operations, conflict resolution, FSRS, import and backups.
- `src/sync/` now implements Supabase Auth and RPC transport; do not recreate the application or rewrite this working layer unnecessarily.
- `.github/workflows/deploy.yml` deploys to Pages; preserve existing checks, and substitute Supabase build-time config for OneDrive config.
- Keep the durable IndexedDB operation journal. Do **not** replace safe synchronization with a last-write-wins upload of the full state.
- Keep FSRS 5.4.2 replay deterministic and directions independent for future users; the algorithm does not need a historical-data conversion.

## Tasks

1. **Analyze and protect data.** Create a working branch. Inspect the codebase, current Dexie schema, operations, and backup compatibility. Preserve every existing locally stored folder/deck/card/review log. Before enabling a new cloud account, offer a full downloadable JSON backup. No destructive IndexedDB reset or silent clearing of existing local storage.

2. **Configure Supabase client.** Add `@supabase/supabase-js`. Support `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`, with `.env.example` and GitHub Actions Variables. Use the existing Supabase project (URL `https://lwcmazbqwbhfumjbbzcj.supabase.co`); DO NOT hard-code credentials in source or commit a private env file. A publishable key is public and permitted in a Vite frontend, but NEVER use `service_role`, secret key, database password, or private tokens in client code. Offline-only mode must work if cloud configuration is absent.

3. **Auth.** Replace Entra/MSAL sign-in/redirect handling with Supabase Auth email magic-link or OTP. Support email sign-in, session restoration/refresh, sign-out, understandable errors, a visible account/sync status and a clear choice to merge local data when signing in. Configure and document local and deployed redirect URLs; deployed app is `https://vladdez.github.io/Flashcards/`.

4. **Postgres schema with RLS.** Create versioned `supabase/migrations/*.sql`. Model per-user folders, decks, cards, per-direction FSRS schedule, immutable review logs, user settings, change operations/sync cursors or another carefully documented equivalent. Give every user-owned row a non-null `owner_id` related to `auth.uid()`. Enforce RLS policies for SELECT/INSERT/UPDATE/DELETE, including `WITH CHECK` for writes and referential integrity/ownership across parent-child rows. Do not expose private data to anonymous users or allow them to see another user's data. Ensure unique review-log/operation IDs for idempotency. Ensure Data API grants are explicit if auto-expose is disabled.

5. **Local-first sync with conflict safety.** Local changes and reviews commit to IndexedDB first and enqueue durable operations. Synced operation IDs must be stable, retries idempotent, and no review logs discarded or duplicated. Pull and merge remote edits when signing in, when online, when tab becomes active and after local changes; don't guarantee background sync when an iOS PWA is closed. Preserve conflict-resolution UI for concurrent text edits and tombstones for deletions. Don't regress multi-device/offline merging. Avoid storing OAuth access tokens in export/backup.

6. **Remove the retired integration.** Remove obsolete Graph/MSAL dependencies, UI, environment variables, redirect bridge and unused file-batch cache. There is no OneDrive data import or export pathway to implement. Keep IndexedDB, the operation journal, backups and safe account binding for new local libraries. Published browser database schemas may still need a small version upgrade to remove obsolete metadata; this is not a user-history migration.

7. **UI + existing features.** Preserve all already implemented features: last studied deck highlighted, folders/nesting, custom flags, per-deck progress (`scheduled_days >=21` for active directions), independently scheduled forward/reverse review modes, 80 new words per day by default and configurable, always-visible italic examples on flip, quick editing, four pastel rating buttons, streaks, CSV/XLSX import with preview/duplicate user decision and editable decks. Fix any regressions found.

8. **GitHub Pages & tests.** Preserve GitHub Pages base `/Flashcards/`, deploy workflow and PWA service-worker scope. Set Actions Variables `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`; ensure they are injected at build time. Run `npm ci`, lint, typecheck, unit tests, build and Playwright e2e tests. Add meaningful Supabase RLS tests for two different users (read and write cross-user denied), auth/redirect tests, sync-offline-retry-idempotency/conflict tests. If access to a real Supabase project is unavailable, distinguish mocks from live integration tests; never claim to have verified live sync when it wasn't tested.

9. **Documentation and PR.** Remove obsolete setup/transfer instructions. Document SQL installation, Auth settings, exact redirects, deployment and safe rollback. If no Supabase administrative tool is available, provide the committed SQL and a complete SQL Editor guide without blocking delivery on access. Open a new pull request with test results and clearly list remaining dashboard actions; do not automatically merge it.

## Acceptance criteria

- Existing local library remains visible and study/review works offline after upgrade.
- New email sign-in through Supabase works on both localhost and GitHub Pages.
- Edits and FSRS reviews sync safely between two signed-in devices, including offline concurrent work, without losing or doubling reviews.
- No other user's rows can be read or written by a signed-in user; anon does not expose private data.
- PWA still builds and deploys to `/Flashcards/`; core UI and imports work unchanged.
- No runtime dependency on OneDrive/Graph/MSAL remains. No mechanism for migrating old cloud data is developed.

## Reference

- Supabase React: https://supabase.com/docs/guides/getting-started/quickstarts/reactjs
- Supabase Auth: https://supabase.com/docs/guides/auth/quickstarts/react
- Supabase RLS: https://supabase.com/docs/guides/database/postgres/row-level-security
- Redirects: https://supabase.com/docs/guides/auth/redirect-urls
