-- Удаление аккаунта мастером: профиль удаляется вместе с аккаунтом.
-- В старых базах profiles.id ссылается на auth.users без «on delete cascade», и удаление падало:
-- «violates foreign key constraint profiles_id_fkey». Пользователя с заказами не удаляем — их удалила бы
-- каскадная связь; сначала удалите или перенесите заказы.
create or replace function public.admin_delete_user(p_id uuid) returns text
language plpgsql security definer set search_path = public, auth as $$
declare d text; n int;
begin
  if not is_admin() then raise exception 'not admin'; end if;
  if p_id = auth.uid() then raise exception 'self'; end if;
  if exists (select 1 from profiles where id = p_id and role = 'admin') then raise exception 'admin'; end if;
  select norm_phone(split_part(email, '@', 1)) into d from auth.users where id = p_id;
  if d is null then return 'not found'; end if;
  select count(*) into n from orders where user_id = p_id;
  if n > 0 then return 'has orders:' || n; end if;
  delete from signup_requests where digits = d;
  delete from password_resets where digits = d;
  update login_help set status = 'done' where digits = d;
  -- своё производство пользователя: без владельца оно больше не показывается клиентам (заказы других клиентов в нём остаются)
  update productions set owner_id = null, status = 'rejected' where owner_id = p_id;
  begin
    delete from profiles where id = p_id;
    delete from auth.users where id = p_id;
  exception when foreign_key_violation then
    get stacked diagnostics d = message_text;
    return 'fk: ' || d;
  end;
  return 'ok';
end $$;

revoke all on function public.admin_delete_user(uuid) from public, anon, authenticated;
grant execute on function public.admin_delete_user(uuid) to authenticated;
notify pgrst, 'reload schema';
