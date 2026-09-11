-- Shared Verastar / PaperTrellis contract. Apply ONCE to their shared database.
-- Existing rows are retained; direct old-client paper writes fail closed.
begin;
create schema if not exists private;
create table if not exists private.library_paper_tombstones (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  deleted_at timestamptz not null default now(),
  primary key (user_id, key)
);
alter table private.library_paper_tombstones enable row level security;
revoke all on private.library_paper_tombstones from public, anon, authenticated;

create or replace function private.guard_library_paper_writes()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('anon', 'authenticated') and
     ((tg_op <> 'INSERT' and old.collection = 'papers') or
      (tg_op <> 'DELETE' and new.collection = 'papers')) then
    raise exception using errcode = '42501', message = 'Library storage upgraded. Reload this app before saving changes.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function private.guard_library_paper_writes() from public, anon, authenticated;
drop trigger if exists guard_library_paper_writes on public.kv;
create trigger guard_library_paper_writes before insert or update or delete on public.kv
  for each row execute function private.guard_library_paper_writes();
revoke truncate on public.kv from public, anon, authenticated;
-- Fresh installs cannot rely on historical public-schema default privileges.
-- Existing owner RLS and the paper-write guard still apply to these grants.
grant select, insert, update, delete on public.kv to authenticated;

create or replace function public.mutate_library_paper(
  p_user_id uuid, p_key text, p_action text,
  p_value jsonb default '{}'::jsonb, p_expected jsonb default '{}'::jsonb,
  p_fields text[] default '{}'::text[]
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_current jsonb;
  v_next jsonb;
  v_field text;
  v_entry jsonb;
  v_projects jsonb;
begin
  if v_user is null or p_user_id is distinct from v_user then
    raise exception using errcode='42501', message='Library account does not match authenticated caller.';
  end if;
  -- Serialize mutations, deletes, clear and migration within one personal library.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text, 91311));
  if p_action = 'clear' then
    insert into private.library_paper_tombstones(user_id,key)
      select v_user,key from public.kv where user_id=v_user and collection='papers'
      on conflict do nothing;
    delete from public.kv where user_id=v_user and collection='papers';
    return jsonb_build_object('status','cleared');
  end if;
  if p_key is null or p_key = '' then raise exception 'Paper key is required'; end if;
  select value into v_current from public.kv where user_id=v_user and collection='papers' and key=p_key for update;
  if p_action = 'delete' then
    insert into private.library_paper_tombstones(user_id,key) values(v_user,p_key) on conflict do nothing;
    delete from public.kv where user_id=v_user and collection='papers' and key=p_key;
    return jsonb_build_object('status','removed');
  end if;
  if p_action = 'restore' and v_current is null then
    -- Explicit user Save, never background enrichment/sync/import.
    delete from private.library_paper_tombstones where user_id=v_user and key=p_key;
  end if;
  if exists(select 1 from private.library_paper_tombstones where user_id=v_user and key=p_key) then
    return jsonb_build_object('status','deleted');
  end if;
  if p_action in ('create','restore') then
    if v_current is not null then
      if (v_current - '_libraryEpoch') = (p_value - '_libraryEpoch') then return jsonb_build_object('status','unchanged','value',v_current); end if;
      return jsonb_build_object('status','conflict');
    end if;
    v_next := p_value;
  elsif p_action = 'patch' then
    if v_current is null then return jsonb_build_object('status','deleted'); end if;
    if jsonb_typeof(p_value) <> 'object' or jsonb_typeof(p_expected) <> 'object' or p_fields is null then raise exception 'Invalid paper patch'; end if;
    if (v_current->'_libraryEpoch') is distinct from (p_expected->'_libraryEpoch') then
      return jsonb_build_object('status','deleted'); -- deleted and explicitly re-saved since read
    end if;
    if '_libraryEpoch' = any(p_fields) then raise exception 'Library generation is server owned'; end if;
    v_next := v_current;
    foreach v_field in array p_fields loop
      -- Retrying the exact successful patch is harmless. Otherwise same-field
      -- conflict is explicit; unrelated fields merge without a stale retry.
      if (v_current -> v_field) is distinct from (p_expected -> v_field)
         and (v_current -> v_field) is distinct from (p_value -> v_field) then
        return jsonb_build_object('status','conflict','field',v_field);
      end if;
      if p_value ? v_field then v_next := jsonb_set(v_next,array[v_field],p_value->v_field,true);
      else v_next := v_next - v_field; end if;
    end loop;
  elsif p_action = 'provenance' then
    v_entry := p_value->'project';
    if jsonb_typeof(v_entry) <> 'object' or coalesce(v_entry->>'id','') = '' then raise exception 'Project identity required'; end if;
    v_next := coalesce(v_current,p_value->'paper');
    v_projects := case when jsonb_typeof(v_next->'trellisProjects')='array' then v_next->'trellisProjects' else '[]'::jsonb end;
    if exists(select 1 from jsonb_array_elements(v_projects) e where e->>'id'=v_entry->>'id') then
      if v_current is not null then return jsonb_build_object('status','unchanged','value',v_current); end if;
    else v_next := jsonb_set(v_next,'{trellisProjects}',v_projects || jsonb_build_array(v_entry),true);
    end if;
  else raise exception 'Unknown library action';
  end if;
  if jsonb_typeof(v_next) <> 'object' or v_next->>'id' is distinct from p_key then raise exception 'Paper identity must equal its key'; end if;
  if v_current is null then v_next := jsonb_set(v_next,'{_libraryEpoch}',to_jsonb(pg_catalog.gen_random_uuid()::text),true); end if;
  insert into public.kv(user_id,collection,key,value,updated_at) values(v_user,'papers',p_key,v_next,clock_timestamp())
    on conflict(user_id,collection,key) do update set value=excluded.value,updated_at=excluded.updated_at;
  return jsonb_build_object('status',case when v_current is null then 'added' else 'linked' end,'value',v_next);
