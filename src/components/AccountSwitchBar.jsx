// Полоса сверху, пока представитель работает в аккаунте своего производства (accounts.js): чей это аккаунт и возврат к себе
import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { switchedInfo, accountsState, switchTo } from '../lib/accounts'

export default function AccountSwitchBar() {
  const { user } = useAuth()
  const [, tick] = useState(0)
  const [open, setOpen] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => { const f = () => tick(x => x + 1); window.addEventListener('accounts', f); return () => window.removeEventListener('accounts', f) }, [])
  const info = switchedInfo(user?.id)
  if (!info) return null
  const others = (accountsState()?.list || []).filter(a => a.id !== user.id && a.id !== info.owner && a.rt)
  const go = async (id, path) => { setErr(''); const r = await switchTo(id, path); if (r.error) setErr(r.error) }
  const pill = { padding: '3px 10px', borderRadius: 12, fontSize: 12, cursor: 'pointer' }
  return (
    <div style={{ position: 'sticky', top: 0, zIndex: 900, padding: '6px 12px', fontSize: 12.5, background: 'var(--blue)', color: 'white' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ flex: 1, minWidth: 0 }}>🤝 Аккаунт клиента: <b>{info.me.label}</b></span>
        {others.length > 0 && <button type="button" onClick={() => setOpen(o => !o)} style={{ ...pill, border: '1px solid white', background: 'transparent', color: 'white' }}>Другой клиент</button>}
        <button type="button" onClick={() => go(info.owner, '/partner')} style={{ ...pill, border: 'none', background: 'white', color: 'var(--blue)', fontWeight: 600 }}>↩ В свой аккаунт</button>
      </div>
      {open && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
        {others.map(a => <button key={a.id} type="button" onClick={() => go(a.id)} style={{ ...pill, border: '1px solid white', background: 'transparent', color: 'white' }}>{a.label}</button>)}
      </div>}
      {err && <div style={{ marginTop: 4 }}>{err}</div>}
    </div>
  )
}
