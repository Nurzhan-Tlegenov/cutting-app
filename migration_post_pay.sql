-- Заработок постов (сдельная оплата): у поста расценка — за заказ, лист, деталь, м² деталей, метр кромки, отверстие
-- или % от суммы заказа. Когда пост выполнен, сотруднику, который его сделал, записывается начисление: количество
-- из заказа × расценка на тот момент (потом расценку можно менять — прошлые начисления не меняются; заказ удалят —
-- начисление остаётся). Заказ вернули на пост — начисление снимается, выполнят снова — запишется заново.
-- Выполнить один раз в Supabase -> SQL Editor (можно повторно), ПОСЛЕ migration_price_thickness.sql.
--
-- Расценка хранится в настройке поста (production_posts.rule → pay: { unit, rate }).
-- Начисляется: тому, кто нажал «Выполнено», если он закреплён за постом; иначе тому, кто принял; иначе тому, кто выполнил.
-- Видят: владелец, начальник (полный доступ) и сотрудники с правами «Итоги» + «Цены» — всех; остальные сотрудники — только своё.

create table if not exists public.post_earnings (
  id bigserial primary key,
  production_id uuid not null,
  order_id uuid,                -- без ссылки: заказ удалят — начисление остаётся
  order_name text,
  order_number text,
  stage_id uuid,
  post_id uuid,
  post_name text,
  user_id uuid,
  unit text not null,
  rate numeric not null,
  qty numeric not null,
  sum numeric not null,
  at timestamptz not null default now()
);
create index if not exists post_earnings_prod on public.post_earnings (production_id, at);
create index if not exists post_earnings_stage on public.post_earnings (stage_id);
alter table public.post_earnings enable row level security;   -- только через функции ниже

-- количество для расценки по заказу: статистика заказа — сохранённая при оформлении (order_work_stats, иначе order_quotes)
create or replace function public.order_pay_qty(p_order uuid, p_unit text) returns numeric
language plpgsql security definer set search_path = public stable as $$
declare o record; st jsonb; q jsonb;
begin
  select * into o from orders where id = p_order;
  if not found then return 0; end if;
  st := coalesce((select stats from order_work_stats where order_id = p_order), (select stats from order_quotes where order_id = p_order), '{}'::jsonb);
  return case p_unit
    when 'order' then 1
    when 'sheet' then coalesce(o.archived_sheets, order_sheet_count(o.nesting_result), jsonb_array_length(case when jsonb_typeof(st->'sheets') = 'array' then st->'sheets' else '[]'::jsonb end))
    when 'part' then coalesce((select sum(d.qty) from order_details d where d.order_id = p_order), jnum(st, 'parts'))
    when 'm2' then case when jnum(st, 'parts_m2') > 0 then jnum(st, 'parts_m2') else jnum(st, 'drill_m2') end
    when 'edge_m' then jnum(st, 'edge_thin_m') + jnum(st, 'edge_thick_m') + jnum(st, 'edge_curved_m')
    when 'hole' then jnum(st, 'holes') + jnum(st, 'edge_holes')
    when 'pct' then coalesce((select jnum(quote, 'total') from order_quotes where order_id = p_order), 0) / 100
    else 0 end;
end $$;
revoke all on function public.order_pay_qty(uuid, text) from public, anon, authenticated;

-- начисление при выполнении поста; снятие при возврате на пост
create or replace function public.trg_post_pay() returns trigger
language plpgsql security definer set search_path = public as $$
declare p record; o record; pay jsonb; rate numeric; unit text; q numeric; who uuid;
begin
  if new.status = 'done' and old.status is distinct from 'done' then
    select * into p from production_posts where id = new.post_id;
    if not found then return null; end if;
    pay := case when jsonb_typeof(p.rule->'pay') = 'object' then p.rule->'pay' else null end;
    rate := jnum(pay, 'rate'); unit := coalesce(pay->>'unit', '');
    if rate <= 0 or unit = '' then return null; end if;
    select * into o from orders where id = new.order_id;
    q := round(order_pay_qty(new.order_id, unit), 2);
    who := case
      when new.done_by is not null and exists (select 1 from post_members pm where pm.post_id = new.post_id and pm.user_id = new.done_by) then new.done_by
      when new.accepted_by is not null then new.accepted_by
      else new.done_by end;
    delete from post_earnings where stage_id = new.id;
    insert into post_earnings (production_id, order_id, order_name, order_number, stage_id, post_id, post_name, user_id, unit, rate, qty, sum, at)
    values (p.production_id, new.order_id, o.order_name, o.order_number, new.id, new.post_id, new.name, who, unit, rate, q, round(q * rate, 2), coalesce(new.done_at, now()));
  elsif old.status = 'done' and new.status is distinct from 'done' then
    delete from post_earnings where stage_id = new.id;
  end if;
  return null;
end $$;
drop trigger if exists post_pay on public.order_stages;
create trigger post_pay after update on public.order_stages for each row execute function public.trg_post_pay();

-- начисления за период: [{ id, at, user_id, user_name, post_id, post_name, order_id, order_name, order_number, unit, rate, qty, sum, mine }]
create or replace function public.post_earnings_of(p_prod uuid, p_from timestamptz, p_to timestamptz) returns json
language plpgsql security definer set search_path = public stable as $$
declare all_rows boolean;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  all_rows := exists (select 1 from productions where id = p_prod and owner_id = auth.uid() and status = 'approved')
    or exists (select 1 from production_members m where m.production_id = p_prod and m.user_id = auth.uid() and m.active
      and (m.perms ->> 'all' = 'true' or (m.perms ->> 'stats' = 'true' and m.perms ->> 'prices' = 'true')));
  if not all_rows and not exists (select 1 from production_members m where m.production_id = p_prod and m.user_id = auth.uid() and m.active) then
    raise exception 'not allowed';
  end if;
  return (select coalesce(json_agg(json_build_object('id', e.id, 'at', e.at, 'user_id', e.user_id, 'user_name', prod_user_name(e.user_id, p_prod),
      'post_id', e.post_id, 'post_name', e.post_name, 'order_id', e.order_id, 'order_name', e.order_name, 'order_number', e.order_number,
      'unit', e.unit, 'rate', e.rate, 'qty', e.qty, 'sum', e.sum, 'mine', e.user_id = auth.uid()) order by e.at desc), '[]'::json)
    from post_earnings e
    where e.production_id = p_prod and (all_rows or e.user_id = auth.uid())
      and (p_from is null or e.at >= p_from) and (p_to is null or e.at < p_to));
end $$;
revoke all on function public.post_earnings_of(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.post_earnings_of(uuid, timestamptz, timestamptz) to authenticated;

notify pgrst, 'reload schema';
