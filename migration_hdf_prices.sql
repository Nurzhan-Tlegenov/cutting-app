-- Прайс-лист: отдельные цены распила для ХДФ / ДВП (тонкий материал задних стенок, режется на пиле).
-- Выполнить один раз в Supabase -> SQL Editor, ПОСЛЕ migration_production_prices.sql (можно повторно).
-- Меняется только функция расчёта quote_calc: если материал заказа — ХДФ, рез за метр, раскрой листа (и ступени по числу
-- деталей) и цена за деталь берутся из цен ХДФ; не заполненная цена ХДФ — как у плиты. Остальное без изменений.

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
  sh jsonb;
  r record;
begin
  select data into pr from production_prices where production_id = p_production;
  if pr is null or coalesce(pr->>'on', '') <> 'true' then return null; end if;

  -- ХДФ / ДВП (задние стенки): распил по своим ценам; пустая цена ХДФ — как у плиты
  if hdf then
    if jnum(pr, 'hdf_cut_m') > 0 then pr := pr || jsonb_build_object('cut_m', pr->'hdf_cut_m'); end if;
    if jnum(pr, 'hdf_cut_part') > 0 then pr := pr || jsonb_build_object('cut_part', pr->'hdf_cut_part'); end if;
    if jnum(pr, 'hdf_cut_sheet') > 0 or (jsonb_typeof(pr->'hdf_tiers') = 'array' and jsonb_array_length(pr->'hdf_tiers') > 0) then
      pr := pr || jsonb_build_object('cut_sheet', coalesce(pr->'hdf_cut_sheet', '0'::jsonb),
        'tiers', case when jsonb_typeof(pr->'hdf_tiers') = 'array' then pr->'hdf_tiers' else '[]'::jsonb end);
    end if;
  end if;

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

  -- в смете у ХДФ строки распила подписаны «ХДФ»
  if hdf then
    select coalesce(jsonb_agg(case when l->>'key' in ('cut_m', 'cut_sheet', 'cut_tiers', 'cut_part')
      then jsonb_set(l, '{key}', to_jsonb('hdf_' || (l->>'key'))) else l end), '[]'::jsonb) into lines
      from jsonb_array_elements(lines) l;
  end if;

  mn := jnum(pr, 'min');
  return jsonb_build_object('currency', coalesce(pr->>'currency', ''), 'lines', lines, 'sum', total,
    'total', greatest(total, case when total > 0 then mn else 0 end), 'min', mn, 'min_applied', total > 0 and total < mn);
end $$;
revoke all on function public.quote_calc(uuid, jsonb) from public;
revoke all on function public.quote_calc(uuid, jsonb) from anon, authenticated;

notify pgrst, 'reload schema';
