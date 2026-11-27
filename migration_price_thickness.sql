-- Прайс-лист: цены по толщине и диаметру, разгрузка, розничный коэффициент (опрос пользователей, ноябрь 2026).
-- Выполнить один раз в Supabase -> SQL Editor (можно повторно), ПОСЛЕ migration_groove_pieces.sql.
-- Всё новое — только когда в прайс-листе заполнены новые цены; пустые — расчёт ровно как раньше.
--
-- • Раскрой листа по толщине плиты: cut_sheet_16 / _18 / _22 / _30 (до 16, 17–21, 22–29, 30 и толще).
--   Цена этой толщины задана — лист по ней; пустая — по ступеням или общей цене за лист, как раньше. ХДФ — по своим ценам.
-- • Кромка по толщине плиты и кромки: edge_<16|18|22|30>_<a|b|c> (кромка до 0,5 / 0,5–1,5 / толще 1,5).
--   Пустая клетка — по прежней цене «до 1 мм» / «толще 1 мм». Склеенная деталь — плита двойной толщины.
-- • Отверстие в пласть по диаметру: hole_a / _b / _c / _d (Ø до 10, 11–32, 33–40, больше 40); пустая — общая цена «Отверстие».
-- • Свои строки «диаметр → цена» (hole_list / edge_hole_list: [{ d, price }]) — точный диаметр важнее диапазона и общей цены.
-- • Разгрузка: unload_16 / _18 / _22 / _30 — за каждый лист заказа (обрезки со склада не считаются).
-- • Розница: retail_k — коэффициент к цене для розничных клиентов. Розница — все клиенты, кроме отмеченных
--   «постоянный» (regular — список id). Своё производство (владелец) — всегда по базовой цене.
-- • order_work_stats — статистика заказа сохраняется при оформлении всегда (и без прайса): по ней считается заработок постов.

create table if not exists public.order_work_stats (
  order_id uuid primary key references public.orders(id) on delete cascade,
  stats jsonb not null,
  updated_at timestamptz default now()
);
alter table public.order_work_stats enable row level security;   -- политик нет: только через функции

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
  hdf boolean := coalesce(p_stats->>'hdf', '') = 'true';
  large boolean := false;
  kinds boolean := false;
  sh jsonb;
  r record;
  tc text;
  th_n jsonb := '{}'::jsonb;      -- листы с ценой своей толщины: { '18': число }
  un_n jsonb := '{}'::jsonb;      -- разгрузка: { '18': число листов }
  c text;
  rate numeric;
  q numeric;
  mx_on boolean;
  wide_priced boolean;
  fb_thin numeric := 0;
  fb_thick numeric := 0;
  client uuid;
  rk numeric;
  retail boolean := false;
  it jsonb;
  dd numeric;
  hd jsonb;
  used jsonb;
  rest numeric;
