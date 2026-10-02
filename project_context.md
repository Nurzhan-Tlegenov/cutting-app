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

## Онлайн-раскрой и буфер (NestingPage)
- Галочка «До «Стоп»» в конфигурации (по умолчанию включена): поиск идёт, пока не нажат «Стоп»
- `src/lib/liveNesting.js` — `runLiveNesting(params, {live, shouldStop, onProgress})`:
  прямоугольные детали — один непрерывный ГА, улучшения через `onProgress` (раз в ~300 мс, уже со стяжкой);
  фигурные/NFP — раунды 3→6→10→15→20→30 с, на экран — если раунд лучше
- `nestingWorker.js` протокол: start / stop → progress / done / error. «Стоп» мягкий: финал с доводкой
- `runNesting` принимает `onProgress`, `shouldStop`
- `src/components/SheetsOverview.jsx` — все листы на одном холсте, детали плавно переезжают
  при каждом улучшении (в т.ч. между листами), щипок — масштаб, тап по листу — открыть его
- Вид «Все листы / Лист N»; во время расчёта правка заблокирована
- Параллельный поиск «островами» (v1.2): одна конфигурация = несколько воркеров (ядра−1, делятся между
  одновременно идущими конфигурациями); лучший вариант (genome = порядок id + режим) рассылается
  остальным и вливается в их популяцию (`takeMigrant` в runNesting). Итог — лучший из островов
- Режимы-гены MaxRects: bssf, baf, blsf, bl, cp (касание); Guillotine: g-bssf, g-baf, g-blsf (+ g-bl для пилы)
- Ускорение ядра: `cannotFit`/`updateFreeBounds` (пропуск заполненных листов), chooseSpot без аллокаций
- Хронология раскроя: `src/lib/nestingHistory.js` пишет во время расчёта улучшения (снимки листов, поток, режим)
  и «пульс» поиска раз в 1 с (`onStats` в runNesting: вар./с, поколение, режимы в популяции, разнообразие,
  мигранты). После «Стоп» — ползунок хронологии на обзоре листов, ▶ проигрывание, «Взять этот вариант»,
  «⬇ Экспорт истории» (JSON). Очищается при «Оформить».
- Разбор экспорта: `node scripts/analyze-nesting-history.mjs файл.json [--events]` — когда встал поиск,
  потоки, режимы, вырождение популяции, ошибки укладки в каждом снимке
- v1.3 (фигурные, exactPack.js): buildPair перебирает положения первой детали (0°/180°…) и прижимает пару
  к углу; пары ищутся детерминированно (+полосы «лёжа»/«стоя») и кэшируются PAIR_CACHE; сетка пар
  (buildGridTilingSheet) перебирает все сочетания размеров; consider() хранит ПОЛНЫЙ порядок (с деталями
  листа-сетки) — раньше детали терялись; packTrueShape отбрасывает точную укладку, если число деталей ≠ заказу
- v1.4: черновик (liveNesting.roughLayout — раскладка по габаритам + roughShapePolygons), первая картинка
  прямоугольного раскроя после 1-й попытки; порог пары относительный (PAIR_MIN_DENSITY_SOFT/GAIN);
  buildPair на участке 2×2 детали, стороны 0°/180°; статус «без улучшений N с» (можно жать «Стоп»)
- v1.5 гибрид: trueShapeNesting.buildHybridPlan (пары из tileIntoPairs → прямоугольники, expand обратно
  через expandPlacement), liveNesting.runHybrid; потоки фигурных деталей: чётные — точная укладка раундами,
  нечётные — гибрид (island/islands в сообщении start воркера); поворот в прямоугольном раскрое — по
  isTurned (origX ≠ width), а НЕ по флагу rotated (при «вдоль X/Y» детали повёрнуты заранее)
- Карты: обзор ≤ 50% высоты экрана, лист ≤ 64%; настройки конфигурации скрыты во время расчёта
- v1.6 дожим последнего листа (nesting.js squeezeLast): пул из 1–3 листов + последний → packAttempt;
  принимается, если последний лист меньше; состояние дожима (sqCur) гуляет по плато; при застое >3 с
  попыток ×6. Работает и в гибриде фигурных деталей
