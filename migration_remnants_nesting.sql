-- Склад остатков в раскрое: «Взять со склада», резерв при «Выбрать» / «Оформить», списание, когда заказ исполнен;
-- остатки из раскроя — «Мои остатки» (производства: сами на склад, без дублей) или «Остатки клиента» (на склад не идут).
-- Выполнить один раз в Supabase → SQL Editor (можно повторно). После migration_remnants_stock.sql и migration_remnants_stock_scan.sql.

alter table public.remnants add column if not exists source_order uuid references public.orders(id) on delete set null;
alter table public.remnants add column if not exists label_key text;   -- код бирки остатка, отсканированной при внесении (если остаток пришёл из раскроя сам)
alter table public.orders add column if not exists offcuts_owner text;   -- null — не выбрано, production — мои остатки, client — остатки клиента

-- ── остатки для раскроя: свои — производство видит всегда; клиенты — если включено «Показывать остатки клиентам» ──
create or replace function public.stock_for_nesting(p_prod uuid, p_order uuid) returns json
language plpgsql security definer set search_path = public stable as $$
declare a text := stock_access(p_prod); cl boolean;
begin
  if auth.uid() is null or p_prod is null then return '[]'::json; end if;
  select coalesce((stock_settings ->> 'clients')::boolean, false) into cl from productions where id = p_prod and status = 'approved';
  if a is null and not coalesce(cl, false) then return json_build_object('allowed', false, 'items', '[]'::json); end if;
  return json_build_object('allowed', true, 'own', a is not null, 'items', coalesce((
    select json_agg(json_build_object('id', r.id, 'length', r.length, 'width', r.width, 'qty', r.qty, 'material', r.material, 'thickness', r.thickness,
      'status', r.status, 'cell', case when a is not null then r.cell end, 'note', case when a is not null then r.note end) order by r.material, r.length * r.width desc)
    from remnants r where r.production_id = p_prod and (r.status = 'free' or (r.status = 'reserved' and p_order is not null and r.reserved_order = p_order))), '[]'::json));
end $$;

