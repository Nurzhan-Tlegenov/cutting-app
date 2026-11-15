-- MAX и для регистрации по ссылке-приглашению (клиент, производство, знакомый): пригласивший видит, что код нужно
-- отправить в MAX (contact_app = 'max'). Выполнить один раз в Supabase -> SQL Editor (можно повторно),
-- ПОСЛЕ migration_max_messenger.sql и migration_ref_friend.sql.

create or replace function public.my_ref_people() returns json
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  return (
    with reg as (
      select (select kind from ref_codes where code = r.ref_code) as kind
      from signup_requests r where r.ref_by = auth.uid() and phone_registered(r.digits)
      union all
      select a.kind from ref_accepts a
      where a.ref_by = auth.uid()
        and not exists (select 1 from signup_requests r where r.ref_by = auth.uid()
                          and r.digits = norm_phone(split_part((select email from auth.users where id = a.user_id), '@', 1)))
    )
    select json_build_object(
      'pending', (select coalesce(json_agg(x order by x.created_at desc), '[]'::json) from (
        select r.id, r.full_name, r.phone, r.digits, r.messenger, r.contact_app, r.created_at, r.code_sent_at,
          (r.phone_verified_at is not null) as verified,
          case when r.code_expires > now() and r.code_attempts < 5 then r.code end as code,
          (select kind from ref_codes where code = r.ref_code) as kind
        from signup_requests r
        where r.ref_by = auth.uid() and r.status = 'approved' and r.created_at > now() - interval '30 days'
          and not phone_registered(r.digits)) x),
      'registered', (select count(*) from reg),
      'by_kind', (select coalesce(json_object_agg(k, n), '{}'::json) from (
        select coalesce(kind, 'client') as k, count(*) as n from reg group by 1) y)));
end $$;

revoke all on function public.my_ref_people() from public, anon;
grant execute on function public.my_ref_people() to authenticated;
notify pgrst, 'reload schema';
