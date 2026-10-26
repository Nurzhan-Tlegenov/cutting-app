import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'

// ─── Две колонки на экране компьютера ───────────────────────────────────────
// Слева — превью (карты раскроя, картинки), справа — кнопки и настройки.
// Между ними — разделитель: тянуть мышью влево/вправо (как ширину колонки в проводнике Windows),
// двойной щелчок — вернуть как было. Ширина запоминается отдельно для каждого экрана (id).
// Колонки занимают всё окно по высоте (над нижним меню) и прокручиваются каждая сама.
// Страница-обёртка на компьютере — без отступов и без собственной прокрутки (className="page desk-page").
//
// Размер левой колонки доступен через usePane() — по нему карты подстраиваются под окно,
// в том числе то, что попадает в левую колонку порталом (контекст общий для обеих колонок).

const PaneCtx = createContext(null)
export const usePane = () => useContext(PaneCtx)

const read = (key, def) => {
  try { const v = Number(localStorage.getItem(key)); return v > 0.05 && v < 0.95 ? v : def } catch { return def }
}

export default function DeskSplit({ id, left, right, def = 0.62, min = 0.25, max = 0.82, leftRef = null, full = false }) {
  const key = 'deskSplit:' + id
  const [ratio, setRatio] = useState(() => read(key, def))
  const [pane, setPane] = useState(null)
  const [navH, setNavH] = useState(0)
  const [drag, setDrag] = useState(false)
  const boxRef = useRef(null)
  const leftBox = useRef(null)

  // нижнее меню — фиксированное: колонки заканчиваются над ним
  useLayoutEffect(() => {
    const upd = () => setNavH(document.querySelector('.bottom-nav')?.offsetHeight || 0)
    upd()
    const t = setTimeout(upd, 300)
    window.addEventListener('resize', upd)
    return () => { clearTimeout(t); window.removeEventListener('resize', upd) }
  }, [])

  // размер левой колонки (без внутренних отступов) — для карт
  useLayoutEffect(() => {
    const el = leftBox.current
    if (!el) return
    const upd = () => {
      const cs = getComputedStyle(el)
      const w = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      const h = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
      setPane(p => (p && Math.abs(p.w - w) < 2 && Math.abs(p.h - h) < 2 ? p : { w: Math.floor(w), h: Math.floor(h) }))
    }
    upd()
    if (typeof ResizeObserver === 'undefined') { window.addEventListener('resize', upd); return () => window.removeEventListener('resize', upd) }
    const ro = new ResizeObserver(upd)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const setLeft = el => {
    leftBox.current = el
    if (typeof leftRef === 'function') leftRef(el)
    else if (leftRef) leftRef.current = el
  }

  function onDown(e) {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    setDrag(true)
  }
  function onMove(e) {
    if (!drag) return
    const r = boxRef.current?.getBoundingClientRect()
    if (!r || r.width <= 0) return
    setRatio(Math.max(min, Math.min(max, (e.clientX - r.left) / r.width)))
  }
  function onUp() {
    if (!drag) return
    setDrag(false)
    try { localStorage.setItem(key, String(ratio)) } catch { /* без памяти */ }
  }
  function reset() {
    setRatio(def)
    try { localStorage.removeItem(key) } catch { /* без памяти */ }
  }
  // пока тянем — текст не выделяется, курсор «↔» по всему окну
  useEffect(() => {
    if (!drag) return
    const prev = document.body.style.cursor, us = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'
    return () => { document.body.style.cursor = prev; document.body.style.userSelect = us }
  }, [drag])

  return (
    <PaneCtx.Provider value={pane}>
      {/* обычный блок высотой в окно (не position: fixed): fixed создал бы свой слой, и окна поверх страницы
          (3D, редактор контура, диалоги) оказывались бы под нижним меню */}
      <div ref={boxRef} className="desk-split" style={{ height: full ? '100dvh' : `calc(100dvh - ${navH}px)`, display: 'flex' }}>
        <div ref={setLeft} className="desk-pane desk-pane-left"
          style={{ flex: `0 0 ${(ratio * 100).toFixed(2)}%`, minWidth: 0, overflow: 'auto', scrollbarGutter: 'stable', padding: '14px 12px 14px 20px', background: 'var(--bg2)' }}>
          {left}
        </div>
        <div className={'desk-divider' + (drag ? ' on' : '')} title="Потяните, чтобы изменить ширину колонок · двойной щелчок — как было"
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onDoubleClick={reset}>
          <span />
        </div>
        <div className="desk-pane desk-pane-right"
          style={{ flex: '1 1 0', minWidth: 0, overflow: 'auto', scrollbarGutter: 'stable', padding: '14px 20px 24px 12px' }}>
          {right}
        </div>
      </div>
    </PaneCtx.Provider>
  )
}

// ─── Ширина правой колонки в редакторах «на весь экран» (PDF, бирки, контур, ЧПУ) ───
// const [sideW, handle] = useSideWidth('pdf-layout', 380) → в разметке: превью | {handle} | колонка шириной sideW.
// Тянуть разделитель мышью; двойной щелчок — как было. Ширина запоминается.
export function useSideWidth(id, def = 380, min = 260, max = 900) {
  const key = 'deskSide:' + id
  const [w, setW] = useState(() => { try { const v = Number(localStorage.getItem(key)); return v >= min && v <= max ? v : def } catch { return def } })
  const st = useRef(null)
  const [on, setOn] = useState(false)
  const onDown = e => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const box = e.currentTarget.parentElement?.getBoundingClientRect()
    st.current = { right: box ? box.right : window.innerWidth, w }
    setOn(true)
  }
  const onMove = e => {
    if (!st.current) return
    const lim = Math.min(max, (window.innerWidth || 1200) - 300)
    setW(Math.round(Math.max(min, Math.min(lim, st.current.right - e.clientX))))
  }
  const onUp = () => {
    if (!st.current) return
    st.current = null
    setOn(false)
    setW(v => { try { localStorage.setItem(key, String(v)) } catch { /* без памяти */ } return v })
  }
  const reset = () => { setW(def); try { localStorage.removeItem(key) } catch { /* без памяти */ } }
  useEffect(() => {
    if (!on) return
    const prev = document.body.style.cursor, us = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'
    return () => { document.body.style.cursor = prev; document.body.style.userSelect = us }
  }, [on])
  const handle = (
    <div className={'desk-divider' + (on ? ' on' : '')} title="Потяните, чтобы изменить ширину колонок · двойной щелчок — как было"
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onDoubleClick={reset}>
      <span />
    </div>
  )
  return [w, handle]
}