end;
$$;
revoke all on function public.mutate_library_paper(uuid,text,text,jsonb,jsonb,text[]) from public, anon;
grant execute on function public.mutate_library_paper(uuid,text,text,jsonb,jsonb,text[]) to authenticated;

-- Insert-only recovery. Never overwrite an account row, including seeded rows,
-- and never revive a paper removed during/after a previous partial import.
create or replace function public.import_library_batch(p_user_id uuid, p_rows jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_row jsonb; v_count integer := 0; v_changed integer;
begin
  if v_user is null or p_user_id is distinct from v_user then raise exception using errcode='42501',message='Migration account does not match authenticated caller.'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows)>200 then raise exception 'Expected at most 200 migration rows'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text,91311));
  for v_row in select * from jsonb_array_elements(p_rows) loop
    if v_row->>'user_id' is distinct from v_user::text or
      v_row->>'collection' not in ('profile','papers','digests','graphNodes','graphEdges','domains','seen','memos') or
      coalesce(v_row->>'key','') = '' or not (v_row ? 'value') or
      (v_row->>'collection'='profile' and v_row->>'key' in ('libraryHandle','migrationState')) then
      raise exception 'Invalid migration row';
    end if;
    if v_row->>'collection'='papers' then
      if v_row->'value'->>'id' is distinct from v_row->>'key' then raise exception 'Paper identity must equal its key'; end if;
      if exists(select 1 from private.library_paper_tombstones where user_id=v_user and key=v_row->>'key') then continue; end if;
    end if;
    insert into public.kv(user_id,collection,key,value,updated_at)
      values(v_user,v_row->>'collection',v_row->>'key',v_row->'value',clock_timestamp()) on conflict do nothing;
    get diagnostics v_changed = row_count;
    v_count := v_count + v_changed;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.import_library_batch(uuid,jsonb) from public, anon;
grant execute on function public.import_library_batch(uuid,jsonb) to authenticated;
commit;
