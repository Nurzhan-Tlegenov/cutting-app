/* eslint-disable react-refresh/only-export-components -- экраны отдаются плееру одним объектом SCREENS */
// Экраны обучающего видео: упрощённые копии настоящих экранов приложения (те же подписи и расположение),
// которые «играет» плеер DemoVideo. Состояние экрана (st) собирают шаги сценария; элементы, куда показывает
// палец, помечены data-demo="…". Размер холста — 360×700, плеер масштабирует его под экран телефона.

const C = { blue: 'var(--blue)', hint: 'var(--text-hint)', muted: 'var(--text-muted)', bg2: 'var(--bg2)', border: 'var(--border)', bmd: 'var(--border-md)' }

const Head = ({ title, sub, left = '←', right }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px 10px' }}>
    <span style={{ color: left === '☰' ? 'var(--text)' : C.blue, fontSize: left === '☰' ? 20 : 22, lineHeight: 1, width: 18 }}>{left}</span>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 17, fontWeight: 500 }}>{title}</div>
      {sub && <div style={{ fontSize: 11.5, color: C.hint }}>{sub}</div>}
    </div>
    {right}
  </div>
)
const Card = ({ children, style, ...p }) => <div {...p} style={{ background: 'var(--bg)', border: `0.5px solid ${C.border}`, borderRadius: 12, padding: '9px 12px', margin: '0 12px 8px', ...style }}>{children}</div>
const Pill = ({ children, on, main, style, ...p }) => (
  <span {...p} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '6px 12px', borderRadius: 18, fontSize: 12, whiteSpace: 'nowrap',
    border: main ? 'none' : `0.5px solid ${on ? C.blue : C.bmd}`, background: main ? C.blue : on ? 'var(--blue-light)' : 'transparent', color: main ? '#fff' : on ? C.blue : C.muted, ...style }}>{children}</span>
)
const Caret = () => <span className="demo-caret" />
// поле ввода: значение, плейсхолдер, курсор, пока печатается
const Field = ({ id, label, value, ph, st, w, style }) => (
  <div style={{ flex: w ? `0 0 ${w}px` : 1, minWidth: 0, ...style }}>
    {label && <div style={{ fontSize: 10.5, color: C.muted, marginBottom: 2 }}>{label}</div>}
    <div data-demo={id} style={{ border: `${st.focus === id ? 1.5 : 0.5}px solid ${st.focus === id ? C.blue : C.bmd}`, borderRadius: 7, padding: '6px 7px', fontSize: 13, minHeight: 18, whiteSpace: 'nowrap', overflow: 'hidden' }}>
      {value ? <span>{value}</span> : st.focus === id ? null : <span style={{ color: C.hint }}>{ph}</span>}
      {st.focus === id && <Caret />}
    </div>
  </div>
)
const Badge = ({ s }) => {
  const m = { new: ['Новый', 'var(--gray-light)', 'var(--gray)'], inwork: ['Принят в работу', 'var(--blue-light)', 'var(--blue-dark)'], done: ['Исполнен', 'var(--teal-light)', 'var(--teal)'], draft: ['Черновик', C.bg2, C.hint] }[s]
  return <span style={{ padding: '3px 8px', borderRadius: 20, fontSize: 11, fontWeight: 500, background: m[1], color: m[2], whiteSpace: 'nowrap' }}>{m[0]}</span>
}
const Nav = () => (
  <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 52, borderTop: `0.5px solid ${C.border}`, background: 'var(--bg)', display: 'flex', justifyContent: 'space-around', alignItems: 'center', fontSize: 10.5, color: C.hint }}>
    {['Заказы', 'Новый', 'Сообщения', 'Профиль'].map((t, i) => <span key={t} style={{ color: i === 0 ? C.blue : C.hint, textAlign: 'center' }}><span style={{ display: 'block', fontSize: 16 }}>{['▤', '＋', '✉', '◯'][i]}</span>{t}</span>)}
  </div>
)

// ── Клиент ──────────────────────────────────────────────────────────────────────────────────────────────
function Orders({ st }) {
  const list = [
    ...(st.sent ? [{ id: 'ord1', t: st.name || 'Кухня Ивановых', m: `${st.mat || 'ЛДСП Белый 16'} · 6 дет. · 2 листа`, s: st.status || 'new' }] : []),
    { t: 'Шкаф-купе Петровых', m: 'ЛДСП Дуб сонома 16 · 24 дет.', s: 'done' },
    { t: 'Прихожая', m: 'ЛДСП Белый 16 · 11 дет.', s: 'draft' },
  ]
  return (
    <>
      <Head left="☰" title="Мои заказы" right={<Pill main data-demo="new">+ Новый</Pill>} />
      {list.map((o, i) => (
        <Card key={i} data-demo={o.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 500, fontSize: 14 }}>{o.t}</div>
            <div style={{ fontSize: 11.5, color: C.muted }}>{o.m}</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
            <Badge s={o.s} />
            {o.s !== 'done' && <span data-demo={o.id ? 'edit' : undefined} style={{ fontSize: 11, color: C.blue }}>✎ Редактировать</span>}
          </div>
        </Card>
      ))}
      <Nav />
    </>
  )
}

