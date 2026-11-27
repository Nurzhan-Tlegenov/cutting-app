-- 1) Маршрут по алгоритму раскроя. Пост техпроцесса может быть «только для» пильного центра, фрезера ЧПУ (нестинг)
--    или форматки: rule.cut = 'beam' | 'cnc' | 'saw' ('any' — любой). Не задано — по названию поста
--    («Пильный…» — пильный центр; «Нестинг», «Фрезер», «ЧПУ» — фрезер; «Форматка» — форматка).
--    Пустили заказ в работу — посты не своего раскроя пропускаются сами: раскроен на пильном центре — «Нестинг» пропущен.
-- 2) Свои строки сметы (EstimateEditor): закрепляются за заказом и идут в «Итоги» (order_extra_lines; после удаления
--    заказа — в order_history.extra).

create or replace function public.post_cut_kind(p_rule jsonb, p_name text) returns text
language sql immutable as $$
  select case
    when p_rule ? 'cut' then case when p_rule ->> 'cut' in ('beam', 'cnc', 'saw') then p_rule ->> 'cut' end
    when coalesce(p_name, '') ~* 'пильн' then 'beam'
    when coalesce(p_name, '') ~* '(нестинг|nesting|фрез|чпу|cnc)' then 'cnc'
    when coalesce(p_name, '') ~* 'форматк' then 'saw'
  end
$$;

-- какими алгоритмами раскроен заказ: {beam, cnc, saw}; раскроя нет — null (ничего не пропускаем)
create or replace function public.order_cut_kinds(p_order uuid) returns text[]
language plpgsql stable security definer set search_path = public as $$
declare o record; nr jsonb; mats jsonb[]; v jsonb; out text[] := '{}'; k text; meth text;
begin
  select * into o from orders where id = p_order;
  if not found or o.nesting_result is null or o.nesting_result = '' then return null; end if;
  begin nr := o.nesting_result::jsonb; exception when others then return null; end;
  meth := to_jsonb(o) ->> 'cutting_method';
  if nr ->> 'multi' = 'true' and jsonb_typeof(nr -> 'byMat') = 'object' then
    select array_agg(value) into mats from jsonb_each(nr -> 'byMat');
  else mats := array[nr]; end if;
  foreach v in array coalesce(mats, '{}') loop
    k := case when jsonb_path_exists(v, '$.**.beamSaw ? (@ == true)') then 'beam'
              when jsonb_path_exists(v, '$.**.method ? (@ == "guillotine")') or (meth = 'guillotine' and not jsonb_path_exists(v, '$.**.method ? (@ == "nesting")')) then 'saw'
              else 'cnc' end;
    if not k = any(out) then out := out || k; end if;
  end loop;
  return case when cardinality(out) = 0 then null else out end;
end $$;

create or replace function public.stage_cut_skip(p_order uuid) returns json
language plpgsql security definer set search_path = public as $$
declare o record; kinds text[]; ok uuid[]; n int := 0; was_active boolean := false;
begin
  select * into o from orders where id = p_order;
  if not found or o.status <> 'inwork' then return json_build_object('skipped', 0, 'reason', 'заказ не в работе'); end if;
  if not (is_admin() or is_my_production(o.production_id) or member_can(o.production_id, null)) then
    return json_build_object('skipped', 0, 'reason', 'нет прав');
  end if;
  kinds := order_cut_kinds(p_order);
  if kinds is null then return json_build_object('skipped', 0, 'reason', 'у заказа нет раскроя'); end if;
  select array_agg(p.id) into ok from production_posts p
    where p.id in (select s.post_id from order_stages s where s.order_id = p_order)
      and post_cut_kind(p.rule, p.name) is not null and not (post_cut_kind(p.rule, p.name) = any(kinds));
  if ok is null then return json_build_object('skipped', 0, 'reason', null, 'kinds', kinds); end if;
  select exists (select 1 from order_stages s where s.order_id = p_order and s.post_id = any(ok) and s.status = 'queued'
                   and not exists (select 1 from stage_scans x where x.stage_id = s.id)) into was_active;
  update order_stages s set status = 'skipped', done_at = now()
    where s.order_id = p_order and s.post_id = any(ok) and s.status in ('waiting', 'queued')
      and not exists (select 1 from stage_scans x where x.stage_id = s.id);
  get diagnostics n = row_count;
  if was_active and not exists (select 1 from order_stages where order_id = p_order and status in ('queued', 'accepted')) then
    perform advance_stage(p_order);
  end if;
  return json_build_object('skipped', n, 'reason', null, 'kinds', kinds);
end $$;
revoke all on function public.stage_cut_skip(uuid) from public, anon;
grant execute on function public.stage_cut_skip(uuid) to authenticated;
revoke all on function public.order_cut_kinds(uuid) from public, anon;

