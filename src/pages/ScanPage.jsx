import { useEffect, useRef, useState, Suspense } from 'react'
import { useNavigate } from 'react-router-dom'
import BottomNav from '../components/BottomNav'
import CncLoader from '../components/CncLoader'
import { lazyRetry } from '../lib/lazyRetry'
import { resolveQr, qrLink } from '../lib/qrResolve'
import { hasModel } from '../lib/model3d'
import { loadOrderModel } from '../lib/orderModel'
import { orderTitle } from '../lib/orderUtils'
import { detailMeta } from '../lib/partLabel'

const Model3D = lazyRetry(() => import('../components/Model3D'))

// Сканер QR-кода бирки: навели камеру на бирку — открылась эта деталь в 3D-модели заказа (дальше — вверх по структуре).
// Код на бирке остаётся обычным текстом, который читает и сканер станка.
export default function ScanPage() {
  const navigate = useNavigate()
  const videoRef = useRef(null)
  const [state, setState] = useState({ step: 'scan' })     // scan | find | show | fail
  const [camError, setCamError] = useState('')
  const [manual, setManual] = useState('')
  const busy = useRef(false)

  const found = async text => {
    if (busy.current) return
    busy.current = true
    const link = qrLink(text)
    if (link) { navigate(link); return }                    // на бирке — ссылка на 3D-модель
    setState({ step: 'find', text })
    const r = await resolveQr(text)
    if (r.error) { setState({ step: 'fail', text, error: r.error }); busy.current = false; return }
    let scene = null
    if (hasModel(r.details)) { try { scene = await loadOrderModel(r.order.id) } catch { scene = null } }
    setState({ step: 'show', text, ...r, scene })
    busy.current = false
  }
  const foundRef = useRef(found)
  foundRef.current = found

  // камера и распознавание: встроенное в браузер, а где его нет — своей библиотекой
  useEffect(() => {
    if (state.step !== 'scan') return
    let stream = null, timer = 0, stop = false
    ;(async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false })
      } catch (e) { setCamError(e?.name === 'NotAllowedError' ? 'Нет доступа к камере — разрешите его в настройках браузера для этого сайта.' : 'Камера недоступна на этом устройстве.'); return }
      if (stop) { stream.getTracks().forEach(t => t.stop()); return }
      const video = videoRef.current
      if (!video) return
      video.srcObject = stream
      try { await video.play() } catch { /* запустится по касанию */ }
      let detector = null, jsQR = null
      try { if ('BarcodeDetector' in window) detector = new window.BarcodeDetector({ formats: ['qr_code'] }) } catch { detector = null }
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
            if (text) { foundRef.current(text); return }
          }
        } catch { /* кадр не прочитался — пробуем следующий */ }
        timer = setTimeout(tick, 220)
      }
      tick()
    })()
    return () => { stop = true; clearTimeout(timer); stream?.getTracks().forEach(t => t.stop()) }
  }, [state.step])

  const again = () => { busy.current = false; setCamError(''); setState({ step: 'scan' }) }

  if (state.step === 'show') {
    const { order, details, di, des, scene } = state
    const d = di >= 0 ? details[di] : null
    const wait = <div style={{ position: 'fixed', inset: 0, zIndex: 960, background: 'var(--bg2)' }}><CncLoader label="Строим 3D-модель…" /></div>
    if (d && hasModel(details)) {
      return (
        <Suspense fallback={wait}>
          <Model3D details={details} scene={scene} title={[detailMeta(d)?.des, d.name].filter(Boolean).join(' ') || orderTitle(order)} onClose={again} readOnly orderId={null}
            materialThickness={order.material_thickness || 16} focus={{ di, des }} />
        </Suspense>
      )
    }
    return (
      <div className="page" style={{ paddingBottom: 100 }}>
        <h1 style={{ fontSize: 18, fontWeight: 500, margin: '8px 0 12px' }}>Сканер QR</h1>
        <div className="card" style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--text-hint)' }}>Заказ</div>
          <div style={{ fontSize: 16, fontWeight: 500, marginBottom: 6 }}>{orderTitle(order)}</div>
          {d ? (
            <>
              <div style={{ fontSize: 12, color: 'var(--text-hint)' }}>Деталь</div>
              <div style={{ fontSize: 15, fontWeight: 500 }}>{[detailMeta(d)?.des, d.name].filter(Boolean).join(' ') || 'Деталь'} — {d.length}×{d.width}, {d.qty} шт.</div>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>У этого заказа нет 3D-модели (детали введены вручную), поэтому показать деталь в модели нельзя.</p>
            </>
          ) : <p style={{ fontSize: 13, color: 'var(--amber)' }}>Заказ найден, но деталь по коду определить не удалось. В код бирки нужно включить обозначение детали или номер карты и номер детали.</p>}
          <button className="btn-primary" style={{ marginTop: 10 }} onClick={() => navigate(`/orders/${order.id}`)}>Открыть заказ</button>
        </div>
        <button className="btn-secondary" onClick={again}>Сканировать ещё</button>
        <BottomNav />
      </div>
    )
  }

  return (
    <div className="page" style={{ paddingBottom: 100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '8px 0 12px' }}>
        <button type="button" onClick={() => navigate('/profile')} style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 22, padding: 0, lineHeight: 1 }}>←</button>
        <h1 style={{ fontSize: 18, fontWeight: 500 }}>Сканер QR</h1>
      </div>
      {state.step === 'find' && <CncLoader compact label="Ищем деталь…" />}
      {state.step === 'fail' && (
        <div className="card" style={{ marginBottom: 12, border: '1px solid var(--amber)' }}>
          <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--amber)', marginBottom: 4 }}>{state.error}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', wordBreak: 'break-all' }}>В коде: <span style={{ fontFamily: 'monospace' }}>{state.text}</span></div>
          <button className="btn-primary" style={{ marginTop: 10 }} onClick={again}>Сканировать ещё</button>
        </div>
      )}
      {state.step === 'scan' && (
        <>
          <div style={{ position: 'relative', borderRadius: 14, overflow: 'hidden', background: '#111', aspectRatio: '3 / 4', maxHeight: '62vh', margin: '0 auto 10px' }}>
            <video ref={videoRef} playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            <div style={{ position: 'absolute', inset: '18% 14%', border: '2px solid rgba(255,255,255,0.85)', borderRadius: 14, boxShadow: '0 0 0 2000px rgba(0,0,0,0.28)' }} />
          </div>
          {camError
            ? <p style={{ fontSize: 13, color: 'var(--danger)', marginBottom: 10 }}>{camError}</p>
            : <p style={{ fontSize: 12, color: 'var(--text-hint)', textAlign: 'center', marginBottom: 10 }}>Наведите камеру на QR-код бирки — откроется эта деталь в 3D-модели заказа</p>}
          <div style={{ display: 'flex', gap: 6 }}>
            <input type="text" value={manual} onChange={e => setManual(e.target.value)} placeholder="или введите код с бирки" style={{ flex: 1, minWidth: 0 }} />
            <button type="button" className="btn-secondary" style={{ width: 'auto', padding: '0 14px' }} disabled={!manual.trim()} onClick={() => found(manual)}>Найти</button>
          </div>
        </>
      )}
      <BottomNav />
    </div>
  )
}
