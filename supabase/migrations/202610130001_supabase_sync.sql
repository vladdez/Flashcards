-- Additive, event-sourced storage. No existing tables/data are modified.
-- FSRS is replayed by the existing pinned ts-fsrs 5.4.2 client, never by SQL LWW.
begin;

create table public.flashcards_libraries (
  owner_id uuid primary key references auth.users(id),
  revision bigint not null default 0 check (revision >= 0 and revision <= 9007199254740991)
);
create table public.flashcards_entities (
  owner_id uuid not null references auth.users(id),
  entity text not null check (entity in ('folder','deck','card','settings','review')),
  entity_id text not null,
  primary key (owner_id, entity, entity_id)
);
create table public.flashcards_operations (
  owner_id uuid not null references auth.users(id),
  id uuid not null,
  revision bigint not null check (revision > 0),
  entity text not null,
  entity_id text not null,
  operation jsonb not null check (jsonb_typeof(operation) = 'object'),
  primary key (owner_id, id),
  unique (owner_id, revision),
  foreign key (owner_id, entity, entity_id)
    references public.flashcards_entities(owner_id, entity, entity_id),
  check (id::text = operation->>'id' and entity = operation->>'entity' and entity_id = operation->>'entityId')
);
create table public.flashcards_operation_parents (
  owner_id uuid not null references auth.users(id),
  operation_id uuid not null,
  parent_id uuid not null,
  primary key (owner_id, operation_id, parent_id),
  foreign key (owner_id, operation_id) references public.flashcards_operations(owner_id, id),
  foreign key (owner_id, parent_id) references public.flashcards_operations(owner_id, id),
  check (operation_id <> parent_id)
);
create table public.flashcards_entity_links (
  owner_id uuid not null references auth.users(id),
  operation_id uuid not null,
  field text not null check (field in ('parentId','folderId','deckId','cardId')),
  target_entity text not null,
  target_id text not null,
  primary key (owner_id, operation_id, field),
  foreign key (owner_id, operation_id) references public.flashcards_operations(owner_id, id),
  foreign key (owner_id, target_entity, target_id)
    references public.flashcards_entities(owner_id, entity, entity_id),
  check ((field in ('parentId','folderId') and target_entity = 'folder')
    or (field = 'deckId' and target_entity = 'deck')
    or (field = 'cardId' and target_entity = 'card'))
);
create index flashcards_operations_entity on public.flashcards_operations(owner_id, entity, entity_id);
create index flashcards_parents_target on public.flashcards_operation_parents(owner_id, parent_id);
create index flashcards_links_target on public.flashcards_entity_links(owner_id, target_entity, target_id);

