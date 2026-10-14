-- Проверка безопасности базы (только чтение — ничего не меняет). Supabase → SQL Editor → вставить целиком → Run.
-- Результат — одна таблица: уровень (🔴 опасно / 🟡 проверить / 🟢 ок), что проверено, объект, пояснение.
-- Сделайте скриншот таблицы (или Export → CSV) и пришлите.

with
tbl as (
  select c.oid, c.relname as name, c.relrowsecurity as rls
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
),
pol as (
  select tablename, policyname, cmd, roles::text as roles, coalesce(qual, '') as qual, coalesce(with_check, '') as chk
  from pg_policies where schemaname = 'public'
),
definer_anon as (   -- функции с правами владельца, которые может вызвать кто угодно без входа
  select p.proname as name, pg_get_function_identity_arguments(p.oid) as args
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef and has_function_privilege('anon', p.oid, 'execute')
),
views as (   -- представления без security_invoker обходят RLS
  select c.relname as name, coalesce(array_to_string(c.reloptions, ','), '') as opts
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'v'
),
findings as (
  -- 1. таблицы без защиты строк
  select case when not rls then '🔴' else '🟢' end as lvl, 'RLS включена' as chk, name as obj,
         case when not rls then 'Защита строк ВЫКЛЮЧЕНА — таблицу может читать/менять любой с публичным ключом' else 'ок' end as note
  from tbl
  union all
  -- 2. таблица с RLS, но без единой политики (никто, кроме функций базы, не достучится — это нормально для служебных)
  select '🟢', 'Только через функции', t.name, 'RLS без политик — доступ только через функции базы'
  from tbl t where t.rls and not exists (select 1 from pol p where p.tablename = t.name)
  union all
  -- 3. политики, открытые всем (using true) — кроме чтения справочников
  select case when p.cmd in ('ALL', 'INSERT', 'UPDATE', 'DELETE') then '🔴' else '🟡' end,
         'Политика «для всех»', p.tablename || ' · ' || p.policyname,
         p.cmd || ' для ' || p.roles || ': ' || case when p.qual = 'true' then 'using (true)' else 'with check (true)' end
  from pol p where p.qual = 'true' or (p.chk = 'true' and p.cmd <> 'SELECT')
  union all
  -- 4. политики для роли anon (без входа)
  select '🟡', 'Политика для anon', p.tablename || ' · ' || p.policyname, p.cmd || ': ' || left(p.qual, 120)
  from pol p where p.roles like '%anon%' or p.roles = '{public}' and p.qual = 'true'
  union all
  -- 6. функции, доступные без входа (одной строкой — список имён)
  select '🟡', 'Функции без входа', count(*)::text || ' шт.', coalesce(string_agg(name, ', ' order by name), '')
  from definer_anon having count(*) > 0
  union all
  -- 7. представления
  select case when opts like '%security_invoker=true%' or opts like '%security_invoker=on%' then '🟢' else '🔴' end,
         'Представление', name, case when opts like '%security_invoker%' then 'security_invoker' else 'обходит RLS — читать может любой, у кого есть доступ к представлению' end
  from views
  union all
  -- 8. публичные бакеты хранилища
  select case when b.public then '🟡' else '🟢' end, 'Хранилище', b.name,
         case when b.public then 'бакет ПУБЛИЧНЫЙ — файлы открываются по прямой ссылке без входа' else 'закрытый' end
  from storage.buckets b
  union all
  -- 9. администраторы
  select case when count(*) = 1 then '🟢' else '🟡' end, 'Администраторы', count(*)::text || ' акк.',
         coalesce(string_agg(coalesce(p.full_name, '') || ' ' || coalesce(p.phone, ''), '; '), '') from public.profiles p where p.role = 'admin'
  union all
  -- 10. регистрация
  select case when coalesce((select (value)::text from public.app_config where key = 'signup_open'), 'true') = 'true' then '🟡' else '🟢' end,
         'Регистрация', 'signup_open', coalesce((select (value)::text from public.app_config where key = 'signup_open'), 'нет записи') || ' (false = только по заявке)'
  union all
  -- 11. проверка кода при регистрации
  select case when exists (select 1 from pg_trigger where tgname = 'check_signup_allowed' and not tgisinternal) then '🟢' else '🔴' end,
         'Проверка регистрации', 'auth.users → check_signup_allowed',
         case when not exists (select 1 from pg_trigger where tgname = 'check_signup_allowed' and not tgisinternal) then 'триггера НЕТ — при закрытой регистрации может зарегистрироваться кто угодно'
              when exists (select 1 from pg_proc where proname = 'confirm_signup_code') then 'триггер есть, код подтверждения номера включён'
              else 'триггер есть, но migration_phone_verify.sql не выполнен' end
  union all
  -- 12. защита роли в профиле
  select case when exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relname = 'profiles' and not t.tgisinternal) then '🟢' else '🔴' end,
         'Защита роли', 'profiles', 'триггер, не дающий назначить себе роль администратора'
  union all
  -- 13. защита статуса производства
  select case when exists (select 1 from pg_trigger where tgname = 'protect_production') then '🟢' else '🔴' end,
         'Защита производства', 'productions', 'владелец не может сам подтвердить своё производство'
)
select lvl as "Уровень", chk as "Проверка", obj as "Объект", note as "Пояснение"
from findings
order by case lvl when '🔴' then 0 when '🟡' then 1 else 2 end, chk, obj;
