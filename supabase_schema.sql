-- Профили пользователей
create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  email text,
  full_name text,
  phone text,
  whatsapp text,
  role text default 'client' check (role in ('client', 'operator', 'admin')),
  created_at timestamptz default now()
);

-- Заказы
create table public.orders (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.profiles(id) on delete cascade,
  order_number text unique not null,
  material_name text default 'Без названия',
  sheet_length numeric default 2750,
  sheet_width numeric default 1830,
  margin_top numeric default 10,
  margin_right numeric default 10,
  margin_bottom numeric default 10,
  margin_left numeric default 10,
  kerf_width numeric default 4,
  status text default 'draft' check (status in ('draft','new','discussion','inwork','done')),
  submitted_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Детали заказа
create table public.order_details (
  id uuid default gen_random_uuid() primary key,
  order_id uuid references public.orders(id) on delete cascade,
  prefix text,
  name text not null,
  display_name text,
  length numeric not null,
  width numeric not null,
  qty integer default 1,
  edge_top boolean default false,
  edge_right boolean default false,
  edge_bottom boolean default false,
  edge_left boolean default false,
  rotatable boolean default false,
  sort_order integer default 0,
  created_at timestamptz default now()
);

-- RLS (Row Level Security)
alter table public.profiles enable row level security;
alter table public.orders enable row level security;
alter table public.order_details enable row level security;

-- Политики для profiles
create policy "Пользователь видит свой профиль"
  on profiles for select using (auth.uid() = id);

create policy "Операторы видят всех"
  on profiles for select using (
    exists (select 1 from profiles where id = auth.uid() and role in ('operator','admin'))
  );

create policy "Пользователь создаёт свой профиль"
  on profiles for insert with check (auth.uid() = id);

create policy "Пользователь обновляет свой профиль"
  on profiles for update using (auth.uid() = id);

-- Политики для orders
create policy "Клиент видит свои заказы"
  on orders for select using (user_id = auth.uid());

create policy "Оператор видит все заказы"
  on orders for select using (
    exists (select 1 from profiles where id = auth.uid() and role in ('operator','admin'))
  );

create policy "Клиент создаёт заказы"
  on orders for insert with check (user_id = auth.uid());

create policy "Клиент обновляет свои черновики"
  on orders for update using (user_id = auth.uid() and status = 'draft');

create policy "Оператор обновляет любой заказ"
  on orders for update using (
    exists (select 1 from profiles where id = auth.uid() and role in ('operator','admin'))
  );

-- Политики для order_details
create policy "Клиент видит детали своих заказов"
  on order_details for select using (
    exists (select 1 from orders where id = order_id and user_id = auth.uid())
  );

create policy "Оператор видит все детали"
  on order_details for select using (
    exists (select 1 from profiles where id = auth.uid() and role in ('operator','admin'))
  );

create policy "Клиент добавляет детали к своим заказам"
  on order_details for insert with check (
    exists (select 1 from orders where id = order_id and user_id = auth.uid())
  );

-- Функция автообновления updated_at
create or replace function update_updated_at()
returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

create trigger orders_updated_at before update on orders
  for each row execute function update_updated_at();
