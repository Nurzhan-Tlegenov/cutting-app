-- Услуги производства: ответы «да / нет» при регистрации (пила, ЧПУ, фигурные детали, ХДФ, кромка, криволинейная кромка,
-- присадка, материал заказчика, свой склад, упаковка, доставка, сборка, установка). Заказчик видит их в окне выбора производства.
-- Выполнить один раз в Supabase → SQL Editor (можно повторно).

alter table public.productions add column if not exists services jsonb not null default '{}'::jsonb;

-- Своё производство: сохранить услуги (только известные ключи, только да/нет)
create or replace function public.production_set_services(p_services jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare clean jsonb := '{}'::jsonb; k text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  foreach k in array array['saw','cnc','shaped','hdf','edge','edge_curved','edge_client','drill','client_material','stock','pack','delivery','assembly','install'] loop
    if jsonb_typeof(p_services -> k) = 'boolean' then clean := clean || jsonb_build_object(k, p_services -> k); end if;
  end loop;
  update productions set services = clean where owner_id = auth.uid();
  if not found then raise exception 'no production'; end if;
end $$;

revoke all on function public.production_set_services(jsonb) from public, anon;
grant execute on function public.production_set_services(jsonb) to authenticated;
notify pgrst, 'reload schema';