const EDGES = [['left', 'Дл'], ['right', 'Дп'], ['top', 'Шв'], ['bottom', 'Шн']]
function DetRow({ n, st, d, e = {} }) {
  const p = `d${n}`
  return (
    <Card style={{ padding: '6px 10px', marginBottom: 5 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <div style={{ width: 24, textAlign: 'center', fontSize: 11, color: C.hint }}>
          #{n}
          <div data-demo={`${p}contour`} style={{ marginTop: 2, border: `0.5px solid ${n === 1 && st.hasContour ? 'var(--teal)' : C.bmd}`, borderRadius: 4, fontSize: 11, color: n === 1 && st.hasContour ? 'var(--teal)' : C.hint, background: n === 1 && st.hasContour ? 'var(--teal-light)' : C.bg2 }}>{n === 1 && st.hasContour ? '✦' : '◇'}</div>
        </div>
        <Field id={`${p}len`} value={d[0]} ph="Длина" st={st} />
        <Field id={`${p}wid`} value={d[1]} ph="Ширина" st={st} />
        <Field id={`${p}qty`} value={d[2]} ph="Кол" st={st} w={46} />
        <span style={{ color: C.hint }}>✕</span>
      </div>
      {st.showEdge && (
        <div style={{ display: 'flex', gap: 4, marginTop: 5, alignItems: 'center' }}>
          <span style={{ fontSize: 10.5, color: C.hint, width: 44 }}>Кромка:</span>
          {EDGES.map(([k, l]) => (
            <span key={k} data-demo={`${p}e-${k}`} style={{ flex: 1, textAlign: 'center', padding: '4px 0', borderRadius: 7, fontSize: 10, lineHeight: 1.25, border: e[k] ? `1.5px solid ${C.blue}` : `0.5px solid ${C.bmd}`, background: e[k] ? 'var(--blue-light)' : 'transparent', color: e[k] ? 'var(--blue-dark)' : C.hint }}>
              {l}{e[k] && <div style={{ fontSize: 8.5, fontWeight: 500 }}>ПВХ 2</div>}
            </span>
          ))}
          <span style={{ padding: '4px 6px', borderRadius: 7, fontSize: 10, border: `0.5px solid ${C.bmd}`, color: C.hint }}>↻</span>
        </div>
      )}
    </Card>
  )
}

function NewOrder({ st }) {
  const rows = [[st.d1len, st.d1wid, st.d1qty], st.d2 || ['', '', ''], st.d3 || ['', '', '']].slice(0, st.rows || 1)
  return (
    <>
      <Head title="Новый заказ" right={<Pill main data-demo="save">Сохранить заказ ({rows.filter(r => r[0]).length} дет.)</Pill>} />
      <Card>
        <div style={{ display: 'flex', gap: 7 }}>
          <Field id="name" label="Название заказа" value={st.name} ph="Кухня Ивановых" st={st} />
          <Field id="mat" label="Материал" value={st.mat} ph="ЛДСП Белый 16мм" st={st} />
          <Field id="thk" label="Толщ." value="16" st={st} w={44} />
        </div>
      </Card>
      <Card data-demo="edges">
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
          <span style={{ fontWeight: 500, color: st.edge ? C.blue : C.hint }}>Виды кромки {st.edge ? '(1)' : ''}{st.edge && <span style={{ fontWeight: 400, fontSize: 11 }}> · активная: {st.edge}</span>}</span>
          <span style={{ fontSize: 10, color: C.hint }}>▼</span>
        </div>
        {st.edgesOpen && (
          <div style={{ marginTop: 7, display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
            <span style={{ flex: 1, padding: '5px 8px', borderRadius: 7, border: `1.5px solid ${C.blue}`, background: 'var(--blue-light)', color: 'var(--blue-dark)' }}>{st.edge || 'ПВХ 2'} · толщина 2 мм ✓</span>
            <span style={{ color: C.blue, fontSize: 12 }}>+ кромка</span>
          </div>
        )}
      </Card>
      <Card data-demo="import" style={{ fontSize: 13, color: C.muted, display: 'flex', alignItems: 'center', gap: 8 }}>⇪ Импорт деталей <span style={{ fontSize: 11, color: C.hint }}>Excel · Базис · PRO100 · Астра · PDF</span></Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 14px 6px', fontSize: 12.5, color: C.muted }}>
        <span style={{ flex: 1 }}>Детали ({rows.length})</span>
        <Pill data-demo="showEdge" on={st.showEdge} style={{ padding: '3px 10px', fontSize: 11.5 }}>{st.showEdge ? 'Скрыть кромку' : 'Показать кромку'}</Pill>
      </div>
      {rows.map((d, i) => <DetRow key={i} n={i + 1} st={st} d={d} e={i === 0 ? st.e1 : i === 1 ? st.e2 : undefined} />)}
      <div style={{ margin: '4px 12px', padding: 9, border: `0.5px dashed ${C.bmd}`, borderRadius: 8, textAlign: 'center', fontSize: 13, color: C.hint }}>+ Добавить деталь</div>
      {st.contour && <ContourPanel st={st} />}
    </>
  )
}

// редактор контура — поверх бланка
function ContourPanel({ st }) {
  const r = st.radius ? 22 : 0
  return (
    <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'flex-end' }}>
      <div style={{ width: '100%', background: 'var(--bg)', borderRadius: '16px 16px 0 0', padding: '12px 14px 18px' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
          <b style={{ flex: 1, fontSize: 14, fontWeight: 500 }}>Редактор контура · #1 720×560</b>
          <span data-demo="contourClose" style={{ width: 28, height: 28, borderRadius: 14, background: C.bg2, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>×</span>
        </div>
        <svg viewBox="0 0 220 200" width="100%" height="200">
          <text x="110" y="14" textAnchor="middle" fontSize="10" fill="var(--text-hint)">560</text>
          <text x="12" y="105" textAnchor="middle" fontSize="10" fill="var(--text-hint)" transform="rotate(-90 12 105)">720</text>
          <path d={`M40 22 H${180 - r} ${r ? `A${r} ${r} 0 0 1 180 ${22 + r}` : ''} V190 H40 Z`} fill="var(--blue-light)" stroke="var(--blue)" strokeWidth="1.5" style={{ transition: 'd .5s' }} />
          {[[40, 22], [180, 22], [180, 190], [40, 190]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r={i === 1 ? 6 : 4} fill={i === 1 ? 'var(--blue)' : 'var(--bg)'} stroke="var(--blue)" data-demo={i === 1 ? 'corner' : undefined} />)}
          {r > 0 && <text x="150" y="48" fontSize="10" fill="var(--blue)">R50</text>}
        </svg>
        <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
          <Pill data-demo="cornerR" on={st.radius}>◜ Радиус 50</Pill><Pill>Фаска</Pill><Pill>Вырез</Pill><Pill>Паз</Pill><Pill>Присадка</Pill>
        </div>
      </div>
    </div>
  )
}

// раскладка деталей на двух листах (в мм листа 1830×2750)
const PARTS = [
  [10, 10, 560, 720], [580, 10, 560, 720], [1150, 10, 300, 2000], [1460, 10, 300, 2000], [10, 740, 560, 720], [580, 740, 560, 720],
  [10, 1470, 400, 900], [420, 1470, 400, 900], [830, 1470, 300, 600],
]
const PARTS2 = [[10, 10, 300, 2000], [320, 10, 300, 2000], [630, 10, 560, 720], [1200, 10, 560, 720]]
function Sheet({ parts, animate, rot, id, w = 150 }) {
  const k = w / 1830
  return (
    <svg data-demo={id} viewBox={`0 0 ${1830 * k} ${2750 * k}`} width={w} height={2750 * k} style={{ background: 'var(--bg2)', borderRadius: 4, border: `0.5px solid ${C.bmd}`, flexShrink: 0 }}>
      {parts.map(([x, y, pw, ph], i) => {
        const turned = rot && i === 8
        const [W, H] = turned ? [ph, pw] : [pw, ph]
        return (
          <g key={i} className={animate ? 'demo-part' : undefined} style={animate ? { animationDelay: `${(i * 0.32) % 2.6}s` } : undefined}>
            <rect x={x * k} y={y * k} width={W * k} height={H * k} rx="1.5" fill={turned ? 'var(--blue-light)' : 'var(--bg)'} stroke={turned ? 'var(--blue)' : 'var(--text-hint)'} strokeWidth="0.8" data-demo={i === 8 ? 'part9' : undefined} />
            {W * k > 26 && <text x={(x + W / 2) * k} y={(y + H / 2) * k + 3} textAnchor="middle" fontSize="7" fill="var(--text-muted)">{H}×{W}</text>}
          </g>
        )
      })}
    </svg>
  )
}

function Nesting({ st }) {
  const done = st.done || st.running
  return (
    <>
      <Head title="Раскрой" sub={st.name || 'Кухня Ивановых'} right={<span style={{ fontSize: 11.5, color: C.blue, border: `0.5px solid ${C.blue}`, borderRadius: 14, padding: '3px 8px' }}>✎ Редактировать</span>} />
      <div data-demo="stats" style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 5, margin: '0 12px 8px' }}>
        {[['Листов', done ? '2' : '—'], ['Деталей', '13'], ['Кромка, м', '9.84'], ['Площадь', '6.1']].map(([l, v]) => (
          <div key={l} style={{ background: C.bg2, borderRadius: 8, padding: '4px 7px' }}><div style={{ fontSize: 9.5, color: C.hint }}>{l}</div><div style={{ fontSize: 15, fontWeight: 500 }}>{v}</div></div>
        ))}
      </div>
      <Card data-demo="sheet" style={{ padding: '7px 10px' }}>
        <div style={{ fontSize: 13, fontWeight: 500 }}>{st.sheetOpen ? '▼' : '▶'} Лист и обрезки</div>
        {!st.sheetOpen && <div style={{ fontSize: 10.5, color: C.hint }}>2750×1830 · рез 4 · отступы 10{st.prod ? ` · ${st.prod}` : ''}</div>}
        {st.sheetOpen && (
          <div style={{ marginTop: 7, fontSize: 11.5, color: C.muted }}>
            Производство
            <div data-demo="prodSel" style={{ border: `0.5px solid ${C.bmd}`, borderRadius: 7, padding: '6px 8px', fontSize: 13, color: st.prod ? 'var(--text)' : C.hint, marginTop: 2 }}>{st.prod || 'Выберите производство ▾'}</div>
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>{[['Лист', '2750×1830'], ['Рез', '4'], ['Отступы', '10']].map(([l, v]) => <div key={l} style={{ flex: 1 }}>{l}<div style={{ border: `0.5px solid ${C.bmd}`, borderRadius: 7, padding: '4px 6px', color: 'var(--text)', opacity: st.prod && l !== 'Лист' ? 0.55 : 1 }}>{v}</div></div>)}</div>
          </div>
        )}
      </Card>
      <div data-demo="machine" style={{ display: 'flex', gap: 6, margin: '0 12px 8px' }}>
        {['Фрезер (ЧПУ)', 'Пила (форматник)'].map((l, i) => <span key={l} style={{ flex: 1, textAlign: 'center', padding: '6px 0', borderRadius: 8, fontSize: 12, background: i === 0 ? C.blue : C.bg2, color: i === 0 ? '#fff' : C.muted }}>{l}</span>)}
      </div>
      <Card style={{ padding: '8px 10px' }}>
        <div style={{ fontSize: 12.5, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
          ▼ Конфигурация 1 · авто
          {st.running && <span className="demo-spin" />}
        </div>
        <div style={{ fontSize: 10.5, color: C.hint, marginBottom: 6 }}>до «Стоп» · {st.running ? 'идёт поиск… 2 листа · загрузка 84%' : st.done ? '2 листа · загрузка 86%' : 'не рассчитан'}</div>
        {done && (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', margin: '4px 0 8px' }}>
            <Sheet id="sheet1" parts={PARTS} animate={st.running} rot={st.rot} />
            <Sheet parts={PARTS2} animate={st.running} />
          </div>
        )}
        {!st.done && <div data-demo={st.running ? 'stop' : 'run'} style={{ textAlign: 'center', padding: 8, borderRadius: 8, fontSize: 13, fontWeight: 500, background: st.running ? 'var(--danger-light)' : C.blue, color: st.running ? 'var(--danger)' : '#fff' }}>{st.running ? '■ Стоп' : '▶ Выполнить раскрой'}</div>}
        {st.done && (
          <div style={{ display: 'flex', gap: 6 }}>
            <span data-demo="pick" style={{ flex: 1, textAlign: 'center', padding: 8, borderRadius: 8, fontSize: 13, fontWeight: 500, border: '0.5px solid var(--teal)', background: st.picked ? '#e6f4ea' : 'var(--teal-light)', color: st.picked ? '#1e7e34' : 'var(--teal)' }}>{st.picked ? '✓ Выбран' : 'Выбрать'}</span>
            <span data-demo="pdf" style={{ padding: '8px 12px', borderRadius: 8, fontSize: 13, border: `0.5px solid ${C.bmd}`, color: C.muted }}>PDF</span>
          </div>
        )}
        {st.picked && <div data-demo="send" style={{ marginTop: 6, textAlign: 'center', padding: 8, borderRadius: 8, fontSize: 13, fontWeight: 500, background: st.sent ? C.bg2 : C.blue, color: st.sent ? C.hint : '#fff' }}>{st.sent ? '✓ Отправлен' : 'Отправить заказ'}</div>}
      </Card>
      {st.confirm && (
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: 280, background: 'var(--bg)', borderRadius: 14, padding: 16 }}>
            <div style={{ fontSize: 14, marginBottom: 6 }}>Отправить заказ на производство «{st.prod || 'Мебельный цех'}»?</div>
            <div style={{ fontSize: 12, color: C.muted, marginBottom: 12 }}>Пока производство не приняло заказ, его можно отозвать кнопкой «Редактировать».</div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 16, fontSize: 14, color: C.blue }}><span>Отмена</span><span data-demo="confirmOk" style={{ fontWeight: 600 }}>OK</span></div>
          </div>
        </div>
      )}
    </>
  )
}

// ── Производство ───────────────────────────────────────────────────────────────────────────────────────
const MENU = [['setCompany', '🏭', 'Мебельный цех', 'KZ · Алматы · +7 701 …'], ['setStaff', '👥', 'Сотрудники', 'Рабочие места, права'], ['setPrices', '🏷', 'Прайс-лист', 'Распил, кромление, присадка'], ['setSheet', '⚙', 'Параметры станка', 'Рез и отступы — по типу материала'], ['setPost', '⌗', 'Постпроцессоры', 'Станки ЧПУ, инструменты, обработка']]
function Production({ st }) {
  const tab = st.tab || 'orders'
  return (
    <>
      <Head left="☰" title="Производство" />
      <div style={{ display: 'flex', gap: 4, background: C.bg2, borderRadius: 18, padding: 3, margin: '0 12px 10px' }}>
        {[['orders', 'Заказы · 3'], ['board', 'Техпроцесс'], ['settings', '⚙ Настройки']].map(([k, l]) => (
          <span key={k} data-demo={k === 'settings' ? 'tabSettings' : k === 'orders' ? 'tabOrders' : undefined} style={{ flex: 1, textAlign: 'center', padding: '5px 0', borderRadius: 15, fontSize: 12, fontWeight: tab === k ? 600 : 400, background: tab === k ? 'var(--bg)' : 'transparent', color: tab === k ? C.blue : C.muted, boxShadow: tab === k ? '0 1px 2px rgba(0,0,0,.12)' : 'none' }}>{l}</span>
        ))}
      </div>
      {tab === 'settings' && !st.sec && (
        <Card style={{ padding: 4 }}>
          {MENU.map(([id, ico, t, s], i) => (
            <div key={id} data-demo={id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 8px', borderTop: i ? `0.5px solid ${C.border}` : 'none' }}>
              <span style={{ width: 32, height: 32, borderRadius: 9, background: 'var(--blue-light)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 15 }}>{ico}</span>
              <span style={{ flex: 1 }}><span style={{ display: 'block', fontSize: 13.5, fontWeight: 500 }}>{t}</span><span style={{ fontSize: 11, color: C.hint }}>{s}</span></span>
              <span style={{ color: C.hint }}>›</span>
            </div>
          ))}
        </Card>
      )}
      {tab === 'settings' && st.sec === 'sheet' && (
        <Card>
          <div data-demo="back" style={{ color: C.blue, fontSize: 13, marginBottom: 8 }}>‹ Настройки</div>
          <div style={{ fontWeight: 500, fontSize: 14, marginBottom: 6 }}>Параметры станка</div>
          {[['Плита (ЛДСП, МДФ) — фрезер ЧПУ', 'kerf'], ['ХДФ, ДВП — пила', 'kerfH']].map(([t, k]) => (
            <div key={k} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, color: C.muted, marginBottom: 4 }}>{t}</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <Field id={k} label="Рез, мм" value={st[k]} ph="—" st={st} />
                {['←', '→', '↑', '↓'].map(a => <Field key={a} id={k + a} label={`Отступ ${a}`} value={st[k] ? '10' : ''} ph="—" st={st} />)}
              </div>
            </div>
          ))}
        </Card>
      )}
      {tab === 'settings' && st.sec === 'post' && (
        <Card>
          <div data-demo="back" style={{ color: C.blue, fontSize: 13, marginBottom: 8 }}>‹ Настройки</div>
          <div style={{ fontWeight: 500, fontSize: 14 }}>Постпроцессор: Мой фрезер</div>
          <div style={{ display: 'flex', gap: 5, margin: '8px 0', flexWrap: 'wrap' }}>{['Основные', 'Инструменты', 'Обработка', 'Команды'].map((t, i) => <Pill key={t} on={i === 1} style={{ padding: '4px 9px', fontSize: 11 }}>{t}</Pill>)}</div>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 4 }}>Фрезы</div>
          {st.tool && <div className="demo-pop" style={{ border: `0.5px solid ${C.bmd}`, borderRadius: 8, padding: '6px 8px', fontSize: 12, marginBottom: 6 }}><b style={{ fontWeight: 500 }}>T1 · Фреза 6 мм</b><div style={{ color: C.muted, fontSize: 11 }}>18 000 об/мин · подача 9 м/мин · проход 9 мм</div></div>}
          <div data-demo="addTool" style={{ padding: 7, border: `0.5px dashed ${C.bmd}`, borderRadius: 8, textAlign: 'center', fontSize: 12.5, color: C.blue }}>+ Фреза</div>
        </Card>
      )}
      {tab === 'orders' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 5, margin: '0 12px 8px' }}>
            {[['Заявок', 3], ['Принято', st.accepted ? 2 : 1], ['Исполнено', st.finished ? 2 : 1]].map(([l, v]) => <div key={l} style={{ background: C.bg2, borderRadius: 8, padding: '3px 8px', display: 'flex', justifyContent: 'space-between', fontSize: 11, color: C.hint }}>{l}<b style={{ color: 'var(--text)', fontSize: 14, fontWeight: 500 }}>{v}</b></div>)}
          </div>
          <Card data-demo="order" style={{ padding: '8px 12px' }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <span style={{ fontSize: 11, color: C.hint }}>{st.open ? '▾' : '▸'}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 500, fontSize: 14 }}>Кухня Ивановых</div>
                <div style={{ fontSize: 11.5, color: C.muted }}>ЛДСП Белый 16 · листов 2</div>
                <div style={{ fontSize: 11.5 }}>Алибек <span style={{ color: C.blue }}>+7 701 555 12 34</span></div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                <Badge s={st.finished ? 'done' : st.accepted ? 'inwork' : 'new'} />
                {st.accepted && <div data-demo="marks" style={{ display: 'flex', gap: 3 }}>{[['G-код', st.built], ['Файлы', st.saved]].map(([l, on]) => <span key={l} style={{ fontSize: 10, borderRadius: 9, padding: '0 6px', border: `0.5px solid ${on ? C.blue : C.bmd}`, color: on ? C.blue : C.hint, background: on ? 'var(--blue-light)' : 'transparent' }}>{l}</span>)}</div>}
              </div>
            </div>
            {st.open && (
              <div style={{ display: 'flex', gap: 5, marginTop: 8, flexWrap: 'wrap' }}>
                {!st.accepted && <Pill main data-demo="accept">✓ Принять</Pill>}
                {st.accepted && !st.finished && <Pill main data-demo="done">Исполнен</Pill>}
                <Pill data-demo="openOrder">Открыть</Pill>
                <Pill style={{ color: 'var(--teal)', borderColor: 'var(--teal)' }}>WhatsApp</Pill>
                <Pill style={{ color: 'var(--amber)', borderColor: 'var(--amber)' }}>↩ Вернуть на доработку</Pill>
              </div>
            )}
          </Card>
          <Card style={{ padding: '8px 12px', opacity: 0.6 }}><div style={{ fontWeight: 500, fontSize: 14 }}>Шкаф-купе Петровых</div><div style={{ fontSize: 11.5, color: C.muted }}>ЛДСП Дуб сонома 16 · листов 5</div></Card>
        </>
      )}
    </>
  )
}

