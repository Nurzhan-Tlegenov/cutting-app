-- Виды кромки заказа: толщина, подрезка на толщину кромки, прифуговка.
-- { "ПВХ 2мм": { "t": 2, "trim": true, "joint": 0.5 }, "default": { ... } }
-- Выполнить один раз в Supabase → SQL Editor. Повторный запуск безопасен.
alter table public.orders add column if not exists edge_types jsonb;
