-- Лимит «nestings» — сохранённых раскроев: каждый материал заказа со своим раскроем — один раскрой (заказ из 6
-- материалов, раскроенный целиком, — 6 раскроев; сколько листов — не важно). Заказ можно завести, импортировать
-- в него всё и сохранить — раскрой сверх лимита не сохранится (а без сохранённого раскроя заказ не отправить и
-- не выгрузить). Лимит «orders» — по-прежнему сколько заказов в кабинете.
-- Заказы, заведённые раньше (до конца поднятого лимита / до смены общих лимитов), доделываются как были.
-- Выполнить один раз в Supabase → SQL Editor (можно повторно). После migration_limits_timer, _schedule и _groups.

-- прежний вариант этого файла (лимит на материал в деталях) — убрать
drop trigger if exists limit_detail_mat on public.order_details;
drop function if exists public.trg_limit_detail_mat();

-- сколько раскроев в заказе: считается один раз при записи раскроя
alter table public.orders add column if not exists nestings_n integer not null default 0;

create or replace function public.nestings_count(p text) returns integer
language plpgsql immutable as $$
declare j jsonb;
begin
  if p is null or btrim(p) = '' or btrim(p) = 'null' then return 0; end if;
  if strpos(p, '"multi"') = 0 then return 1; end if;
  begin
    j := p::jsonb;
    if coalesce((j ->> 'multi')::boolean, false) then return (select count(*) from jsonb_object_keys(coalesce(j -> 'byMat', '{}'::jsonb)))::integer; end if;
  exception when others then return 1;
  end;
  return 1;
end $$;

-- заполнить для уже сохранённых раскроев (до триггера — старое не проверяется; дата изменения заказов не трогается)
do $$
declare t boolean := exists (select 1 from pg_trigger where tgrelid = 'public.orders'::regclass and tgname = 'orders_updated_at');
begin
  if t then execute 'alter table public.orders disable trigger orders_updated_at'; end if;
  update public.orders set nestings_n = nestings_count(nesting_result::text) where nesting_result is not null and nestings_n = 0;
  if t then execute 'alter table public.orders enable trigger orders_updated_at'; end if;
end $$;

create or replace function public.usage_of(p_user uuid, p_key text) returns integer
language sql security definer set search_path = public stable as $$
  select case p_key
    when 'orders' then (select count(*) from orders where user_id = p_user)
    when 'nestings' then (select coalesce(sum(nestings_n), 0) from orders where user_id = p_user)
    when 'models' then (select count(*) from order_models m join orders o on o.id = m.order_id where o.user_id = p_user)
    when 'materials' then (select count(*) from material_textures where user_id = p_user and name not like '\_\_label\_\_%')
    when 'accepted' then (select count(*) from orders o join productions p on p.id = o.production_id
                          where p.owner_id = p_user and o.status in ('inwork', 'done') and o.prod_archived_at is null)
    when 'views3d' then (select count(*) from production_model_views v join orders o on o.id = v.order_id
                         where v.user_id = p_user and o.status <> 'done' and o.prod_archived_at is null)
    else 0 end::integer
$$;

-- запись раскроя: раскроев в заказе стало больше — проверить лимит
create or replace function public.trg_nestings() returns trigger
language plpgsql security definer set search_path = public as $$
declare lim integer; other integer; was integer := 0;
begin
  if tg_op = 'UPDATE' then
    if new.nesting_result is not distinct from old.nesting_result then return new; end if;
    was := old.nestings_n;
  end if;
  new.nestings_n := nestings_count(new.nesting_result::text);
  if new.nestings_n <= was or is_admin() then return new; end if;
  if new.split_of is not null and exists (select 1 from orders where id = new.split_of and user_id = new.user_id) then return new; end if;
  if tg_op = 'UPDATE' and old.created_at < limit_grace(new.user_id) then return new; end if;
  lim := limit_of(new.user_id, 'nestings');
  if lim is null then return new; end if;
  select coalesce(sum(nestings_n), 0) into other from orders where user_id = new.user_id and id <> new.id;
  if other + new.nestings_n > lim then
    raise exception 'LIMIT:nestings:%', lim using hint = 'Предел бесплатного использования';
  end if;
  return new;
end $$;

drop trigger if exists limit_nestings on public.orders;
create trigger limit_nestings before insert or update of nesting_result on public.orders
  for each row execute function public.trg_nestings();

-- 3D-модель части заказа, отправленного по материалам, — модель того же заказа, не новая
create or replace function public.trg_limit_models() returns trigger
language plpgsql security definer set search_path = public as $$
declare o record;
begin
  if exists (select 1 from order_models where order_id = new.order_id) then return new; end if;
  select user_id, created_at, split_of into o from orders where id = new.order_id;
  if o.split_of is not null and exists (select 1 from order_models where order_id = o.split_of) then return new; end if;
  if o.created_at < limit_grace(o.user_id) then return new; end if;
  perform check_limit(o.user_id, 'models');
  return new;
end $$;

-- мои лимиты — с раскроями
create or replace function public.my_limits() returns json
language plpgsql security definer set search_path = public stable as $$
declare k text; res jsonb := '{}'::jsonb; u record;
begin
  foreach k in array array['orders', 'nestings', 'models', 'materials', 'accepted', 'views3d', 'import_mats'] loop
    res := res || jsonb_build_object(k, jsonb_build_object('limit', limit_of(auth.uid(), k), 'used', usage_of(auth.uid(), k)));
  end loop;
  select * into u from user_limits where user_id = auth.uid() and (expires_at is null or expires_at > now()) and (unlimited or limits <> '{}'::jsonb);
  return json_build_object('limits', res, 'master', is_admin(),
    'unlimited', coalesce(u.unlimited, false), 'until', u.expires_at);
end $$;


create or replace function public.admin_limits() returns json
language plpgsql security definer set search_path = public stable as $$
declare n jsonb := (select value from app_config where key = 'limits_next');
  np jsonb := (select value from app_config where key = 'limits_prod_next');
begin
  if not is_admin() then raise exception 'not admin'; end if;
  return json_build_object(
    'defaults', eff_default_limits('client'),
    'next', case when n ? 'at' and (n ->> 'at')::timestamptz > now() then n else null end,
    'defaults_prod', eff_default_limits('prod'),
    'next_prod', case when np ? 'at' and (np ->> 'at')::timestamptz > now() then np else null end,
    'prod_own', exists (select 1 from app_config where key in ('limits_prod', 'limits_prod_next')),
    'users', coalesce((select json_agg(json_build_object('user_id', p.id, 'unlimited', coalesce(u.unlimited, false), 'limits', coalesce(u.limits, '{}'::jsonb),
        'expires_at', u.expires_at, 'expired', coalesce(u.expires_at <= now(), false), 'group', limits_group(p.id),
        'used', json_build_object('orders', usage_of(p.id, 'orders'), 'nestings', usage_of(p.id, 'nestings'), 'models', usage_of(p.id, 'models'), 'materials', usage_of(p.id, 'materials'), 'accepted', usage_of(p.id, 'accepted'), 'views3d', usage_of(p.id, 'views3d'))))
      from profiles p left join user_limits u on u.user_id = p.id), '[]'::json));
end $$;

revoke all on function public.nestings_count(text) from public, anon;
notify pgrst, 'reload schema';
