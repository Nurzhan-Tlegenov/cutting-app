import { useEffect, useState } from 'react'
import { pushStatus, enablePush, disablePush, testPush, soundOn, setSoundOn } from '../lib/push'

// Уведомления на этом телефоне: включить / проверить / выключить, звук в открытом приложении
const TEXT = {
  on: ['✓ Включены на этом телефоне', 'var(--teal)'],
  off: ['Выключены — приходят только когда приложение открыто', 'var(--amber)'],
  denied: ['Запрещены в настройках браузера: откройте настройки сайта raskroypro.com → Уведомления → Разрешить', 'var(--danger)'],
  'ios-home': ['На iPhone: Поделиться → «На экран Домой», затем откройте RaskroyPro с экрана Домой и включите здесь', 'var(--amber)'],
  unsupported: ['Этот браузер не умеет присылать уведомления — откройте приложение в Chrome', 'var(--text-hint)'],
}
const btn = main => ({ padding: '6px 12px', borderRadius: 8, fontSize: 13, border: main ? 'none' : '0.5px solid var(--border-md)', background: main ? 'var(--blue)' : 'var(--bg)', color: main ? 'white' : 'var(--text)', fontWeight: main ? 500 : 400 })

export default function PushSettings() {
  const [st, setSt] = useState(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [sound, setSound] = useState(soundOn)
  const refresh = () => pushStatus().then(setSt)
  useEffect(() => { refresh() }, [])
  const run = async (fn, ok) => { setBusy(true); setMsg(''); const r = await fn(); setBusy(false); setMsg(r?.error ? r.error : ok); refresh() }
  const [label, color] = TEXT[st] || ['Проверяем…', 'var(--text-hint)']
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div style={{ fontWeight: 500, fontSize: 14 }}>🔔 Уведомления на телефон</div>
      <div style={{ fontSize: 12, color: 'var(--text-hint)', marginTop: 2 }}>Новые заявки, статусы заказов, заказы на посту — в шторку телефона со звуком, даже когда приложение закрыто. Нажатие открывает нужную заявку.</div>
      <div style={{ fontSize: 12.5, color, marginTop: 6 }}>{label}</div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        {(st === 'off' || st === 'denied') && <button type="button" disabled={busy} style={btn(true)} onClick={() => run(enablePush, 'Включено. Нажмите «Проверить».')}>Включить</button>}
        {st === 'on' && <button type="button" disabled={busy} style={btn(true)} onClick={() => run(testPush, 'Отправлено — уведомление придёт через несколько секунд. Можно свернуть приложение.')}>Проверить</button>}
        {st === 'on' && <button type="button" disabled={busy} style={btn()} onClick={() => run(disablePush, 'Выключено на этом телефоне.')}>Выключить</button>}
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, marginLeft: 'auto' }}>
          <input type="checkbox" checked={sound} onChange={e => { setSound(e.target.checked); setSoundOn(e.target.checked) }} /> Звук в приложении
        </label>
      </div>
      {msg && <div style={{ fontSize: 12, marginTop: 6, color: /^(Включено|Отправлено|Выключено)/.test(msg) ? 'var(--teal)' : 'var(--danger)' }}>{msg}</div>}
    </div>
  )
}
