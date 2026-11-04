-- Мастер-аккаунт: кто чей сотрудник — для карточки пользователя (обращения, выдача постпроцессоров).
-- Выполнить один раз в Supabase → SQL Editor (можно повторно).
create or replace function public.admin_memberships() returns json
language plpgsql security definer set search_path = public stable as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  return (select coalesce(json_agg(json_build_object(
      'user_id', m.user_id, 'name', m.name, 'active', m.active, 'perms', m.perms, 'created_at', m.created_at,
      'production_id', p.id, 'production_name', p.name, 'production_city', p.city, 'production_country', p.country,
      'owner_name', (select pf.full_name from profiles pf where pf.id = p.owner_id)
    ) order by m.created_at), '[]'::json)
    from production_members m join productions p on p.id = m.production_id);
end $$;
revoke all on function public.admin_memberships() from public, anon;
grant execute on function public.admin_memberships() to authenticated;

notify pgrst, 'reload schema';
