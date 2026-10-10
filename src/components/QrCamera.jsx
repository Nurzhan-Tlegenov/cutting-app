import { useEffect, useRef, useState } from 'react'

// Камера для сканирования QR бирок подряд: onCode(text) на каждый прочитанный код. Тот же код повторно — не раньше
// чем через 2,5 с (чтобы одна бирка перед камерой не считалась много раз). Распознавание — встроенное в браузер,
// а где его нет — библиотекой jsQR.
export default function QrCamera({ onCode, height = 220 }) {
  const videoRef = useRef(null)
  const cb = useRef(onCode)
  useEffect(() => { cb.current = onCode }, [onCode])
  const [err, setErr] = useState('')
  useEffect(() => {
    let stream = null, timer = 0, stop = false
    const last = { text: '', at: 0 }
    ;(async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false })
      } catch (e) { setErr(e?.name === 'NotAllowedError' ? 'Нет доступа к камере — разрешите его в настройках браузера.' : 'Камера недоступна на этом устройстве.'); return }
      if (stop) { stream.getTracks().forEach(t => t.stop()); return }
      const video = videoRef.current
      if (!video) return
      video.srcObject = stream
      try { await video.play() } catch { /* запустится по касанию */ }
      let detector = null, jsQR = null
      try { if ('BarcodeDetector' in window) detector = new window.BarcodeDetector({ formats: ['qr_code', 'code_128', 'ean_13', 'data_matrix'] }) } catch { detector = null }
      if (!detector) { try { jsQR = (await import('jsqr')).default } catch { jsQR = null } }
      const cv = document.createElement('canvas'), ctx = cv.getContext('2d', { willReadFrequently: true })
      const tick = async () => {
        if (stop) return
        try {
          if (video.readyState >= 2 && video.videoWidth) {
            let text = ''
            if (detector) { const r = await detector.detect(video); text = r[0]?.rawValue || '' }
            else if (jsQR) {
              const k = Math.min(1, 800 / video.videoWidth)
              cv.width = Math.round(video.videoWidth * k); cv.height = Math.round(video.videoHeight * k)
              ctx.drawImage(video, 0, 0, cv.width, cv.height)
              const d = ctx.getImageData(0, 0, cv.width, cv.height)
              text = jsQR(d.data, d.width, d.height)?.data || ''
            }
            const now = Date.now()
            if (text && (text !== last.text || now - last.at > 2500)) { last.text = text; last.at = now; cb.current(text) }
            else if (text) last.at = now
          }
        } catch { /* кадр не прочитался — следующий */ }
        timer = setTimeout(tick, 200)
      }
      tick()
    })()
    return () => { stop = true; clearTimeout(timer); stream?.getTracks().forEach(t => t.stop()) }
  }, [])
  if (err) return <p style={{ fontSize: 12, color: 'var(--danger)', margin: '6px 0' }}>{err}</p>
  return (
    <div style={{ position: 'relative', height, background: '#000', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
      <video ref={videoRef} playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      <div style={{ position: 'absolute', inset: '18% 22%', border: '2px solid rgba(255,255,255,.8)', borderRadius: 12, pointerEvents: 'none' }} />
    </div>
  )
}
