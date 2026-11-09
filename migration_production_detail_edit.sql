-- Производство в карточке заказа (список деталей → галочки): «Удалить детали» и «Удалить присадку».
-- Детали клиента производство само не меняет (правила order_details — только хозяин заказа), поэтому — через функции базы.
-- Кто может: администратор, хозяин заказа, владелец / начальник производства заказа, сотрудник с правом «ЧПУ»
-- в назначенном ему заказе (can_work_order). Черновик клиента производство не трогает.
-- Выполнить один раз в Supabase → SQL Editor (можно повторно).

-- удалить детали заказа; p_nesting — карты раскроя без этих деталей (приложение пересчитывает номера деталей в раскрое)
create or replace function public.production_delete_details(p_order uuid, p_ids uuid[], p_nesting text) returns integer
language plpgsql security definer set search_path = public as $$
declare o record; n integer;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into o from orders where id = p_order;
  if not found or not (is_admin() or o.user_id = auth.uid() or can_work_order(p_order, 'cnc')) then raise exception 'not allowed'; end if;
  delete from order_details where order_id = p_order and id = any(p_ids);
  get diagnostics n = row_count;
  update orders set nesting_result = p_nesting where id = p_order;
  return n;
end $$;
revoke all on function public.production_delete_details(uuid, uuid[], text) from public;
grant execute on function public.production_delete_details(uuid, uuid[], text) to authenticated;

-- удалить всю присадку у деталей: отверстия в пласть и в торец (contour.drillings). Пазы, выемки, вырезы, контур — остаются
create or replace function public.production_strip_drilling(p_order uuid, p_ids uuid[]) returns integer
language plpgsql security definer set search_path = public as $$
declare o record; d record; v jsonb; inner_v jsonb; wrapped boolean; n integer := 0;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into o from orders where id = p_order;
  if not found or not (is_admin() or o.user_id = auth.uid() or can_work_order(p_order, 'cnc')) then raise exception 'not allowed'; end if;
  for d in select id, contour::text as c from order_details where order_id = p_order and id = any(p_ids) and contour is not null loop
    begin v := d.c::jsonb; exception when others then continue; end;
    wrapped := jsonb_typeof(v) = 'string';          -- контур, записанный строкой JSON
    if wrapped then begin inner_v := (v #>> '{}')::jsonb; exception when others then continue; end; else inner_v := v; end if;
    if jsonb_typeof(inner_v) <> 'object' or coalesce(jsonb_array_length(case when jsonb_typeof(inner_v -> 'drillings') = 'array' then inner_v -> 'drillings' end), 0) = 0 then continue; end if;
    inner_v := jsonb_set(inner_v, '{drillings}', '[]'::jsonb);
    update order_details set contour = case when wrapped then to_jsonb(inner_v::text) else inner_v end where id = d.id;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.production_strip_drilling(uuid, uuid[]) from public;
grant execute on function public.production_strip_drilling(uuid, uuid[]) to authenticated;
notify pgrst, 'reload schema';
