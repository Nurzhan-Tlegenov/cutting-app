-- 3D-модель заказа, импортированного из Базиса (вся модель: панели всех
-- материалов, профили, фурнитура). Хранится отдельно от orders, чтобы не
-- утяжелять список заказов. Выполнить один раз в Supabase → SQL Editor.
create table if not exists public.order_models (
  order_id uuid primary key references public.orders(id) on delete cascade,
  data text not null,
  created_at timestamptz default now()
);
alter table public.order_models disable row level security;
