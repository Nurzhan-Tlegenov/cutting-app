import { useEffect, useRef, useState } from 'react'

// Редактор картинки для бирки: убрать фон (сделать прозрачным), обрезать пустые поля, перевернуть цвета.
// Результат — PNG с прозрачным фоном в хорошем качестве (до 1400 точек по большей стороне).
// src — File/Blob или адрес картинки; onDone(blob) — готовая картинка; onCancel — закрыть.
const MAX = 1400

async function loadImage(src) {
  const blob = typeof src === 'string' ? await (await fetch(src)).blob() : src
  const url = URL.createObjectURL(blob)
  try {
    return await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Не удалось прочитать картинку')); i.src = url })
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000) }
}

// фон — цвет углов и краёв картинки; убирается заливкой от краёв (только связанный с краем фон — белое внутри
// значка остаётся) или везде по цвету
function process(base, { removeBg, tol, everywhere, trim, invert, soft }) {
  const w = base.width, h = base.height
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h
  const g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(base, 0, 0)
  const img = g.getImageData(0, 0, w, h), d = img.data
  if (removeBg) {
    // цвет фона: средний по рамке в 2 точки
    let r = 0, gg = 0, b = 0, n = 0
    const add = i => { if (d[i + 3] > 10) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++ } }
    for (let x = 0; x < w; x++) for (const y of [0, 1, h - 2, h - 1]) if (y >= 0 && y < h) add((y * w + x) * 4)
    for (let y = 0; y < h; y++) for (const x of [0, 1, w - 2, w - 1]) if (x >= 0 && x < w) add((y * w + x) * 4)
    if (n) { r /= n; gg /= n; b /= n }
    const t2 = tol * tol * 3
    const dist = i => { const a = d[i] - r, c = d[i + 1] - gg, e = d[i + 2] - b; return a * a + c * c + e * e }
    const kill = new Uint8Array(w * h)
    if (everywhere) { for (let p = 0; p < w * h; p++) if (d[p * 4 + 3] < 10 || dist(p * 4) <= t2) kill[p] = 1 }
    else {
      const st = []
      const push = p => { if (!kill[p] && (d[p * 4 + 3] < 10 || dist(p * 4) <= t2)) { kill[p] = 1; st.push(p) } }
      for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x) }
      for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1) }
      while (st.length) {
        const p = st.pop(), x = p % w
        if (x > 0) push(p - 1); if (x < w - 1) push(p + 1); if (p >= w) push(p - w); if (p < w * (h - 1)) push(p + w)
      }
    }
    for (let p = 0; p < w * h; p++) {
      if (kill[p]) { d[p * 4 + 3] = 0; continue }
      // мягкий край: точки, близкие к фону, — полупрозрачные (без «лесенки» вокруг значка)
      if (soft) { const k = Math.sqrt(dist(p * 4) / (t2 || 1)); if (k < 2) d[p * 4 + 3] = Math.round(d[p * 4 + 3] * Math.min(1, (k - 1) * 1)) }
    }
  }
  if (invert) for (let p = 0; p < w * h; p++) { d[p * 4] = 255 - d[p * 4]; d[p * 4 + 1] = 255 - d[p * 4 + 1]; d[p * 4 + 2] = 255 - d[p * 4 + 2] }
  g.putImageData(img, 0, 0)
  if (!trim) return cv
  let x0 = w, y0 = h, x1 = -1, y1 = -1
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 12) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
  if (x1 < 0) return cv
  const pad = 2, cx = Math.max(0, x0 - pad), cy = Math.max(0, y0 - pad), cw = Math.min(w, x1 + pad + 1) - cx, ch = Math.min(h, y1 + pad + 1) - cy
  const out = document.createElement('canvas'); out.width = cw; out.height = ch
  out.getContext('2d').drawImage(cv, cx, cy, cw, ch, 0, 0, cw, ch)
  return out
}

