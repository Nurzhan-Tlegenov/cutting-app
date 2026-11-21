-- Лимит «orders» считает раскрои, а не заказы: каждый материал в заказе — отдельный раскрой (заказ из 6 материалов —
-- 6 раскроев). Иначе лимит обходится: всё в одну модель — и один «заказ». Сколько листов у материала — не важно.
-- Новый материал в заказ (импорт, ручной ввод, правка) не добавляется, если раскроев уже по лимиту.
-- Заказы, заведённые раньше (до конца поднятого лимита / до смены общих лимитов), доделываются как были.
-- Выполнить один раз в Supabase → SQL Editor (можно повторно). После migration_limits_timer.sql.

-- материал детали: из модели (contour.meta.material / thickness), иначе — материал заказа (как detailMatKey в приложении)
create or replace function public.detail_mat_key(p_contour text, p_name text, p_thick numeric) returns text
language plpgsql immutable as $$
declare j jsonb;
begin
  if p_contour is not null and strpos(p_contour, '"material"') > 0 then
    begin
      j := p_contour::jsonb -> 'meta';
      if coalesce(j ->> 'material', '') <> '' then return (j ->> 'material') || '|' || coalesce(j ->> 'thickness', ''); end if;
    exception when others then null;
    end;
  end if;
  return coalesce(p_name, '') || '|' || coalesce(p_thick::text, '');
end $$;

-- раскроев в заказе: сколько разных материалов (пустой заказ — 1)
create or replace function public.order_nestings(p_order uuid) returns integer
language sql security definer set search_path = public stable as $$
  select greatest(1, (select count(distinct detail_mat_key(d.contour, o.material_name, o.material_thickness))
    from order_details d join orders o on o.id = d.order_id where d.order_id = p_order))::integer
$$;

create or replace function public.usage_of(p_user uuid, p_key text) returns integer
language sql security definer set search_path = public stable as $$
  select case p_key
    when 'orders' then (select coalesce(sum(greatest(1, coalesce(m.n, 0))), 0) from orders o
                        left join (select d.order_id, count(distinct detail_mat_key(d.contour, o2.material_name, o2.material_thickness)) as n
                                   from order_details d join orders o2 on o2.id = d.order_id where o2.user_id = p_user group by d.order_id) m on m.order_id = o.id
                        where o.user_id = p_user)
    when 'models' then (select count(*) from order_models m join orders o on o.id = m.order_id where o.user_id = p_user)
    when 'materials' then (select count(*) from material_textures where user_id = p_user and name not like '\_\_label\_\_%')
    when 'accepted' then (select count(*) from orders o join productions p on p.id = o.production_id
                          where p.owner_id = p_user and o.status in ('inwork', 'done') and o.prod_archived_at is null)
    when 'views3d' then (select count(*) from production_model_views v join orders o on o.id = v.order_id
                         where v.user_id = p_user and o.status <> 'done' and o.prod_archived_at is null)
    else 0 end::integer
$$;

-- деталь с новым для заказа материалом = ещё один раскрой
create or replace function public.trg_limit_detail_mat() returns trigger
language plpgsql security definer set search_path = public as $$
declare o record; k text;
begin
  select id, user_id, created_at, split_of, material_name, material_thickness into o from orders where id = new.order_id;
  if not found or is_admin() then return new; end if;
  k := detail_mat_key(new.contour, o.material_name, o.material_thickness);
  -- в заказе ещё нет деталей (или только эта) — материал не добавляет раскроя: пустой заказ и так считается
  if not exists (select 1 from order_details d where d.order_id = new.order_id and d.id <> new.id) then return new; end if;
  if exists (select 1 from order_details d where d.order_id = new.order_id and d.id <> new.id
             and detail_mat_key(d.contour, o.material_name, o.material_thickness) = k) then return new; end if;
  if o.created_at < limit_grace(o.user_id) then return new; end if;
  perform check_limit(o.user_id, 'orders');
  return new;
end $$;

drop trigger if exists limit_detail_mat on public.order_details;
create trigger limit_detail_mat before insert or update of contour on public.order_details
  for each row execute function public.trg_limit_detail_mat();

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

revoke all on function public.detail_mat_key(text, text, numeric), public.order_nestings(uuid) from public, anon;
grant execute on function public.order_nestings(uuid) to authenticated;
notify pgrst, 'reload schema';
