-- Прайс-лист производства и расчёт стоимости заказа.
-- Выполнить один раз в Supabase → SQL Editor (можно повторно). После migration_security_all.sql.
--
-- Расценки лежат в отдельной таблице, которую читает и меняет ТОЛЬКО владелец производства
-- (ни другие производства, ни заказчики, ни администратор её не видят).
-- Заказчик получает не расценки, а готовую сумму: её считает сама база (функция production_quote)
-- по статистике раскроя. Аккаунту, у которого есть своё производство, стоимость у ЧУЖОГО
-- производства не показывается вовсе — одно производство не может смотреть цены другого.

create table if not exists public.production_prices (
  production_id uuid primary key references public.productions(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now()
);
alter table public.production_prices enable row level security;
drop policy if exists "production_prices: владелец" on public.production_prices;
create policy "production_prices: владелец" on public.production_prices for all to authenticated
  using (exists (select 1 from public.productions p where p.id = production_id and p.owner_id = auth.uid()))
  with check (exists (select 1 from public.productions p where p.id = production_id and p.owner_id = auth.uid()));

-- число из JSON: пусто, текст или отрицательное — 0
create or replace function public.jnum(j jsonb, k text) returns numeric
language sql immutable as $$
  select case when replace(coalesce(j->>k, ''), ',', '.') ~ '^\s*\d+(\.\d+)?\s*$' then least(trim(replace(j->>k, ',', '.'))::numeric, 1e9) else 0 end
$$;

-- Стоимость работ производства p_production для раскроя со статистикой p_stats.
-- p_stats: { sheets: [{ parts }], parts, cut_m, edge_thin_m, edge_thick_m, edge_curved_m, edge_curved_parts,
--            holes, edge_holes, groove_m, pockets, cutouts, shaped_parts }
-- Ответ:
--   { hidden: true }  — у вызывающего есть своё производство, а это чужое: цены не показываем;
--   { empty: true }   — прайс-лист не заполнен или выключен;
--   владельцу:  { own: true, currency, total, min_applied, lines: [{ group, key, qty, rate, sum }] }
--   заказчику:  { currency, total, min_applied, groups: [{ group, sum }] }  — без расценок и количеств
create or replace function public.production_quote(p_production uuid, p_stats jsonb) returns jsonb
language plpgsql security definer set search_path = public stable as $$
declare
  own boolean;
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
  if auth.uid() is null then raise exception 'not signed in'; end if;
  own := exists (select 1 from productions where id = p_production and owner_id = auth.uid());
  if not own and exists (select 1 from productions where owner_id = auth.uid()) then
    return jsonb_build_object('hidden', true);
  end if;
  select data into pr from production_prices where production_id = p_production;
  if pr is null or coalesce(pr->>'on', '') <> 'true' then return jsonb_build_object('empty', true); end if;

  -- распил: цена за лист — по числу деталей на листе (ступени «до N деталей»), иначе единая цена за лист
  has_tiers := jsonb_typeof(pr->'tiers') = 'array' and jsonb_array_length(pr->'tiers') > 0;
  if jsonb_typeof(s->'sheets') = 'array' then
    for sh in select value from jsonb_array_elements(s->'sheets') limit 5000 loop
      sheet_n := sheet_n + 1;
      n := jnum(sh, 'parts');
      if has_tiers then
        tprice := null;
        select jnum(t.value, 'price') into tprice from jsonb_array_elements(pr->'tiers') t
          where jnum(t.value, 'to') > 0 and n <= jnum(t.value, 'to') order by jnum(t.value, 'to') limit 1;
        if tprice is null then        -- деталей больше, чем в последней ступени: «свыше» (ступень без числа), а если её нет — последняя ступень
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

  -- остальное: количество из статистики × цена из прайс-листа
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
  if own then
    return jsonb_build_object('own', true, 'currency', coalesce(pr->>'currency', ''), 'lines', lines,
      'sum', total, 'total', greatest(total, mn), 'min_applied', total < mn and total > 0, 'min', mn);
  end if;
  return jsonb_build_object('currency', coalesce(pr->>'currency', ''),
    'total', greatest(total, case when total > 0 then mn else 0 end), 'min_applied', total < mn and total > 0,
    'groups', (select coalesce(jsonb_agg(jsonb_build_object('group', g.grp, 'sum', g.sm) order by g.ord), '[]'::jsonb) from (
      select l->>'group' as grp, sum((l->>'sum')::numeric) as sm,
        min(case l->>'group' when 'cut' then 1 when 'edge' then 2 when 'drill' then 3 else 4 end) as ord
      from jsonb_array_elements(lines) l group by l->>'group') g));
end $$;
revoke all on function public.production_quote(uuid, jsonb) from public;
grant execute on function public.production_quote(uuid, jsonb) to authenticated;
notify pgrst, 'reload schema';
