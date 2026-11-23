// «Выводить в УП» — быстрый доступ на странице раскроя (кабинет производства, фрезер).
// Те же галочки, что в ЧПУ → постпроцессор → «Обработка» → «Выводить в УП» раскроечного станка: пишутся в те же
// настройки (useCnc), поэтому что отметили здесь — сразу так же в «Обработке», и наоборот; запоминается.
import { useCnc } from '../hooks/useCnc'
import { routerPost, isRouterPost, postView, postBack } from '../lib/cncSettings'
import { skipOf, SKIP_KEYS } from '../lib/gcode'
import Hint from './Hint'

const ITEMS = [
  ['contour', 'Фигурные контуры'], ['cutouts', 'Внутренние вырезы'],
  ['through', 'Сквозные отверстия'], ['blind', 'Глухие отверстия'],
  ['grooves', 'Пазы'], ['pockets', 'Выемки'],
]

export default function CncSkipQuick({ prodId, onChanged }) {
  const { cnc, change, ready } = useCnc(null, prodId)
  if (!ready) return null
  const rp = routerPost(cnc)
  if (!isRouterPost(rp)) return null
  const skip = skipOf(postView({ ...cnc, post: rp.id }).ops)
  const setSkip = patch => {
    change(prev => {
      // правим «Обработку» именно раскроечного станка; выбранный в настройках постпроцессор не меняем
      const at = { ...prev, post: rp.id }
      const v = postView(at)
      const sk = { ...skipOf(v.ops), ...patch }
      const back = postBack(at, { ...v, ops: { ...v.ops, skip: Object.fromEntries(SKIP_KEYS.map(k => [k, !!sk[k]])) } })
      return { ...back, post: prev.post }
    })
    onChanged?.()
  }
  const off = ITEMS.filter(([k]) => skip[k]).length
  return (
    <div style={{ marginBottom: 8, padding: '6px 8px', border: '0.5px solid var(--border)', borderRadius: 'var(--radius)' }}>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <span>Выводить в УП <span style={{ color: 'var(--text-hint)' }}>· {rp.name || 'фрезер'}</span></span>
        <span style={{ color: off ? 'var(--amber)' : 'var(--text-hint)' }}>{off ? `без: ${off}` : 'всё'}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '4px 10px' }}>
        {ITEMS.map(([k, label]) => (
          <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, cursor: 'pointer', minWidth: 0 }}>
            <input type="checkbox" checked={!skip[k]} onChange={e => setSkip({ [k]: !e.target.checked })} style={{ width: 17, height: 17, flexShrink: 0 }} />
            <span style={{ minWidth: 0 }}>{label}</span>
          </label>
        ))}
      </div>
      <Hint>Те же галочки, что в ЧПУ → «Обработка» → «Выводить в УП»: изменили здесь — там так же, и запоминается. Снятая обработка не попадает ни в программу, ни в симуляцию. «Фигурные контуры» сняты — фигурные детали режутся прямоугольником и раскраиваются по габаритам (раскрой пересчитать).</Hint>
    </div>
  )
}
