-- Припуск из модели (Базис: «Припуск» у облицовки торца) — что делать с ним, решает производство:
-- allow_mode: 'model' (как в модели, по умолчанию) | 'off' (не учитывать) | 'own' (свой припуск allow_mm на тех же сторонах)
alter table productions add column if not exists allow_mode text;
alter table productions add column if not exists allow_mm numeric;
