-- Бета-тест новых функций (первая — «Пильный центр»). Выполнить один раз в Supabase → SQL Editor.
--
-- Мастер-аккаунт сам выбирает, кто тестирует: в «Пользователях» у карточки переключатель «β Пильный центр».
-- Мастер-аккаунт видит все бета-функции всегда. Остальные — только включённые ему.
-- Таблица читается только через функции ниже (RLS включён, политик нет).

create table if not exists public.beta_testers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  features text[] not null default '{}',
  updated_at timestamptz default now()
);
alter table public.beta_testers enable row level security;

-- Заказ раскраивается под пильный центр (способ резки остаётся 'guillotine' — сквозные резы)
alter table public.orders add column if not exists beam_saw boolean not null default false;

-- мои бета-функции; мастер-аккаунт — все
create or replace function public.my_beta() returns text[]
language plpgsql security definer set search_path = public stable as $$
begin
  if is_admin() then return array['beam_saw']; end if;
  return coalesce((select features from beta_testers where user_id = auth.uid()), '{}');
end $$;

-- мастер: кто что тестирует -> [{ user_id, features }]
create or replace function public.admin_beta() returns json
language plpgsql security definer set search_path = public stable as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  return coalesce((select json_agg(json_build_object('user_id', user_id, 'features', features)) from beta_testers where cardinality(features) > 0), '[]'::json);
end $$;

-- мастер: включить / выключить бета-функцию пользователю
create or replace function public.admin_set_beta(p_user uuid, p_feature text, p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  insert into beta_testers (user_id, features, updated_at)
    values (p_user, case when p_on then array[p_feature] else '{}' end, now())
  on conflict (user_id) do update set
    features = case when p_on then (select array_agg(distinct f) from unnest(beta_testers.features || p_feature) f)
                    else array_remove(beta_testers.features, p_feature) end,
    updated_at = now();
end $$;

revoke all on function public.my_beta(), public.admin_beta(), public.admin_set_beta(uuid, text, boolean) from public, anon;
grant execute on function public.my_beta(), public.admin_beta(), public.admin_set_beta(uuid, text, boolean) to authenticated;
