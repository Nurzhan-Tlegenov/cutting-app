-- Ссылка на 3D-модель заказа для клиента (просмотр без входа в приложение).
-- Выполнить один раз в Supabase → SQL Editor (можно целиком).
--
-- model_shares: одна строка = одна открытая ссылка на заказ. Удалили строку — доступ закрыт.
-- shared_model(token): отдаёт по токену детали заказа и его 3D-модель; больше ничего
-- посторонний человек получить не может.
create table if not exists public.model_shares (
  token uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz default now()
);
alter table public.model_shares enable row level security;
drop policy if exists "own shares" on public.model_shares;
create policy "own shares" on public.model_shares for all
  using (auth.uid() = user_id or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('operator', 'admin')))
  with check (auth.uid() = user_id);

create or replace function public.shared_model(p_token uuid)
returns json language plpgsql security definer set search_path = public as $$
declare
  s record;
  o record;
  res json;
  mdl text;
  tex json;
begin
  select * into s from model_shares where token = p_token;
  if not found then return null; end if;
  select * into o from orders where id = s.order_id;
  if not found then return null; end if;
  begin
    select m.data into mdl from order_models m where m.order_id = s.order_id;
  exception when undefined_table then mdl := null;
  end;
  begin
    select coalesce(json_agg(json_build_object('name', t.name, 'data', t.data, 'size_mm', t.size_mm, 'rot', t.rot)), '[]'::json)
      into tex from material_textures t where t.user_id = o.user_id;
  exception when undefined_table then tex := '[]'::json;
  end;
  select json_build_object(
    'title', coalesce(nullif(o.order_name, ''), o.order_number),
    'material_name', o.material_name,
    'material_thickness', o.material_thickness,
    'details', (select coalesce(json_agg(json_build_object(
        'name', d.name, 'length', d.length, 'width', d.width, 'qty', d.qty,
        'edge_top', d.edge_top, 'edge_right', d.edge_right, 'edge_bottom', d.edge_bottom, 'edge_left', d.edge_left,
        'contour', d.contour) order by d.sort_order), '[]'::json)
      from order_details d where d.order_id = s.order_id),
    'model', mdl,
    'textures', coalesce(tex, '[]'::json)
  ) into res;
  return res;
end $$;
revoke all on function public.shared_model(uuid) from public;
grant execute on function public.shared_model(uuid) to anon, authenticated;
