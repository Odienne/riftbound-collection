create table if not exists public.user_collections (
  user_id uuid primary key references auth.users (id) on delete cascade,
  collection jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.user_collections enable row level security;

revoke all on public.user_collections from anon;
grant select, insert, update on public.user_collections to authenticated;

drop policy if exists "Users can read their own collection" on public.user_collections;
create policy "Users can read their own collection"
  on public.user_collections
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their own collection" on public.user_collections;
create policy "Users can create their own collection"
  on public.user_collections
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own collection" on public.user_collections;
create policy "Users can update their own collection"
  on public.user_collections
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
