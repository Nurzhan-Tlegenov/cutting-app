-- Мастер-аккаунт: у кого свои постпроцессоры (сами настроили или взяли за основу один из каталога и сохранили под своим
-- именем). Выполнить один раз в Supabase → SQL Editor (можно повторно). После migration_post_access.sql.
--
-- Свой постпроцессор — раскроечный станок в настройках ЧПУ пользователя (или его производства) с командами, которые
-- отличаются от стандартных. «Из каталога» — команды совпадают с постпроцессором из каталога или имя начинается с его имени.

-- команды станка одной строкой без пробелов и переводов строк — для сравнения
create or replace function public.post_cmd_key(d jsonb) returns text
language sql immutable as $$
  select regexp_replace(upper(concat_ws('|', d ->> 'cmdStart', d ->> 'cmdToolStart', d ->> 'cmdToolEnd', d ->> 'cmdEnd')), '\s+', '', 'g')
$$;

create or replace function public.admin_user_posts() returns json
language plpgsql security definer set search_path = public stable as $$
declare std text := post_cmd_key('{"cmdStart":"M16\nG54","cmdToolStart":"G53 Z0\nM05\nM06 T{T}\nG43 H{T}\nM03 S{S}","cmdToolEnd":"G53 Z0\nG54","cmdEnd":"M05\nM30"}'::jsonb);
        res json;
begin
  if not is_admin() then return null; end if;
  with own as (
    -- станки из личных настроек и из настроек своих производств
    select u.id as user_id, p as post from auth.users u, jsonb_array_elements(coalesce(u.raw_user_meta_data #> '{app_settings,cnc,posts}', '[]'::jsonb)) p
    union all
    select pr.owner_id, p from productions pr, jsonb_array_elements(coalesce(pr.cnc -> 'posts', '[]'::jsonb)) p where pr.owner_id is not null
  ), mine as (
    select distinct on (o.user_id, o.post ->> 'name') o.user_id, o.post ->> 'name' as name,
      (select s.name from shared_posts s where post_cmd_key(s.data) = post_cmd_key(o.post) and post_cmd_key(s.data) <> '|||'
         or lower(o.post ->> 'name') like lower(s.name) || '%' limit 1) as base
    from own o
    where coalesce(o.post ->> 'kind', 'router') = 'router' and not coalesce((o.post ->> 'shared')::boolean, false)
      and post_cmd_key(o.post) not in ('', '|||', std)
  ), runs as (
    select g.user_id, count(*) filter (where not g.shared)::int as own_runs, max(g.created_at) filter (where not g.shared) as own_last
    from post_usage g group by g.user_id
  )
  select coalesce(json_agg(json_build_object('user_id', x.user_id, 'own', x.own, 'own_runs', coalesce(r.own_runs, 0), 'own_last', r.own_last)), '[]'::json) into res
  from (select user_id, json_agg(json_build_object('name', name, 'base', base) order by name) as own from mine group by user_id) x
  left join runs r on r.user_id = x.user_id;
  return res;
end $$;
revoke all on function public.admin_user_posts() from public, anon;
grant execute on function public.admin_user_posts() to authenticated;
notify pgrst, 'reload schema';
