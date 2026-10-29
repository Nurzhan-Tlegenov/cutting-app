-- Склад остатков: остаток в резерве за заказом списывается, как только выпустили программы ЧПУ (или пройден пост
-- раскроя / заказ исполнен). Остаток в резерве нельзя перерезать, списать вручную, поменять размер или удалить.
-- Выполнить один раз в Supabase → SQL Editor (можно повторно). После migration_remnants_nesting.sql.

alter table public.remnants add column if not exists reserved_title text;   -- за каким заказом (номер / название) — видно на складе

create or replace function public.stock_reserve(p_order uuid, p_items jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare o record; x jsonb; r remnants; n remnants; q integer; busy bigint[] := '{}'; ids bigint[] := '{}'; cl boolean;
begin
  select * into o from orders where id = p_order;
  if not found then raise exception 'stock: not found'; end if;
  if not (o.user_id = auth.uid() or is_my_production(o.production_id)) then raise exception 'not allowed'; end if;
  -- снять прежний резерв заказа
  for r in select * from remnants where reserved_order = p_order and status = 'reserved' for update loop
    update remnants set status = 'free', reserved_order = null, reserved_title = null, updated_at = now() where id = r.id;
    perform stock_log(r.id, r.production_id, 'release', jsonb_build_object('order', coalesce(nullif(o.order_name, ''), o.order_number)), null, r.qty, 'раскрой заказа пересчитан');
  end loop;
  for x in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    select * into r from remnants where id = (x ->> 'id')::bigint for update;
    if not found then busy := busy || (x ->> 'id')::bigint; continue; end if;
    select coalesce((stock_settings ->> 'clients')::boolean, false) into cl from productions where id = r.production_id;
    if stock_access(r.production_id) is null and not (cl and r.production_id = o.production_id) then raise exception 'not allowed'; end if;
    if r.status <> 'free' then busy := busy || r.id; continue; end if;
    q := least(greatest(1, coalesce((x ->> 'qty')::integer, 1)), r.qty);
    if q < r.qty then
      update remnants set qty = qty - q, updated_at = now() where id = r.id;
      insert into remnants (production_id, length, width, qty, material, thickness, cell, note, status, reserved_order, reserved_title, label_at, source, source_order, created_by)
        values (r.production_id, r.length, r.width, q, r.material, r.thickness, r.cell, r.note, 'reserved', p_order, coalesce(nullif(o.order_name, ''), o.order_number), r.label_at, r.source, r.source_order, auth.uid()) returning * into n;
      perform stock_log(r.id, r.production_id, 'reserve', jsonb_build_object('qty', r.qty), jsonb_build_object('qty', r.qty - q, 'to', n.id), q, null);
      perform stock_log(n.id, r.production_id, 'reserve', jsonb_build_object('from', r.id), jsonb_build_object('order', coalesce(nullif(o.order_name, ''), o.order_number)), q, null);
      ids := ids || n.id;
    else
      update remnants set status = 'reserved', reserved_order = p_order, reserved_title = coalesce(nullif(o.order_name, ''), o.order_number), updated_at = now() where id = r.id;
      perform stock_log(r.id, r.production_id, 'reserve', null, jsonb_build_object('order', coalesce(nullif(o.order_name, ''), o.order_number)), r.qty, null);
      ids := ids || r.id;
    end if;
  end loop;
  if array_length(busy, 1) > 0 then raise exception 'stock: busy %', array_to_string(busy, ','); end if;
  return to_json(ids);
end $$;

-- списать резерв заказа «в заказ» (внутренняя)
create or replace function public.stock_use_reserved(p_order uuid, p_reason text) returns integer
language plpgsql security definer set search_path = public as $$
declare r remnants; n integer := 0;
begin
  for r in select * from remnants where reserved_order = p_order and status = 'reserved' for update loop
    update remnants set status = 'used', used_kind = 'order', used_at = now(), updated_at = now() where id = r.id;
    perform stock_log(r.id, r.production_id, 'writeoff', jsonb_build_object('status', 'reserved'), jsonb_build_object('status', 'used', 'kind', 'order', 'order', r.reserved_title), r.qty, p_reason);
    n := n + 1;
  end loop;
  return n;
end $$;

-- выпустили программы ЧПУ — остатки из резерва заказа ушли в работу
create or replace function public.stock_use_order(p_order uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare o record;
begin
  select * into o from orders where id = p_order;
  if not found then return 0; end if;
  if not (o.user_id = auth.uid() or is_my_production(o.production_id) or can_work_order(p_order, 'cnc')) then raise exception 'not allowed'; end if;
  return stock_use_reserved(p_order, 'выпущены программы ЧПУ');
end $$;

-- заказ удалён — резерв снимается; заказ исполнен — списание
create or replace function public.stock_order_trg() returns trigger
language plpgsql security definer set search_path = public as $$
declare r remnants;
begin
  if tg_op = 'DELETE' then
    for r in select * from remnants where reserved_order = old.id and status = 'reserved' loop
      update remnants set status = 'free', reserved_order = null, reserved_title = null, updated_at = now() where id = r.id;
      perform stock_log(r.id, r.production_id, 'release', jsonb_build_object('order', r.reserved_title), null, r.qty, 'заказ удалён');
    end loop;
    return old;
  end if;
  if new.status = 'done' and old.status is distinct from 'done' then perform stock_use_reserved(new.id, 'заказ исполнен'); end if;
  return new;
end $$;

-- пост раскроя в техпроцессе выполнен (название поста: раскрой / распил / пила / ЧПУ) — списание
create or replace function public.stock_stage_trg() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'done' and old.status is distinct from 'done' and new.name ~* '(раскро|распил|пил[аы]|чпу|cnc|фрез)' then
    perform stock_use_reserved(new.order_id, 'пройден пост «' || new.name || '»');
  end if;
  return new;
end $$;
drop trigger if exists stock_stage_done on public.order_stages;
create trigger stock_stage_done after update of status on public.order_stages for each row execute function public.stock_stage_trg();

-- в резерве — нельзя списать вручную, поменять размер, удалить
create or replace function public.stock_writeoff(p_id bigint, p_qty integer, p_kind text, p_reason text) returns bigint
language plpgsql security definer set search_path = public as $$
declare r remnants; n remnants; q integer;
begin
  r := stock_row_for_edit(p_id);
  if r.status = 'used' then raise exception 'stock: already used'; end if;
  if r.status = 'reserved' then raise exception 'stock: reserved'; end if;      -- остаток пойдёт в раскрой заказа — трогать нельзя
  if coalesce(p_kind, '') not in ('order', 'defect', 'claim', 'other') then raise exception 'stock: bad kind'; end if;
  perform stock_need_reason(r.production_id, p_reason);
  q := least(greatest(1, coalesce(p_qty, r.qty)), r.qty);
  if q < r.qty then
    update remnants set qty = qty - q, updated_at = now() where id = p_id;
    insert into remnants (production_id, length, width, qty, material, thickness, cell, note, status, used_kind, used_at, label_at, source, created_by)
      values (r.production_id, r.length, r.width, q, r.material, r.thickness, r.cell, r.note, 'used', p_kind, now(), r.label_at, r.source, auth.uid()) returning * into n;
    perform stock_log(p_id, r.production_id, 'writeoff', jsonb_build_object('qty', r.qty), jsonb_build_object('qty', r.qty - q, 'kind', p_kind, 'to', n.id), q, p_reason);
    perform stock_log(n.id, r.production_id, 'writeoff', jsonb_build_object('from', p_id), jsonb_build_object('kind', p_kind), q, p_reason);
    return n.id;
  end if;
  update remnants set status = 'used', used_kind = p_kind, used_at = now(), reserved_order = null, updated_at = now() where id = p_id;
  perform stock_log(p_id, r.production_id, 'writeoff', jsonb_build_object('status', r.status), jsonb_build_object('status', 'used', 'kind', p_kind), r.qty, p_reason);
  return p_id;
end $$;

create or replace function public.stock_edit(p_id bigint, p_patch jsonb, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare r remnants; n remnants; b jsonb := '{}'; a jsonb := '{}'; k text;
begin
  r := stock_row_for_edit(p_id);
  n := r;
  if p_patch ? 'length' then n.length := (p_patch ->> 'length')::numeric; end if;
  if p_patch ? 'width' then n.width := (p_patch ->> 'width')::numeric; end if;
  if p_patch ? 'qty' then n.qty := greatest(1, (p_patch ->> 'qty')::integer); end if;
  if p_patch ? 'material' then n.material := coalesce(trim(p_patch ->> 'material'), ''); end if;
  if p_patch ? 'thickness' then n.thickness := nullif(p_patch ->> 'thickness', '')::numeric; end if;
  if p_patch ? 'cell' then n.cell := nullif(trim(coalesce(p_patch ->> 'cell', '')), ''); end if;
  if p_patch ? 'note' then n.note := nullif(trim(coalesce(p_patch ->> 'note', '')), ''); end if;
  if r.status = 'reserved' and (n.length <> r.length or n.width <> r.width or n.qty <> r.qty or n.material <> r.material) then raise exception 'stock: reserved'; end if;
  if coalesce(n.length, 0) <= 0 or coalesce(n.width, 0) <= 0 then raise exception 'stock: bad size'; end if;
  for k in select unnest(array['length', 'width', 'qty', 'material', 'thickness', 'cell', 'note']) loop
    if (stock_snap(r) -> k) is distinct from (stock_snap(n) -> k) then
      b := b || jsonb_build_object(k, stock_snap(r) -> k); a := a || jsonb_build_object(k, stock_snap(n) -> k);
    end if;
  end loop;
  if a = '{}'::jsonb then return; end if;
  update remnants set length = n.length, width = n.width, qty = n.qty, material = n.material, thickness = n.thickness, cell = n.cell, note = n.note,
    label_at = case when n.length <> r.length or n.width <> r.width or n.material <> r.material then null else label_at end,
    updated_at = now() where id = p_id;
  perform stock_log(p_id, r.production_id, case when a ?& array['cell'] and (select count(*) from jsonb_object_keys(a)) = 1 then 'cell' else 'edit' end, b, a, null, p_reason);
end $$;

create or replace function public.stock_delete(p_id bigint, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare r remnants;
begin
  r := stock_row_for_edit(p_id);
  if r.status = 'reserved' then raise exception 'stock: reserved'; end if;
  perform stock_log(p_id, r.production_id, 'delete', stock_snap(r), null, r.qty, p_reason);
  delete from remnants where id = p_id;
end $$;

revoke all on function public.stock_use_reserved(uuid, text), public.stock_use_order(uuid), public.stock_stage_trg() from public, anon;
grant execute on function public.stock_use_order(uuid), public.stock_reserve(uuid, jsonb), public.stock_writeoff(bigint, integer, text, text),
  public.stock_edit(bigint, jsonb, text), public.stock_delete(bigint, text) to authenticated;
notify pgrst, 'reload schema';