function OrderView() {
  return (
    <>
      <Head title="Кухня Ивановых" sub="Алибек · +7 701 555 12 34" right={<Badge s="inwork" />} />
      <Card style={{ fontSize: 12.5, color: C.muted }}><b style={{ color: 'var(--text)', fontWeight: 500 }}>ЛДСП Белый 16</b> · 13 дет. · карты ниже<div style={{ fontSize: 11.5, color: C.hint }}>Лист 2750×1830 мм</div></Card>
      <div data-demo="maps" style={{ margin: '0 12px' }}>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', background: C.bg2, borderRadius: 10, padding: 10 }}>
          <Sheet parts={PARTS} w={130} /><Sheet parts={PARTS2} w={130} />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <span style={{ flex: 1, textAlign: 'center', padding: 9, borderRadius: 8, fontSize: 13, border: `0.5px solid ${C.bmd}` }}>Открыть / перекроить</span>
          <span data-demo="cnc" style={{ flex: 1, textAlign: 'center', padding: 9, borderRadius: 8, fontSize: 13, background: C.blue, color: '#fff', fontWeight: 500 }}>ЧПУ</span>
          <span data-demo="labels" style={{ flex: 1, textAlign: 'center', padding: 9, borderRadius: 8, fontSize: 13, border: `0.5px solid ${C.bmd}` }}>Бирки</span>
        </div>
      </div>
    </>
  )
}

