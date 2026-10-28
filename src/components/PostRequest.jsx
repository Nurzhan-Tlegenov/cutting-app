// Запрос постпроцессора у разработчика (мастер-аккаунта): из каталога («Станок X — запросить») или под свой станок.
// Станок, система ЧПУ, пример рабочей программы со станка (G-код) — по нему настраивается постпроцессор.
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { requestPost, PROGRAM_MAX } from '../lib/postAccess'
import { useBackClose } from '../lib/backStack'

export default function PostRequest({ catalogItem = null, onClose, onSent }) {
  useBackClose(true, onClose)
  const [machine, setMachine] = useState('')
  const [controller, setController] = useState('')
  const [note, setNote] = useState('')
  const [file, setFile] = useState(null)               // { name, text }
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const pick = async e => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    const text = await f.text()
    setFile({ name: f.name, text: text.slice(0, PROGRAM_MAX), cut: text.length > PROGRAM_MAX })
  }
  const send = async () => {
    if (!catalogItem && !machine.trim()) { setErr('Напишите, какой у вас станок — хотя бы производитель и модель.'); return }
    setBusy(true); setErr('')
    const r = await requestPost({ post_id: catalogItem?.id, machine: machine.trim(), controller: controller.trim(), note: note.trim(), program_name: file?.name, program: file?.text })
    setBusy(false)
    if (r.error) { setErr(r.error); return }
    onSent?.(); onClose()
    window.alert('Запрос отправлен. Когда постпроцессор будет выдан, он появится в списке станков в настройках ЧПУ.')
  }
  const field = { width: '100%', padding: '8px 10px', fontSize: 14, borderRadius: 8, border: '1px solid var(--border-md)', background: 'var(--bg)', color: 'var(--text)', fontFamily: 'inherit', marginTop: 3 }
  const lbl = { display: 'block', fontSize: 12, color: 'var(--text-muted)', marginTop: 10 }
  return createPortal(
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1250, background: 'rgba(0,0,0,.38)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 520, maxHeight: '90dvh', overflowY: 'auto', background: 'var(--bg)', borderRadius: '18px 18px 0 0', padding: '14px 16px 22px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, fontSize: 16, fontWeight: 600 }}>{catalogItem ? `Запросить «${catalogItem.name}»` : 'Запросить постпроцессор'}</div>
          <button type="button" onClick={onClose} style={{ width: 34, height: 34, borderRadius: 17, border: 'none', background: 'var(--bg2)', fontSize: 18, cursor: 'pointer', color: 'var(--text-muted)' }}>×</button>
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '6px 0 0' }}>
          Постпроцессоры настраиваются и выдаются по запросу — под ваш станок. Чем точнее описание и пример программы, тем быстрее настройка.
        </p>
        <label style={lbl}>Станок: производитель, модель{catalogItem ? ' (если отличается)' : ''}
          <input type="text" value={machine} onChange={e => setMachine(e.target.value)} placeholder="Например: Woodtec H 2040" style={field} />
        </label>
        <label style={lbl}>Система ЧПУ (контроллер)
          <input type="text" value={controller} onChange={e => setController(e.target.value)} placeholder="NC Studio, Syntec, Weihong, Mach3…" style={field} />
        </label>
        <label style={lbl}>Что ещё важно
          <textarea value={note} onChange={e => setNote(e.target.value)} rows={3} placeholder="Присадочная голова, датчик длины инструмента, магазин на 8 инструментов…" style={{ ...field, resize: 'vertical' }} />
        </label>
        <div style={lbl}>Пример рабочей программы со станка (G-код) — лучше лист, где есть и раскрой, и сверление</div>
        <label style={{ display: 'block', marginTop: 4, padding: '9px 10px', borderRadius: 10, border: '1px dashed var(--blue)', color: 'var(--blue)', fontSize: 13, cursor: 'pointer', textAlign: 'center' }}>
          {file ? `📄 ${file.name}${file.cut ? ' (взято начало файла)' : ''} — заменить` : '📂 Выбрать файл программы'}
          <input type="file" onChange={pick} style={{ display: 'none' }} />
        </label>
        {err && <p className="error-text" style={{ marginTop: 8 }}>{err}</p>}
        <button type="button" className="btn-primary" disabled={busy} onClick={send} style={{ marginTop: 14 }}>{busy ? 'Отправляем…' : 'Отправить запрос'}</button>
      </div>
    </div>,
    document.body,
  )
}
