# РаскройPro — Контекст проекта

## Суть проекта
Веб-приложение (PWA) для автоматизации раскроя листового материала (ЛДСП).
Клиенты вводят детали с телефона, получают карты раскроя, оформляют заказ.
Производство видит заказы, меняет статусы, печатает бирки и УП для ЧПУ.

## Технологии
- **Frontend**: React + Vite (PWA)
- **Backend/DB**: Supabase (PostgreSQL + Auth + RLS)
- **Хостинг**: Vercel (автодеплой из GitHub)
- **Репозиторий**: https://github.com/Nurzhan-Tlegenov/cutting-app
- **Prod URL**: https://cutting-app-nine.vercel.app
- **Supabase**: https://bmcmyrdsxievaglpspcn.supabase.co

## Стандарт координат (мебельный)
- Лист: **2750×1830** — первое число Y (вертикаль), второе X (горизонталь)
- Деталь: **Длина×Ширина** — Длина=Y (вертикаль), Ширина=X (горизонталь)
- Пример: деталь 700×400 → 700 по Y (высокая), 400 по X (узкая)
- Текстура идёт вдоль Y (первого числа)

## Структура базы данных (Supabase)
```sql
-- Пользователи (через auth.users + profiles)
profiles: id (→ auth.users), email, full_name, phone, whatsapp, role (client/operator/admin)

-- Заказы
orders: id, user_id (→ auth.users), order_number, order_name, material_name,
        sheet_length(2750=Y), sheet_width(1830=X),
        margin_top, margin_right, margin_bottom, margin_left, kerf_width,
        status (draft/new/discussion/inwork/done),
        nesting_result (JSON)

-- Детали заказа
order_details: id, order_id, prefix, name, display_name,
               length(Y), width(X), qty,
               edge_top, edge_right, edge_bottom, edge_left (text),
               rotatable, sort_order, contour (JSON)
```

## SQL для новой установки
```sql
-- Профили
create table if not exists profiles (
  id uuid references auth.users(id) primary key,
  created_at timestamp default now(),
  email text, full_name text, phone text, whatsapp text,
  role text default 'client'
);
alter table profiles enable row level security;
create policy "profiles full access" on profiles for all using (true);

-- Заказы
create table if not exists orders (
  id uuid default gen_random_uuid() primary key,
  created_at timestamp default now(),
  user_id uuid references auth.users(id),
  order_number text, order_name text, material_name text default '',
  sheet_length numeric default 2750, sheet_width numeric default 1830,
  margin_top numeric default 10, margin_right numeric default 10,
  margin_bottom numeric default 10, margin_left numeric default 10,
  kerf_width numeric default 4,
  status text default 'draft',
  nesting_result text
);
alter table orders disable row level security;

-- Детали
create table if not exists order_details (
  id uuid default gen_random_uuid() primary key,
  created_at timestamp default now(),
  order_id uuid references orders(id) on delete cascade,
  prefix text, name text, display_name text,
  length numeric, width numeric, qty integer default 1,
  edge_top text, edge_right text, edge_bottom text, edge_left text,
  rotatable boolean default true, sort_order integer default 0,
  contour text
);
alter table order_details disable row level security;
```

## Номер заказа
Формат: `YYMMDD_NNN` (например 260611_001)
Генерируется автоматически в `src/lib/orderUtils.js`

## Роли пользователей
- **client** — видит свои заказы, создаёт заказы
- **operator/admin** — видит все заказы, меняет статусы

## Статусы заказа
draft → new → discussion → inwork → done

## Структура файлов
```
src/
  pages/
    AuthPage.jsx       — вход/регистрация по телефону (email генерируется автоматически)
    OrdersPage.jsx     — список заказов (удержание → мульти-выбор → удаление)
    OrderPage.jsx      — карточка заказа со статистикой и кнопкой удаления
    NewOrderPage.jsx   — создание заказа (кнопка сохранить вверху)
    EditOrderPage.jsx  — редактирование заказа (с кнопкой контура в каждой детали)
    NestingPage.jsx    — раскрой + карты листов
    ProfilePage.jsx    — профиль пользователя
  components/
    BottomNav.jsx      — нижняя навигация
    ContourEditor.jsx  — редактор контура детали
  lib/
    supabase.js        — клиент Supabase
    nesting.js         — алгоритм раскроя (Maximal Rectangles BSSF)
    orderUtils.js      — утилиты (номер заказа, статусы)
  context/
    AuthContext.jsx    — авторизация через Supabase Auth
```

## Авторизация
- Вход по номеру телефона: телефон → фейковый email `{digits}@raskoypro.local`
- Supabase Auth + таблица profiles
- При регистрации создаётся запись в profiles
- Подтверждение email ОТКЛЮЧЕНО

## Редактор контура (ContourEditor.jsx) — ключевая архитектура

