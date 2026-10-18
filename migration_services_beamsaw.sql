-- Услуги производства: ответ «Есть пильный центр» (beamsaw) теперь сохраняется.
-- Выполнить один раз в Supabase -> SQL Editor (можно повторно).
create or replace function public.production_set_services(p_services jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare clean jsonb := '{}'::jsonb; k text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  foreach k in array array['saw','cnc','beamsaw','shaped','hdf','edge','edge_curved','edge_client','drill','client_material','stock','pack','delivery','assembly','install'] loop
    if jsonb_typeof(p_services -> k) = 'boolean' then clean := clean || jsonb_build_object(k, p_services -> k); end if;
  end loop;
  update productions set services = clean where owner_id = auth.uid();
  if not found then raise exception 'no production'; end if;
end $$;

revoke all on function public.production_set_services(jsonb) from public, anon;
grant execute on function public.production_set_services(jsonb) to authenticated;
notify pgrst, 'reload schema';