- Проверка раскроя (src/lib/validateNesting.js) перед «Выбрать»/«Оформить»: количество каждой детали,
  выход на отступы, пересечения и зазор на рез (фигурные — по контуру), размеры и запрет поворота,
  для пилы — сквозные резы. При ошибках — красный список и кнопки «Всё равно сохранить/оформить»;
  результат привязан к раскладке (check.for === sheetsData) и станку
- v1.7 «мелкие — в центр» жёстко: nesting.smallAtEdge; better() и liveBetter(): листы → мелкие у края →
  последний лист; squeezeLast не добавляет мелких у края. UI: «Площадь до, м²» (хранится как сторона
  квадрата small_parts_max_square_side: 0,16 м² ⇔ 400), «Узкая сторона до, мм», список мелких до запуска,
  в статусе «мелкие у края: N / в центре ✓», в проверке — предупреждение
- v1.8: «у края» = nesting.smallEdgeSides: сторона ближе SMALL_EDGE_MIN=150 мм к краю и не прикрыта
  соседями (≥50% длины) → нарушение; штраф SMALL_NEAR_PENALTY в chooseSpot; мелкие ставятся после крупных
  (packAttempt); gravityAll/compactPass не открывают мелкие; repairSmall перекладывает листы с нарушением.
  На картах такие детали — оранжевые
- v1.9: миграция раскладки между потоками (migrant = genome + sheets; validLayout проверяет id);
  SQUEEZE_PER_GEN=700, при застое >2 с ×2
- v2.0 «Лист и обрезки» (NestingPage, над «Тип станка»): производство (таблица productions, выпадающий
  список виден, если есть записи), формат листа, рез, отступы ←→↑↓ — пишутся в orders.* на blur;
  при выбранном производстве (orders.production_id) из него копируются и блокируются только рез и отступы
  (PROD_LOCKED); формат листа пользователь меняет всегда (свой материал). v2.1: обрезок заполняется за 0,15 с.
  Обрезки со склада — orders.offcuts (JSON {margin, items:[{length,width,qty}]}). Миграция —
  migration_productions_offcuts.sql. Из формы нового заказа «Параметры листа» убраны (там только умолчания).
  Алгоритм: liveNesting.runLiveNesting → fillOffcuts: каждый экземпляр обрезка (крупные первыми)
  заполняется runNesting по габаритам (лучший по площади лист), остаток заказа — runCore; листы-обрезки
  идут первыми в res.sheets (stock:'offcut', свои sheetL/sheetW/usableX/usableY/отступы), res.offcutSheets.
  Миграция между потоками — только при одинаковом остатке (genome.subKey). Геометрия листа в UI/DXF/
  проверке — geoOf(order, result, sheet): свой у обрезка, иначе из результата. res.paramsKey —
  подсказка «пересчитайте», если параметры листа/обрезки поменяли после расчёта
- v2.2: runNesting укладывает в зону usable + kerf (рез у края не нужен), в результате — настоящий usableX/Y;
  liveBetter: 4-й критерий env (сумма «занятых углов» листов) — компактнее при равных листах/последнем
- v2.3: buildHybridPlan(params, choice) + pairShapes; liveNesting.chooseHybridPlan пробует сочетания форм пар
  быстрым раскроем (0 с); пара со второй сцепкой ~транспонированной — rotatable + freeTurn (направление её не
  поворачивает). src/lib/partHoles.js — внутренние вырезы (rect/с дугами/круг) → карта, обзор, DXF (слой vyrez).
  dxfExport: исправлен TDZ (sheetW до объявления). «🗑 Удалить пустой лист» в режиме листа
- v2.4: squeezeLast(…, deadline) — время дожима ≥ времени поколения (застой ×4, ≤8 с). SheetsOverview — сетка-
  галерея: cols 1..10 (щипок / кнопки −+), ширина = ширина блока, окно ≤60vh с прокруткой, sticky-холст рисует
  только видимые ряды; у мелких листов номер бейджем
