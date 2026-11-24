// «Виды кромки» в бланке заказа — сворачиваемая карточка. По умолчанию свёрнута (в заголовке — сколько видов и
// активная кромка), раскрыта или свёрнута — запоминается за аккаунтом (настройки пользователя: edgeTypesOpen).
import { useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { getUserSettings, saveUserSettings } from '../lib/userSettings'
import EdgeTypes from './EdgeTypes'

export default function EdgeTypesCard({ edgeNames, edgeTypes, activeEdge, onNames, onTypes, onSetActive, tour }) {
  const { user } = useAuth()
  const [open, setOpen] = useState(() => !!getUserSettings(user).edgeTypesOpen)
  const flip = () => { const v = !open; setOpen(v); saveUserSettings({ edgeTypesOpen: v }, user) }
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="card" data-tour={tour} style={{ padding: '8px 12px' }}>
        <div onClick={flip} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-hint)', cursor: 'pointer', userSelect: 'none' }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontWeight: 500, color: edgeNames.length ? 'var(--blue)' : 'var(--text-hint)' }}>Виды кромки {edgeNames.length ? `(${edgeNames.length})` : ''}</span>
            {activeEdge && <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--blue)' }}>· активная: {activeEdge}</span>}
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{open ? '▾' : '▸'}</span>
        </div>
        {open && (
          <div style={{ marginTop: 8 }}>
            <EdgeTypes edgeNames={edgeNames} edgeTypes={edgeTypes} activeEdge={activeEdge} onNames={onNames} onTypes={onTypes} onSetActive={onSetActive} />
          </div>
        )}
      </div>
    </div>
  )
}
