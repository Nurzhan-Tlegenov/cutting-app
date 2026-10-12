-- Техпроцесс: журнал движения заказа по постам, «Принять» = сотрудник увидел заказ, отмена принятия,
-- «Исполнен» — только после всех постов. Выполнить один раз в Supabase → SQL Editor (можно повторно).
-- После migration_stage_move.sql и migration_production_board.sql.
--
-- • Журнал (stage_events): заказ пришёл на пост, принят (кто и через сколько увидел), отмена принятия, выполнен,
--   передан дальше без принятия (руководитель перенёс), пропущен, возвращён. Пишется сам — триггером на этапах.
--   Видят: владелец, начальник и сотрудники производства (не заказчик).
-- • «Принять» на посту, за которым закреплены сотрудники, — только эти сотрудники (руководитель за них не принимает,
--   он двигает сам заказ — перетаскиванием на доске). На посту без закреплённых — как раньше, руководитель тоже.
-- • «Выполнено» сотрудник нажимает только после «Принять». Руководитель двигает заказ всегда; при этом в журнале
--   видно, что пост пройден без принятия.
-- • Отменить своё «Принять» может тот, кто принял, и руководитель.
-- • Заказ, пущенный по постам, нельзя отметить «Исполнен», пока он не прошёл все посты (последний пост выполнен —
--   заказ исполнен сам).

create table if not exists public.stage_events (
  id bigserial primary key,
  order_id uuid not null references public.orders(id) on delete cascade,
  stage_id uuid,
  post_id uuid,
  post_name text,
  kind text not null,          -- queued | accepted | unaccepted | done | passed | skipped | returned
  user_id uuid references auth.users(id) on delete set null,
  at timestamptz not null default now()
);
create index if not exists stage_events_order on public.stage_events (order_id, at);
alter table public.stage_events enable row level security;   -- только через функции ниже

-- имя человека в производстве: как его назвали в сотрудниках, иначе из профиля
create or replace function public.prod_user_name(p_user uuid, p_prod uuid) returns text
language sql security definer set search_path = public stable as $$
  select case when p_user is null then null else coalesce(
    (select nullif(trim(m.name), '') from production_members m where m.user_id = p_user and m.production_id = p_prod),
    user_contact(p_user) ->> 'full_name', 'без имени') end
$$;

-- журнал пишется сам при каждом изменении этапа
create or replace function public.trg_stage_log() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text;
begin
  if tg_op = 'INSERT' then
    k := case new.status when 'queued' then 'queued' when 'skipped' then 'skipped' end;
  elsif new.status is distinct from old.status then
    k := case
      when new.status = 'queued' and old.status = 'accepted' then 'unaccepted'
      when new.status = 'queued' and old.status = 'done' then 'returned'
      when new.status = 'queued' then 'queued'
      when new.status = 'accepted' then 'accepted'
      when new.status = 'done' and old.status = 'queued' then 'passed'
      when new.status = 'done' then 'done'
      when new.status = 'skipped' then 'skipped'
    end;                                           -- снова «ждёт» (сброс при возврате) — не пишется
  elsif new.status = 'queued' and new.queued_at is distinct from old.queued_at then
    k := 'returned';
  end if;
  if k is not null then
    insert into stage_events (order_id, stage_id, post_id, post_name, kind, user_id)
    values (new.order_id, new.id, new.post_id, new.name, k, auth.uid());
  end if;
  return null;
end $$;
drop trigger if exists stage_log on public.order_stages;
create trigger stage_log after insert or update on public.order_stages for each row execute function public.trg_stage_log();