- v2.5: smallEdgeSides — у узкой детали сторона ≤ edgeOkMax (порог узкой + kerf) у края допустима, угол (две
  соседние стороны у края) — всегда нарушение; rowSwapRepair/rowSwapAll — перестановка ряда одинаковых и обмен с
  соседом другого размера (freeRects пересобираются). BIG_ORDER (>300 дет.): RANDOM_PHASE_MS 3 с, POP 16, дожим ×2/×6
- v2.6: nesting.makePatternPool / colgenPack — шаблоны листа + ЛП (lpCover: симплекс с большим M, min Σx при
  покрытии спроса, π — двойственные цены) + генерация столбцов + svcPack (SVC); целое — последовательное округление
  по ЛП, хвост — SVC; мелкие у края из шаблонов убираются (stripEdgeSmall). В runNesting для BIG_ORDER (фрезер):
  colgen 8–15 с в начале, дальше листы лучших раскладок — в пул, ЛП по пулу раз в 6 с. Порог «до края» —
  smallPartsEdgeGap → p.edgeMin (orders.small_parts_edge_gap, migration_small_edge_gap.sql); p.kf — рез;
  smallAtEdge(…, real) / smallEdgeReal — проверка по настоящей зоне (+рез) снаружи укладки
- v2.7: packPatternSheet → packBlockSheet (мелкие блоком внутри, не ближе порога к краям, крупные вокруг) /
  packOneSheet; в генерации столбцов каждая 3-я попытка — packAttempt+compactUntilStable на ~3 листа; squeezeLast
  (onAccept) отдаёт удачные перекладки в пул
- v2.8: stripPermuteRepair — дерево сквозных резов листа (buildCutTree), перестановка полос/блоков на каждом
  уровне, пока мелких у края меньше; stripPermuteAll в цикле поиска и в конце; stripEdgeSmall сначала переставляет.
  packDenseThenFix (70% шаблонов): укладка без правила, потом перестановка → ЛП шаблонов с правилом = как без него
- v2.9: исправлена потеря isSmall в packDenseThenFix (v2.8 давала «118 л., 0 у края» при 205 реально у края);
  в конце runNesting признаки мелких восстанавливаются из basePieces по id. smallPartsEndSide → edgeOkMax
  («Торцом к краю до, мм», orders.small_parts_end_side; пусто — как узкая сторона, 0 — нельзя)
- v3.0: wideNarrowWide (по умолчанию для фрезера, в maybeReport и в финале): на каждом уровне дерева резов
  полосы — широкие по краям, узкие в середине, пустое — в конец; не добавляет мелких у края. Пул шаблонов:
  при одинаковом составе листа хранится раскладка с меньшим narrowEdgeScore (узкие < 300 мм у края, ≤80 мм).
  UI: значения-подсказки при включении «мелкие — в центр» (0,12 / 200 / 100), «до края» по умолчанию 100
- v3.1: relayoutForEdges в финале runNesting (фрезер, любые заказы): лист переукладывается packAttempt (300 попыток,
  для BIG_ORDER 40), берётся раскладка с меньшим narrowEdgeScore; последний лист — без роста занятой части
- Буфер: тап по детали → «В буфер» → открыть лист → «На лист N» (первое свободное место,
  поворот только если rotatable) или «На новый лист». С непустым буфером сохранить нельзя;
  пустые листы при сохранении выкидываются

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
6. [ ] Кабинет производства: создание/редактирование записей productions (таблица и выбор в раскрое уже есть)

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

