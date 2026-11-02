// Настройки производства → «Сохранить / загрузить настройки»: один файл .json со всеми настройками производства
// (постпроцессоры, бирки, отчёты, параметры станка, прайс-лист, прочее) — сохранить у себя, перенести на другой аккаунт.
import { useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { SECTIONS, makeBackup, downloadJson, readBackup, applyBackup } from '../lib/settingsBackup'

export default function SettingsBackup({ prod, onApplied }) {
  const { user } = useAuth()
  const fileRef = useRef(null)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [loaded, setLoaded] = useState(null)        // { data, sections, picked: Set }
  const save = async () => {
    setBusy('save'); setMsg('')
    try { const { data, fileName } = await makeBackup(user, prod); downloadJson(data, fileName); setMsg(`Файл сохранён: ${fileName}. Разделов: ${Object.keys(data.sections).length}.`) }
    catch (e) { setMsg('Не удалось собрать настройки: ' + (e?.message || e)) }
    setBusy('')
  }
  const open = async f => {
    setMsg('')
    const r = await readBackup(f)
    if (r.error) { setMsg(r.error); return }
    setLoaded({ ...r, picked: new Set(r.sections) })
  }
  const apply = async () => {
    const picked = [...loaded.picked]
    if (!picked.length) return
    const names = SECTIONS.filter(([k]) => picked.includes(k)).map(([, t]) => '· ' + t).join('\n')
    if (!window.confirm(`Заменить настройки этого аккаунта настройками из файла?\n\n${names}\n\nТекущие настройки этих разделов будут заменены. Если сомневаетесь — сначала нажмите «Сохранить настройки в файл».`)) return
    setBusy('apply')
    const r = await applyBackup(user, prod, loaded.data, picked)
    setBusy('')
    setLoaded(null)
    setMsg([r.done.length ? `✓ Восстановлено: ${r.done.join(', ')}.` : '', r.errors.length ? `Не получилось: ${r.errors.join('; ')}` : ''].filter(Boolean).join(' '))
    onApplied?.()
  }
  const btn = { padding: '10px 12px', borderRadius: 'var(--radius)', fontSize: 14, cursor: 'pointer', width: '100%' }
  return (
    <div>
      <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '0 0 10px', lineHeight: 1.45 }}>
        Все настройки производства — одним файлом: постпроцессоры, бирки, отчёты PDF, параметры станка, прайс-лист.
        Сохраните его у себя на всякий случай или загрузите на другом аккаунте — всё восстановится. Заказы, клиенты и сотрудники в файл не входят.
      </p>
      <button type="button" className="btn-primary" style={btn} disabled={!!busy} onClick={save}>{busy === 'save' ? 'Собираем…' : '⬇ Сохранить настройки в файл'}</button>
      <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) open(f) }} />
      <button type="button" className="btn-secondary" style={{ ...btn, marginTop: 8 }} disabled={!!busy} onClick={() => fileRef.current?.click()}>⬆ Загрузить настройки из файла…</button>
      {loaded && (
        <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 'var(--radius)', border: '0.5px solid var(--blue)', background: 'var(--blue-light)' }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Файл настроек{loaded.data.from ? ` «${loaded.data.from}»` : ''}{loaded.data.at ? ` · ${new Date(loaded.data.at).toLocaleDateString('ru-RU')}` : ''}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '2px 0 6px' }}>Отметьте, что восстановить:</div>
          {SECTIONS.filter(([k]) => loaded.sections.includes(k)).map(([k, t, sub]) => (
            <label key={k} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 0', borderTop: '0.5px solid var(--border)', cursor: 'pointer' }}>
              <input type="checkbox" checked={loaded.picked.has(k)} style={{ width: 18, height: 18, flex: '0 0 18px', margin: '1px 0 0', padding: 0 }}
                onChange={() => setLoaded(l => { const p = new Set(l.picked); if (p.has(k)) p.delete(k); else p.add(k); return { ...l, picked: p } })} />
              <span style={{ fontSize: 13.5 }}>{t}<span style={{ display: 'block', fontSize: 11, color: 'var(--text-hint)' }}>{sub}</span></span>
            </label>
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button type="button" className="btn-secondary" style={{ ...btn, flex: 1 }} onClick={() => setLoaded(null)}>Отмена</button>
            <button type="button" className="btn-primary" style={{ ...btn, flex: 1 }} disabled={!!busy || !loaded.picked.size} onClick={apply}>{busy === 'apply' ? 'Восстанавливаем…' : `Восстановить (${loaded.picked.size})`}</button>
          </div>
        </div>
      )}
      {msg && <p style={{ fontSize: 12.5, color: /Не |не удалось|Не получилось/.test(msg) && !/^✓/.test(msg) ? 'var(--danger)' : 'var(--teal)', marginTop: 8 }}>{msg}</p>}
    </div>
  )
}