-- журнал для заказов, которые уже идут по постам (один раз: только у кого журнала ещё нет)
insert into public.stage_events (order_id, stage_id, post_id, post_name, kind, user_id, at)
select x.* from (
  select s.order_id, s.id, s.post_id, s.name, 'queued', null::uuid, s.queued_at from order_stages s where s.queued_at is not null
  union all
  select s.order_id, s.id, s.post_id, s.name, 'accepted', s.accepted_by, s.accepted_at from order_stages s where s.accepted_at is not null
  union all
  select s.order_id, s.id, s.post_id, s.name, case when s.status = 'skipped' then 'skipped' else 'done' end, s.done_by, s.done_at
    from order_stages s where s.done_at is not null and s.status in ('done', 'skipped')
) x(order_id, stage_id, post_id, post_name, kind, user_id, at)
where not exists (select 1 from stage_events e where e.order_id = x.order_id);

-- руководитель заказа: владелец, начальник производства или мастер-аккаунт
create or replace function public.order_boss(p_order uuid) returns boolean
language sql security definer set search_path = public stable as $$
  select is_admin() or exists (select 1 from orders o where o.id = p_order and is_my_production(o.production_id))
$$;
-- за постом закреплены сотрудники — принимают только они
create or replace function public.post_has_members(p_post uuid) returns boolean
language sql security definer set search_path = public stable as $$
  select exists (select 1 from post_members pm join production_posts p on p.id = pm.post_id
                 join production_members m on m.production_id = p.production_id and m.user_id = pm.user_id and m.active
                 where pm.post_id = p_post)
$$;
create or replace function public.can_accept_stage(s order_stages) returns boolean
language sql security definer set search_path = public stable as $$
  select case when post_has_members(s.post_id) then on_post(s.post_id) else can_stage(s) end
$$;

