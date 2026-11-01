// Файл в сообщении: картинку (скриншот) — посмотреть прямо здесь, любой файл — скачать.
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { messagePayload, payloadBlob } from '../lib/messages'

const isImageName = n => /\.(png|jpe?g|gif|webp|bmp|heic)$/i.test(n || '')
const sizeTxt = n => (n > 1048576 ? (n / 1048576).toFixed(1) + ' МБ' : n > 1024 ? Math.round(n / 1024) + ' КБ' : (n || 0) + ' Б')

function downloadPayload(name, payload) {
  const url = URL.createObjectURL(payloadBlob(payload))
  const a = document.createElement('a')
  a.href = url; a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30000)
}

export default function MsgFile({ m, onError, light = false }) {
  const [busy, setBusy] = useState(false)
  const [img, setImg] = useState(null)       // { url, name } — открытая картинка
  if (!m?.file_name) return null
  const get = async view => {
    setBusy(true)
    const r = await messagePayload(m.id)
    setBusy(false)
    if (r.error) { onError?.(r.error); return }
    if (view) setImg({ url: URL.createObjectURL(payloadBlob(r.payload)), name: r.fileName })
    else downloadPayload(r.fileName, r.payload)
  }
  const pic = isImageName(m.file_name)
  const btn = { padding: '4px 10px', borderRadius: 16, fontSize: 12, border: `0.5px solid ${light ? 'rgba(255,255,255,.7)' : 'var(--teal)'}`, background: 'transparent', color: light ? '#fff' : 'var(--teal)', cursor: 'pointer', whiteSpace: 'nowrap' }
  return (
    <div style={{ marginTop: 5 }}>
      <div style={{ fontSize: 12, opacity: 0.85, wordBreak: 'break-all', marginBottom: 4 }}>📎 {m.file_name} · {sizeTxt(m.file_size * 0.75)}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {pic && <button type="button" style={btn} disabled={busy} onClick={() => get(true)}>👁 Посмотреть</button>}
        <button type="button" style={btn} disabled={busy} onClick={() => get(false)}>{busy ? '…' : '⬇ Скачать'}</button>
      </div>
      {img && createPortal(
        <div onClick={() => { URL.revokeObjectURL(img.url); setImg(null) }}
          style={{ position: 'fixed', inset: 0, zIndex: 3000, background: 'rgba(0,0,0,.88)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }}>
          <img src={img.url} alt={img.name} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 6 }} />
          <span style={{ position: 'absolute', top: 'calc(10px + env(safe-area-inset-top))', right: 14, color: '#fff', fontSize: 28 }}>×</span>
        </div>,
        document.body,
      )}
    </div>
  )
}