export default function LabelImageEditor({ src, onDone, onCancel }) {
  const [base, setBase] = useState(null)
  const [err, setErr] = useState('')
  const [opt, setOpt] = useState({ removeBg: true, tol: 40, everywhere: false, trim: true, invert: false, soft: true })
  const [busy, setBusy] = useState(false)
  const viewRef = useRef(null), outRef = useRef(null)
  useEffect(() => {
    let alive = true
    loadImage(src).then(im => {
      if (!alive) return
      const iw = im.naturalWidth || 600, ih = im.naturalHeight || 600, k = Math.min(1, MAX / Math.max(iw, ih))
      const cv = document.createElement('canvas'); cv.width = Math.max(1, Math.round(iw * k)); cv.height = Math.max(1, Math.round(ih * k))
      const g = cv.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(im, 0, 0, cv.width, cv.height)
      setBase(cv)
    }).catch(e => { if (alive) setErr(typeof src === 'string' ? 'С этого адреса картинку взять не получилось (сайт не разрешает). Сохраните её на телефон и выберите файлом.' : String(e?.message || e)) })
    return () => { alive = false }
  }, [src])
  useEffect(() => {
    if (!base) return
    const t = setTimeout(() => {
      const out = process(base, opt); outRef.current = out
      const v = viewRef.current; if (!v) return
      const box = v.parentElement.clientWidth || 300, k = Math.min(box / out.width, 260 / out.height, 4)
      v.width = Math.max(1, Math.round(out.width * k)); v.height = Math.max(1, Math.round(out.height * k))
      const g = v.getContext('2d'); g.clearRect(0, 0, v.width, v.height); g.imageSmoothingQuality = 'high'; g.drawImage(out, 0, 0, v.width, v.height)
    }, 60)
    return () => clearTimeout(t)
  }, [base, opt])
  const set = patch => setOpt(o => ({ ...o, ...patch }))
  const save = () => { const out = outRef.current; if (!out) return; setBusy(true); out.toBlob(b => { setBusy(false); if (b) onDone(b) }, 'image/png') }
  const chk = (k, label) => (
    <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, padding: '3px 0', cursor: 'pointer' }}>
      <input type="checkbox" checked={!!opt[k]} onChange={e => set({ [k]: e.target.checked })} style={{ width: 17, height: 17 }} />{label}
    </label>
  )
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 260, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }} onClick={onCancel}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--bg)', width: '100%', maxWidth: 520, borderRadius: '14px 14px 0 0', padding: '14px 14px calc(14px + env(safe-area-inset-bottom))', maxHeight: '92dvh', overflowY: 'auto' }}>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 8 }}>Картинка для бирки</div>
        {err ? <p className="error-text">{err}</p> : (
          <>
            {/* шахматка — видно, где фон стал прозрачным */}
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 120, borderRadius: 8, marginBottom: 10,
              backgroundColor: '#fff', backgroundImage: 'linear-gradient(45deg,#ddd 25%,transparent 25%),linear-gradient(-45deg,#ddd 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#ddd 75%),linear-gradient(-45deg,transparent 75%,#ddd 75%)',
              backgroundSize: '16px 16px', backgroundPosition: '0 0,0 8px,8px -8px,-8px 0' }}>
              {base ? <canvas ref={viewRef} style={{ maxWidth: '100%' }} /> : <span style={{ fontSize: 12, color: 'var(--text-hint)' }}>Загружаем…</span>}
            </div>
            {chk('removeBg', 'Убрать фон — прозрачный PNG')}
            {opt.removeBg && (
              <div style={{ paddingLeft: 24 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Насколько похожий на фон цвет убирать: {opt.tol}</div>
                <input type="range" min={5} max={140} value={opt.tol} onChange={e => set({ tol: Number(e.target.value) })} style={{ width: '100%' }} />
                {chk('everywhere', 'Убирать этот цвет везде (и внутри значка)')}
                {chk('soft', 'Сгладить край')}
              </div>
            )}
            {chk('trim', 'Обрезать пустые поля')}
            {chk('invert', 'Перевернуть цвета (белое ↔ чёрное)')}
            <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: '6px 0 10px' }}>Принтер бирок печатает чёрным: тёмные части картинки — чёрные точки, прозрачное и светлое — без печати.</p>
          </>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn-secondary" onClick={onCancel} style={{ flex: 1 }}>Отмена</button>
          {!err && <button type="button" className="btn-primary" disabled={!base || busy} onClick={save} style={{ flex: 2 }}>{busy ? 'Сохраняем…' : 'Поставить на бирку'}</button>}
        </div>
      </div>
    </div>
  )
}
