import { useState } from 'react'
import { CncBasic, CncCommands, CncTools, CncOps } from './CncSettings'
import { useCnc } from '../hooks/useCnc'
import { activePost, routerPost, drillPosts } from '../lib/cncSettings'
import CncLoader from './CncLoader'

// Настройки постпроцессора на главном экране производства — те же, что в заказе (ЧПУ), это дубль, не перенос:
// настроить станки можно до заказов, а поправить — и здесь, и прямо при выпуске программ в заказе.
const TABS = [['basic', 'Основные'], ['cmd', 'Команды'], ['tools', 'Инструменты'], ['ops', 'Обработка']]

export default function CncSetup() {
  const { cnc, change, ready, isMaster } = useCnc()
  const [tab, setTab] = useState('basic')
  if (!ready) return <CncLoader compact label="Загружаем постпроцессоры…" />
  const chip = on => ({ flex: '0 0 auto', padding: '6px 11px', borderRadius: 20, border: 'none', fontSize: 12, background: on ? 'var(--blue)' : 'var(--bg2)', color: on ? 'white' : 'var(--text-muted)' })
  const drills = drillPosts(cnc)
  return (
    <div style={{ marginTop: 6 }}>
      <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: '0 0 6px' }}>
        Выпуск: <b style={{ color: 'var(--text-muted)' }}>{routerPost(cnc)?.name}</b>{drills.length ? <> + <b style={{ color: 'var(--text-muted)' }}>{drills.map(p => p.name).join(', ')}</b></> : null}.
        {' '}Это те же настройки, что в заказе (ЧПУ): поправили здесь — там уже так же.
      </p>
      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 10, paddingBottom: 2 }}>
        {TABS.map(([k, l]) => <button key={k} type="button" onClick={() => setTab(k)} style={chip(tab === k)}>{l}</button>)}
      </div>
      {tab === 'basic' && <CncBasic cnc={cnc} onChange={change} isMaster={isMaster} />}
      {tab === 'cmd' && <CncCommands cnc={cnc} onChange={change} isMaster={isMaster} />}
      {tab === 'tools' && <CncTools cnc={cnc} onChange={change} />}
      {tab === 'ops' && <CncOps cnc={cnc} onChange={change} layers={null} />}
      <p style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 6 }}>Открыт: {activePost(cnc)?.name}</p>
    </div>
  )
}