begin
  select data into pr from production_prices where production_id = p_production;
  if pr is null or coalesce(pr->>'on', '') <> 'true' then return null; end if;

  -- присадка за м²: две цены — кухни/ванные (drill_m2) и шкафы (drill_m2_large); тип изделия — из заказа (drill_kind)
  kinds := jnum(pr, 'drill_m2') > 0 and jnum(pr, 'drill_m2_large') > 0;
  if coalesce(s->>'drill_kind', '') = 'large' and jnum(pr, 'drill_m2_large') > 0 then
    pr := pr || jsonb_build_object('drill_m2', pr->'drill_m2_large'); large := true;
  end if;

  -- ХДФ / ДВП (задние стенки): распил по своим ценам; пустая цена ХДФ — как у плиты
  if hdf then
    if jnum(pr, 'hdf_cut_m') > 0 then pr := pr || jsonb_build_object('cut_m', pr->'hdf_cut_m'); end if;
    if jnum(pr, 'hdf_cut_part') > 0 then pr := pr || jsonb_build_object('cut_part', pr->'hdf_cut_part'); end if;
    if jnum(pr, 'hdf_cut_sheet') > 0 or (jsonb_typeof(pr->'hdf_tiers') = 'array' and jsonb_array_length(pr->'hdf_tiers') > 0) then
      pr := pr || jsonb_build_object('cut_sheet', coalesce(pr->'hdf_cut_sheet', '0'::jsonb),
        'tiers', case when jsonb_typeof(pr->'hdf_tiers') = 'array' then pr->'hdf_tiers' else '[]'::jsonb end);
    end if;
  end if;

  -- распил: цена за лист — своей толщины (если задана), иначе по числу деталей на листе (ступени), иначе единая цена за лист
  has_tiers := jsonb_typeof(pr->'tiers') = 'array' and jsonb_array_length(pr->'tiers') > 0;
  if jsonb_typeof(s->'sheets') = 'array' then
    for sh in select value from jsonb_array_elements(s->'sheets') limit 5000 loop
      tc := coalesce(sh->>'t', '');
      -- разгрузка — за лист заказа своей толщины (обрезки со склада не разгружают)
      if tc <> '' and coalesce(sh->>'o', '') = '' and jnum(pr, 'unload_' || tc) > 0 then
        un_n := un_n || jsonb_build_object(tc, coalesce((un_n->>tc)::int, 0) + 1);
      end if;
      if not hdf and tc <> '' and jnum(pr, 'cut_sheet_' || tc) > 0 then
        th_n := th_n || jsonb_build_object(tc, coalesce((th_n->>tc)::int, 0) + 1);
        continue;
      end if;
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
  for c in select unnest(array['16', '18', '22', '30']) loop
    q := coalesce((th_n->>c)::numeric, 0);
    if q > 0 then
      lines := lines || jsonb_build_object('group', 'cut', 'key', 'cut_sheet_' || c, 'qty', q, 'rate', jnum(pr, 'cut_sheet_' || c),
        'sum', round(q * jnum(pr, 'cut_sheet_' || c), 2));
      total := total + round(q * jnum(pr, 'cut_sheet_' || c), 2);
    end if;
  end loop;
  if sheet_sum > 0 then
    lines := lines || jsonb_build_object('group', 'cut', 'key', case when has_tiers then 'cut_tiers' else 'cut_sheet' end,
      'qty', sheet_n, 'rate', case when has_tiers then null else jnum(pr, 'cut_sheet') end, 'sum', round(sheet_sum, 2));
    total := total + round(sheet_sum, 2);
  end if;

  -- широкая кромка (склейка) со своей ценой — не считать её ещё раз по цене обычной кромки
  wide_priced := jnum(pr, 'edge_wide_m') > 0 or jnum(pr, 'edge_wide_part') > 0;
  if wide_priced then
    s := s || jsonb_build_object(
      'edge_thin_m', greatest(jnum(s, 'edge_thin_m') - jnum(s, 'edge_wide_thin_m'), 0),
      'edge_thick_m', greatest(jnum(s, 'edge_thick_m') - jnum(s, 'edge_wide_thick_m'), 0));
  end if;

  -- кромка по толщине плиты и кромки: клетка с ценой — по ней; пустая — по прежней цене (до 1 мм / толще 1 мм).
  -- Старое приложение (без разбивки em) — как раньше
  mx_on := jsonb_typeof(s->'em') = 'object' and exists (select 1 from jsonb_each(pr) e where e.key ~ '^edge_(16|18|22|30)_[abc]$' and jnum(pr, e.key) > 0);
  if mx_on then
    for r in select e.key, e.value from jsonb_each(s->'em') e
      union all select e.key, e.value from jsonb_each(case when jsonb_typeof(s->'emg') = 'object' and not wide_priced then s->'emg' else '{}'::jsonb end) e loop
      q := coalesce((r.value->>0)::numeric, 0) + coalesce((r.value->>1)::numeric, 0);
      rate := jnum(pr, 'edge_' || r.key);
      if rate > 0 and q > 0 then
        lines := lines || jsonb_build_object('group', 'edge', 'key', 'edge_' || r.key, 'qty', round(q, 2), 'rate', rate, 'sum', round(q * rate, 2));
        total := total + round(q * rate, 2);
      else
        fb_thin := fb_thin + coalesce((r.value->>0)::numeric, 0);
        fb_thick := fb_thick + coalesce((r.value->>1)::numeric, 0);
      end if;
    end loop;
    s := s || jsonb_build_object('edge_thin_m', fb_thin, 'edge_thick_m', fb_thick);
  end if;

  -- свои строки «диаметр → цена» (точный диаметр): в пласть (hole_list, по hdd) и в торец (edge_hole_list, по ehd).
  -- Отверстия этих диаметров — по своей цене, остальные дальше — по диапазону или общей цене
  if jsonb_typeof(pr->'hole_list') = 'array' and jsonb_typeof(s->'hdd') = 'object' then
    hd := case when jsonb_typeof(s->'hd') = 'object' then s->'hd' else '{}'::jsonb end;
    rest := jnum(s, 'holes'); used := '[]'::jsonb;
    for it in select value from jsonb_array_elements(pr->'hole_list') limit 100 loop
      dd := jnum(it, 'd'); rate := jnum(it, 'price');
      if dd <= 0 or rate <= 0 or used ? dd::text then continue; end if;
      used := used || to_jsonb(dd::text);
      select coalesce(sum(e.value::numeric), 0) into q from jsonb_each_text(s->'hdd') e
        where e.key ~ '^[0-9]+([.][0-9]+)?$' and abs(e.key::numeric - dd) < 0.05;
      if q > 0 then
        lines := lines || jsonb_build_object('group', 'drill', 'key', 'hole_d:' || (case when dd::text like '%.%' then rtrim(rtrim(dd::text, '0'), '.') else dd::text end), 'qty', q, 'rate', rate, 'sum', round(q * rate, 2));
        total := total + round(q * rate, 2);
        rest := rest - q;
        c := case when dd <= 10 then 'a' when dd <= 32 then 'b' when dd <= 40 then 'c' else 'd' end;
        hd := hd || jsonb_build_object(c, greatest(jnum(hd, c) - q, 0));
      end if;
    end loop;
    s := s || jsonb_build_object('holes', greatest(rest, 0), 'hd', hd);
  end if;
  if jsonb_typeof(pr->'edge_hole_list') = 'array' and jsonb_typeof(s->'ehd') = 'object' then
    rest := jnum(s, 'edge_holes'); used := '[]'::jsonb;
    for it in select value from jsonb_array_elements(pr->'edge_hole_list') limit 100 loop
      dd := jnum(it, 'd'); rate := jnum(it, 'price');
      if dd <= 0 or rate <= 0 or used ? dd::text then continue; end if;
      used := used || to_jsonb(dd::text);
      select coalesce(sum(e.value::numeric), 0) into q from jsonb_each_text(s->'ehd') e
        where e.key ~ '^[0-9]+([.][0-9]+)?$' and abs(e.key::numeric - dd) < 0.05;
      if q > 0 then
        lines := lines || jsonb_build_object('group', 'drill', 'key', 'edge_hole_d:' || (case when dd::text like '%.%' then rtrim(rtrim(dd::text, '0'), '.') else dd::text end), 'qty', q, 'rate', rate, 'sum', round(q * rate, 2));
        total := total + round(q * rate, 2);
        rest := rest - q;
      end if;
    end loop;
    s := s || jsonb_build_object('edge_holes', greatest(rest, 0));
  end if;

  -- отверстия в пласть по диаметру: цена диаметра задана — по ней, пустая — общая цена «Отверстие в пласть»
  if jsonb_typeof(s->'hd') = 'object' and (jnum(pr, 'hole_a') > 0 or jnum(pr, 'hole_b') > 0 or jnum(pr, 'hole_c') > 0 or jnum(pr, 'hole_d') > 0) then
    for c in select unnest(array['a', 'b', 'c', 'd']) loop
      q := jnum(s->'hd', c);
      rate := case when jnum(pr, 'hole_' || c) > 0 then jnum(pr, 'hole_' || c) else jnum(pr, 'hole') end;
      if q > 0 and rate > 0 then
        lines := lines || jsonb_build_object('group', 'drill', 'key', 'hole_' || c, 'qty', q, 'rate', rate, 'sum', round(q * rate, 2));
        total := total + round(q * rate, 2);
      end if;
    end loop;
    s := s || jsonb_build_object('holes', 0);
  end if;

  -- остальное: количество из статистики x цена из прайс-листа
  for r in select * from (values
      ('cut',   'cut_m',            'cut_m'),
      ('cut',   'cut_part',         'parts'),
      ('cut',   'upil',             'upil_n'),
      ('cut',   'upil_m',           'upil_m'),
      ('cut',   'shaped_part',      'shaped_parts'),
      ('cut',   'cutout',           'cutouts'),
      ('edge',  'edge_m',           'edge_thin_m'),
      ('edge',  'edge_thick_m',     'edge_thick_m'),
      ('edge',  'edge_curved_m',    'edge_curved_m'),
      ('edge',  'edge_curved_part', 'edge_curved_parts'),
      ('glue',  'glue_m2',          'glue_m2'),
      ('glue',  'glue_part',        'glue_n'),
      ('glue',  'edge_wide_m',      'edge_wide_m'),
      ('glue',  'edge_wide_part',   'edge_wide_parts'),
      ('drill', 'hole',             'holes'),
      ('drill', 'edge_hole',        'edge_holes'),
      ('drill', 'drill_m2',         'drill_m2'),
      ('drill', 'groove_m',         'groove_m'),
      ('drill', 'groove_narrow',    'groove_n_narrow'),
      ('drill', 'groove_wide',      'groove_n_wide'),
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

  -- разгрузка — за лист, по толщине
  for c in select unnest(array['16', '18', '22', '30']) loop
    q := coalesce((un_n->>c)::numeric, 0);
    if q > 0 then
      lines := lines || jsonb_build_object('group', 'other', 'key', 'unload_' || c, 'qty', q, 'rate', jnum(pr, 'unload_' || c),
        'sum', round(q * jnum(pr, 'unload_' || c), 2));
      total := total + round(q * jnum(pr, 'unload_' || c), 2);
    end if;
  end loop;

  -- в смете у ХДФ строки распила подписаны «ХДФ»
  if hdf then
    select coalesce(jsonb_agg(case when l->>'key' in ('cut_m', 'cut_sheet', 'cut_tiers', 'cut_part')
      then jsonb_set(l, '{key}', to_jsonb('hdf_' || (l->>'key'))) else l end), '[]'::jsonb) into lines
      from jsonb_array_elements(lines) l;
  end if;

  -- в смете строка присадки за м² для шкафов подписана своим названием
  if large then
    select coalesce(jsonb_agg(case when l->>'key' = 'drill_m2' then jsonb_set(l, '{key}', to_jsonb('drill_m2_large'::text)) else l end), '[]'::jsonb) into lines
      from jsonb_array_elements(lines) l;
  end if;

  -- розница: коэффициент ко всем строкам. Клиент — из _client (его ставит сама база, не приложение заказчика);
  -- постоянные клиенты (regular) и само производство — по базовой цене
  rk := jnum(pr, 'retail_k');
  begin client := nullif(s->>'_client', '')::uuid; exception when others then client := null; end;
  if rk > 0 and rk <> 1 and client is not null
    and not exists (select 1 from productions p where p.id = p_production and p.owner_id = client)
    and not (case when jsonb_typeof(pr->'regular') = 'array' then pr->'regular' else '[]'::jsonb end) ? client::text then
    retail := true;
    select coalesce(jsonb_agg(l || jsonb_build_object('sum', round((l->>'sum')::numeric * rk, 2),
      'rate', case when l->'rate' is null or jsonb_typeof(l->'rate') = 'null' then l->'rate' else to_jsonb(round((l->>'rate')::numeric * rk, 2)) end)), '[]'::jsonb)
      into lines from jsonb_array_elements(lines) l;
    select coalesce(sum((l->>'sum')::numeric), 0) into total from jsonb_array_elements(lines) l;
  end if;

  mn := jnum(pr, 'min');
  return jsonb_build_object('currency', coalesce(pr->>'currency', ''), 'lines', lines, 'sum', total,
    'total', greatest(total, case when total > 0 then mn else 0 end), 'min', mn, 'min_applied', total > 0 and total < mn, 'drill_kinds', kinds)
    || case when retail then jsonb_build_object('retail_k', rk) else '{}'::jsonb end;
end $$;
revoke all on function public.quote_calc(uuid, jsonb) from public;
revoke all on function public.quote_calc(uuid, jsonb) from anon, authenticated;

-- Стоимость по текущему прайс-листу. Клиент для розницы: заказчик — он сам; владелец производства — заказчик заказа,
-- который приложение присылает в статистике (client)
create or replace function public.production_quote(p_production uuid, p_stats jsonb) returns jsonb
language plpgsql security definer set search_path = public stable as $$
declare own boolean; q jsonb; cl text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  own := owns_production(p_production);
  if not own and exists (select 1 from productions where owner_id = auth.uid()) then
    return jsonb_build_object('hidden', true);
  end if;
  cl := case when own then coalesce(p_stats->>'client', '') else auth.uid()::text end;
  q := quote_calc(p_production, coalesce(p_stats, '{}'::jsonb) || jsonb_build_object('_client', cl));
  if q is null then return jsonb_build_object('empty', true); end if;
  if own then return q || jsonb_build_object('own', true); end if;
  return quote_public(q);
end $$;
revoke all on function public.production_quote(uuid, jsonb) from public;
grant execute on function public.production_quote(uuid, jsonb) to authenticated;

-- Фиксация цены при оформлении: клиент для розницы — заказчик заказа. Статистика заказа сохраняется всегда
-- (order_work_stats) — по ней считается заработок постов, даже если прайс-листа нет
create or replace function public.fix_order_quote(p_order uuid, p_stats jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o record; q jsonb;
begin
  select * into o from orders where id = p_order;
  if not found or not (o.user_id = auth.uid() or owns_production(o.production_id)) then raise exception 'not allowed'; end if;
  if p_stats is not null then
    insert into order_work_stats (order_id, stats, updated_at) values (p_order, p_stats, now())
      on conflict (order_id) do update set stats = excluded.stats, updated_at = now();
  end if;
  if o.production_id is null then return jsonb_build_object('none', true); end if;
  q := quote_calc(o.production_id, coalesce(p_stats, '{}'::jsonb) || jsonb_build_object('_client', o.user_id::text));
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

-- Клиенты производства (для категорий: розница / постоянный) — кто оформлял заказы на это производство. Только владелец
create or replace function public.production_client_list(p_prod uuid) returns json
language plpgsql security definer set search_path = public stable as $$
begin
  if not owns_production(p_prod) then raise exception 'not allowed'; end if;
  return (select coalesce(json_agg(x order by x.last desc nulls last), '[]'::json) from (
    select o.user_id as id, max(coalesce(o.submitted_at, o.created_at)) as last, count(*) as orders,
      user_contact(o.user_id) ->> 'full_name' as name, user_contact(o.user_id) ->> 'phone' as phone
    from orders o
    where o.production_id = p_prod and o.status <> 'draft' and o.user_id is not null
      and o.user_id <> (select owner_id from productions where id = p_prod)
    group by o.user_id) x);
end $$;
revoke all on function public.production_client_list(uuid) from public, anon;
grant execute on function public.production_client_list(uuid) to authenticated;

notify pgrst, 'reload schema';