-- Explicit permissions also work when automatic Data API grants are disabled.
-- SELECT is available through RLS. Mutation is only through the validated RPC.
-- UPDATE/DELETE are intentionally denied: edits and tombstones are new events.
do $$
declare t text;
begin
  foreach t in array array['flashcards_libraries','flashcards_entities','flashcards_operations','flashcards_operation_parents','flashcards_entity_links'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('create policy owner_select on public.%I for select to authenticated using ((select auth.uid()) = owner_id)', t);
    execute format('create policy owner_insert on public.%I for insert to authenticated with check ((select auth.uid()) = owner_id)', t);
    execute format('create policy no_update on public.%I for update to authenticated using (false) with check (false)', t);
    execute format('create policy no_delete on public.%I for delete to authenticated using (false)', t);
  end loop;
end $$;
grant usage on schema public to authenticated;

-- Typed, security-invoker views expose complete histories, including conflicts
-- and tombstones. They are deliberately not lossy "latest row" projections.
create view public.flashcards_folders with (security_invoker = true) as
  select owner_id, entity_id as id, jsonb_agg(operation order by revision) as history
  from public.flashcards_operations where entity = 'folder' group by owner_id, entity_id;
create view public.flashcards_decks with (security_invoker = true) as
  select owner_id, entity_id as id, jsonb_agg(operation order by revision) as history
  from public.flashcards_operations where entity = 'deck' group by owner_id, entity_id;
create view public.flashcards_cards with (security_invoker = true) as
  select owner_id, entity_id as id, jsonb_agg(operation order by revision) as history
  from public.flashcards_operations where entity = 'card' group by owner_id, entity_id;
create view public.flashcards_user_settings with (security_invoker = true) as
  select owner_id, entity_id as id, jsonb_agg(operation order by revision) as history
  from public.flashcards_operations where entity = 'settings' group by owner_id, entity_id;
create view public.flashcards_review_logs with (security_invoker = true) as
  select owner_id, id, operation->'patch' as review,
    operation->'patch'->>'cardId' as card_id,
    operation->'patch'->>'deckId' as deck_id,
    operation->'patch'->>'direction' as direction,
    (operation->'patch'->>'reviewedAt')::timestamptz as reviewed_at
  from public.flashcards_operations where entity = 'review';
create view public.flashcards_schedule_events with (security_invoker = true) as
  select owner_id, card_id, direction,
    jsonb_agg(review order by reviewed_at, id) as events
  from public.flashcards_review_logs group by owner_id, card_id, direction;
revoke all on public.flashcards_folders, public.flashcards_decks, public.flashcards_cards,
  public.flashcards_user_settings, public.flashcards_review_logs, public.flashcards_schedule_events
  from public, anon, authenticated;
grant select on public.flashcards_folders, public.flashcards_decks, public.flashcards_cards,
  public.flashcards_user_settings, public.flashcards_review_logs, public.flashcards_schedule_events to authenticated;

-- Validate the version-1 envelope and all supported patch fields. The client
-- independently validates the full causal graph and replays before committing.
create function public.flashcards_validate_operation(op jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare p jsonb; k text; v jsonb; e text; allowed text[];
begin
  if op is null or jsonb_typeof(op) <> 'object' or not (op ?& array['id','schemaVersion','deviceId','timestamp','parents','entity','entityId','patch'])
    or op - array['id','schemaVersion','deviceId','timestamp','parents','entity','entityId','patch'] <> '{}'::jsonb
    or op->'schemaVersion' <> '1'::jsonb then return false; end if;
  if jsonb_typeof(op->'id') <> 'string' or jsonb_typeof(op->'deviceId') <> 'string'
    or jsonb_typeof(op->'entity') <> 'string' or jsonb_typeof(op->'entityId') <> 'string'
    then return false; end if;
  if (op->>'id')::uuid::text <> op->>'id' or (op->>'deviceId')::uuid::text <> op->>'deviceId' then return false; end if;
  perform (op->>'timestamp')::timestamptz;
  if jsonb_typeof(op->'timestamp') <> 'string' or op->>'timestamp' !~ '^\d{4}-\d\d-\d\dT.*Z$'
    or jsonb_typeof(op->'parents') <> 'array' or jsonb_array_length(op->'parents') > 10000 then return false; end if;
  for v in select value from jsonb_array_elements(op->'parents') loop
    if jsonb_typeof(v) <> 'string' or (v #>> '{}')::uuid::text <> v #>> '{}' then return false; end if;
  end loop;
  e := op->>'entity'; p := op->'patch';
  if jsonb_typeof(p) <> 'object' then return false; end if;
  if e = 'settings' then
    if op->>'entityId' <> 'settings' then return false; end if;
    allowed := array['retention','theme','timeZone'];
  else
    if (op->>'entityId')::uuid::text <> op->>'entityId' then return false; end if;
    allowed := array['createdAt','updatedAt','deletedAt'];
    case e
      when 'folder' then allowed := allowed || array['parentId','name','icon','sortOrder'];
      when 'deck' then allowed := allowed || array['folderId','name','languageCode','flagEmoji','flagIsManuallySet','studyMode','newWordsPerDay'];
      when 'card' then allowed := allowed || array['deckId','front','back','examples','notes','tags'];
      when 'review' then
        allowed := array['id','cardId','deckId','direction','rating','reviewedAt','deviceId','retention','schedulerVersion','kind'];
        if not (p ?& allowed) or op->>'id' <> op->>'entityId' or p->>'id' <> op->>'id'
          or p->>'deviceId' <> op->>'deviceId' or op->'parents' <> '[]'::jsonb then return false; end if;
      else return false;
    end case;
  end if;
  if p - allowed <> '{}'::jsonb then return false; end if;
  for k,v in select key,value from jsonb_each(p) loop
    if k in ('createdAt','updatedAt','deletedAt','reviewedAt') then
      if k = 'deletedAt' and v = 'null'::jsonb then continue; end if;
      if jsonb_typeof(v) <> 'string' or v #>> '{}' !~ '^\d{4}-\d\d-\d\dT.*Z$' then return false; end if;
      perform (v #>> '{}')::timestamptz;
    elsif k in ('parentId','folderId','deckId','cardId','id','deviceId') then
      if k in ('parentId','folderId') and v = 'null'::jsonb then continue; end if;
      if jsonb_typeof(v) <> 'string' or (v #>> '{}')::uuid::text <> v #>> '{}' then return false; end if;
    elsif k in ('examples','tags') then
      if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > 100 then return false; end if;
      if exists(select 1 from jsonb_array_elements(v) x where jsonb_typeof(x) <> 'string' or length(x #>> '{}') > 20000) then return false; end if;
    elsif k = 'flagIsManuallySet' then
      if jsonb_typeof(v) <> 'boolean' then return false; end if;
    elsif k in ('retention','rating','newWordsPerDay','sortOrder') then
      if jsonb_typeof(v) <> 'number' then return false; end if;
      if k = 'retention' and ((v::text)::numeric < 0.7 or (v::text)::numeric > 0.99) then return false; end if;
      if k = 'rating' and v not in ('1'::jsonb,'2'::jsonb,'3'::jsonb,'4'::jsonb) then return false; end if;
      if k = 'newWordsPerDay' and ((v::text)::numeric < 0 or (v::text)::numeric > 10000 or trunc((v::text)::numeric) <> (v::text)::numeric) then return false; end if;
    else
      if jsonb_typeof(v) <> 'string' or length(v #>> '{}') > 20000 then return false; end if;
      if k in ('name','front','back','flagEmoji') and length(btrim(v #>> '{}')) = 0 then return false; end if;
      if k = 'studyMode' and v #>> '{}' not in ('forward','reverse','both') then return false; end if;
      if k = 'direction' and v #>> '{}' not in ('forward','reverse') then return false; end if;
      if k = 'theme' and v #>> '{}' not in ('system','light','dark') then return false; end if;
      if k = 'schedulerVersion' and v #>> '{}' <> '5' then return false; end if;
      if k = 'kind' and v #>> '{}' not in ('answer','reset') then return false; end if;
    end if;
  end loop;
  return true;
exception when others then return false;
end $$;
revoke all on function public.flashcards_validate_operation(jsonb) from public, anon, authenticated;

create function public.flashcards_push(incoming jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  who uuid := auth.uid(); rev bigint; op jsonb; existing jsonb;
  op_id uuid; e text; eid text; p jsonb; parent text; field text; kind text;
  required text[]; accepted jsonb := '[]'::jsonb;
begin
  if who is null then raise exception 'Sign in required' using errcode = '42501'; end if;
  if incoming is null or jsonb_typeof(incoming) <> 'array' or jsonb_array_length(incoming) > 100
    or octet_length(incoming::text) > 10485760 then raise exception 'Invalid batch'; end if;
  insert into public.flashcards_libraries(owner_id) values(who) on conflict do nothing;
  -- Lock BEFORE assigning revisions; per-owner ordering equals commit ordering.
  -- A plain bigserial/high-water cursor would miss transactions committing late.
  select revision into rev from public.flashcards_libraries where owner_id = who for update;
  for op in select value from jsonb_array_elements(incoming) loop
    if not public.flashcards_validate_operation(op) then raise exception 'Invalid version-1 operation'; end if;
    op_id := (op->>'id')::uuid; e := op->>'entity'; eid := op->>'entityId'; p := op->'patch';
    select operation into existing from public.flashcards_operations where owner_id = who and id = op_id;
    if found then
      if existing <> op then raise exception 'Operation ID collision: immutable content differs'; end if;
      accepted := accepted || jsonb_build_array(op_id); continue;
    end if;
    if not exists(select 1 from public.flashcards_entities where owner_id = who and entity = e and entity_id = eid) then
      required := case e
        when 'folder' then array['createdAt','updatedAt','parentId','name','sortOrder']
        when 'deck' then array['createdAt','updatedAt','folderId','name','languageCode','flagEmoji','flagIsManuallySet','studyMode','newWordsPerDay']
        when 'card' then array['createdAt','updatedAt','deckId','front','back','examples','notes','tags']
        else array[]::text[] end;
      if not (p ?& required) or op->'parents' <> '[]'::jsonb then raise exception 'Missing entity creation'; end if;
      insert into public.flashcards_entities(owner_id,entity,entity_id) values(who,e,eid);
    end if;
    rev := rev + 1;
    insert into public.flashcards_operations(owner_id,id,revision,entity,entity_id,operation) values(who,op_id,rev,e,eid,op);
    for parent in select jsonb_array_elements_text(op->'parents') loop
      if not exists(select 1 from public.flashcards_operations where owner_id = who and id = parent::uuid and entity = e and entity_id = eid and revision < rev)
        then raise exception 'Missing or foreign causal parent'; end if;
      insert into public.flashcards_operation_parents values(who,op_id,parent::uuid) on conflict do nothing;
    end loop;
    foreach field in array array['parentId','folderId','deckId','cardId'] loop
      if p ? field and p->field <> 'null'::jsonb then
        kind := case when field in ('parentId','folderId') then 'folder' when field = 'deckId' then 'deck' else 'card' end;
        insert into public.flashcards_entity_links values(who,op_id,field,kind,p->>field);
      end if;
    end loop;
    accepted := accepted || jsonb_build_array(op_id);
  end loop;
  update public.flashcards_libraries set revision = rev where owner_id = who;
  return accepted;
end $$;
revoke all on function public.flashcards_push(jsonb) from public, anon, authenticated;
grant execute on function public.flashcards_push(jsonb) to authenticated;

create function public.flashcards_head() returns bigint
language sql stable security invoker set search_path = '' as $$
  select coalesce((select revision from public.flashcards_libraries where owner_id = auth.uid()),0);
$$;
create function public.flashcards_pull(after_revision bigint, until_revision bigint)
returns table(revision bigint, operation jsonb)
language sql stable security invoker set search_path = '' as $$
  select revision, operation from public.flashcards_operations
  where owner_id = auth.uid() and revision > after_revision and revision <= until_revision
  order by revision limit 500;
$$;
revoke all on function public.flashcards_head(), public.flashcards_pull(bigint,bigint) from public, anon, authenticated;
grant execute on function public.flashcards_head(), public.flashcards_pull(bigint,bigint) to authenticated;

commit;