// путь фрезы на листе для симулятора (в координатах svg 150×225)
const SIM_PATH = 'M5 5 L50 5 L50 64 L5 64 Z M55 5 L100 5 L100 64 L55 64 Z M74 128 L98 128 L98 177 L74 177 Z M5 125 L37 125 L37 197 L5 197 Z M39 125 L71 125 L71 197 L39 197 Z M5 66 L50 66 L50 125 L5 125 Z M55 66 L100 66 L100 125 L55 125 Z M102 5 L126 5 L126 168 L102 168 Z M128 5 L145 5 L145 168 L128 168 Z'
function Cnc({ st }) {
  return (
    <>
      <Head title="ЧПУ · Кухня Ивановых" right={<span style={{ fontSize: 11, color: C.blue, border: `0.5px solid ${C.blue}`, borderRadius: 14, padding: '3px 8px' }}>Перейти к заказам</span>} />
      <div data-demo="cncTabs" style={{ display: 'flex', gap: 5, margin: '0 12px 10px', overflow: 'hidden' }}>
        {['Листы', 'Обработка', 'Инструменты', 'Основные', 'Команды'].map((t, i) => <Pill key={t} on={i === 0} style={{ padding: '4px 9px', fontSize: 11.5 }}>{t}</Pill>)}
      </div>
      <Card data-demo="post" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: C.muted }}>
        <div style={{ flex: 1 }}>Постпроцессор: <b style={{ color: 'var(--text)', fontWeight: 500 }}>Мой фрезер</b><div>ЛДСП Белый 16 · 16 мм · поле 2100×3000</div></div>
        <Pill style={{ padding: '4px 10px' }}>Настроить</Pill>
      </Card>
      <div data-demo="sheets" style={{ margin: '0 12px' }}>
        <div style={{ display: 'flex', fontSize: 12.5, color: C.muted, margin: '4px 2px 6px' }}><span style={{ flex: 1 }}>Листы (2 из 2)</span><span style={{ color: C.blue, fontSize: 12 }}>PDF карт</span></div>
        {[1, 2].map(n => (
          <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 8, border: `0.5px solid ${C.border}`, borderRadius: 10, padding: '7px 10px', marginBottom: 6, fontSize: 12.5 }}>
            <span style={{ width: 16, height: 16, borderRadius: 4, background: C.blue, color: '#fff', fontSize: 11, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>✓</span>
            <span style={{ flex: 1 }}>Лист {n} · {n === 1 ? 9 : 4} дет.{st.built && <span style={{ color: C.hint }}> · Kuhnya_LDSP_{n}.nc</span>}</span>
            {st.built && <span data-demo={n === 1 ? 'sim1' : undefined} className="demo-pop" style={{ fontSize: 11, padding: '3px 8px', borderRadius: 14, background: 'var(--blue-light)', color: 'var(--blue-dark)', border: `0.5px solid ${C.blue}` }}>▶ Симулятор</span>}
          </div>
        ))}
      </div>
      <div style={{ margin: '6px 12px' }}>
        <div data-demo="build" style={{ textAlign: 'center', padding: 10, borderRadius: 8, fontSize: 14, fontWeight: 500, background: C.blue, color: '#fff' }}>{st.built ? '↻ Создать G-код заново' : 'Создать G-код'}</div>
        {st.built && <div data-demo="saveAll" className="demo-pop" style={{ marginTop: 8, textAlign: 'center', padding: 10, borderRadius: 8, fontSize: 14, border: `0.5px solid ${C.bmd}` }}>{st.saved ? '✓ Файлы сохранены' : '⬇ Сохранить все файлы (2)'}</div>}
      </div>
      {st.sim && (
        <div style={{ position: 'absolute', inset: 0, background: '#1d2430', color: '#dfe6ee', padding: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}><b style={{ flex: 1, fontWeight: 500, fontSize: 13 }}>Симулятор · Kuhnya_LDSP_1.nc</b><span data-demo="simClose" style={{ width: 28, height: 28, borderRadius: 14, background: 'rgba(255,255,255,.12)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>×</span></div>
          <svg data-demo="simView" viewBox="0 0 150 225" width="100%" height="430" style={{ background: '#2a3342', borderRadius: 8, transform: 'perspective(600px) rotateX(18deg)' }}>
            <rect x="1" y="1" width="148" height="223" fill="#c9b48f" opacity=".35" />
            <path d={SIM_PATH} fill="none" stroke="#5f7189" strokeWidth=".6" strokeDasharray="2 2" />
            <path id="demo-sim-path" d={SIM_PATH} fill="none" stroke="#4fc3f7" strokeWidth="1.4" pathLength="1" className="demo-draw" />
            <circle r="3.2" fill="#ffca28" stroke="#fff" strokeWidth=".6"><animateMotion dur="9s" fill="freeze" path={SIM_PATH} /></circle>
          </svg>
          <div style={{ fontFamily: 'monospace', fontSize: 10.5, marginTop: 8, lineHeight: 1.5, opacity: 0.85 }}>N120 G1 X500.0 Y10.0 F9000<br />N121 G1 X500.0 Y730.0<br /><span style={{ background: 'rgba(79,195,247,.25)' }}>N122 G1 X10.0 Y730.0</span></div>
        </div>
      )}
      {st.saveAsk && (
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.4)', display: 'flex', alignItems: 'flex-end' }}>
          <div style={{ width: '100%', background: 'var(--bg)', borderRadius: '16px 16px 0 0', padding: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>Сохранить 2 файла</div>
            <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>Папки: Kuhnya_Ivanovyh / LDSP_Belyi_16</div>
            {['Отдельными файлами', 'Одним архивом (.zip)'].map((t, i) => <div key={t} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '7px 0', fontSize: 13 }}><span style={{ width: 16, height: 16, borderRadius: 8, border: `1.5px solid ${C.blue}`, background: i === 0 ? C.blue : 'transparent', boxShadow: i === 0 ? 'inset 0 0 0 3px var(--bg)' : 'none' }} />{t}</div>)}
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <span style={{ flex: 1, textAlign: 'center', padding: 10, borderRadius: 8, border: `0.5px solid ${C.bmd}`, fontSize: 13 }}>⬇ Скачать</span>
              <span data-demo="share" style={{ flex: 1, textAlign: 'center', padding: 10, borderRadius: 8, background: C.blue, color: '#fff', fontSize: 13, fontWeight: 500 }}>Поделиться</span>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function Labels() {
  return (
    <>
      <Head title="Бирки · Кухня Ивановых" right={<span style={{ display: 'flex', gap: 5 }}><Pill main data-demo="labelPdf" style={{ background: 'var(--teal)' }}>⬇ PDF</Pill><Pill>🖨 Печать</Pill></span>} />
      <div style={{ margin: '0 12px 8px', fontSize: 12, color: C.muted }}>Бирка 60×40 мм · 13 шт. · конструктор: перетащите элементы</div>
      {[['01.01', 'Боковина', '720 × 560'], ['01.02', 'Боковина', '720 × 560'], ['02.01', 'Полка', '2000 × 300']].map(([d, n, s], i) => (
        <div key={d} data-demo={i === 0 ? 'label1' : undefined} style={{ margin: '0 auto 10px', width: 300, height: 200, border: `1px solid ${C.bmd}`, borderRadius: 6, background: '#fff', color: '#222', position: 'relative', padding: 10, boxSizing: 'border-box' }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Кухня Ивановых</div>
          <div style={{ fontSize: 11 }}>ЛДСП Белый 16</div>
          <div style={{ fontSize: 22, fontWeight: 700, marginTop: 6 }}>{d}</div>
          <div style={{ fontSize: 12 }}>{n} · {s}</div>
          <svg viewBox="0 0 40 40" width="62" height="62" style={{ position: 'absolute', right: 10, top: 10 }}>{Array.from({ length: 64 }, (_, k) => ((k * 37 + i * 11) % 5 < 2 ? <rect key={k} x={(k % 8) * 5} y={Math.floor(k / 8) * 5} width="5" height="5" fill="#222" /> : null))}<rect x="0" y="0" width="13" height="13" fill="none" stroke="#222" strokeWidth="2.5" /><rect x="27" y="0" width="13" height="13" fill="none" stroke="#222" strokeWidth="2.5" /><rect x="0" y="27" width="13" height="13" fill="none" stroke="#222" strokeWidth="2.5" /></svg>
          <svg viewBox="0 0 100 50" width="120" height="60" style={{ position: 'absolute', right: 10, bottom: 10 }}><rect x="1" y="1" width="98" height="48" fill="#eee" stroke="#999" strokeWidth=".6" />{[[3, 3, 26, 20], [31, 3, 26, 20], [3, 25, 26, 20]].map(([x, y, w, h], k) => <rect key={k} x={x} y={y} width={w} height={h} fill={k === i ? '#222' : '#fff'} stroke="#999" strokeWidth=".5" />)}</svg>
        </div>
      ))}
    </>
  )
}


// ── Урок: угол укладки и доприсадка ────────────────────────────────────────
const CORNER_TXT = { tl: '↖ левый верхний', tr: '↗ правый верхний', bl: '↙ левый нижний', br: '↘ правый нижний' }
const CornerBtns = ({ val, pre }) => (
  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
    {['tl', 'tr', 'bl', 'br'].map(k => (
      <span key={k} data-demo={`${pre}-${k}`} style={{ padding: '6px 8px', borderRadius: 8, fontSize: 11.5, border: `0.5px solid ${k === val ? C.blue : C.bmd}`, background: k === val ? 'var(--blue-light)' : 'transparent', fontWeight: k === val ? 600 : 400 }}>{CORNER_TXT[k]}</span>
    ))}
  </div>
)
const Chk = ({ on, children, ...p }) => (
  <div {...p} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, padding: '3px 0' }}>
    <span style={{ width: 15, height: 15, borderRadius: 4, border: on ? 'none' : `1px solid ${C.bmd}`, background: on ? C.blue : 'transparent', color: '#fff', fontSize: 10, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{on ? '✓' : ''}</span>{children}
  </div>
)
function CncSet({ st }) {
  const corner = st.corner || 'bl'
  return (
    <>
      <Head title="Настройки ЧПУ · Мой фрезер" />
      <div style={{ display: 'flex', gap: 5, margin: '0 12px 8px' }}>{['Основные', 'Команды', 'Инструменты', 'Обработка'].map((t, i) => <Pill key={t} on={i === 0} style={{ padding: '4px 9px', fontSize: 11.5 }}>{t}</Pill>)}</div>
      <Card>
        <div style={{ fontWeight: 500, fontSize: 13.5, marginBottom: 6 }}>Рабочее поле станка</div>
        <div style={{ display: 'flex', gap: 7, marginBottom: 8 }}><Field id="fx" label="Поле X, мм" value="2100" st={st} /><Field id="fy" label="Поле Y, мм" value="3000" st={st} /></div>
        <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 4 }}>Угол укладки (ноль программы)</div>
        <div data-demo="cornerPick"><CornerBtns val={corner} pre="c" /></div>
        <div style={{ fontSize: 10.5, color: C.hint, marginTop: 4 }}>Оси станка как есть: от верхнего угла Y — в минус, от правого — X в минус.</div>
      </Card>
      <Card>
        <div style={{ fontWeight: 500, fontSize: 13.5, marginBottom: 4 }}>Доприсадка — обратная сторона</div>
        <Chk on={!!st.back} data-demo="backOn">Выпускать управляющие программы обратной стороны деталей</Chk>
        {st.back && (
          <div className="demo-pop">
            <div style={{ fontSize: 11, color: C.muted, margin: '5px 0 3px' }}>Деталь на доприсадке:</div>
            <div data-demo="edgeSeg" style={{ display: 'flex', gap: 5 }}><Pill on={!st.edge} style={{ flex: 1 }}>Без кромки</Pill><Pill on={!!st.edge} style={{ flex: 1 }}>С кромкой</Pill></div>
            <div data-demo="backWhat" style={{ marginTop: 5 }}>
              <div style={{ fontSize: 11, color: C.muted }}>Что выпускать в доприсадку:</div>
              <Chk on>Отверстия в пласть (глухие)</Chk><Chk on>Пазы</Chk><Chk on>Выемки</Chk><Chk on={false}>Контур детали</Chk>
            </div>
            <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>Имя файла доприсадки — как на бирке:</div>
            <div data-demo="bname" style={{ border: `0.5px solid ${C.bmd}`, borderRadius: 7, padding: '5px 7px', fontFamily: 'monospace', fontSize: 12 }}>{'{POZ}_{NAIM}_x{KOL}'}</div>
            <div style={{ fontSize: 10.5, color: C.hint, marginTop: 2 }}>Например: 3_Bokovina_x4.nc</div>
          </div>
        )}
      </Card>
    </>
  )
}
// лист с деталями, прижатыми к углу c (схема 150×225), и точка-ноль со стрелками
function CornerSheet({ c, w = 200 }) {
  const right = c === 'tr' || c === 'br', top = c === 'tl' || c === 'tr'
  const P = [[0, 0, 60, 90], [62, 0, 40, 90], [0, 92, 60, 50], [62, 92, 40, 30], [104, 0, 40, 60]]
  const tx = ([x, y, ww, hh]) => [right ? 150 - x - ww - 2 : x + 2, top ? y + 2 : 225 - y - hh - 2, ww, hh]
  const cx = right ? 149 : 1, cy = top ? 1 : 224, sx = right ? -1 : 1, sy = top ? 1 : -1
  return (
    <svg viewBox="0 0 150 225" width={w} height={w * 1.5} style={{ background: '#f4efe6', borderRadius: 4 }}>
      <rect x=".5" y=".5" width="149" height="224" fill="none" stroke="#888" strokeWidth=".8" />
      {P.map((p, i) => { const [x, y, ww, hh] = tx(p); return <rect key={i} x={x} y={y} width={ww} height={hh} fill="#d8c7a5" stroke="#8a7650" strokeWidth=".6" /> })}
      <g data-demo="cornerDot" stroke="#185FA5" fill="#185FA5" strokeWidth="1.6">
        <line x1={cx} y1={cy} x2={cx + sx * 22} y2={cy} /><line x1={cx} y1={cy} x2={cx} y2={cy + sy * 22} /><circle cx={cx} cy={cy} r="3.4" />
      </g>
    </svg>
  )
}
function NestCorner({ st }) {
  const c = st.ncorner || 'tl'
  return (
    <>
      <Head title="Раскрой · Кухня Ивановых" sub="Лист 2800×2070 · рез 6" />
      <div style={{ display: 'flex', justifyContent: 'center', margin: '0 12px 8px', background: C.bg2, borderRadius: 10, padding: 10 }}><CornerSheet c={c} /></div>
      <Card>
        <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 4 }}>Угол укладки — от него идёт раскрой</div>
        <CornerBtns val={c} pre="n" />
      </Card>
    </>
  )
}
function LabelMark() {
  return (
    <>
      <Head title="Бирки · Кухня Ивановых" />
      <div data-demo="mark" style={{ margin: '0 auto 12px', width: 280, height: 170, border: `1px solid ${C.bmd}`, borderRadius: 6, background: '#fff', color: '#222', position: 'relative', padding: 10, boxSizing: 'border-box', overflow: 'hidden' }}>
        <div style={{ fontSize: 12, fontWeight: 600 }}>Кухня Ивановых · Иванов</div>
        <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>3 · Боковина</div>
        <div style={{ fontSize: 11 }}>2000 × 400 · отв. с двух сторон</div>
        <svg width="40" height="40" style={{ position: 'absolute', right: 0, bottom: 0 }}><polygon points="40,0 40,40 0,40" fill="#111" /></svg>
      </div>
      <div data-demo="flipPic" style={{ margin: '0 12px', background: C.bg2, borderRadius: 10, padding: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-around', fontSize: 10.5, color: C.muted, textAlign: 'center' }}>
        <div><svg width="60" height="120"><rect x="2" y="2" width="56" height="116" fill="#d8c7a5" stroke="#8a7650" /><rect x="10" y="40" width="40" height="28" fill="#fff" stroke="#999" /><polygon points="50,58 50,68 40,68" fill="#111" /></svg><div>лицевая,<br />бирка сверху</div></div>
        <div style={{ fontSize: 22 }}>⇆</div>
        <div><svg width="80" height="130"><rect x="0" y="0" width="80" height="130" fill="#e8edf3" /><rect x="4" y="10" width="56" height="116" fill="#cbb994" stroke="#8a7650" /><rect x="0" y="122" width="10" height="8" fill="#185FA5" /><rect x="0" y="0" width="4" height="130" fill="#185FA5" opacity=".6" /><circle cx="6" cy="124" r="4" fill="#111" /></svg><div>обратной стороной,<br />уголком к упору</div></div>
      </div>
    </>
  )
}
function CncOut({ st }) {
  return (
    <>
      <Head title="ЧПУ · Кухня Ивановых" />
      <div style={{ margin: '0 12px' }}>
        {[1, 2].map(n => <div key={n} style={{ border: `0.5px solid ${C.border}`, borderRadius: 10, padding: '7px 10px', marginBottom: 6, fontSize: 12.5 }}>✓ Лист {n} · <span style={{ color: C.hint }}>Kuhnya_LDSP_{n}.nc</span></div>)}
      </div>
      <Card data-demo="backCard" className="demo-pop">
        <div style={{ fontSize: 13, fontWeight: 500 }}>⇆ Доприсадка — обратная сторона</div>
        <div style={{ fontSize: 11, color: C.hint, margin: '3px 0 6px' }}>Программ: 2 — по одной на деталь с обработкой с двух сторон. Папка: Kuhnya_LDSP_Doprisadka</div>
        <div data-demo="backFile" style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}><Pill>⬇ Боковина ×4</Pill><Pill>⬇ Перегородка ×2</Pill></div>
      </Card>
      <div style={{ margin: '6px 12px' }}><div data-demo="backSave" style={{ textAlign: 'center', padding: 10, borderRadius: 8, fontSize: 14, border: `0.5px solid ${C.bmd}` }}>{st.bsaved ? '✓ Файлы сохранены' : '⬇ Сохранить все файлы (4)'}</div></div>
    </>
  )
}

// ── Урок: склад деловых остатков ───────────────────────────────────────────
const STOCK = [['№12', '1200 × 640', 'ЛДСП Белый 16', 'A-3'], ['№13', '820 × 410', 'ЛДСП Белый 16', 'A-3'], ['№14', '1530 × 380', 'ЛДСП Дуб сонома 16', 'B-1']]
function Stock({ st }) {
  return (
    <>
      <Head left="☰" title="Деловые остатки" />
      <div style={{ display: 'flex', gap: 6, margin: '0 12px 8px' }}>
        <Pill main data-demo="addBtn" style={{ flex: 1 }}>+ Внести остатки</Pill><Pill>Из Excel</Pill><Pill>⬇ В Excel</Pill>
      </div>
      <div style={{ display: 'flex', gap: 6, margin: '0 12px 10px' }}><Pill data-demo="scanBtn" on style={{ flex: 1 }}>📷 Сканировать бирку</Pill><Pill style={{ flex: 1 }}>🏷 Бирки</Pill></div>
      {st.adding && (
        <Card data-demo="addForm" className="demo-pop">
          <div style={{ display: 'flex', gap: 6 }}><Field id="sl" label="Длина" value="1100" st={st} /><Field id="sw" label="Ширина" value="520" st={st} /><Field id="sc" label="Ячейка" value="A-4" st={st} w={70} /></div>
          <div style={{ fontSize: 11.5, color: C.muted, marginTop: 5 }}>Материал: ЛДСП Белый 16 · бирка с QR-кодом печатается сразу</div>
        </Card>
      )}
      {st.scanned && (
        <Card className="demo-pop" style={{ border: `1px solid ${C.blue}` }}>
          <div style={{ fontSize: 13, fontWeight: 500 }}>Остаток №15 · 960 × 450 · ЛДСП Белый 16</div>
          <div style={{ fontSize: 11.5, color: C.muted }}>Из раскроя «Кухня Ивановых», лист 2</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}><Field id="cell2" label="Ячейка хранения" value="A-4" st={st} /><Pill main style={{ alignSelf: 'flex-end' }}>Сохранить</Pill></div>
        </Card>
      )}
      <div data-demo="stockList">
        {STOCK.map(([n, sz, m, c], i) => (
          <Card key={n} style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: st.used && i === 0 ? 0.45 : 1 }}>
            <div style={{ flex: 1 }}><div style={{ fontSize: 13.5, fontWeight: 500 }}>{n} · {sz}</div><div style={{ fontSize: 11.5, color: C.muted }}>{m}{st.used && i === 0 ? ' · списан в заказ «Кухня Ивановых»' : ''}</div></div>
            <span style={{ fontSize: 14, padding: '3px 10px', borderRadius: 9, fontWeight: 600, background: 'var(--teal-light)', color: 'var(--teal)' }}>{c}</span>
          </Card>
        ))}
      </div>
    </>
  )
}
function NestStock({ st }) {
  return (
    <>
      <Head title="Раскрой · Кухня Ивановых" sub="Лист и обрезки" />
      <Card>
        <div style={{ fontSize: 12.5, fontWeight: 500, marginBottom: 4 }}>Обрезки со склада</div>
        <div style={{ fontSize: 11, color: C.hint, marginBottom: 6 }}>Раскраиваются первыми, потом — целые листы.</div>
        <div data-demo="offRows">
          {(st.picked ? [['1200', '640', '№12'], ['820', '410', '№13']] : []).map(([l, w, n]) => (
            <div key={n} className="demo-pop" style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 5 }}><Field id={'o' + n} value={l} st={st} /><Field id={'w' + n} value={w} st={st} /><Field id={'q' + n} value="1" st={st} w={40} /><span style={{ fontSize: 11, color: 'var(--teal)' }}>📦 {n}</span></div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6 }}><Pill data-demo="takeBtn" on style={{ flex: 1 }}>📦 Взять со склада</Pill><Pill>+ Обрезок</Pill></div>
      </Card>
      {st.picked && <div className="demo-pop" style={{ display: 'flex', gap: 10, justifyContent: 'center', margin: '0 12px', background: C.bg2, borderRadius: 10, padding: 10 }}><Sheet parts={PARTS2} w={110} /><Sheet parts={PARTS} w={130} /></div>}
    </>
  )
}

