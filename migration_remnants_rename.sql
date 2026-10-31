-- Склад остатков: групповое переименование материала. Название — только для показа (карточка, список, раскрой):
-- бирка с QR остаётся действительной (остаток ищется по номеру), поэтому смена названия не сбрасывает «бирка выпущена»
-- и разрешена и у остатка в резерве. Размер у остатка в резерве по-прежнему не меняется.
-- Выполнить один раз в Supabase → SQL Editor (можно повторно). После migration_remnants_use.sql.

create or replace function public.stock_edit(p_id bigint, p_patch jsonb, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare r remnants; n remnants; b jsonb := '{}'; a jsonb := '{}'; k text;
begin
  r := stock_row_for_edit(p_id);
  n := r;
  if p_patch ? 'length' then n.length := (p_patch ->> 'length')::numeric; end if;
  if p_patch ? 'width' then n.width := (p_patch ->> 'width')::numeric; end if;
  if p_patch ? 'qty' then n.qty := greatest(1, (p_patch ->> 'qty')::integer); end if;
  if p_patch ? 'material' then n.material := coalesce(trim(p_patch ->> 'material'), ''); end if;
  if p_patch ? 'thickness' then n.thickness := nullif(p_patch ->> 'thickness', '')::numeric; end if;
  if p_patch ? 'cell' then n.cell := nullif(trim(coalesce(p_patch ->> 'cell', '')), ''); end if;
  if p_patch ? 'note' then n.note := nullif(trim(coalesce(p_patch ->> 'note', '')), ''); end if;
  if r.status = 'reserved' and (n.length <> r.length or n.width <> r.width or n.qty <> r.qty) then raise exception 'stock: reserved'; end if;
  if coalesce(n.length, 0) <= 0 or coalesce(n.width, 0) <= 0 then raise exception 'stock: bad size'; end if;
  for k in select unnest(array['length', 'width', 'qty', 'material', 'thickness', 'cell', 'note']) loop
    if (stock_snap(r) -> k) is distinct from (stock_snap(n) -> k) then
      b := b || jsonb_build_object(k, stock_snap(r) -> k); a := a || jsonb_build_object(k, stock_snap(n) -> k);
    end if;
  end loop;
  if a = '{}'::jsonb then return; end if;
  update remnants set length = n.length, width = n.width, qty = n.qty, material = n.material, thickness = n.thickness, cell = n.cell, note = n.note,
    label_at = case when n.length <> r.length or n.width <> r.width then null else label_at end,   -- новый размер — бирку перепечатать
    updated_at = now() where id = p_id;
  perform stock_log(p_id, r.production_id, case when a ?& array['cell'] and (select count(*) from jsonb_object_keys(a)) = 1 then 'cell' else 'edit' end, b, a, null, p_reason);
end $$;

grant execute on function public.stock_edit(bigint, jsonb, text) to authenticated;
notify pgrst, 'reload schema';
