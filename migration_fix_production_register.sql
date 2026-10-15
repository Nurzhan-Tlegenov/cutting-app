-- Исправление: «null value in column "kerf_width" of relation "productions" violates not-null constraint».
-- Короткий файл: выполнить в Supabase → SQL Editor один раз (то же самое есть в свежем migration_security_all.sql).
do $$
declare c record;
begin
  for c in select column_name from information_schema.columns
           where table_schema = 'public' and table_name = 'productions' and is_nullable = 'NO' and column_default is null
             and column_name not in ('id', 'name', 'status') loop
    execute format('alter table public.productions alter column %I drop not null', c.column_name);
  end loop;
end $$;

create or replace function public.register_production(p_name text, p_phone text default '', p_city text default '',
  p_kerf numeric default null, p_ml numeric default null, p_mr numeric default null, p_mt numeric default null, p_mb numeric default null,
  p_country text default '')
returns uuid language plpgsql security definer set search_path = public as $$
declare pid uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if length(trim(coalesce(p_name, ''))) < 2 then raise exception 'bad name'; end if;
  if length(trim(coalesce(p_country, ''))) < 2 then raise exception 'bad country'; end if;       -- страна обязательна
  select id into pid from productions where owner_id = auth.uid();
  if pid is null then
    insert into productions (name, owner_id, country, phone, city, kerf_width, margin_left, margin_right, margin_top, margin_bottom, status)
      values (left(trim(p_name), 80), auth.uid(), left(trim(p_country), 60), left(trim(coalesce(p_phone, '')), 40), left(trim(coalesce(p_city, '')), 80), coalesce(p_kerf, 4), coalesce(p_ml, 10), coalesce(p_mr, 10), coalesce(p_mt, 10), coalesce(p_mb, 10),    -- станок не указан — обычные значения, их можно поменять в кабинете
        case when is_admin() or signup_open() then 'approved' else 'pending' end)
      returning id into pid;
  else
    update productions set name = left(trim(p_name), 80), country = left(trim(p_country), 60), phone = left(trim(coalesce(p_phone, '')), 40), city = left(trim(coalesce(p_city, '')), 80),
      kerf_width = coalesce(p_kerf, kerf_width), margin_left = coalesce(p_ml, margin_left), margin_right = coalesce(p_mr, margin_right),
      margin_top = coalesce(p_mt, margin_top), margin_bottom = coalesce(p_mb, margin_bottom),
      status = case when status = 'rejected' then (case when is_admin() or signup_open() then 'approved' else 'pending' end) else status end   -- отклонённую заявку можно подать заново
      where id = pid;
  end if;
  -- статус «Производство» в профиле — только у подтверждённого (администратор остаётся администратором)
  if exists (select 1 from productions where id = pid and status = 'approved') then
    update profiles set role = 'operator' where id = auth.uid() and role = 'client';
  end if;
  return pid;
end $$;

notify pgrst, 'reload schema';