// ── Урок: бирки ────────────────────────────────────────────────────────────
function LabelEdit({ st }) {
  const items = ['Заказ', 'Заказчик (имя)', 'Наименование', 'Размер и количество', 'Кромка — списком', 'Чертёж детали', 'Карта раскроя', 'QR-код']
  return (
    <>
      <Head title="Шаблон бирки" right={<Pill main data-demo="lbSave">Сохранить</Pill>} />
      <Card data-demo="lbSize" style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}><Field id="lw" label="Ширина, мм" value="60" st={st} /><Field id="lh" label="Высота, мм" value="40" st={st} /><Pill data-demo="lbAdd" main>+ Элемент</Pill></Card>
      <div style={{ position: 'relative', margin: '0 auto 10px', width: 300, height: 200, border: `1px solid ${C.bmd}`, borderRadius: 6, background: '#fff', color: '#222' }}>
        <div data-demo="lbItem" style={{ position: 'absolute', left: 10, top: 8, border: '1px dashed #185FA5', padding: '1px 4px', fontSize: 13, fontWeight: 600 }}>Кухня Ивановых · Иванов</div>
        <div style={{ position: 'absolute', left: 10, top: 40, fontSize: 22, fontWeight: 700 }}>01.02</div>
        <div style={{ position: 'absolute', left: 10, top: 72, fontSize: 12 }}>Боковина · 720 × 560</div>
        <svg data-demo="lbQr" viewBox="0 0 40 40" width="62" height="62" style={{ position: 'absolute', right: 10, top: 10 }}>{Array.from({ length: 64 }, (_, k) => ((k * 37) % 5 < 2 ? <rect key={k} x={(k % 8) * 5} y={Math.floor(k / 8) * 5} width="5" height="5" fill="#111" /> : null))}</svg>
        <svg viewBox="0 0 100 50" width="120" height="60" style={{ position: 'absolute', right: 10, bottom: 10 }}><rect x="1" y="1" width="98" height="48" fill="#eee" stroke="#999" strokeWidth=".6" /><rect x="31" y="3" width="26" height="20" fill="#111" /></svg>
      </div>
      {st.menu && (
        <Card className="demo-pop">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>{items.map(t => <Pill key={t} style={{ padding: '4px 9px', fontSize: 11.5 }}>+ {t}</Pill>)}</div>
        </Card>
      )}
      <Card style={{ fontSize: 11.5, color: C.muted }}>Что зашито в QR-код: <span style={{ fontFamily: 'monospace', color: 'var(--text)' }}>{'{ZAKAZ}_{OBOZ}'}</span></Card>
    </>
  )
}

