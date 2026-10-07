import { useState } from 'react'
import { zipSync, strToU8 } from 'fflate'

// Перед сохранением нескольких файлов — вопрос: одним архивом или все файлы по отдельности (не архивом).
// files — [{ name, data: строка | Uint8Array }]; zipName — имя архива; onDone(сообщение) — что получилось.
// folders — вложенные папки, в которые кладутся файлы: [заказ, материал]. При сохранении по отдельности они
// создаются внутри выбранной папки; в архиве файлы лежат в этих же папках.
// «Поделиться» — системное меню телефона (мессенджеры, облачные диски); выбор «куда сохранить» у обычного
// сохранения задаёт телефон, не приложение.
const bytes = d => (typeof d === 'string' ? strToU8(d) : d)
function download(name, data, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const a = document.createElement('a')
  a.href = url; a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

export default function SaveFilesDialog({ files, zipName, onClose, onDone, folders = [] }) {
  const [busy, setBusy] = useState('')
  if (!files?.length) return null
  const path = folders.filter(Boolean)
  const zipData = () => zipSync(Object.fromEntries(files.map(f => [[...path, f.name].join('/'), bytes(f.data)])), { level: 6 })
  const zipFile = () => new File([zipData()], zipName, { type: 'application/zip' })
  // «Поделиться» — системное меню телефона (мессенджеры, облачные диски). Сначала пробуем отдать файлы по отдельности;
  // если браузер такие файлы передавать не разрешает (у него свой список типов) — архивом. Папок при передаче
  // по отдельности не бывает: приложение-получатель получает просто набор файлов; папки сохраняются только в архиве.
  const MIME = { bmp: 'image/bmp', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf', xml: 'text/xml', txt: 'text/plain', csv: 'text/csv' }
  const asFiles = () => files.map(f => new File([bytes(f.data)], f.name, { type: MIME[f.name.split('.').pop().toLowerCase()] || 'text/plain' }))
  const can = list => { try { return !!navigator.canShare && navigator.canShare({ files: list }) } catch { return false } }
  const shareMode = can(files.map(f => new File([new Uint8Array(1)], f.name, { type: MIME[f.name.split('.').pop().toLowerCase()] || 'text/plain' }))) ? 'files'
    : can([new File([new Uint8Array(1)], zipName, { type: 'application/zip' })]) ? 'zip' : ''
  const share = async () => {
    setBusy(shareMode === 'zip' ? 'Собираем архив…' : 'Готовим файлы…')
    try {
      await navigator.share({ files: shareMode === 'zip' ? [zipFile()] : asFiles(), title: path.join(' / ') || zipName })
      done(shareMode === 'zip' ? `Архив «${zipName}» передан в выбранное приложение` : `Файлы (${files.length}) переданы в выбранное приложение`)
    } catch (e) { setBusy(''); if (e?.name !== 'AbortError') window.alert('Не удалось передать файлы в другое приложение. Сохраните их архивом и отправьте из памяти телефона.') }
  }
  const done = msg => { setBusy(''); onDone?.(msg); onClose() }
  const asZip = () => {
    setBusy('Собираем архив…')
    setTimeout(() => {
      download(zipName, zipData(), 'application/zip')
      done(`Архив «${zipName}» отправлен на сохранение — файлов в нём: ${files.length}`)
    }, 30)
  }
  const separate = async () => {
    // все файлы разом в выбранную папку; где браузер этого не умеет — загрузками друг за другом
    if (window.showDirectoryPicker) {
      try {
        const top = await window.showDirectoryPicker({ mode: 'readwrite' })
        setBusy('Сохраняем файлы…')
        let dir = top
        for (const name of path) dir = await dir.getDirectoryHandle(name, { create: true })       // папка заказа, в ней — папка материала
        for (const f of files) { const h = await dir.getFileHandle(f.name, { create: true }); const w = await h.createWritable(); await w.write(f.data); await w.close() }
        done(`Сохранено файлов: ${files.length} — в папку «${[top.name, ...path].join('/')}»`)
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
              {window.showDirectoryPicker
                ? `Выберите папку — в ней ${path.length ? `создастся «${path.join('/')}», и ` : ''}все файлы запишутся туда разом.`
                : `Файлы сохранятся в «Загрузки» друг за другом; браузер может спросить разрешение на несколько загрузок — разрешите.${path.length ? ' Папки на телефоне браузер создать не может — они есть внутри архива.' : ''}`}
            </p>
            <button type="button" className="btn-secondary" onClick={asZip}>Одним архивом (zip)</button>
            {path.length > 0 && <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: '4px 0 10px' }}>В архиве файлы лежат в папках «{path.join('/')}».</p>}
            <button type="button" className="btn-secondary" disabled={!shareMode} onClick={share} style={{ opacity: shareMode ? 1 : 0.5 }}>Поделиться…</button>
            <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: '4px 0 0' }}>
              {shareMode === 'files' ? `Откроется меню «Поделиться» телефона — мессенджер или облачный диск. Уйдут файлы по отдельности (${files.length} шт.); папки при такой передаче не создаются — их создаёт только сохранение в папку или архив.`
                : shareMode === 'zip' ? `Откроется меню «Поделиться» телефона — мессенджер или облачный диск. Файлы этого типа по отдельности браузер передавать не разрешает, поэтому уйдёт архив${path.length ? ` с папками «${path.join('/')}» внутри` : ''}.`
                  : 'В этом браузере меню «Поделиться» для таких файлов недоступно. Сохраните архив и отправьте его из памяти телефона.'}
            </p>
            <button type="button" onClick={onClose} style={{ width: '100%', marginTop: 10, padding: 9, background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 14 }}>Отмена</button>
          </>
        )}
      </div>
    </div>
  )
}
