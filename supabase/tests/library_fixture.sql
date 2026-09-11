create schema if not exists auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
grant usage on schema auth to authenticated,anon;
grant execute on function auth.uid() to authenticated,anon;
create table public.kv(user_id uuid not null references auth.users(id),collection text not null,key text not null,value jsonb not null,updated_at timestamptz default now(),primary key(user_id,collection,key));
alter table public.kv enable row level security;
create policy own on public.kv for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
grant select,insert,update,delete,truncate on public.kv to authenticated;
