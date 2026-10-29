-- Склад остатков: внесение остатка сканом бирки из раскроя (без дублей — по коду бирки).
-- Выполнить один раз в Supabase → SQL Editor (можно повторно). После migration_remnants_stock.sql.

create or replace function public.stock_add(p_prod uuid, p_rows jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare x jsonb; r remnants; ids bigint[] := '{}'; k text;
begin
  if coalesce(stock_access(p_prod), '') <> 'edit' then raise exception 'not allowed'; end if;
  for x in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    if coalesce((x ->> 'length')::numeric, 0) <= 0 or coalesce((x ->> 'width')::numeric, 0) <= 0 then continue; end if;
    -- остаток с бирки (код бирки): уже внесён — второй раз не вносится, возвращается его номер
    k := nullif(trim(coalesce(x ->> 'source_key', '')), '');
    if k is not null then
      select * into r from remnants where production_id = p_prod and source_key = k;
      if found then ids := ids || r.id; continue; end if;
    end if;
    insert into remnants (production_id, length, width, qty, material, thickness, cell, note, source, source_key)
      values (p_prod, (x ->> 'length')::numeric, (x ->> 'width')::numeric, greatest(1, coalesce((x ->> 'qty')::integer, 1)),
              coalesce(trim(x ->> 'material'), ''), nullif(x ->> 'thickness', '')::numeric,
              nullif(trim(coalesce(x ->> 'cell', '')), ''), nullif(trim(coalesce(x ->> 'note', '')), ''),
              coalesce(nullif(x ->> 'source', ''), 'manual'), k)
      returning * into r;
    perform stock_log(r.id, p_prod, 'create', null, stock_snap(r) || jsonb_build_object('source', r.source), r.qty, null);
    ids := ids || r.id;
  end loop;
  return to_json(ids);
end $$;

notify pgrst, 'reload schema';
