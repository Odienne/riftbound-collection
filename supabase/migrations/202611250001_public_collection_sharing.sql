alter table public.user_collections
  add column if not exists share_id uuid not null default gen_random_uuid(),
  add column if not exists is_public boolean not null default false;

create unique index if not exists user_collections_share_id_key
  on public.user_collections (share_id);

create or replace function public.get_public_collection(p_share_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select collection
  from public.user_collections
  where share_id = p_share_id
    and is_public = true
  limit 1;
$$;

revoke all on function public.get_public_collection(uuid) from public;
grant execute on function public.get_public_collection(uuid) to anon, authenticated;
