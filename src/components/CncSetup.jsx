import { useKeptState } from '../hooks/useKeptState'
import { CncBasic, CncCommands, CncTools, CncOps } from './CncSettings'
import PostPicker from './PostPicker'
import { useCnc } from '../hooks/useCnc'
import { activePost, routerPost, drillPosts, isDrill6 } from '../lib/cncSettings'
import DirPathEditor, { routerDirDefault } from './DirPathEditor'
import { DRILL_DIR_DEFAULT } from '../lib/drill6Xml'
import { folderName } from '../lib/orderUtils'

// пример заказа — чтобы видеть, как назовутся папки
const SAMPLE = { n: null, total: 3, order: { order_name: 'Kuhnya', order_number: '261010' }, material: 'LDSP 16', thickness: 16, client: 'Klient' }
const pathOf = tpl => String(tpl || '').split('/').map(t => t.trim()).filter(Boolean).map(t => folderName(t, SAMPLE)).filter(Boolean)
import CncLoader from './CncLoader'

// Настройки постпроцессора на главном экране производства — те же, что в заказе (ЧПУ), это дубль, не перенос:
// настроить станки можно до заказов, а поправить — и здесь, и прямо при выпуске программ в заказе.
const TABS = [['basic', 'Основные'], ['cmd', 'Команды'], ['tools', 'Инструменты'], ['ops', 'Обработка']]

export default function CncSetup() {
  const { cnc, change, ready, isMaster } = useCnc()
  const [tab, setTab] = useKeptState('cncTab', 'basic')
  if (!ready) return <CncLoader compact label="Загружаем постпроцессоры…" />
  const chip = on => ({ flex: '0 0 auto', padding: '6px 11px', borderRadius: 20, border: 'none', fontSize: 12, background: on ? 'var(--blue)' : 'var(--bg2)', color: on ? 'white' : 'var(--text-muted)' })
  const drills = drillPosts(cnc)
  return (
    <div style={{ marginTop: 6 }}>
      <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: '0 0 6px' }}>
        Выпуск: <b style={{ color: 'var(--text-muted)' }}>{routerPost(cnc)?.name}</b>{drills.length ? <> + <b style={{ color: 'var(--text-muted)' }}>{drills.map(p => p.name).join(', ')}</b></> : null}.
        {' '}Это те же настройки, что в заказе (ЧПУ): поправили здесь — там уже так же.
      </p>
      <PostPicker cnc={cnc} onChange={change} />
      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 10, paddingBottom: 2 }}>
        {TABS.map(([k, l]) => <button key={k} type="button" onClick={() => setTab(k)} style={chip(tab === k)}>{l}</button>)}
      </div>
      {tab === 'basic' && <CncBasic cnc={cnc} onChange={change} isMaster={isMaster} />}
      {tab === 'basic' && (() => {
        // папки выгрузки программ (матрёшка) — у открытого станка; то же, что в заказе (ЧПУ)
        const p = activePost(cnc)
        if (!p) return null
        const def = isDrill6(p) ? DRILL_DIR_DEFAULT : routerDirDefault(p, drills.length > 0)
        const val = p.dirPath ?? def
        return (
          <div className="card" style={{ marginTop: 10, fontSize: 12, color: 'var(--text-muted)' }}>
            <div style={{ fontWeight: 500, fontSize: 13, color: 'var(--text)' }}>Папки выгрузки программ · {p.name}</div>
            <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>Пример — для заказа «Kuhnya», материал LDSP 16.</div>
            <DirPathEditor value={val} def={def} preview={pathOf(val)} onChange={v => change({ ...cnc, posts: cnc.posts.map(q => (q.id === p.id ? { ...q, dirPath: v } : q)) })} />
          </div>
        )
      })()}
      {tab === 'cmd' && <CncCommands cnc={cnc} onChange={change} isMaster={isMaster} />}
      {tab === 'tools' && <CncTools cnc={cnc} onChange={change} />}
      {tab === 'ops' && <CncOps cnc={cnc} onChange={change} layers={null} />}
    </div>
  )
}
