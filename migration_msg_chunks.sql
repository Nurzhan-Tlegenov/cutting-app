-- Сообщения: большой файл (модель, история раскроя) уходит частями — один большой запрос на медленной / мобильной сети
-- обрывался («TypeError: Failed to fetch»). Сообщение создаётся с первой частью, остальные дописываются по одной.
-- Дописывать можно только в своё сообщение-обращение / файл для отладки, пока оно свежее (1 час).
-- Выполнить один раз в Supabase → SQL Editor (можно повторно). После migration_messages_posts.sql.

create or replace function public.msg_append(p_id uuid, p_chunk text) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update app_messages set payload = coalesce(payload, '') || coalesce(p_chunk, '')
    where id = p_id and from_id = auth.uid() and created_at > now() - interval '1 hour'
    returning length(payload) into n;
  if n is null then raise exception 'msg: not found'; end if;
  return n;
end $$;

revoke all on function public.msg_append(uuid, text) from public, anon;
grant execute on function public.msg_append(uuid, text) to authenticated;
notify pgrst, 'reload schema';
