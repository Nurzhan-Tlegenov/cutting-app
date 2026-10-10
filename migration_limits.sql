-- Лимиты бесплатного использования. Выполнить один раз в Supabase → SQL Editor.
--
-- Лимит — сколько чего может БЫТЬ у пользователя одновременно (не за период): лимит заказов 3 — в кабинете не больше
-- трёх заказов; удалил один — может завести ещё один.
--   orders    — заказов в кабинете клиента
--   models    — заказов с загруженной 3D-моделью
--   materials — загруженных материалов (текстур)
--   accepted  — принятых производством заказов (в работе и исполненных, не убранных в архив производства)
-- Пороги по умолчанию — app_config.limits (мастер-аккаунт), у отдельного пользователя — свои (user_limits):
-- «без ограничений» или свои числа. Число null у ключа — без лимита. На мастер-аккаунт лимиты не действуют.
-- Проверка — в базе (триггеры): из приложения её не обойти. Ошибка начинается с «LIMIT:ключ:порог».

create table if not exists public.user_limits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  unlimited boolean not null default false,
  limits jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now()
);
alter table public.user_limits enable row level security;   -- читается только через функции ниже
insert into public.app_config (key, value) values ('limits', '{}'::jsonb) on conflict (key) do nothing;

-- порог для пользователя: null — без лимита
create or replace function public.limit_of(p_user uuid, p_key text) returns integer
language plpgsql security definer set search_path = public stable as $$
declare u record; v jsonb;
begin
  if p_user is null or exists (select 1 from profiles where id = p_user and role = 'admin') then return null; end if;
  select * into u from user_limits where user_id = p_user;
  if found and u.unlimited then return null; end if;
  if found and u.limits ? p_key then v := u.limits -> p_key;
  else v := (select value -> p_key from app_config where key = 'limits'); end if;
  if v is null or jsonb_typeof(v) <> 'number' then return null; end if;
  return greatest(0, floor((v)::text::numeric))::integer;
end $$;

-- сколько уже есть
create or replace function public.usage_of(p_user uuid, p_key text) returns integer
language sql security definer set search_path = public stable as $$
  select case p_key
    when 'orders' then (select count(*) from orders where user_id = p_user)
    when 'models' then (select count(*) from order_models m join orders o on o.id = m.order_id where o.user_id = p_user)
    when 'materials' then (select count(*) from material_textures where user_id = p_user and name not like '\_\_label\_\_%')
    when 'accepted' then (select count(*) from orders o join productions p on p.id = o.production_id
                          where p.owner_id = p_user and o.status in ('inwork', 'done') and o.prod_archived_at is null)
    else 0 end::integer
$$;

-- мои лимиты: { ключ: { limit, used } }, master — мастер-аккаунт, unlimited — сняты все ограничения
create or replace function public.my_limits() returns json
language plpgsql security definer set search_path = public stable as $$
declare k text; res jsonb := '{}'::jsonb;
begin
  foreach k in array array['orders', 'models', 'materials', 'accepted'] loop
    res := res || jsonb_build_object(k, jsonb_build_object('limit', limit_of(auth.uid(), k), 'used', usage_of(auth.uid(), k)));
  end loop;
  return json_build_object('limits', res, 'master', is_admin(),
    'unlimited', coalesce((select unlimited from user_limits where user_id = auth.uid()), false));
end $$;

-- ── проверки ──
create or replace function public.check_limit(p_user uuid, p_key text) returns void
language plpgsql security definer set search_path = public as $$
declare lim integer;
begin
  lim := limit_of(p_user, p_key);
  if lim is not null and usage_of(p_user, p_key) >= lim then
    raise exception 'LIMIT:%:%', p_key, lim using hint = 'Предел бесплатного использования';
  end if;
end $$;

create or replace function public.trg_limit_orders() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform check_limit(new.user_id, 'orders');
  return new;
end $$;
drop trigger if exists limit_orders on public.orders;
create trigger limit_orders before insert on public.orders for each row execute function public.trg_limit_orders();

-- 3D-модель: замена модели того же заказа лимит не тратит
create or replace function public.trg_limit_models() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from order_models where order_id = new.order_id) then return new; end if;
  perform check_limit((select user_id from orders where id = new.order_id), 'models');
  return new;
end $$;
drop trigger if exists limit_models on public.order_models;
create trigger limit_models before insert on public.order_models for each row execute function public.trg_limit_models();

-- материалы: замена картинки того же материала лимит не тратит; картинки бирок не считаются
create or replace function public.trg_limit_materials() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.name like '\_\_label\_\_%' then return new; end if;
  if exists (select 1 from material_textures where user_id = new.user_id and name = new.name) then return new; end if;
  perform check_limit(new.user_id, 'materials');
  return new;
end $$;
drop trigger if exists limit_materials on public.material_textures;
create trigger limit_materials before insert on public.material_textures for each row execute function public.trg_limit_materials();

-- принять заказ в работу: лимит владельца производства (заказ видно, а принять нельзя)
create or replace function public.trg_limit_accept() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.production_id is not null and new.status in ('inwork', 'done') and coalesce(old.status, '') not in ('inwork', 'done') and not is_admin() then
    perform check_limit((select owner_id from productions where id = new.production_id), 'accepted');
  end if;
  return new;
end $$;
drop trigger if exists limit_accept on public.orders;
create trigger limit_accept before update of status on public.orders for each row execute function public.trg_limit_accept();

-- ── мастер-аккаунт ──
-- всё о лимитах: пороги по умолчанию, личные настройки и сколько у кого уже есть
create or replace function public.admin_limits() returns json
language plpgsql security definer set search_path = public stable as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  return json_build_object(
    'defaults', (select value from app_config where key = 'limits'),
    'users', coalesce((select json_agg(json_build_object('user_id', p.id, 'unlimited', coalesce(u.unlimited, false), 'limits', coalesce(u.limits, '{}'::jsonb),
        'used', json_build_object('orders', usage_of(p.id, 'orders'), 'models', usage_of(p.id, 'models'), 'materials', usage_of(p.id, 'materials'), 'accepted', usage_of(p.id, 'accepted'))))
      from profiles p left join user_limits u on u.user_id = p.id), '[]'::json));
end $$;

create or replace function public.admin_set_default_limits(p_limits jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  insert into app_config (key, value) values ('limits', coalesce(p_limits, '{}'::jsonb)) on conflict (key) do update set value = excluded.value;
end $$;

-- личные лимиты пользователя: p_unlimited — снять все; p_limits — свои пороги ({ключ: число | null}), пусто — как у всех
create or replace function public.admin_set_user_limits(p_user uuid, p_unlimited boolean, p_limits jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  insert into user_limits (user_id, unlimited, limits, updated_at) values (p_user, coalesce(p_unlimited, false), coalesce(p_limits, '{}'::jsonb), now())
  on conflict (user_id) do update set unlimited = excluded.unlimited, limits = excluded.limits, updated_at = now();
end $$;

revoke all on function public.limit_of(uuid, text), public.usage_of(uuid, text), public.check_limit(uuid, text) from public, anon, authenticated;
revoke all on function public.my_limits(), public.admin_limits(), public.admin_set_default_limits(jsonb), public.admin_set_user_limits(uuid, boolean, jsonb) from public, anon;
grant execute on function public.my_limits(), public.admin_limits(), public.admin_set_default_limits(jsonb), public.admin_set_user_limits(uuid, boolean, jsonb) to authenticated;
