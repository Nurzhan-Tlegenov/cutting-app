import { useKeptState } from '../hooks/useKeptState'
import { CncBasic, CncCommands, CncTools, CncOps } from './CncSettings'
import PostPicker from './PostPicker'
import { useCnc } from '../hooks/useCnc'
import { routerPost, drillPosts, secondRouter, postView, postBack, activePost, isDrill6 } from '../lib/cncSettings'

import CncLoader from './CncLoader'
import Drill6Ops from './Drill6Ops'

// Настройки постпроцессора на главном экране производства — те же, что в заказе (ЧПУ), это дубль, не перенос:
// настроить станки можно до заказов, а поправить — и здесь, и прямо при выпуске программ в заказе.
const TABS = [['basic', 'Основные'], ['cmd', 'Команды'], ['tools', 'Инструменты'], ['ops', 'Обработка']]

export default function CncSetup({ prodId = null }) {
  const { cnc, change, ready, isMaster } = useCnc(null, prodId)
  const [tab, setTab] = useKeptState('cncTab', 'basic')
  if (!ready) return <CncLoader compact label="Загружаем постпроцессоры…" />
  const chip = on => ({ flex: '0 0 auto', padding: '6px 11px', borderRadius: 20, border: 'none', fontSize: 12, background: on ? 'var(--blue)' : 'var(--bg2)', color: on ? 'white' : 'var(--text-muted)' })
  const drills = [secondRouter(cnc), ...drillPosts(cnc)].filter(Boolean)     // второй постпроцессор: раскроечный или шестисторонний
  // инструменты и обработка открытого постпроцессора (у настроенного по чужой программе — свои, см. postTools.js)
  const view = postView(cnc), vchange = v => change(postBack(cnc, v))
  return (
    <div style={{ marginTop: 6 }}>
      <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: '0 0 6px' }}>
        Выпуск: <b style={{ color: 'var(--text-muted)' }}>{routerPost(cnc)?.name}</b>{drills.length ? <> + <b style={{ color: 'var(--text-muted)' }}>{drills.map(p => p.name).join(', ')}</b></> : null}.
        {' '}Это те же настройки, что в заказе (ЧПУ): поправили здесь — там уже так же.
      </p>
      <PostPicker cnc={cnc} onChange={change} isMaster={isMaster} />
      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 10, paddingBottom: 2 }}>
        {TABS.map(([k, l]) => <button key={k} type="button" onClick={() => setTab(k)} style={chip(tab === k)}>{l}</button>)}
      </div>
      {tab === 'basic' && <CncBasic cnc={cnc} onChange={change} isMaster={isMaster} />}
      {tab === 'cmd' && <CncCommands cnc={cnc} onChange={change} isMaster={isMaster} />}
      {/* шестисторонний станок: свои инструменты и обработка (номера инструментов у всех станков разные) */}
      {(tab === 'tools' || tab === 'ops') && isDrill6(activePost(cnc)) && <Drill6Ops cnc={cnc} onChange={change} isMaster={isMaster} part={tab} />}
      {tab === 'tools' && !isDrill6(activePost(cnc)) && <CncTools cnc={view} onChange={vchange} />}
      {tab === 'ops' && !isDrill6(activePost(cnc)) && <CncOps cnc={view} onChange={vchange} layers={null} />}
    </div>
  )
}