## Импорт деталей (карточка заказа)
- `src/components/ImportDetails.jsx` — блок «Импорт деталей» в NewOrderPage и EditOrderPage: кнопки Excel/CSV, Базис-Мебельщик, PRO100; окно предпросмотра, выбор материала, «добавить/заменить».
- `src/lib/importDetails.js` — таблицы (.xlsx/.xls/.csv/.txt): чтение (`@e965/xlsx`, CSV в cp1251), автораспознавание колонок по шапке, сборка деталей.
- `src/lib/basisB3d.js` — чтение модели Базис-Мебельщик `.b3d` (формат BZ85, описан в шапке файла; распаковка `fflate`). Берёт панели (Type 4002): размеры, контур и вырезы, кромку (Butts), пазы (Cuts), присадку. Присадка считается пересечением отверстий крепежа (Type 3001 → FurnList.Holes) с панелью в 3D. Длина детали = размер вдоль текстуры (TexDir). Лицевой считается пласть с большей глухой обработкой. Равношаговые отверстия сворачиваются в «ряд».
- PRO100: файл проекта `.sto` закрытого формата — не читается; импорт из отчёта (список деталей) в Excel/CSV.
- Название детали из импорта хранится в `order_details.name` (свои названия не заменяются на «Деталь N»).
- Свойства детали из Базиса (ID панелей, обозначение 01.02, позиция, изделие, путь по блокам, материал, кромка по сторонам, заказ, файл) хранятся в `contour.meta` — для бирки и подписи на карте. ContourEditor сохраняет `meta` при правке контура.
- Подпись детали на карте раскроя и в DXF выбирает пользователь (наименование / обозначение / оба / позиция / без подписи): `src/lib/partLabel.js`, выбор идёт за аккаунтом (см. ниже).
- Торцевая присадка в край выреза/ступеньки: поле `edgeInset` у присадки `kind:'edge'` (на сколько торец утоплен от стороны детали) — учтено в `drillGeometry.js` и в копии внутри ContourEditor.
- Настройки пользователя за аккаунтом: `src/lib/userSettings.js` — хранятся в профиле входа Supabase (`user_metadata.app_settings`, без таблиц и миграций; копия в localStorage). Там подпись на карте (`nestLabelMode`) и `orderDefaults` — параметры раскроя, которые пользователь менял в NestingPage (лист, рез/фреза, отступы, мелкие детали, время, способ). NewOrderPage подставляет их в новый заказ вместо SHEET_DEFAULTS.
- Лицевая сторона при импорте из Базиса: правило выбирает пользователь в окне импорта (`FACE_RULES` в `basisB3d.js`: holes / groove / sum / model), выбор хранится за аккаунтом (`basisFaceRule`). Обработка с изнанки остаётся в детали (`face:'back'`), в редакторе видна; на карте раскроя не рисуется (`getAllDrillPoints(..., frontOnly)`).
- Переворот детали: `flipDetail()` в `mirrorDetail.js` (зеркало контура и кромок, лицо↔изнанка), кнопка во вкладке «Контур» редактора.
- Редактор контура с карты раскроя: долгое удержание детали (`EDIT_HOLD_MS`) → ContourEditor поверх NestingPage; сохраняет `order_details`; если силуэт изменился — раскрой сбрасывается.
- Сортировка списка деталей: `src/lib/sortDetails.js` (OrderPage — только показ; New/EditOrderPage — меняет порядок деталей).
- 3D-модель заказа из Базиса: `src/lib/model3d.js` собирает панели из `contour.meta.local` + `meta.inst` (матрица положения каждой штуки, 12 чисел: R по строкам + t), `src/components/Model3D.jsx` — просмотр на three.js (сплошной / полупрозрачный / каркас, вращение, тап по детали). Кнопка «3D-модель» в OrderPage; подгружается отдельным чанком.
- Вся модель Базиса для 3D: при импорте `parseBasis` возвращает `scene` (все панели любых материалов, профили Type 2004, фурнитура с формой из FurnList.TriData + её положения). Упаковывается `packScene` (JSON→gzip→base64, ~50 КБ) и хранится в таблице `order_models` (`migration_order_models.sql`, `src/lib/orderModel.js`). В 3D детали заказа строятся из текущего контура (с отверстиями и пазами), остальное — из scene; переключатель «Вся модель / Только детали заказа».
