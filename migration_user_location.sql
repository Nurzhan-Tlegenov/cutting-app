alter table public.profiles add column if not exists country text;
alter table public.profiles add column if not exists city text;
alter table public.signup_requests add column if not exists country text;
alter table public.signup_requests add column if not exists city text;

update public.profiles p
set country = coalesce(nullif(trim(p.country), ''), nullif(trim(u.raw_user_meta_data->>'country'), ''), (select pr.country from public.productions pr where pr.owner_id = p.id limit 1)),
    city = coalesce(nullif(trim(p.city), ''), nullif(trim(u.raw_user_meta_data->>'city'), ''), (select pr.city from public.productions pr where pr.owner_id = p.id limit 1))
from auth.users u
where u.id = p.id and (coalesce(trim(p.country), '') = '' or coalesce(trim(p.city), '') = '');

drop function if exists public.request_signup(text, text, text);
create or replace function public.request_signup(p_name text, p_phone text, p_comment text default '', p_country text default '', p_city text default '')
returns text language plpgsql security definer set search_path = public as $$
declare d text := norm_phone(p_phone); st text;
begin
  if signup_open() then return 'open'; end if;
  if length(d) < 10 or length(d) > 15 then raise exception 'bad phone'; end if;
  select status into st from signup_requests where digits = d;
  if found then
    update signup_requests set full_name = coalesce(nullif(trim(p_name), ''), full_name), comment = coalesce(nullif(trim(p_comment), ''), comment),
      country = coalesce(nullif(left(trim(p_country), 60), ''), country), city = coalesce(nullif(left(trim(p_city), 80), ''), city)
    where digits = d and status = 'new';
    return st;
  end if;
  insert into signup_requests (phone, digits, full_name, comment, country, city)
    values (left(trim(p_phone), 40), d, left(trim(coalesce(p_name, '')), 120), left(trim(coalesce(p_comment, '')), 500), nullif(left(trim(coalesce(p_country, '')), 60), ''), nullif(left(trim(coalesce(p_city, '')), 80), ''));
  return 'new';
end $$;
revoke all on function public.request_signup(text, text, text, text, text) from public;
grant execute on function public.request_signup(text, text, text, text, text) to anon, authenticated;

create or replace function public.admin_users() returns json
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  return (select coalesce(json_agg(x order by x.created_at desc), '[]'::json) from (
    select u.id, u.email, u.created_at, u.last_sign_in_at, p.full_name, p.phone, p.whatsapp, coalesce(p.role, 'client') as role,
      coalesce(nullif(trim(p.country), ''), nullif(trim(u.raw_user_meta_data->>'country'), ''), pr.country,
        (select r.country from signup_requests r where r.digits = norm_phone(split_part(u.email, '@', 1)) limit 1)) as country,
      coalesce(nullif(trim(p.city), ''), nullif(trim(u.raw_user_meta_data->>'city'), ''), pr.city,
        (select r.city from signup_requests r where r.digits = norm_phone(split_part(u.email, '@', 1)) limit 1)) as city,
      (select count(*) from orders o where o.user_id = u.id) as orders,
      (select count(*) from orders o where o.user_id = u.id and o.status <> 'draft') as submitted,
      (select max(o.created_at) from orders o where o.user_id = u.id) as last_order_at,
      pr.id as production_id, pr.name as production_name, pr.city as production_city, pr.country as production_country, pr.created_at as production_created_at, pr.phone as production_phone, pr.status as production_status,
      (select count(*) from orders o where o.production_id = pr.id and o.status <> 'draft') as received,
      (select count(*) from orders o where o.production_id = pr.id and o.status in ('inwork', 'done')) as accepted,
      (select count(*) from orders o where o.production_id = pr.id and o.status = 'done') as done
    from auth.users u left join profiles p on p.id = u.id left join productions pr on pr.owner_id = u.id) x);
end $$;

notify pgrst, 'reload schema';
