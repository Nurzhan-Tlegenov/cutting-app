-- Пометки на заказе в кабинете производства: «G-код создан» и «файлы сохранены (выгружены)».
-- Выполнить один раз в Supabase → SQL Editor (можно повторно). После migration_security_all.sql.
alter table public.orders add column if not exists gcode_at timestamptz;
alter table public.orders add column if not exists files_saved_at timestamptz;

-- Поставить пометку: 'gcode' — создан G-код (выгрузка при этом снова «не сделана»), 'files' — файлы сохранены
create or replace function public.production_mark(p_order uuid, p_what text) returns void
language plpgsql security definer set search_path = public as $$
declare o record;
begin
  if p_what not in ('gcode', 'files') then raise exception 'bad mark'; end if;
  select * into o from orders where id = p_order;
  if not found or not (is_admin() or o.user_id = auth.uid() or (o.status <> 'draft' and is_my_production(o.production_id))) then
    raise exception 'not allowed';
  end if;
  if p_what = 'gcode' then
    update orders set gcode_at = now(), files_saved_at = null where id = p_order;
  else
    update orders set files_saved_at = now(), gcode_at = coalesce(gcode_at, now()) where id = p_order;
  end if;
end $$;
revoke all on function public.production_mark(uuid, text) from public;
grant execute on function public.production_mark(uuid, text) to authenticated;

-- Заявки моего производства — теперь вместе с пометками
create or replace function public.production_orders() returns json
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  return (select coalesce(json_agg(x order by x.submitted_at desc nulls last), '[]'::json) from (
    select o.id, o.order_number, o.order_name, o.material_name, o.status, o.submitted_at, o.accepted_at, o.created_at,
      o.gcode_at, o.files_saved_at,
      o.user_id = auth.uid() as own,
      c.full_name as client_name, c.phone as client_phone, c.whatsapp as client_whatsapp,
      (select coalesce(sum(d.qty), 0) from order_details d where d.order_id = o.id) as parts
    from orders o join productions p on p.id = o.production_id left join profiles c on c.id = o.user_id
    where p.owner_id = auth.uid() and p.status = 'approved' and o.status <> 'draft') x);
end $$;
notify pgrst, 'reload schema';
