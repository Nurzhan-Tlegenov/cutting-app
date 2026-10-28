-- Галочки у ответов мастер-аккаунта: ✓ отправлено, ✓✓ серые — дошло (у пользователя открылось приложение),
-- ✓✓ синие — прочитано (пользователь открыл «Сообщения»). Выполнить один раз в Supabase → SQL Editor (можно повторно).
alter table public.app_messages add column if not exists delivered_at timestamptz;
alter table public.app_messages add column if not exists read_at timestamptz;

-- пользователь: ответы ему дошли (p_read = false) или прочитаны (p_read = true)
create or replace function public.msg_receipt(p_read boolean default false) returns integer
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update app_messages set delivered_at = coalesce(delivered_at, now()), read_at = case when p_read then coalesce(read_at, now()) else read_at end
    where to_id = auth.uid() and kind = 'reply' and (delivered_at is null or (p_read and read_at is null));
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.msg_receipt(boolean) from public, anon;
grant execute on function public.msg_receipt(boolean) to authenticated;
notify pgrst, 'reload schema';
