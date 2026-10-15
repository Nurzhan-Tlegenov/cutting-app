-- Прайс-лист производства, расчёт стоимости заказа и фиксация цены при оформлении.
-- Выполнить один раз в Supabase -> SQL Editor (можно повторно; заменяет прежнюю версию этого файла).
-- После migration_security_all.sql.
--
-- Расценки лежат в отдельной таблице, которую читает и меняет ТОЛЬКО владелец производства.
-- Заказчик получает не расценки, а готовую сумму: её считает сама база по статистике раскроя.
-- Аккаунту, у которого есть своё производство, стоимость у ЧУЖОГО производства не показывается.
-- При оформлении заказа цена фиксируется (order_quotes) и дальше не зависит от изменений прайс-листа.

create table if not exists public.production_prices (
  production_id uuid primary key references public.productions(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now()
);
alter table public.production_prices enable row level security;

create or replace function public.owns_production(p_id uuid) returns boolean
language sql security definer set search_path = public stable as $$
  select exists (select 1 from productions p where p.id = p_id and p.owner_id = auth.uid())
$$;
grant execute on function public.owns_production(uuid) to authenticated;

drop policy if exists "production_prices: владелец" on public.production_prices;
drop policy if exists production_prices_owner on public.production_prices;
create policy production_prices_owner on public.production_prices
  for all to authenticated
  using (public.owns_production(production_id))
  with check (public.owns_production(production_id));

-- число из JSON: пусто, текст или отрицательное — 0
create or replace function public.jnum(j jsonb, k text) returns numeric
language sql immutable as $$
  select case when replace(coalesce(j->>k, ''), ',', '.') ~ '^[ ]*[0-9]+([.][0-9]+)?[ ]*$'
    then least(trim(replace(j->>k, ',', '.'))::numeric, 1000000000) else 0 end
$$;

-- Сам расчёт (служебная функция, напрямую из приложения не вызывается).
-- -> null (прайс не заполнен или выключен) | { currency, lines: [{ group, key, qty, rate, sum }], sum, total, min, min_applied }
create or replace function public.quote_calc(p_production uuid, p_stats jsonb) returns jsonb
language plpgsql security definer set search_path = public stable as $$
declare
  pr jsonb;
  s jsonb := coalesce(p_stats, '{}'::jsonb);
  lines jsonb := '[]'::jsonb;
  total numeric := 0;
  mn numeric;
  sheet_n int := 0;
  sheet_sum numeric := 0;
  n numeric;
  tprice numeric;
  has_tiers boolean;
  sh jsonb;
  r record;
begin
  select data into pr from production_prices where production_id = p_production;
  if pr is null or coalesce(pr->>'on', '') <> 'true' then return null; end if;

  -- распил: цена за лист — по числу деталей на листе (ступени), иначе единая цена за лист
  has_tiers := jsonb_typeof(pr->'tiers') = 'array' and jsonb_array_length(pr->'tiers') > 0;
  if jsonb_typeof(s->'sheets') = 'array' then
    for sh in select value from jsonb_array_elements(s->'sheets') limit 5000 loop
      sheet_n := sheet_n + 1;
      n := jnum(sh, 'parts');
      if has_tiers then
        tprice := null;
        select jnum(t.value, 'price') into tprice from jsonb_array_elements(pr->'tiers') t
          where jnum(t.value, 'to') > 0 and n <= jnum(t.value, 'to') order by jnum(t.value, 'to') limit 1;
        if tprice is null then
          select jnum(t.value, 'price') into tprice from jsonb_array_elements(pr->'tiers') t
            order by (jnum(t.value, 'to') = 0) desc, jnum(t.value, 'to') desc limit 1;
        end if;
        sheet_sum := sheet_sum + coalesce(tprice, 0);
      else
        sheet_sum := sheet_sum + jnum(pr, 'cut_sheet');
      end if;
    end loop;
  end if;
  if sheet_sum > 0 then
    lines := lines || jsonb_build_object('group', 'cut', 'key', case when has_tiers then 'cut_tiers' else 'cut_sheet' end,
      'qty', sheet_n, 'rate', case when has_tiers then null else jnum(pr, 'cut_sheet') end, 'sum', round(sheet_sum, 2));
    total := total + round(sheet_sum, 2);
  end if;

  -- остальное: количество из статистики x цена из прайс-листа
  for r in select * from (values
      ('cut',   'cut_m',            'cut_m'),
      ('cut',   'cut_part',         'parts'),
      ('cut',   'shaped_part',      'shaped_parts'),
      ('cut',   'cutout',           'cutouts'),
      ('edge',  'edge_m',           'edge_thin_m'),
      ('edge',  'edge_thick_m',     'edge_thick_m'),
      ('edge',  'edge_curved_m',    'edge_curved_m'),
      ('edge',  'edge_curved_part', 'edge_curved_parts'),
      ('drill', 'hole',             'holes'),
      ('drill', 'edge_hole',        'edge_holes'),
      ('drill', 'groove_m',         'groove_m'),
      ('drill', 'pocket',           'pockets'),
      ('other', 'label',            'parts')
    ) as v(grp, price_key, stat_key) loop
    if jnum(pr, r.price_key) > 0 and jnum(s, r.stat_key) > 0 then
      lines := lines || jsonb_build_object('group', r.grp, 'key', r.price_key, 'qty', round(jnum(s, r.stat_key), 2),
        'rate', jnum(pr, r.price_key), 'sum', round(jnum(s, r.stat_key) * jnum(pr, r.price_key), 2));
      total := total + round(jnum(s, r.stat_key) * jnum(pr, r.price_key), 2);
    end if;
  end loop;
  -- толстая кромка без своей цены идёт по цене обычной
  if jnum(pr, 'edge_thick_m') = 0 and jnum(pr, 'edge_m') > 0 and jnum(s, 'edge_thick_m') > 0 then
    lines := lines || jsonb_build_object('group', 'edge', 'key', 'edge_thick_m', 'qty', round(jnum(s, 'edge_thick_m'), 2),
      'rate', jnum(pr, 'edge_m'), 'sum', round(jnum(s, 'edge_thick_m') * jnum(pr, 'edge_m'), 2));
    total := total + round(jnum(s, 'edge_thick_m') * jnum(pr, 'edge_m'), 2);
  end if;

  mn := jnum(pr, 'min');
  return jsonb_build_object('currency', coalesce(pr->>'currency', ''), 'lines', lines, 'sum', total,
    'total', greatest(total, case when total > 0 then mn else 0 end), 'min', mn, 'min_applied', total > 0 and total < mn);
end $$;
revoke all on function public.quote_calc(uuid, jsonb) from public;
revoke all on function public.quote_calc(uuid, jsonb) from anon, authenticated;

-- То же для заказчика: без расценок и количеств, только суммы по видам работ
create or replace function public.quote_public(q jsonb) returns jsonb
language sql immutable as $$
  select jsonb_build_object('currency', q->'currency', 'total', q->'total', 'min_applied', q->'min_applied',
    'groups', (select coalesce(jsonb_agg(jsonb_build_object('group', g.grp, 'sum', g.sm) order by g.ord), '[]'::jsonb) from (
      select l->>'group' as grp, sum((l->>'sum')::numeric) as sm,
        min(case l->>'group' when 'cut' then 1 when 'edge' then 2 when 'drill' then 3 else 4 end) as ord
      from jsonb_array_elements(q->'lines') l group by l->>'group') g))
$$;

-- Стоимость по текущему прайс-листу (до оформления заказа).
--   { hidden: true } — у вызывающего своё производство, а это чужое;  { empty: true } — прайс не заполнен;
--   владельцу — построчно с ценами (own: true), заказчику — итог и суммы по видам работ.
create or replace function public.production_quote(p_production uuid, p_stats jsonb) returns jsonb
language plpgsql security definer set search_path = public stable as $$
declare own boolean; q jsonb;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  own := owns_production(p_production);
  if not own and exists (select 1 from productions where owner_id = auth.uid()) then
    return jsonb_build_object('hidden', true);
  end if;
  q := quote_calc(p_production, p_stats);
  if q is null then return jsonb_build_object('empty', true); end if;
  if own then return q || jsonb_build_object('own', true); end if;
  return quote_public(q);
end $$;
revoke all on function public.production_quote(uuid, jsonb) from public;
grant execute on function public.production_quote(uuid, jsonb) to authenticated;

-- ── Фиксация цены при оформлении заказа ──
create table if not exists public.order_quotes (
  order_id uuid primary key references public.orders(id) on delete cascade,
  production_id uuid,
  quote jsonb not null,
  stats jsonb,
  created_at timestamptz default now()
);
alter table public.order_quotes enable row level security;
-- политик нет: читается и пишется только через функции ниже

-- Зафиксировать цену заказа: вызывает заказчик при оформлении (или производство — для своего заказа).
-- Цена считается по прайс-листу производства, на которое оформлен заказ, и записывается.
create or replace function public.fix_order_quote(p_order uuid, p_stats jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o record; q jsonb;
begin
  select * into o from orders where id = p_order;
  if not found or not (o.user_id = auth.uid() or owns_production(o.production_id)) then raise exception 'not allowed'; end if;
  if o.production_id is null then return jsonb_build_object('none', true); end if;
  q := quote_calc(o.production_id, p_stats);
  if q is null then
    delete from order_quotes where order_id = p_order;
    return jsonb_build_object('none', true);
  end if;
  insert into order_quotes (order_id, production_id, quote, stats, created_at) values (p_order, o.production_id, q, p_stats, now())
    on conflict (order_id) do update set production_id = excluded.production_id, quote = excluded.quote, stats = excluded.stats, created_at = now();
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.fix_order_quote(uuid, jsonb) from public;
grant execute on function public.fix_order_quote(uuid, jsonb) to authenticated;

-- Зафиксированная цена заказа.
--   { none: true } — цена не фиксировалась;  { hidden: true } — у вызывающего своё производство, а заказ на чужом;
--   производству — построчно (own: true), заказчику — итог и суммы по видам работ. В обоих случаях fixed: true и at.
create or replace function public.order_quote(p_order uuid) returns jsonb
language plpgsql security definer set search_path = public stable as $$
declare o record; r record; own boolean;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into o from orders where id = p_order;
  if not found then return jsonb_build_object('none', true); end if;
  select * into r from order_quotes where order_id = p_order;
  if not found or r.production_id is distinct from o.production_id then return jsonb_build_object('none', true); end if;
  own := owns_production(r.production_id);
  if own then return r.quote || jsonb_build_object('own', true, 'fixed', true, 'at', r.created_at); end if;
  if o.user_id is distinct from auth.uid() then return jsonb_build_object('none', true); end if;
  if exists (select 1 from productions where owner_id = auth.uid()) then return jsonb_build_object('hidden', true); end if;
  return quote_public(r.quote) || jsonb_build_object('fixed', true, 'at', r.created_at);
end $$;
revoke all on function public.order_quote(uuid) from public;
grant execute on function public.order_quote(uuid) to authenticated;

notify pgrst, 'reload schema';
