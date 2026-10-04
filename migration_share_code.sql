-- Короткая ссылка на 3D-модель: /v/K7mP2xQa вместо длинного кода.
-- Выполнить один раз в Supabase → SQL Editor (можно повторно). Старые длинные ссылки продолжают работать.

-- 8 знаков без похожих символов (0/O, 1/l/I): подобрать перебором нереально
create or replace function public.gen_share_code() returns text
language sql volatile as $$
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789', 1 + get_byte(uuid_send(gen_random_uuid()), i) % 56, 1), '')
  from generate_series(0, 7) as i
$$;

alter table public.model_shares add column if not exists code text;
update public.model_shares set code = public.gen_share_code() where code is null;
alter table public.model_shares alter column code set default public.gen_share_code();
alter table public.model_shares alter column code set not null;
create unique index if not exists model_shares_code_uq on public.model_shares (code);

-- модель по короткому коду — то же, что shared_model по длинному
create or replace function public.shared_model_code(p_code text) returns json
language sql security definer set search_path = public as $$
  select public.shared_model(s.token) from model_shares s where s.code = p_code
$$;
revoke all on function public.shared_model_code(text) from public;
grant execute on function public.shared_model_code(text) to anon, authenticated;

notify pgrst, 'reload schema';
