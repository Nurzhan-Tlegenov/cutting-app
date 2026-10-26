-- Производство может поправить название материала в заказе клиента (клиент забыл указать цвет и т. п.).
-- Меняется везде, где это название записано: у заказа, у деталей с материалом из модели (contour.meta.material)
-- и в ключах готового раскроя по материалам (nesting_result.byMat «название|толщина») — раскрой не теряется.
-- Выполнить один раз в Supabase → SQL Editor (можно повторно).
create or replace function public.production_set_material(p_order uuid, p_old text, p_new text) returns text
language plpgsql security definer set search_path = public as $$
declare o record; v text; nr jsonb; bm jsonb; k text; val jsonb; nb jsonb := '{}'::jsonb;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into o from orders where id = p_order;
  if not found or not (is_admin() or o.user_id = auth.uid() or is_my_production(o.production_id)) then raise exception 'not allowed'; end if;
  v := nullif(btrim(left(coalesce(p_new, ''), 200)), '');
  if v is null then raise exception 'empty name'; end if;
  p_old := coalesce(p_old, '');
  -- материал заказа
  if coalesce(o.material_name, '') = p_old then update orders set material_name = v where id = p_order; end if;
  -- детали с материалом из модели
  update order_details set contour = jsonb_set(contour::text::jsonb, '{meta,material}', to_jsonb(v))
    where order_id = p_order and contour is not null and left(btrim(contour::text), 1) = '{'
      and (contour::text::jsonb) -> 'meta' ->> 'material' = p_old;
  -- готовый раскрой по материалам: ключи «старое|толщина» → «новое|толщина»
  if o.nesting_result is not null then
    begin
      nr := o.nesting_result::text::jsonb;
      if jsonb_typeof(nr) = 'string' then nr := (nr #>> '{}')::jsonb; end if;
      if coalesce((nr ->> 'multi')::boolean, false) and jsonb_typeof(nr -> 'byMat') = 'object' then
        bm := nr -> 'byMat';
        for k, val in select * from jsonb_each(bm) loop
          if split_part(k, '|', 1) = p_old then nb := nb || jsonb_build_object(v || '|' || split_part(k, '|', 2), val);
          else nb := nb || jsonb_build_object(k, val); end if;
        end loop;
        update orders set nesting_result = jsonb_set(nr, '{byMat}', nb) where id = p_order;
      end if;
    exception when others then null;   -- раскрой не разобрался — название всё равно поменяно
    end;
  end if;
  return v;
end $$;
revoke all on function public.production_set_material(uuid, text, text) from public;
grant execute on function public.production_set_material(uuid, text, text) to authenticated;
notify pgrst, 'reload schema';
