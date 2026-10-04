import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { parseGcode, fmtTime } from '../lib/gcodeSim'

// Симулятор G-кода в 3D: лист на столе, траектории фрезы в объёме (с глубиной), фреза идёт по программе,
// на листе остаётся след реза. Один палец — вращать, два — масштаб и сдвиг.
// Траектории по видам (контуры деталей, вырезы, пазы и выемки, отверстия, входы и выходы, холостые)
// включаются и выключаются по отдельности. Тап по траектории выделяет её (и всю операцию) и показывает
// её строку в G-коде; тап по строке G-кода — выделяет её траекторию. Список G-кода листается.
//
// text — G-код; kinds / opIds — вид операции и её номер по строкам (из генератора; без них всё — «контуры»);
// sheet — { x, y, w, l } лист в координатах станка; outlines — контуры деталей [[x, y]…];
// toolDia(T) — диаметр инструмента по номеру; thickness — толщина материала; rapid — холостая подача.

const SPEEDS = [1, 5, 20, 60, 200]
const LAYERS = [
  { id: 'outer', label: 'Контуры деталей', groups: ['outer'], css: '#185FA5' },
  { id: 'cutout', label: 'Вырезы', groups: ['cutout'], css: '#7B1FA2' },
  { id: 'pocket', label: 'Пазы и выемки', groups: ['pocket'], css: '#1D9E75' },
  { id: 'hole', label: 'Отверстия', groups: ['hole'], css: '#D9480F' },
  { id: 'io', label: 'Входы и выходы', groups: ['entry', 'exit'], css: '#2E9E3F' },
  { id: 'rapid', label: 'Холостые', groups: ['rapid'], css: '#888780' },
]
const GROUP = {
  outer: [0x185FA5, 'контур детали'], cutout: [0x7B1FA2, 'вырез'], pocket: [0x1D9E75, 'паз / выемка'], hole: [0xD9480F, 'отверстие'],
  entry: [0x2E9E3F, 'вход'], exit: [0xE24B4A, 'выход'], rapid: [0x888780, 'холостой ход'],
}
const LAYER_OF = Object.fromEntries(LAYERS.flatMap(l => l.groups.map(g => [g, l.id])))
const LH = 18, CODE_H = 198

function groupOf(m, kind) {
  const vert = Math.abs(m.x1 - m.x0) < 1e-6 && Math.abs(m.y1 - m.y0) < 1e-6
  if (kind === 'hole') return m.rapid && !vert ? 'rapid' : 'hole'
  if (m.rapid) return vert && m.z1 > m.z0 ? 'exit' : 'rapid'
  if (m.z1 < m.z0 - 1e-6) return 'entry'
  if (kind === 'groove' || kind === 'pocket') return 'pocket'
  return kind === 'cutout' ? 'cutout' : 'outer'
}

