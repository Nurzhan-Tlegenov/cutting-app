-- Припуск из модели (Базис: «Припуск» у облицовки торца) — что делать с ним, решает производство:
-- allow_mode: 'model' (как в модели, по умолчанию) | 'off' (не учитывать) | 'own' (свой припуск allow_mm на тех же сторонах)
alter table productions add column if not exists allow_mode text;
alter table productions add column if not exists allow_mm numeric;

-- Артикул заказа (из модели Базиса: свойства модели → «Артикул», или вписанный вручную) — на бирку
alter table orders add column if not exists order_article text;

-- Наименьшая ширина детали на кромочном станке производства (узкие детали наращиваются, после кромки упиливаются)
alter table productions add column if not exists edge_min_width numeric;
alter table productions add column if not exists edge_min_on boolean;