-- «Принять» — сотрудник поста увидел заказ и взял его
create or replace function public.stage_accept(p_stage uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s order_stages;
begin
  select * into s from order_stages where id = p_stage;
  if not found then raise exception 'not allowed'; end if;
  if not can_accept_stage(s) then raise exception 'stage: members only'; end if;
  if s.status <> 'queued' then raise exception 'stage: not queued'; end if;
  update order_stages set status = 'accepted', accepted_at = now(), accepted_by = auth.uid() where id = p_stage;
end $$;

-- отменить «Принять»: тот, кто принял, или руководитель. Заказ снова «новый» на этом посту
create or replace function public.stage_unaccept(p_stage uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s order_stages;
begin
  select * into s from order_stages where id = p_stage;
  if not found or not (s.accepted_by = auth.uid() or order_boss(s.order_id)) then raise exception 'not allowed'; end if;
  if s.status <> 'accepted' then return; end if;
  update order_stages set status = 'queued', accepted_at = null, accepted_by = null where id = p_stage;
end $$;

-- «Выполнено»: сотрудник поста — только после «Принять»; руководитель — всегда (в журнале будет «передан без принятия»)
create or replace function public.stage_done(p_stage uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s order_stages; boss boolean;
begin
  select * into s from order_stages where id = p_stage;
  if not found or not can_stage(s) then raise exception 'not allowed'; end if;
  if s.status not in ('queued', 'accepted') then raise exception 'stage: not active'; end if;
  boss := order_boss(s.order_id);
  if s.status = 'queued' and not boss then raise exception 'stage: accept first'; end if;
  update order_stages set status = 'done', done_at = now(), done_by = auth.uid() where id = p_stage;
  perform advance_stage(s.order_id);
end $$;

-- перенос заказа на любой пост (доска): принятие за сотрудника больше не подставляется
create or replace function public.stage_move(p_order uuid, p_post uuid) returns text
language plpgsql security definer set search_path = public as $$
declare cur order_stages; tgt order_stages; boss boolean;
begin
  select exists (select 1 from orders o where o.id = p_order and o.status = 'inwork' and (is_admin() or is_my_production(o.production_id))) into boss;
  select * into cur from order_stages where order_id = p_order and status in ('queued', 'accepted') order by sort limit 1;
  select * into tgt from order_stages where order_id = p_order and post_id = p_post order by sort limit 1;
  if tgt.id is null then return 'no_stage'; end if;
  if cur.id is not null and tgt.id = cur.id then return 'same'; end if;
  if cur.id is null or tgt.sort < cur.sort then
    if not boss and not (cur.id is not null and on_post(cur.post_id)) then raise exception 'not allowed'; end if;
    update order_stages set status = 'waiting', queued_at = null, accepted_at = null, accepted_by = null, done_at = null, done_by = null
      where order_id = p_order and sort > tgt.sort and status in ('done', 'queued', 'accepted');
  else
    if not boss then raise exception 'not allowed'; end if;
    update order_stages set status = 'done', done_at = now(), done_by = auth.uid() where id = cur.id;
    update order_stages set status = 'skipped', done_at = now(), done_by = auth.uid()
      where order_id = p_order and sort > cur.sort and sort < tgt.sort and status = 'waiting';
  end if;
  update order_stages set status = 'queued', queued_at = now(), accepted_at = null, accepted_by = null, done_at = null, done_by = null where id = tgt.id;
  return 'ok';
end $$;

-- «Исполнен» вручную — только когда заказ прошёл все посты (последний пост выполнен — заказ исполняется сам)
create or replace function public.trg_done_after_stages() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'done' and old.status is distinct from 'done'
     and exists (select 1 from order_stages s where s.order_id = new.id and s.status in ('waiting', 'queued', 'accepted')) then
    raise exception 'stages: not finished';
  end if;
  return new;
end $$;
drop trigger if exists done_after_stages on public.orders;
create trigger done_after_stages before update of status on public.orders for each row execute function public.trg_done_after_stages();

-- маршрут заказа: кто принял, кто должен принять (сотрудники поста), могу ли я принять / отменить
create or replace function public.order_stages_of(p_order uuid) returns json
language plpgsql security definer set search_path = public stable as $$
declare o record;
begin
  select * into o from orders where id = p_order;
  if not found or not (is_admin() or o.user_id = auth.uid() or is_my_production(o.production_id) or is_order_worker(p_order) or member_can(o.production_id, null)) then return '[]'::json; end if;
  return coalesce((select json_agg(json_build_object('id', s.id, 'post_id', s.post_id, 'name', s.name, 'sort', s.sort, 'status', s.status,
      'queued_at', s.queued_at, 'accepted_at', s.accepted_at, 'done_at', s.done_at,
      'rule', (select p.rule from production_posts p where p.id = s.post_id),
      'scanned', (select coalesce(sum(n), 0) from stage_scans x where x.stage_id = s.id),
      'accepted_by', prod_user_name(s.accepted_by, o.production_id),
      'done_by', prod_user_name(s.done_by, o.production_id),
      'accepted_me', s.accepted_by = auth.uid(),
      'members', (select json_agg(prod_user_name(pm.user_id, o.production_id)) from post_members pm
                  join production_members m on m.user_id = pm.user_id and m.production_id = o.production_id and m.active where pm.post_id = s.post_id),
      'can_accept', can_accept_stage(s),
      'can_unaccept', s.status = 'accepted' and (s.accepted_by = auth.uid() or order_boss(p_order)),
      'mine', on_post(s.post_id)) order by s.sort)
    from order_stages s where s.order_id = p_order), '[]'::json);
end $$;

-- журнал движения заказа по постам: владелец, начальник, сотрудники производства (заказчик — нет)
create or replace function public.order_stage_log(p_order uuid) returns json
language plpgsql security definer set search_path = public stable as $$
declare o record;
begin
  select * into o from orders where id = p_order;
  if not found or not (is_admin() or is_my_production(o.production_id) or member_can(o.production_id, null) or is_order_worker(p_order)) then return null; end if;
  return coalesce((select json_agg(json_build_object('kind', e.kind, 'post', e.post_name, 'stage_id', e.stage_id, 'at', e.at,
      'who', prod_user_name(e.user_id, o.production_id), 'me', e.user_id = auth.uid()) order by e.at, e.id)
    from stage_events e where e.order_id = p_order), '[]'::json);
end $$;

-- доска техпроцесса: + кто должен принять, могу ли я принять / отменить
create or replace function public.production_board(p_prod uuid default null) returns json
language plpgsql security definer set search_path = public stable as $$
declare pr uuid;
begin
  pr := case when p_prod is not null and (is_admin() or is_my_production(p_prod)) then p_prod else my_prod_admin() end;
  if pr is null then return null; end if;
  return json_build_object(
    'posts', coalesce((select json_agg(json_build_object('id', p.id, 'name', p.name, 'rule', p.rule, 'sort', p.sort) order by p.sort, p.created_at)
      from production_posts p where p.production_id = pr and p.active), '[]'::json),
    'items', coalesce((select json_agg(json_build_object('stage_id', s.id, 'status', s.status, 'post_id', s.post_id, 'post_name', s.name,
        'rule', (select p.rule from production_posts p where p.id = s.post_id),
        'scanned', (select coalesce(sum(n), 0) from stage_scans x where x.stage_id = s.id),
        'queued_at', s.queued_at, 'accepted_at', s.accepted_at,
        'accepted_by', prod_user_name(s.accepted_by, o.production_id),
        'accepted_me', s.accepted_by = auth.uid(),
        'members', (select json_agg(prod_user_name(pm.user_id, o.production_id)) from post_members pm
                    join production_members m on m.user_id = pm.user_id and m.production_id = o.production_id and m.active where pm.post_id = s.post_id),
        'can_accept', can_accept_stage(s),
        'can_unaccept', s.status = 'accepted' and (s.accepted_by = auth.uid() or is_admin() or is_my_production(o.production_id)),
        'order_id', o.id, 'order_number', o.order_number, 'order_name', o.order_name, 'material_name', o.material_name,
        'client_name', user_contact(o.user_id) ->> 'full_name', 'own', o.user_id = auth.uid(),
        'production_id', o.production_id, 'gcode_at', o.gcode_at, 'files_saved_at', o.files_saved_at,
        'sheets', order_sheet_count(o.nesting_result),
        'parts', (select coalesce(sum(d.qty), 0) from order_details d where d.order_id = o.id),
        'has_prev', exists (select 1 from order_stages b where b.order_id = s.order_id and b.status = 'done' and b.sort < s.sort),
        'next_post', (select n.name from order_stages n where n.order_id = s.order_id and n.status = 'waiting' order by n.sort limit 1))
      order by s.status desc, s.queued_at)
      from order_stages s join orders o on o.id = s.order_id
      where o.production_id = pr and o.status = 'inwork' and s.status in ('queued', 'accepted')), '[]'::json),
    'idle', coalesce((select json_agg(json_build_object('order_id', o.id, 'order_number', o.order_number, 'order_name', o.order_name,
        'material_name', o.material_name, 'client_name', user_contact(o.user_id) ->> 'full_name', 'own', o.user_id = auth.uid(),
        'accepted_at', o.accepted_at, 'sheets', order_sheet_count(o.nesting_result),
        'parts', (select coalesce(sum(d.qty), 0) from order_details d where d.order_id = o.id)) order by o.accepted_at nulls last)
      from orders o where o.production_id = pr and o.status = 'inwork'
        and not exists (select 1 from order_stages s where s.order_id = o.id)), '[]'::json));
end $$;

revoke all on function public.prod_user_name(uuid, uuid), public.trg_stage_log(), public.trg_done_after_stages(),
  public.order_boss(uuid), public.post_has_members(uuid), public.can_accept_stage(order_stages) from public, anon, authenticated;
revoke all on function public.stage_accept(uuid), public.stage_unaccept(uuid), public.stage_done(uuid), public.stage_move(uuid, uuid),
  public.order_stages_of(uuid), public.order_stage_log(uuid), public.production_board(uuid) from public, anon;
grant execute on function public.stage_accept(uuid), public.stage_unaccept(uuid), public.stage_done(uuid), public.stage_move(uuid, uuid),
  public.order_stages_of(uuid), public.order_stage_log(uuid), public.production_board(uuid) to authenticated;
notify pgrst, 'reload schema';
