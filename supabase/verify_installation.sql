-- Run after migrations/202610130001_supabase_sync.sql in Supabase SQL Editor.
-- Read-only installation checks: no users, cards, or review events are created.
-- This checks deployed objects/permissions, not email delivery or JWT handling.
do $$
declare
  object_name text;
  object_id oid;
  privilege_name text;
  role_name text;
  expected_definer boolean;
begin
  foreach object_name in array array[
    'flashcards_libraries','flashcards_entities','flashcards_operations',
    'flashcards_operation_parents','flashcards_entity_links',
    'flashcards_folders','flashcards_decks','flashcards_cards',
    'flashcards_user_settings','flashcards_review_logs','flashcards_schedule_events'
  ] loop
    object_id := to_regclass('public.' || object_name);
    if object_id is null then
      raise exception 'Missing object: %. Apply the Flashcards SQL migration first.', object_name;
    end if;
    if not has_table_privilege('authenticated', object_id, 'SELECT') then
      raise exception 'Missing authenticated SELECT grant: %', object_name;
    end if;
    foreach privilege_name in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
      if has_table_privilege('anon', object_id, privilege_name) then
        raise exception 'Unexpected anon % grant: %', privilege_name, object_name;
      end if;
      if privilege_name <> 'SELECT' and has_table_privilege('authenticated', object_id, privilege_name) then
        raise exception 'Unexpected authenticated % grant: %', privilege_name, object_name;
      end if;
    end loop;
    if exists(select 1 from pg_class where oid = object_id and relkind = 'r') then
      if not (select relrowsecurity from pg_class where oid = object_id) then
        raise exception 'RLS is disabled: %', object_name;
      end if;
      if (select count(*) from pg_policy where polrelid = object_id) <> 4
        or (select count(*) from pg_policy where polrelid = object_id and
          polname in ('owner_select','owner_insert','no_update','no_delete')) <> 4 then
        raise exception 'Missing or unexpected RLS policies: %', object_name;
      end if;
      if not exists(select 1 from pg_attribute where attrelid = object_id
        and attname = 'owner_id' and attnotnull and atttypid = 'uuid'::regtype) then
        raise exception 'Missing non-null owner_id UUID: %', object_name;
      end if;
      if not exists(select 1 from pg_constraint c join pg_attribute a
        on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
        where c.conrelid = object_id and c.contype = 'f'
          and c.confrelid = 'auth.users'::regclass and a.attname = 'owner_id') then
        raise exception 'Missing auth.users ownership foreign key: %', object_name;
      end if;
    elsif not exists(select 1 from pg_class where oid = object_id and relkind = 'v'
      and 'security_invoker=true' = any(reloptions)) then
      raise exception 'Expected a security-invoker view: %', object_name;
    end if;
  end loop;
  foreach object_name in array array[
    'flashcards_head()', 'flashcards_pull(bigint,bigint)',
    'flashcards_push(jsonb)', 'flashcards_validate_operation(jsonb)'
  ] loop
    object_id := to_regprocedure('public.' || object_name);
    if object_id is null then raise exception 'Missing function: %', object_name; end if;
    expected_definer := object_name = 'flashcards_push(jsonb)';
    if (select prosecdef from pg_proc where oid = object_id) <> expected_definer then
      raise exception 'Unexpected function security mode: %', object_name;
    end if;
    if not exists(select 1 from pg_proc where oid = object_id
      and 'search_path=""' = any(proconfig)) then
      raise exception 'Function search_path is not locked: %', object_name;
    end if;
    if has_function_privilege('anon', object_id, 'EXECUTE') then
      raise exception 'Unexpected anon EXECUTE grant: %', object_name;
    end if;
    if has_function_privilege('authenticated', object_id, 'EXECUTE')
      <> (object_name <> 'flashcards_validate_operation(jsonb)') then
      raise exception 'Unexpected authenticated EXECUTE grant: %', object_name;
    end if;
  end loop;
  foreach role_name in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname = role_name and (rolsuper or rolbypassrls)) then
      raise exception 'Role can bypass RLS: %', role_name;
    end if;
  end loop;
end $$;

select 'OK: Flashcards schema, RLS, views and grants are installed. Test email sign-in and two-device sync next.' as result;