### Координатная система
- 0,0 = нижний левый угол детали, Y вверх
- Canvas инвертирует Y: `canvasY = oy + dh - v.y * sc`

### Типы вершин
- `'point'` — обычная точка (r=0 острый, r>0 скругление arcTo)
- `'arc'` — контрольная точка дуги через 3+ точек
- `'fillet'` — явная дуга скругления (fcx, fcy, fr, fa0, fa1, fccw)

### Слои контура (для G-кода)
- **Detal** — внешний контур детали
- **Vyrez** — сквозные вырезы (прямоугольник, круг)
- **Paz(глубина)** — пазы с глубиной (например Paz(6), Paz(8))

### Вырезы (holes)
- Прямоугольный вырез хранит `vertices` — 4 точки (конвертируются через `holeToVertices()`)
- При изменении размеров/привязки — vertices пересчитываются (если не `_verticesEdited`)
- Можно редактировать точки выреза как внешний контур
- `activeHoleIdx` переключает контекст редактирования

### Радиус скругления
- На стыке двух прямых: `r` на вершине → `buildPath` использует arcTo
- На стыке прямой и дуги: создаются точки tp, fillet, ta через `findFillet()`
- `findFillet()` — геометрически точный центр скругления
- Превью при вводе R показывается через `previewVerts`
- Кнопка «Выбрать другой отрезок» переключает `fccw` у fillet точки

### Дуга через точки
- Выбор точек через кнопки слева + тап по canvas
- 3+ точек → кнопка «Применить дугу»
- Средние точки помечаются `type:'arc'`
- Рисуется через circumcircle formula

## Алгоритм нестинга (src/lib/nesting.js)
- Алгоритм: Maximal Rectangles Best Short Side Fit (BSSF)
- Вращение только если `rotatable=true`
- Результат сохраняется в `orders.nesting_result` как JSON

## Визуализация раскроя (NestingPage)
- Canvas: масштаб по ширине листа
- Двойной тап = поворот детали
- Одиночный тап+drag = перемещение с магнитом 50мм
- Запрет пересечений при перетаскивании

## Contour JSON структура
```json
{
  "vertices": [
    {"x": 0, "y": 0, "r": 50, "type": "point"},
    {"x": 400, "y": 0, "r": 0, "type": "point"},
    {"x": 200, "y": -50, "r": 0, "type": "arc"},
    {"x": 100, "y": 100, "r": 0, "type": "fillet",
     "fcx": 50, "fcy": 50, "fr": 30, "fa0": 0, "fa1": 1.57, "fccw": false}
  ],
  "holes": [
    {"type": "rect", "hw": 200, "hh": 100, "sides": ["top","left"],
     "offsets": {"top": 50, "left": 100},
     "vertices": [{"x":100,"y":400,"r":0,"type":"point"}, ...]},
    {"type": "circle", "d": 80, "sides": ["bottom"], "offsets": {"bottom": 30}}
  ],
  "grooves": [
    {"dir": "horizontal", "length": 300, "width": 8, "depth": 10,
     "sides": ["top"], "offsets": {"top": 0}}
  ]
}
```

## Что сделано (хронология)
1. ✅ Базовая структура React + Vite + Supabase
2. ✅ Авторизация по телефону
3. ✅ Создание/редактирование/просмотр заказов
4. ✅ Алгоритм нестинга BSSF
5. ✅ Визуализация раскроя с drag&drop
6. ✅ Редактор контура — внешний контур с точками
7. ✅ Дуга через 3+ точки (circumcircle)
8. ✅ Радиус скругления на стыке прямой и дуги (fillet)
9. ✅ Вырезы как контур с редактируемыми точками
10. ✅ Слои: Detal, Vyrez, Paz (архитектура для G-кода)
11. ✅ Удаление заказов через удержание + мульти-выбор
12. ✅ SPA routing (vercel.json)
13. ✅ Кнопка сохранить вверху страницы

## Что предстоит
1. [ ] Исправить сдвиг точек выреза (натягиваются на контур детали)
2. [ ] G-код генерация для ЧПУ
3. [ ] Бирки — PDF с QR-кодом для каждой детали
4. [ ] Кабинет производства — подтверждение заказов
5. [ ] Импорт деталей из Excel/CSV
6. [ ] Параметры листа настраиваемые производством

## Известные баги
- Сдвиг точек выреза использует `contour.vertices` вместо `getActiveVerts()`
  → нужно исправить в `moveVertex` в ContourEditor.jsx

## Команды для обновления
```bash
# В папке C:\cutting-app после изменений:
git add .
git commit -m "описание"
git push
# Vercel автоматически деплоит через ~1 минуту
```

## Supabase настройки
- Authentication → Providers → Email → Confirm email: ВЫКЛЮЧЕНО
- RLS на orders и order_details: ВЫКЛЮЧЕНО
- profiles: RLS включён, политика "full access"
