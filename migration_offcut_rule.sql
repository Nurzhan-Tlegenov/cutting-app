-- Деловой обрезок по правилу производства: от какого размера свободный кусок листа отмечается обрезком сам
-- (раскрой фрезером ЧПУ и на форматно-раскроечном станке). Пусто — выключено.
alter table productions add column if not exists offcut_min_length numeric;   -- вдоль текстуры (длина, Y), мм
alter table productions add column if not exists offcut_min_width numeric;    -- поперёк текстуры (ширина, X), мм