// ── Урок: импорт моделей ───────────────────────────────────────────────────
const SRC = [['📊', 'Excel / CSV'], ['📐', 'Базис-Мебельщик'], ['🗄️', 'К3-Мебель'], ['🧩', 'Астра'], ['🪑', 'PRO100'], ['🏠', 'SketchUp'], ['🛠️', 'bCAD'], ['📏', 'DXF']]
function ImportSrc() {
  return (
    <>
      <Head title="Импорт деталей" />
      <div data-demo="impList" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7, margin: '0 12px' }}>
        {SRC.map(([i, t]) => <div key={t} data-demo={t === 'Базис-Мебельщик' ? 'impBasis' : undefined} style={{ border: `0.5px solid ${C.bmd}`, borderRadius: 10, padding: '12px 8px', textAlign: 'center', fontSize: 12.5 }}><div style={{ fontSize: 22 }}>{i}</div>{t}</div>)}
      </div>
    </>
  )
}
function ImportRes() {
  const rows = [['Бок левый', '720 × 560', 'кромка 2 · отв. 12'], ['Бок правый', '720 × 560', 'кромка 2 · отв. 12'], ['Полка', '764 × 540', 'кромка 1 · отв. 4'], ['Задняя стенка', '796 × 716', 'ХДФ 3 · паз']]
  return (
    <>
      <Head title="Импорт · Кухня.b3d" sub="Базис-Мебельщик · 4 вида деталей" />
      <div data-demo="impRows">{rows.map(([n, sz, w]) => <Card key={n} style={{ padding: '7px 12px' }}><div style={{ fontSize: 13, fontWeight: 500 }}>{n} · {sz}</div><div style={{ fontSize: 11.5, color: C.muted }}>{w}</div></Card>)}</div>
      <Card data-demo="impNote" style={{ background: 'var(--amber-light)', fontSize: 11.5, color: C.muted }}>Покупные изделия и «Не учитывать в раскрое»: Петли, Фасад в рамке — в раскрой не идут, видны в 3D.</Card>
      <Card data-demo="impFace"><div style={{ fontSize: 11.5, color: C.muted, marginBottom: 4 }}>Лицевая сторона детали — по приоритету</div><div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>{['Назначена в модели', 'Больше глухих отверстий', 'Пазы и вырезы'].map(t => <Pill key={t} style={{ padding: '4px 8px', fontSize: 11 }}>{t}</Pill>)}</div></Card>
      <div style={{ display: 'flex', gap: 6, margin: '0 12px' }}><Pill data-demo="imp3d" style={{ flex: 1 }}>🧊 3D-модель</Pill><Pill main data-demo="impAdd" style={{ flex: 1 }}>Добавить в заказ</Pill></div>
    </>
  )
}

export const SCREENS = { orders: Orders, new: NewOrder, nest: Nesting, prod: Production, order: OrderView, cnc: Cnc, labels: Labels, cset: CncSet, ncorner: NestCorner, lmark: LabelMark, cout: CncOut, stock: Stock, nstock: NestStock, lbedit: LabelEdit, impsrc: ImportSrc, impres: ImportRes }
