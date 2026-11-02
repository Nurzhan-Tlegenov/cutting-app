// β-постпроцессор шестистороннего станка: окно «Положение деталей» при выпуске программ (заказ → ЧПУ).
import { d6bOf } from '../lib/drill6Xml'
import Drill6PartsView from './Drill6PartsView'

export default function Drill6Orient({ mat, order, post, man = {}, onChange, onClose }) {
  const b = d6bOf(post) || {}
  const btn = { padding: '6px 10px', borderRadius: 20, fontSize: 12, border: '0.5px solid var(--border-md)', background: 'var(--bg)', color: 'var(--text)', cursor: 'pointer' }
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,.4)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--bg)', width: '100%', maxWidth: 720, maxHeight: '88vh', overflow: 'auto', borderRadius: '16px 16px 0 0', padding: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <div style={{ fontWeight: 500, fontSize: 15, flex: 1 }}>Положение деталей на станке · β</div>
          <button type="button" onClick={onClose} style={btn}>Готово</button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 6 }}>Правила: {b.rules ? 'включены' : 'выключены'} (настройки постпроцессора → «β · Положение»). Повёрнутое и перевёрнутое вручную главнее правил и запоминается.</div>
        <Drill6PartsView mat={mat} order={order} post={post} man={man} onMan={onChange} maxWidth={Math.min(680, (typeof window !== 'undefined' ? window.innerWidth : 400) - 40)} />
      </div>
    </div>
  )
}
