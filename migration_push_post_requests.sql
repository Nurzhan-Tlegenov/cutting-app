-- Push в шторку телефона мастеру: новый запрос постпроцессора (производство просит постпроцессор под свой станок).
-- Как у новых обращений: уведомление со звуком, даже когда приложение закрыто; без включённого push — от бота @RaskroyProBot.
-- Нужен migration_push.sql (функции push_admins / push_enqueue). Выполнить один раз в Supabase → SQL Editor.
create or replace function public.push_on_post_request() returns trigger
language plpgsql security definer set search_path = public as $$
declare who text;
begin
  select coalesce(nullif(full_name, ''), phone) into who from profiles where id = new.user_id;
  perform push_admins('Запрос постпроцессора' || coalesce(': ' || nullif(who, ''), ''),
    coalesce(nullif(concat_ws(' · ', nullif(new.machine, ''), nullif(new.controller, '')), ''), case when new.post_id is not null then 'постпроцессор из каталога' else 'свой станок' end),
    '/go?t=posts&f=' || new.id, 'pq:' || new.id);
  return new;
exception when others then return new;   -- уведомление не должно мешать самому запросу
end $$;
drop trigger if exists push_post_request on public.post_requests;
create trigger push_post_request after insert on public.post_requests for each row execute function public.push_on_post_request();