export default function GcodeSimulator({ text, kinds, opIds, sheet, outlines, toolDia, thickness = 16, rapid = 20000, title = '', onClose }) {
  const prog = useMemo(() => parseGcode(text, { rapid }), [text, rapid])
  const data = useMemo(() => {
    const groups = {}, firstByLine = new Map()
    const grp = prog.moves.map((m, i) => {
      const g = groupOf(m, kinds?.[m.line])
      const o = groups[g] || (groups[g] = { pos: [] })
      o.pos.push(m.x0, m.y0, m.z0, m.x1, m.y1, m.z1)
      if (!firstByLine.has(m.line)) firstByLine.set(m.line, i)
      return g
    })
    return { groups, grp, firstByLine }
  }, [prog, kinds])
  const total = prog.lines.length - (prog.lines[prog.lines.length - 1] === '' ? 1 : 0)

  const wrapRef = useRef(null), mountRef = useRef(null), codeRef = useRef(null)
  const api = useRef(null)                 // сцена: setTime, select, setVis, setView, resize
  const tRef = useRef(0), speedRef = useRef(20), pickRef = useRef(null), diaRef = useRef(toolDia)
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(20)
  const [vis, setVis] = useState(() => Object.fromEntries(LAYERS.map(l => [l.id, true])))
  const [sel, setSel] = useState(-1)       // выделенное перемещение
  const [scrollTop, setScrollTop] = useState(0)

  const moveAt = time => {
    const m = prog.moves
    let lo = 0, hi = m.length - 1
    if (hi < 0) return -1
    while (lo < hi) { const mid = (lo + hi) >> 1; if (m[mid].t1 < time) lo = mid + 1; else hi = mid }
    return lo
  }
  const seek = v => { tRef.current = Number(v); setT(tRef.current) }
  const choose = i => { setPlaying(false); setSel(i); if (i >= 0) seek(prog.moves[i].t1) }
  const chooseLine = li => {
    for (let k = li; k < total; k++) if (data.firstByLine.has(k)) { choose(data.firstByLine.get(k)); return }
  }
  useEffect(() => { speedRef.current = speed }, [speed])
  useEffect(() => { diaRef.current = toolDia; pickRef.current = choose })

  // ─── сцена ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const mount = mountRef.current, wrap = wrapRef.current
    if (!mount || !wrap) return
    const b = prog.box, T = Number(thickness) || 16
    const S = sheet || { x: b.x0, y: b.y0, w: Math.max(1, b.x1 - b.x0), l: Math.max(1, b.y1 - b.y0) }
    const cx = S.x + S.w / 2, cy = S.y + S.l / 2, big = Math.max(S.w, S.l)
    const viewH = () => Math.round(Math.max(260, Math.min(window.innerHeight * 0.5, 620)))
    let W = wrap.clientWidth || 360, H = viewH()

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setSize(W, H)
    renderer.setClearColor(0xE8E6DF)
    const el = renderer.domElement
    el.style.display = 'block'; el.style.touchAction = 'none'
    mount.appendChild(el)
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(35, W / H, 5, big * 30)
    camera.up.set(0, 0, 1)
    const controls = new OrbitControls(camera, el)
    controls.target.set(cx, cy, 0)
    controls.maxPolarAngle = Math.PI / 2 - 0.03
    controls.minDistance = 40; controls.maxDistance = big * 6
    const disposables = []
    const keep = x => { disposables.push(x); return x }
    let raf = 0
    const render = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderer.render(scene, camera) }) }
    controls.addEventListener('change', render)

    // стол, лист, верх листа с рисунком реза
    const table = new THREE.Mesh(keep(new THREE.PlaneGeometry(S.w + 300, S.l + 300)), keep(new THREE.MeshBasicMaterial({ color: 0xD3D1C7 })))
    table.position.set(cx, cy, -0.3); scene.add(table)
    const body = new THREE.Mesh(keep(new THREE.BoxGeometry(S.w, S.l, T)), keep(new THREE.MeshBasicMaterial({ color: 0xC2AD84 })))
    body.position.set(cx, cy, T / 2 - 0.05); scene.add(body)
    const k = Math.min(2048 / big, 2)
    const cv = document.createElement('canvas')
    cv.width = Math.max(2, Math.round(S.w * k)); cv.height = Math.max(2, Math.round(S.l * k))
    const ctx = cv.getContext('2d')
    const tex = keep(new THREE.CanvasTexture(cv))
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy()
    const top = new THREE.Mesh(keep(new THREE.PlaneGeometry(S.w, S.l)), keep(new THREE.MeshBasicMaterial({ map: tex })))
    top.position.set(cx, cy, T); scene.add(top)
    const PX = x => (x - S.x) * k, PY = y => (S.l - (y - S.y)) * k
    const base = () => {
      ctx.fillStyle = '#FBFAF6'; ctx.fillRect(0, 0, cv.width, cv.height)
      ctx.fillStyle = '#ECEAE3'; ctx.strokeStyle = 'rgba(20,20,20,0.4)'; ctx.lineWidth = 1
      ;(outlines || []).forEach(pts => {
        ctx.beginPath()
        pts.forEach(([x, y], i) => (i ? ctx.lineTo(PX(x), PY(y)) : ctx.moveTo(PX(x), PY(y))))
        ctx.closePath(); ctx.fill(); ctx.stroke()
      })
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    }
    const kerf = (m, x1, y1, z1) => {
      if (m.rapid) return
      const zLow = Math.min(m.z0, z1)
      if (zLow >= T - 0.001) return
      const d = Math.max(1.5, (diaRef.current?.(m.tool) || 3) * k)
      ctx.strokeStyle = ctx.fillStyle = zLow <= 0.6 ? '#4A4741' : '#B9975B'       // насквозь — тёмный, на глубину — светлее
      if (Math.abs(m.x0 - x1) < 1e-6 && Math.abs(m.y0 - y1) < 1e-6) { ctx.beginPath(); ctx.arc(PX(x1), PY(y1), d / 2, 0, Math.PI * 2); ctx.fill(); return }
      ctx.lineWidth = d
      ctx.beginPath(); ctx.moveTo(PX(m.x0), PY(m.y0)); ctx.lineTo(PX(x1), PY(y1)); ctx.stroke()
    }
    base()

    // траектории — по видам
    const lines = {}
    Object.entries(data.groups).forEach(([g, o]) => {
      const geo = keep(new LineSegmentsGeometry())
      geo.setPositions(new Float32Array(o.pos))
      const dashed = g === 'rapid'
      const mat = keep(new LineMaterial({ color: GROUP[g][0], linewidth: dashed ? 1.2 : 2.2, depthTest: false, transparent: true, opacity: dashed ? 0.75 : 1, dashed, dashSize: 22, gapSize: 16 }))
      mat.resolution.set(W, H)
      const obj = new LineSegments2(geo, mat)
      if (dashed) obj.computeLineDistances()
      obj.renderOrder = dashed ? 2 : 3; obj.frustumCulled = false
      scene.add(obj); lines[g] = obj
    })
    // выделение: операция целиком + сама траектория
    const selMat = keep(new LineMaterial({ color: 0xFFB300, linewidth: 4.5, depthTest: false, transparent: true }))
    selMat.resolution.set(W, H)
    let selObj = null
    const oneMat = keep(new LineMaterial({ color: 0xFF2D95, linewidth: 7, depthTest: false, transparent: true }))
    oneMat.resolution.set(W, H)
    let oneObj = null
    // фреза
    const toolGeo = keep(new THREE.CylinderGeometry(0.5, 0.5, 60, 24)); toolGeo.translate(0, 30, 0); toolGeo.rotateX(Math.PI / 2)
    const tool = new THREE.Mesh(toolGeo, keep(new THREE.MeshBasicMaterial({ color: 0xE24B4A, transparent: true, opacity: 0.8 })))
    tool.renderOrder = 4; scene.add(tool)

    const st = { drawn: 0, vis: Object.fromEntries(LAYERS.map(l => [l.id, true])) }
    const find = time => {
      const m = prog.moves
      let lo = 0, hi = m.length - 1
      if (hi < 0) return -1
      while (lo < hi) { const mid = (lo + hi) >> 1; if (m[mid].t1 < time) lo = mid + 1; else hi = mid }
      return lo
    }
    const setTime = time => {
      const cur = find(time), moves = prog.moves
      if (cur < 0) { render(); return }
      if (cur < st.drawn) { base(); st.drawn = 0 }
      for (let i = st.drawn; i < cur; i++) kerf(moves[i], moves[i].x1, moves[i].y1, moves[i].z1)
      st.drawn = cur
      const m = moves[cur], f = m.t1 > m.t0 ? Math.max(0, Math.min(1, (time - m.t0) / (m.t1 - m.t0))) : 1
      const x = m.x0 + (m.x1 - m.x0) * f, y = m.y0 + (m.y1 - m.y0) * f, z = m.z0 + (m.z1 - m.z0) * f
      if (time > 0) kerf(m, x, y, z)
      tex.needsUpdate = true
      const d = diaRef.current?.(m.tool) || 3
      tool.position.set(time > 0 ? x : m.x0, time > 0 ? y : m.y0, time > 0 ? z : m.z0); tool.scale.set(d, d, 1)
      render()
    }
    const fat = (pos, mat, order) => { const geo = new LineSegmentsGeometry(); geo.setPositions(new Float32Array(pos)); const o = new LineSegments2(geo, mat); o.renderOrder = order; o.frustumCulled = false; scene.add(o); return o }
    const select = i => {
      for (const o of [selObj, oneObj]) if (o) { scene.remove(o); o.geometry.dispose() }
      selObj = oneObj = null
      const m = prog.moves[i]
      if (m) {
        const op = opIds?.[m.line] || 0, pos = []
        if (op) prog.moves.forEach((q, qi) => { if (opIds[q.line] === op && data.grp[qi] !== 'rapid') pos.push(q.x0, q.y0, q.z0, q.x1, q.y1, q.z1) })
        if (pos.length) selObj = fat(pos, selMat, 4)                                        // вся операция
        oneObj = fat([m.x0, m.y0, m.z0, m.x1, m.y1, m.z1], oneMat, 5)                       // сама траектория
      }
      render()
    }
    const setVisible = v => { st.vis = v; Object.entries(lines).forEach(([g, o]) => { o.visible = v[LAYER_OF[g]] !== false }); render() }
    const setView = kind => {
      const D = big * 1.75
      if (kind === 'top') camera.position.set(cx, cy - 1, D * 1.05)
      else camera.position.set(cx - D * 0.3, cy - D * 0.7, D * 0.6)
      controls.target.set(cx, cy, 0); controls.update(); render()
    }
    const resize = () => {
      W = wrap.clientWidth || W; H = viewH()
      renderer.setSize(W, H); camera.aspect = W / H; camera.updateProjectionMatrix()
      Object.values(lines).forEach(o => o.material.resolution.set(W, H)); selMat.resolution.set(W, H); oneMat.resolution.set(W, H)
      render()
    }
    // тап по траектории — ближайшая к пальцу на экране
    const v = new THREE.Vector3()
    const proj = (x, y, z) => { v.set(x, y, z).project(camera); return [(v.x + 1) / 2 * W, (1 - v.y) / 2 * H, v.z] }
    const pick = (px, py) => {
      let best = -1, bd = 18
      prog.moves.forEach((m, i) => {
        const g = data.grp[i]
        if (st.vis[LAYER_OF[g]] === false) return
        const a = proj(m.x0, m.y0, m.z0), c = proj(m.x1, m.y1, m.z1)
        if (a[2] > 1 || c[2] > 1) return
        const dx = c[0] - a[0], dy = c[1] - a[1], l2 = dx * dx + dy * dy
        const f = l2 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2)) : 0
        let d = Math.hypot(px - a[0] - f * dx, py - a[1] - f * dy)
        if (g === 'rapid') d = d * 2 + 5                 // холостые — в последнюю очередь
        if (d < bd) { bd = d; best = i }
      })
      return best
    }
    let down = null
    const onDown = e => { down = e.isPrimary ? { x: e.clientX, y: e.clientY, t: performance.now() } : null }
    const onUp = e => {
      if (!down || !e.isPrimary) return
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), dt = performance.now() - down.t
      down = null
      if (moved > 7 || dt > 500) return
      const r = el.getBoundingClientRect()
      pickRef.current?.(pick(e.clientX - r.left, e.clientY - r.top))
    }
    el.addEventListener('pointerdown', onDown); el.addEventListener('pointerup', onUp)
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null
    ro?.observe(wrap)

    setView('iso'); setTime(tRef.current)
    api.current = { setTime, select, setVisible, setView }
    return () => {
      api.current = null
      ro?.disconnect(); cancelAnimationFrame(raf)
      el.removeEventListener('pointerdown', onDown); el.removeEventListener('pointerup', onUp)
      controls.dispose()
      for (const o of [selObj, oneObj]) if (o) o.geometry.dispose()
      disposables.forEach(x => x.dispose())
      renderer.dispose(); el.remove()
    }
  }, [prog, data, opIds, sheet, outlines, thickness])

  useEffect(() => { api.current?.setTime(t) }, [t, prog, data, sheet, outlines, thickness, opIds])
  useEffect(() => { api.current?.setVisible(vis) }, [vis, prog, data, sheet, outlines, thickness, opIds])
  useEffect(() => { api.current?.select(sel) }, [sel, prog, data, sheet, outlines, thickness, opIds])

  // проигрывание
  useEffect(() => {
    if (!playing) return
    let last = 0, id = 0
    const step = ts => {
      if (last) tRef.current = Math.min(prog.time, tRef.current + (ts - last) / 1000 * speedRef.current)
      last = ts
      setT(tRef.current)
      if (tRef.current >= prog.time) { setPlaying(false); return }
      id = requestAnimationFrame(step)
    }
    id = requestAnimationFrame(step)
    return () => cancelAnimationFrame(id)
  }, [playing, prog])

  const ci = moveAt(t), cm = ci >= 0 ? prog.moves[ci] : null
  const line = cm ? cm.line : 0
  const selLine = sel >= 0 ? prog.moves[sel]?.line : -1
  // текущая строка — всегда на виду в списке кода
  useEffect(() => {
    const el = codeRef.current
    if (!el) return
    const y = line * LH
    if (y < el.scrollTop + LH || y > el.scrollTop + CODE_H - 2 * LH) el.scrollTop = Math.max(0, y - CODE_H / 2 + LH / 2)
  }, [line])

  const first = Math.max(0, Math.floor(scrollTop / LH) - 4), count = Math.ceil(CODE_H / LH) + 8
  const chip = on => ({ padding: '5px 9px', borderRadius: 20, fontSize: 12, border: 'none', background: on ? 'var(--blue)' : 'var(--bg2)', color: on ? 'white' : 'var(--text-muted)' })
  const viewBtn = { padding: '5px 10px', borderRadius: 20, fontSize: 12, border: '0.5px solid var(--border-md)', background: 'rgba(255,255,255,0.9)', color: 'var(--text)' }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title || 'Симулятор'}</div>
        <span style={{ fontSize: 11, color: 'var(--text-hint)', whiteSpace: 'nowrap' }}>{fmtTime(t)} / {fmtTime(prog.time)}</span>
        {onClose && <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, color: 'var(--text-muted)', padding: '0 4px' }}>×</button>}
      </div>
      <div ref={wrapRef} style={{ position: 'relative', background: 'var(--bg3)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
        <div ref={mountRef} />
        <div style={{ position: 'absolute', top: 6, right: 6, display: 'flex', gap: 4 }}>
          <button type="button" style={viewBtn} onClick={() => api.current?.setView('iso')}>3D</button>
          <button type="button" style={viewBtn} onClick={() => api.current?.setView('top')}>Сверху</button>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 8 }}>
        {LAYERS.filter(l => l.groups.some(g => data.groups[g])).map(l => (
          <button key={l.id} type="button" onClick={() => setVis(v => ({ ...v, [l.id]: !v[l.id] }))}
            style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 9px', borderRadius: 20, fontSize: 12, border: '0.5px solid ' + (vis[l.id] ? l.css : 'var(--border-md)'), background: vis[l.id] ? 'var(--bg)' : 'var(--bg2)', color: vis[l.id] ? 'var(--text)' : 'var(--text-hint)', textDecoration: vis[l.id] ? 'none' : 'line-through' }}>
            <i style={{ width: 9, height: 9, borderRadius: 5, background: vis[l.id] ? l.css : 'var(--gray-mid)' }} />{l.label}
          </button>
        ))}
      </div>
      <input type="range" min={0} max={prog.time || 1} step="any" value={t} onChange={e => { setPlaying(false); seek(e.target.value) }} style={{ width: '100%', padding: 0, margin: '8px 0 4px', border: 'none' }} />
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" onClick={() => { if (t >= prog.time) seek(0); setPlaying(p => !p) }}
          style={{ padding: '7px 16px', borderRadius: 20, border: 'none', background: 'var(--blue)', color: 'white', fontSize: 14, fontWeight: 500 }}>{playing ? '⏸ Пауза' : '▶ Пуск'}</button>
        <button type="button" onClick={() => { setPlaying(false); seek(0) }} style={chip(false)}>⏮</button>
        <button type="button" onClick={() => { setPlaying(false); seek(prog.time) }} style={chip(false)}>⏭</button>
        <span style={{ flex: 1 }} />
        {SPEEDS.map(s => <button key={s} type="button" onClick={() => setSpeed(s)} style={chip(speed === s)}>×{s}</button>)}
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8, fontSize: 12, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
        <span>T{cm?.tool ?? '—'}</span>
        <span>X{cm ? Math.round(cm.x1 * 10) / 10 : 0} Y{cm ? Math.round(cm.y1 * 10) / 10 : 0} Z{cm ? Math.round(cm.z1 * 100) / 100 : 0}</span>
        <span>{cm?.rapid ? 'холостой' : `F${cm ? Math.round(cm.feed) : 0}`}</span>
        {sel >= 0 && (
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
            <b style={{ fontWeight: 500, color: '#B26A00' }}>Выбрано: {GROUP[data.grp[sel]]?.[1]}, строка {selLine + 1}</b>
            <button type="button" onClick={() => setSel(-1)} style={{ background: 'none', border: 'none', color: 'var(--text-hint)', fontSize: 15, padding: 0 }}>×</button>
          </span>
        )}
      </div>
      <div ref={codeRef} onScroll={e => setScrollTop(e.currentTarget.scrollTop)}
        style={{ marginTop: 8, height: CODE_H, overflowY: 'auto', background: 'var(--bg2)', borderRadius: 'var(--radius)', fontFamily: 'monospace', fontSize: 11, WebkitOverflowScrolling: 'touch' }}>
        <div style={{ position: 'relative', height: total * LH }}>
          {prog.lines.slice(first, Math.min(total, first + count)).map((s, i) => {
            const li = first + i, isCur = li === line, isSel = li === selLine
            return (
              <div key={li} onClick={() => chooseLine(li)}
                style={{ position: 'absolute', top: li * LH, left: 0, right: 0, height: LH, lineHeight: LH + 'px', padding: '0 8px', whiteSpace: 'pre', cursor: 'pointer', overflow: 'hidden',
                  background: isSel ? '#FFE6A6' : isCur ? 'var(--blue-light)' : 'transparent', color: isCur || isSel ? 'var(--blue-dark)' : 'var(--text-muted)', fontWeight: isCur || isSel ? 600 : 400 }}>
                <span style={{ color: 'var(--text-hint)', fontWeight: 400 }}>{String(li + 1).padStart(5, ' ')}  </span>{s}
              </div>
            )
          })}
        </div>
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: '6px 0 0' }}>Тап по траектории или по строке кода — выделить. Один палец — вращать, два — масштаб и сдвиг.</p>
    </div>
  )
}
