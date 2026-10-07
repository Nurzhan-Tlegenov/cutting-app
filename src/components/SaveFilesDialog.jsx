import { useState } from 'react'
import { zipSync, strToU8 } from 'fflate'

// Перед сохранением нескольких файлов — вопрос: одним архивом или все файлы по отдельности (не архивом).
// files — [{ name, data: строка | Uint8Array }]; zipName — имя архива; onDone(сообщение) — что получилось.
const bytes = d => (typeof d === 'string' ? strToU8(d) : d)
function download(name, data, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const a = document.createElement('a')
  a.href = url; a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

export default function SaveFilesDialog({ files, zipName, onClose, onDone }) {
  const [busy, setBusy] = useState('')
  if (!files?.length) return null
  const done = msg => { setBusy(''); onDone?.(msg); onClose() }
  const asZip = () => {
    setBusy('Собираем архив…')
    setTimeout(() => {
      download(zipName, zipSync(Object.fromEntries(files.map(f => [f.name, bytes(f.data)])), { level: 6 }), 'application/zip')
      done(`Архив «${zipName}» отправлен на сохранение — файлов в нём: ${files.length}`)
    }, 30)
  }
  const separate = async () => {
    // все файлы разом в выбранную папку; где браузер этого не умеет — загрузками друг за другом
    if (window.showDirectoryPicker) {
      try {
        const dir = await window.showDirectoryPicker({ mode: 'readwrite' })
        setBusy('Сохраняем файлы…')
        for (const f of files) { const h = await dir.getFileHandle(f.name, { create: true }); const w = await h.createWritable(); await w.write(f.data); await w.close() }
        done(`Сохранено файлов: ${files.length} — в папку «${dir.name}»`)
        return
      } catch (e) { if (e?.name === 'AbortError') { setBusy(''); return } }
    }
    setBusy('Сохраняем файлы…')
    for (let i = 0; i < files.length; i++) { setBusy(`Сохраняем файлы… ${i + 1} из ${files.length}`); download(files[i].name, files[i].data); await new Promise(r => setTimeout(r, 350)) }
    done(`Отправлено на сохранение файлов: ${files.length}`)
  }
  return (
    <div onClick={busy ? undefined : onClose} style={{ position: 'fixed', inset: 0, zIndex: 400, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} className="card" style={{ width: '100%', maxWidth: 480, borderRadius: '16px 16px 0 0', paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}>
        <div style={{ fontWeight: 500, fontSize: 16, marginBottom: 4 }}>Как сохранить файлы?</div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>Файлов: {files.length}</p>
        {busy ? <p style={{ fontSize: 13, color: 'var(--text-hint)', padding: '8px 0' }}>{busy}</p> : (
          <>
            <button type="button" className="btn-primary" onClick={separate}>Все файлы по отдельности</button>
            <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: '4px 0 10px' }}>
              {window.showDirectoryPicker ? 'Выберите папку — все файлы запишутся в неё разом.' : 'Файлы сохранятся в «Загрузки» друг за другом; браузер может спросить разрешение на несколько загрузок — разрешите.'}
            </p>
            <button type="button" className="btn-secondary" onClick={asZip}>Одним архивом (zip)</button>
            <button type="button" onClick={onClose} style={{ width: '100%', marginTop: 10, padding: 9, background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 14 }}>Отмена</button>
          </>
        )}
      </div>
    </div>
  )
}
