// Заголовок таблицы деталей бланка заказа на компьютере: колонки № · Поз. · Наименование · Длина · Ширина · Кол. · Кромка.
// Ширину колонки меняют, перетаскивая её правую границу в заголовке (двойной щелчок — ширина по умолчанию).
// Ширины — CSS-переменные --oc-<колонка> (сетка строк деталей в index.css), запоминаются в этом браузере.
import { useRef } from 'react'

const COLS = [['num', '№', 44], ['pos', 'Поз.', 70], ['name', 'Наименование', 240], ['len', 'Длина', 80], ['wid', 'Ширина', 80], ['qty', 'Кол.', 50], ['edge', 'Кромка', 250]]
const KEY = 'orderCols'
const MIN = { num: 30, pos: 40, name: 80, len: 50, wid: 50, qty: 36, edge: 150 }

function load() { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {} } catch { return {} } }
function apply(w) {
  if (typeof document === 'undefined') return
  for (const [k, , def] of COLS) document.documentElement.style.setProperty(`--oc-${k}`, `${Number(w[k]) > 0 ? w[k] : def}px`)
}
apply(load())   // сохранённые ширины — сразу при загрузке, до первой отрисовки строк

export default function DetailTableHead() {
  const drag = useRef(null)
  const widthOf = k => { const v = load()[k]; return Number(v) > 0 ? Number(v) : COLS.find(c => c[0] === k)[2] }
  const save = (k, v) => { const w = { ...load(), [k]: v }; if (v == null) delete w[k]; try { localStorage.setItem(KEY, JSON.stringify(w)) } catch { /* без памяти */ } apply(w) }
  const start = (k, e) => {
    e.preventDefault()
    drag.current = { k, x: e.clientX, w0: widthOf(k) }
    const move = ev => { const d = drag.current; if (!d) return; save(d.k, Math.max(MIN[d.k], Math.round(d.w0 + ev.clientX - d.x))) }
    const up = () => { drag.current = null; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  const handle = k => (
    <span onPointerDown={e => start(k, e)} onDoubleClick={() => save(k, null)} title="Потяните, чтобы изменить ширину колонки (двойной щелчок — как было)"
      style={{ position: 'absolute', right: -5, top: 0, bottom: 0, width: 9, cursor: 'col-resize', zIndex: 1, display: 'flex', justifyContent: 'center' }}>
      <span style={{ width: 1, background: 'var(--border-md)', margin: '3px 0' }} />
    </span>
  )
  return (
    <div className="card det-card det-head desk-only">
      {COLS.map(([k, title], i) => (
        <div key={k} style={{ gridRow: 1, gridColumn: i + 1, position: 'relative', minWidth: 0, padding: '4px 0', whiteSpace: 'nowrap' }}>
          {k === 'edge'
            ? <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                {['Дл', 'Дп', 'Шв', 'Шн'].map(t => <div key={t} style={{ flex: 1, textAlign: 'center' }}>{t}</div>)}
                <div style={{ width: 26, textAlign: 'center' }} title="Вращение">↻</div>
              </div>
            : <span style={{ paddingLeft: k === 'num' ? 0 : 4 }}>{title}</span>}
          {handle(k)}
        </div>
      ))}
    </div>
  )
}