-- ── свои строки сметы за заказом ──
create table if not exists public.order_extra_lines (
  order_id uuid not null references public.orders(id) on delete cascade,
  mat text not null default '',
  lines jsonb not null,
  currency text,
  updated_at timestamptz default now(),
  primary key (order_id, mat)
);
alter table public.order_extra_lines enable row level security;   -- политик нет: только через функции
alter table public.order_history add column if not exists extra jsonb;

create or replace function public.set_order_extra(p_order uuid, p_mat text, p_lines jsonb, p_currency text) returns boolean
language plpgsql security definer set search_path = public as $$
declare o record;
begin
  select * into o from orders where id = p_order;
  if not found or not owns_production(o.production_id) then raise exception 'not allowed'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    delete from order_extra_lines where order_id = p_order and mat = coalesce(p_mat, '');
  else
    insert into order_extra_lines (order_id, mat, lines, currency, updated_at) values (p_order, coalesce(p_mat, ''), p_lines, nullif(p_currency, ''), now())
      on conflict (order_id, mat) do update set lines = excluded.lines, currency = excluded.currency, updated_at = now();
  end if;
  return true;
end $$;
revoke all on function public.set_order_extra(uuid, text, jsonb, text) from public, anon;
grant execute on function public.set_order_extra(uuid, text, jsonb, text) to authenticated;
notify pgrst, 'reload schema';

-- ── часть 2: «Итоги» видят свои строки ──
create or replace function public.orders_keep_history() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.production_id is not null and old.status <> 'draft' then
    insert into order_history (order_id, user_id, production_id, order_number, order_name, material_name, client_name, client_phone,
        created_at, submitted_at, accepted_at, done_at, archived_at, status, sheets, parts, total, currency, stats, lines, extra)
      select old.id, old.user_id, old.production_id, old.order_number, old.order_name, old.material_name,
        (select c.full_name from profiles c where c.id = old.user_id), (select c.phone from profiles c where c.id = old.user_id),
        old.created_at, old.submitted_at, old.accepted_at, old.done_at, old.archived_at, old.status,
        coalesce(old.archived_sheets, order_sheet_count(old.nesting_result)),
        (select coalesce(sum(d.qty), 0) from order_details d where d.order_id = old.id),
        (select (q.quote->>'total')::numeric from order_quotes q where q.order_id = old.id and q.production_id = old.production_id),
        (select q.quote->>'currency' from order_quotes q where q.order_id = old.id and q.production_id = old.production_id),
        coalesce((select q.stats from order_quotes q where q.order_id = old.id and q.production_id = old.production_id),
          (select w.stats from order_work_stats w where w.order_id = old.id)),
        (select q.quote->'lines' from order_quotes q where q.order_id = old.id and q.production_id = old.production_id),
        (select jsonb_agg(l) from order_extra_lines x, jsonb_array_elements(x.lines) l where x.order_id = old.id)
    on conflict (order_id) do nothing;
  end if;
  delete from order_details where order_id = old.id;
  return old;
end $$;


create or replace function public.production_stats() returns json
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  return (select coalesce(json_agg(x order by x.submitted_at desc nulls last), '[]'::json) from (
    select o.id, o.order_number, o.order_name, o.status,
      o.created_at, o.submitted_at, o.accepted_at, o.done_at, o.prod_archived_at, false as deleted,
      coalesce(o.archived_sheets, order_sheet_count(o.nesting_result)) as sheets,
      (select coalesce(sum(d.qty), 0) from order_details d where d.order_id = o.id) as parts,
      (q.quote->>'total')::numeric as total, q.quote->>'currency' as currency, coalesce(q.stats, w.stats) as stats, q.quote->'lines' as lines,
      (select jsonb_agg(l) from order_extra_lines x, jsonb_array_elements(x.lines) l where x.order_id = o.id) as extra,
      (select x.currency from order_extra_lines x where x.order_id = o.id and x.currency is not null limit 1) as extra_currency,
      (select c.full_name from profiles c where c.id = o.user_id) as client_name,
      exists (select 1 from stats_excluded e where e.order_id = o.id) as excluded
    from orders o
      join productions p on p.id = o.production_id
      left join order_quotes q on q.order_id = o.id and q.production_id = o.production_id
      left join order_work_stats w on w.order_id = o.id
    where p.owner_id = auth.uid() and p.status = 'approved' and o.status <> 'draft'
    union all
    select h.order_id, h.order_number, h.order_name, coalesce(h.status, 'done'),
      h.created_at, h.submitted_at, h.accepted_at, h.done_at, h.archived_at, true,
      h.sheets, h.parts, h.total, h.currency, h.stats, h.lines, h.extra, null::text, h.client_name,
      exists (select 1 from stats_excluded e where e.order_id = h.order_id)
    from order_history h
      join productions p on p.id = h.production_id
    where p.owner_id = auth.uid() and p.status = 'approved') x);
end $$;
revoke all on function public.production_stats() from public;
grant execute on function public.production_stats() to authenticated;
notify pgrst, 'reload schema';
