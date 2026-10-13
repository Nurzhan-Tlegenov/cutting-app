-- Производство (владелец и начальник производства) перекраивает заказ на другом листе: формат листа, рез, отступы и
-- обрезки сохраняются в заказе. Раньше сохранялись только карты, а лист оставался старым — карты не сходились с листом
-- («раскрой с нарушением»). Остальное в заказе (детали, материал, производство) производство по-прежнему не меняет.
-- Выполнить один раз в Supabase → SQL Editor (можно повторно).
create or replace function public.production_order_sheet(p_order uuid, p_patch jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare o record; k text;
begin
  select * into o from orders where id = p_order;
  if not found or not (is_admin() or o.user_id = auth.uid() or (o.status <> 'draft' and is_my_production(o.production_id))) then
    raise exception 'not allowed';
  end if;
  foreach k in array array['sheet_length', 'sheet_width', 'kerf_width', 'margin_left', 'margin_right', 'margin_top', 'margin_bottom', 'offcuts'] loop
    if p_patch ? k then
      execute format('update orders set %I = %L where id = %L', k, p_patch ->> k, p_order);
    end if;
  end loop;
end $$;
revoke all on function public.production_order_sheet(uuid, jsonb) from public, anon;
grant execute on function public.production_order_sheet(uuid, jsonb) to authenticated;
notify pgrst, 'reload schema';
