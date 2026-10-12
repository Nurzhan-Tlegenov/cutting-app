-- Пост «по умолчанию» — галочка в настройке поста («Учитывать техпроцесс по умолчанию»).
-- Выполнить один раз в Supabase → SQL Editor (можно повторно). После migration_stage_start.sql.
-- Включено — пост всегда в маршруте приходящего заказа; выключено — пост добавляется галочкой в «Операциях» заказа.
-- Не задано — по названию (раскрой, кромление, присадка — по умолчанию; остальные — по галочке).

create or replace function public.post_on_demand(p_rule jsonb, p_name text) returns boolean
language sql immutable as $$
  select not coalesce((p_rule ->> 'byDefault')::boolean,
                      not (p_rule ->> 'onDemand')::boolean,
                      coalesce(p_name, '') ~* '(раскр|распил|кром|присад|сверл)')
$$;
notify pgrst, 'reload schema';
