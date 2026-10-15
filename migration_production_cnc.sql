-- Настройки ЧПУ производства (постпроцессоры, инструменты, обработка) — общие для владельца и сотрудников.
-- Выполнить один раз в Supabase → SQL Editor (можно повторно).
-- Раньше настройки ЧПУ были только в аккаунте владельца: начальник производства и сотрудник с правом «Управляющие
-- программы» открывали ЧПУ заказа со своими пустыми настройками. Теперь владелец (и начальник) сохраняют настройки
-- в производство, а сотрудники выпускают программы по ним.

alter table public.productions add column if not exists cnc jsonb;

-- настройки ЧПУ производства: владелец, начальник, сотрудник с правом «Управляющие программы»
create or replace function public.production_cnc(p_prod uuid) returns json
language plpgsql security definer set search_path = public stable as $$
declare p record;
begin
  select * into p from productions where id = p_prod;
  if not found or not (is_admin() or is_my_production(p_prod) or member_can(p_prod, 'cnc')) then return null; end if;
  return json_build_object('cnc', p.cnc, 'own', p.owner_id = auth.uid(), 'edit', is_my_production(p_prod));
end $$;

-- сохранить: владелец или начальник производства
create or replace function public.production_cnc_save(p_prod uuid, p_cnc jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (is_admin() or is_my_production(p_prod)) then raise exception 'not allowed'; end if;
  update productions set cnc = p_cnc where id = p_prod;
end $$;

revoke all on function public.production_cnc(uuid), public.production_cnc_save(uuid, jsonb) from public, anon;
grant execute on function public.production_cnc(uuid), public.production_cnc_save(uuid, jsonb) to authenticated;
notify pgrst, 'reload schema';