-- ── резерв: раскрой с остатками выбран («Выбрать» / «Оформить»). Прежний резерв этого заказа снимается, новый ставится.
-- Остаток уже занят другим заказом (или списан) — ошибка 'stock: busy <номера>', ничего не меняется ──
create or replace function public.stock_reserve(p_order uuid, p_items jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare o record; x jsonb; r remnants; n remnants; q integer; busy bigint[] := '{}'; ids bigint[] := '{}'; cl boolean;
begin
  select * into o from orders where id = p_order;
  if not found then raise exception 'stock: not found'; end if;
  if not (o.user_id = auth.uid() or is_my_production(o.production_id)) then raise exception 'not allowed'; end if;
  -- снять прежний резерв заказа
  for r in select * from remnants where reserved_order = p_order and status = 'reserved' for update loop
    update remnants set status = 'free', reserved_order = null, updated_at = now() where id = r.id;
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
      insert into remnants (production_id, length, width, qty, material, thickness, cell, note, status, reserved_order, label_at, source, source_order, created_by)
        values (r.production_id, r.length, r.width, q, r.material, r.thickness, r.cell, r.note, 'reserved', p_order, r.label_at, r.source, r.source_order, auth.uid()) returning * into n;
      perform stock_log(r.id, r.production_id, 'reserve', jsonb_build_object('qty', r.qty), jsonb_build_object('qty', r.qty - q, 'to', n.id), q, null);
      perform stock_log(n.id, r.production_id, 'reserve', jsonb_build_object('from', r.id), jsonb_build_object('order', coalesce(nullif(o.order_name, ''), o.order_number)), q, null);
      ids := ids || n.id;
    else
      update remnants set status = 'reserved', reserved_order = p_order, updated_at = now() where id = r.id;
      perform stock_log(r.id, r.production_id, 'reserve', null, jsonb_build_object('order', coalesce(nullif(o.order_name, ''), o.order_number)), r.qty, null);
      ids := ids || r.id;
    end if;
  end loop;
  if array_length(busy, 1) > 0 then raise exception 'stock: busy %', array_to_string(busy, ','); end if;
  return to_json(ids);
end $$;

-- ── заказ удалён — резерв снимается; заказ исполнен — остатки из резерва списываются «в заказ» ──
create or replace function public.stock_order_trg() returns trigger
language plpgsql security definer set search_path = public as $$
declare r remnants; t text;
begin
  if tg_op = 'DELETE' then
    t := coalesce(nullif(old.order_name, ''), old.order_number);
    for r in select * from remnants where reserved_order = old.id and status = 'reserved' loop
      update remnants set status = 'free', reserved_order = null, updated_at = now() where id = r.id;
      perform stock_log(r.id, r.production_id, 'release', jsonb_build_object('order', t), null, r.qty, 'заказ удалён');
    end loop;
    return old;
  end if;
  if new.status = 'done' and old.status is distinct from 'done' then
    t := coalesce(nullif(new.order_name, ''), new.order_number);
    for r in select * from remnants where reserved_order = new.id and status = 'reserved' loop
      update remnants set status = 'used', used_kind = 'order', used_at = now(), updated_at = now() where id = r.id;
      perform stock_log(r.id, r.production_id, 'writeoff', jsonb_build_object('status', 'reserved'), jsonb_build_object('status', 'used', 'kind', 'order', 'order', t), r.qty, 'заказ исполнен');
    end loop;
  end if;
  return new;
end $$;
drop trigger if exists stock_order_del on public.orders;
create trigger stock_order_del before delete on public.orders for each row execute function public.stock_order_trg();
drop trigger if exists stock_order_done on public.orders;
create trigger stock_order_done after update of status on public.orders for each row execute function public.stock_order_trg();

-- ── остатки из раскроя заказа: «Мои остатки» — на склад (без ячейки, без дублей); «Остатки клиента» — не на склад ──
-- p_items: [{ key, length, width, material, thickness, note }] — все деловые остатки сохранённого раскроя.
create or replace function public.stock_from_nesting(p_order uuid, p_owner text, p_items jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare o record; pr uuid; x jsonb; r remnants; keys text[] := '{}'; added integer := 0; removed integer := 0; t text;
begin
  if p_owner not in ('production', 'client') then raise exception 'bad owner'; end if;
  select * into o from orders where id = p_order;
  if not found then raise exception 'stock: not found'; end if;
  pr := coalesce(o.production_id, (select id from productions where owner_id = auth.uid() and status = 'approved' limit 1));
  if pr is null then raise exception 'no production'; end if;
  if not (coalesce(stock_access(pr), '') = 'edit' or can_work_order(p_order, 'cnc') or can_work_order(p_order, 'labels')
          or (o.user_id = auth.uid() and exists (select 1 from productions where id = pr and owner_id = auth.uid()))) then raise exception 'not allowed'; end if;
  update orders set offcuts_owner = p_owner where id = p_order;
  t := coalesce(nullif(o.order_name, ''), o.order_number);
  if p_owner = 'production' then
    for x in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
      if coalesce((x ->> 'length')::numeric, 0) <= 0 or coalesce((x ->> 'width')::numeric, 0) <= 0 or coalesce(x ->> 'key', '') = '' then continue; end if;
      keys := keys || (x ->> 'key');
      if exists (select 1 from remnants where production_id = pr and source_key = x ->> 'key') then continue; end if;
      insert into remnants (production_id, length, width, qty, material, thickness, note, source, source_key, source_order)
        values (pr, (x ->> 'length')::numeric, (x ->> 'width')::numeric, 1, coalesce(trim(x ->> 'material'), ''), nullif(x ->> 'thickness', '')::numeric,
                nullif(trim(coalesce(x ->> 'note', '')), ''), 'nesting', x ->> 'key', p_order)
        returning * into r;
      perform stock_log(r.id, pr, 'create', null, stock_snap(r) || jsonb_build_object('source', 'nesting', 'order', t), 1, null);
      added := added + 1;
    end loop;
  end if;
  -- остатки этого раскроя, которых больше нет (раскрой переделан) или они клиента: убрать, пока их не трогали
  -- (свободен, без ячейки) — тронутые остаются
  for r in select * from remnants where production_id = pr and source_order = p_order and source = 'nesting' and status = 'free' and cell is null
             and source_key like 'auto:%' and (p_owner = 'client' or not (source_key = any(keys))) loop
    perform stock_log(r.id, pr, 'delete', stock_snap(r), null, r.qty, case when p_owner = 'client' then 'остатки клиента' else 'раскрой заказа изменён' end);
    delete from remnants where id = r.id;
    removed := removed + 1;
  end loop;
  return json_build_object('added', added, 'removed', removed, 'production', pr);
end $$;

-- ── отсканировали бирку остатка, который уже пришёл из раскроя: запомнить код бирки и вписать ячейку ──
create or replace function public.stock_link_label(p_id bigint, p_key text, p_cell text) returns void
language plpgsql security definer set search_path = public as $$
declare r remnants;
begin
  r := stock_row_for_edit(p_id);
  if coalesce(p_key, '') <> '' then update remnants set label_key = p_key where id = p_id; end if;
  if coalesce(trim(p_cell), '') <> '' then perform stock_edit(p_id, jsonb_build_object('cell', p_cell), null); end if;
end $$;

-- ── остаток по коду бирки (внесённый сканом или привязанный к бирке) ──
create or replace function public.stock_by_key(p_prod uuid, p_key text) returns json
language plpgsql security definer set search_path = public stable as $$
begin
  if stock_access(p_prod) is null then raise exception 'not allowed'; end if;
  return (select row_to_json(r) from remnants r where r.production_id = p_prod and (r.source_key = p_key or r.label_key = p_key) order by r.id desc limit 1);
end $$;

revoke all on function public.stock_for_nesting(uuid, uuid), public.stock_reserve(uuid, jsonb), public.stock_from_nesting(uuid, text, jsonb),
  public.stock_link_label(bigint, text, text), public.stock_by_key(uuid, text), public.stock_order_trg() from public, anon;
grant execute on function public.stock_for_nesting(uuid, uuid), public.stock_reserve(uuid, jsonb), public.stock_from_nesting(uuid, text, jsonb),
  public.stock_link_label(bigint, text, text), public.stock_by_key(uuid, text) to authenticated;
notify pgrst, 'reload schema';
