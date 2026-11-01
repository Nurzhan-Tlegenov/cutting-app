// Файл в сообщении: картинку (скриншот) видно сразу — миниатюра прямо в переписке, нажать — на весь экран;
// любой файл можно скачать.
import { useEffect, useState } from 'react'
import ImageZoom from './ImageZoom'
import { messagePayload, payloadBlob } from '../lib/messages'

const isImageName = n => /\.(png|jpe?g|gif|webp|bmp|heic)$/i.test(n || '')
const sizeTxt = n => (n > 1048576 ? (n / 1048576).toFixed(1) + ' МБ' : n > 1024 ? Math.round(n / 1024) + ' КБ' : (n || 0) + ' Б')
const urls = new Map()        // уже загруженные картинки: id сообщения -> адрес (второй раз из базы не качаем)

function downloadPayload(name, payload) {
  const url = URL.createObjectURL(payloadBlob(payload))
  const a = document.createElement('a')
  a.href = url; a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30000)
}

export default function MsgFile({ m, onError, light = false }) {
  const pic = isImageName(m?.file_name)
  const [busy, setBusy] = useState(false)
  const [url, setUrl] = useState(() => (m?.id ? urls.get(m.id) || null : null))
  const [full, setFull] = useState(false)
  // картинка — сразу загружаем миниатюру
  useEffect(() => {
    if (!pic || url || !m?.id) return
    let alive = true
    messagePayload(m.id).then(r => {
      if (!alive || r.error || !r.payload) return
      const u = URL.createObjectURL(payloadBlob(r.payload))
      urls.set(m.id, u); setUrl(u)
    })
    return () => { alive = false }
  }, [m?.id, pic, url])
  if (!m?.file_name) return null
  const download = async () => {
    setBusy(true)
    const r = await messagePayload(m.id)
    setBusy(false)
    if (r.error) { onError?.(r.error); return }
    downloadPayload(r.fileName, r.payload)
  }
  const btn = { padding: '4px 10px', borderRadius: 16, fontSize: 12, border: `0.5px solid ${light ? 'rgba(255,255,255,.7)' : 'var(--teal)'}`, background: 'transparent', color: light ? '#fff' : 'var(--teal)', cursor: 'pointer', whiteSpace: 'nowrap' }
  return (
    <div style={{ marginTop: 5 }}>
      {pic ? (
        url
          ? <img src={url} alt={m.file_name} onClick={() => setFull(true)} style={{ display: 'block', maxWidth: '100%', maxHeight: 260, borderRadius: 10, cursor: 'zoom-in', background: '#fff' }} />
          : <div style={{ width: 160, height: 100, borderRadius: 10, background: light ? 'rgba(255,255,255,.18)' : 'var(--bg2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, opacity: 0.8 }}>картинка…</div>
      ) : <div style={{ fontSize: 12, opacity: 0.85, wordBreak: 'break-all', marginBottom: 4 }}>📎 {m.file_name} · {sizeTxt(m.file_size * 0.75)}</div>}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: pic ? 5 : 0 }}>
        <button type="button" style={btn} disabled={busy} onClick={download}>{busy ? '…' : '⬇ Скачать'}</button>
      </div>
      {full && url && <ImageZoom src={url} alt={m.file_name} onClose={() => setFull(false)} />}
    </div>
  )
}
