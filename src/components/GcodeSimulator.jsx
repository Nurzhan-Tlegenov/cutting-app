import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
const LH = 18

function groupOf(m, kind) {
  const vert = Math.abs(m.x1 - m.x0) < 1e-6 && Math.abs(m.y1 - m.y0) < 1e-6
  if (kind === 'hole') return m.rapid && !vert ? 'rapid' : 'hole'
  if (m.rapid) return vert && m.z1 > m.z0 ? 'exit' : 'rapid'
  if (m.z1 < m.z0 - 1e-6) return 'entry'
  if (kind === 'groove' || kind === 'pocket') return 'pocket'
  return kind === 'cutout' ? 'cutout' : 'outer'
}

export default function GcodeSimulator({ text, kinds, opIds, sheet, outlines, toolDia, thickness = 16, rapid = 20000, title = '', onClose, onDownload }) {
  const prog = useMemo(() => parseGcode(text, { rapid }), [text, rapid])
  const data = useMemo(() => {
    const groups = {}, firstByLine = new Map()
    const grp = prog.moves.map((m, i) => {
      const g = groupOf(m, kinds?.[m.line])
      const o = groups[g] || (groups[g] = { pos: [], idx: [] })
      o.idx.push(i)
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
  const [viewH, setViewH] = useState(() => Math.round(Math.max(200, Math.min(window.innerHeight * 0.42, 620))))   // высота 3D-окна — двигается границей
  const dragRef = useRef(null)

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
    let W = wrap.clientWidth || 360, H = wrap.clientHeight || 300

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 3))
    renderer.setSize(W, H)
    renderer.setClearColor(0xDEDBD2)
    const el = renderer.domElement
    el.style.display = 'block'; el.style.touchAction = 'none'
    mount.appendChild(el)
    const scene = new THREE.Scene()
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8478, 1.6))
    const sun = new THREE.DirectionalLight(0xffffff, 1.8); sun.position.set(-0.4, -0.7, 1); scene.add(sun)
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

    // Стол и лист. Лист — «слоёный»: верх (ламинат) и несколько срезов сердцевины по толщине. Фреза вырезает
    // материал в слоях (прозрачность рисунка), поэтому рез виден объёмно: насквозь — до стола, паз — до середины.
    const table = new THREE.Mesh(keep(new THREE.PlaneGeometry(S.w + 300, S.l + 300)), keep(new THREE.MeshBasicMaterial({ color: 0x8B7658 })))
    table.position.set(cx, cy, -0.3); scene.add(table)
    const sideMat = keep(new THREE.MeshBasicMaterial({ color: 0xB69364 })), noMat = keep(new THREE.MeshBasicMaterial({ visible: false }))
    const body = new THREE.Mesh(keep(new THREE.BoxGeometry(S.w, S.l, T)), [sideMat, sideMat, sideMat, sideMat, noMat, noMat])
    body.position.set(cx, cy, T / 2); scene.add(body)
    const maxTex = Math.min(renderer.capabilities.maxTextureSize || 2048, 3072)
    const k = Math.min(maxTex / big, 2)
    const mkCanvas = () => { const c = document.createElement('canvas'); c.width = Math.max(2, Math.round(S.w * k)); c.height = Math.max(2, Math.round(S.l * k)); return c }
    const cvA = mkCanvas(), cvB = mkCanvas()            // A — всё, что срезано сверху; B — только прорезанное насквозь
    const cA = cvA.getContext('2d'), cB = cvB.getContext('2d')
    const mkTex = c => { const t = keep(new THREE.CanvasTexture(c)); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = renderer.capabilities.getMaxAnisotropy(); return t }
    const texA = mkTex(cvA), texB = mkTex(cvB)
    const planeGeo = keep(new THREE.PlaneGeometry(S.w, S.l))
    const SLICES = 8
    for (let i = 1; i <= SLICES; i++) {
      const topLayer = i === SLICES, f = i / SLICES
      const shade = 0.55 + 0.4 * f                                                    // глубже — темнее
      const color = topLayer ? new THREE.Color(1, 1, 1) : new THREE.Color(0.78 * shade, 0.62 * shade, 0.42 * shade)
      const mat = keep(new THREE.MeshBasicMaterial({ map: f > 0.5 ? texA : texB, color, transparent: true, depthWrite: false }))
      const pl = new THREE.Mesh(planeGeo, mat)
      pl.position.set(cx, cy, T * f); pl.renderOrder = i; scene.add(pl)
    }
    const PX = x => (x - S.x) * k, PY = y => (S.l - (y - S.y)) * k
    const base = () => {
      for (const c of [cA, cB]) { c.globalCompositeOperation = 'source-over'; c.lineCap = 'round'; c.lineJoin = 'round' }
      cB.fillStyle = '#FFFFFF'; cB.fillRect(0, 0, cvB.width, cvB.height)
      cA.fillStyle = '#FAF8F2'; cA.fillRect(0, 0, cvA.width, cvA.height)
      cA.fillStyle = '#F1EEE6'; cA.strokeStyle = 'rgba(40,40,40,0.28)'; cA.lineWidth = Math.max(1, k)
      ;(outlines || []).forEach(pts => {
        cA.beginPath()
        pts.forEach(([x, y], i) => (i ? cA.lineTo(PX(x), PY(y)) : cA.moveTo(PX(x), PY(y))))
        cA.closePath(); cA.fill(); cA.stroke()
      })
      for (const c of [cA, cB]) c.globalCompositeOperation = 'destination-out'
      st.dirtyA = st.dirtyB = true
    }
    const erase = (c, m, x1, y1, d) => {
      if (Math.abs(m.x0 - x1) < 1e-6 && Math.abs(m.y0 - y1) < 1e-6) { c.beginPath(); c.arc(PX(x1), PY(y1), d / 2, 0, Math.PI * 2); c.fill(); return }
      c.lineWidth = d
      c.beginPath(); c.moveTo(PX(m.x0), PY(m.y0)); c.lineTo(PX(x1), PY(y1)); c.stroke()
    }
    const kerf = (m, x1, y1, z1) => {
      if (m.rapid) return
      const zLow = Math.min(m.z0, z1)
      if (zLow >= T - 0.001) return
      const d = Math.max(1.5, (diaRef.current?.(m.tool) || 3) * k)
      erase(cA, m, x1, y1, d); st.dirtyA = true
      if (zLow <= T * 0.5) { erase(cB, m, x1, y1, d); st.dirtyB = true }
    }

    // траектории — по видам; при проигрывании показывается только пройденная часть
    const lines = {}
    const fatLine = (pos, mat, order) => { const geo = new LineSegmentsGeometry(); geo.setPositions(new Float32Array(pos)); const o = new LineSegments2(geo, mat); o.renderOrder = order; o.frustumCulled = false; scene.add(o); return o }
    const mats = {}
    Object.entries(data.groups).forEach(([g, o]) => {
      const dashed = g === 'rapid'
      const mat = keep(new LineMaterial({ color: GROUP[g][0], linewidth: dashed ? 1.2 : 2.2, depthTest: false, transparent: true, opacity: dashed ? 0.75 : 1, dashed, dashSize: 22, gapSize: 16 }))
      mat.resolution.set(W, H); mats[g] = mat
      const obj = fatLine(o.pos, mat, dashed ? 20 : 21)
      keep(obj.geometry)
      if (dashed) obj.computeLineDistances()
      obj.__total = o.idx.length
      lines[g] = obj
    })
    let liveObj = null                                   // отрезок, который фреза проходит прямо сейчас
    // выделение: операция целиком + сама траектория
    const selMat = keep(new LineMaterial({ color: 0xFFB300, linewidth: 4.5, depthTest: false, transparent: true }))
    selMat.resolution.set(W, H)
    let selObj = null
    const oneMat = keep(new LineMaterial({ color: 0xFF2D95, linewidth: 7, depthTest: false, transparent: true }))
    oneMat.resolution.set(W, H)
    let oneObj = null
    // шпиндель с фрезой
    const tool = new THREE.Group()
    const zCyl = (r, h, z0, mat, seg = 32) => { const g = keep(new THREE.CylinderGeometry(r, r, h, seg)); g.translate(0, h / 2 + z0, 0); g.rotateX(Math.PI / 2); const m = new THREE.Mesh(g, mat); tool.add(m); return m }
    const steel = keep(new THREE.MeshPhongMaterial({ color: 0xC8CDD4, specular: 0xffffff, shininess: 90 }))
    const cutter = zCyl(0.5, 34, 0, steel)
    zCyl(15, 18, 34, keep(new THREE.MeshPhongMaterial({ color: 0x3A3D42, specular: 0x999999, shininess: 60 })))
    zCyl(42, 130, 52, keep(new THREE.MeshPhongMaterial({ color: 0x9AA3AD, specular: 0xffffff, shininess: 40, transparent: true, opacity: 0.28, depthWrite: false })))
    tool.traverse(o => { o.renderOrder = 30 })
    scene.add(tool)

    const st = { drawn: 0, vis: Object.fromEntries(LAYERS.map(l => [l.id, true])), dirtyA: true, dirtyB: true, lastUp: 0, timer: 0, cur: -1, live: true }
    const find = time => {
      const m = prog.moves
      let lo = 0, hi = m.length - 1
      if (hi < 0) return -1
      while (lo < hi) { const mid = (lo + hi) >> 1; if (m[mid].t1 < time) lo = mid + 1; else hi = mid }
      return lo
    }
    const flush = () => {
      st.timer = 0; st.lastUp = performance.now()
      if (st.dirtyA) { texA.needsUpdate = true; st.dirtyA = false }
      if (st.dirtyB) { texB.needsUpdate = true; st.dirtyB = false }
      render()
    }
    const countBefore = (idx, cur) => { let lo = 0, hi = idx.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (idx[mid] < cur) lo = mid + 1; else hi = mid } return lo }
    const showLines = () => {
      Object.entries(lines).forEach(([g, o]) => {
        const n = st.live ? countBefore(data.groups[g].idx, st.cur) : o.__total
        o.geometry.instanceCount = n
        o.visible = n > 0 && st.vis[LAYER_OF[g]] !== false
      })
      if (liveObj) liveObj.visible = st.live && st.vis[LAYER_OF[liveObj.__g]] !== false
    }
    // live — траектории строятся по ходу фрезы (после «Пуск»); иначе показана вся программа целиком
    const setTime = (time, live) => {
      const cur = find(time), moves = prog.moves
      if (liveObj) { scene.remove(liveObj); liveObj.geometry.dispose(); liveObj = null }
      st.live = !!live; st.cur = cur
      if (cur < 0) { showLines(); render(); return }
      if (!live) { if (st.drawn > 0) { base(); st.drawn = 0 } }
      else {
        if (cur < st.drawn) { base(); st.drawn = 0 }
        for (let i = st.drawn; i < cur; i++) kerf(moves[i], moves[i].x1, moves[i].y1, moves[i].z1)
        st.drawn = cur
      }
      const m = moves[cur], f = !live ? 0 : m.t1 > m.t0 ? Math.max(0, Math.min(1, (time - m.t0) / (m.t1 - m.t0))) : 1
      const x = m.x0 + (m.x1 - m.x0) * f, y = m.y0 + (m.y1 - m.y0) * f, z = m.z0 + (m.z1 - m.z0) * f
      if (live && f > 0) {
        kerf(m, x, y, z)
        const g = data.grp[cur]
        liveObj = fatLine([m.x0, m.y0, m.z0, x, y, z], mats[g], 22); liveObj.__g = g
        if (g === 'rapid') liveObj.computeLineDistances()
      }
      const d = diaRef.current?.(m.tool) || 3
      tool.position.set(x, y, z); cutter.scale.set(d, d, 1)
      showLines()
      if (st.dirtyA || st.dirtyB) {                        // рисунок реза обновляем не чаще ~12 раз в секунду — движение остаётся плавным
        if (performance.now() - st.lastUp > 80) flush(); else if (!st.timer) st.timer = setTimeout(flush, 90)
      }
      render()
    }
    const fat = fatLine
    const select = i => {
      for (const o of [selObj, oneObj]) if (o) { scene.remove(o); o.geometry.dispose() }
      selObj = oneObj = null
      const m = prog.moves[i]
      if (m) {
        const op = opIds?.[m.line] || 0, pos = []
        if (op) prog.moves.forEach((q, qi) => { if (opIds[q.line] === op && data.grp[qi] !== 'rapid') pos.push(q.x0, q.y0, q.z0, q.x1, q.y1, q.z1) })
        if (pos.length) selObj = fat(pos, selMat, 24)                                        // вся операция
        oneObj = fat([m.x0, m.y0, m.z0, m.x1, m.y1, m.z1], oneMat, 25)                       // сама траектория
      }
      render()
    }
    const setVisible = v => { st.vis = v; showLines(); render() }
    const setView = kind => {
      const D = big * 1.75
      if (kind === 'top') camera.position.set(cx, cy - 1, D * 1.05)
      else camera.position.set(cx - D * 0.3, cy - D * 0.7, D * 0.6)
      controls.target.set(cx, cy, 0); controls.update(); render()
    }
    const resize = () => {
      W = wrap.clientWidth || W; H = wrap.clientHeight || H
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
        if (st.vis[LAYER_OF[g]] === false || (st.live && i > st.cur)) return
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

    base(); setView('iso'); setTime(tRef.current, tRef.current > 0)
    api.current = { setTime, select, setVisible, setView }
    return () => {
      api.current = null
      ro?.disconnect(); cancelAnimationFrame(raf); clearTimeout(st.timer)
      if (liveObj) liveObj.geometry.dispose()
      el.removeEventListener('pointerdown', onDown); el.removeEventListener('pointerup', onUp)
      controls.dispose()
      for (const o of [selObj, oneObj]) if (o) o.geometry.dispose()
      disposables.forEach(x => x.dispose())
      renderer.dispose(); el.remove()
    }
  }, [prog, data, opIds, sheet, outlines, thickness])

  useEffect(() => { api.current?.setTime(t, playing || t > 0) }, [t, playing, prog, data, sheet, outlines, thickness, opIds])
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
  useLayoutEffect(() => {
    const el = codeRef.current
    if (!el) return
    const y = line * LH
    const h = el.clientHeight
    if (y < el.scrollTop + LH || y > el.scrollTop + h - 2 * LH) el.scrollTop = Math.max(0, y - h / 2 + LH / 2)
  }, [line])
  const first = Math.max(0, Math.floor(scrollTop / LH) - 4), count = Math.ceil((typeof window !== 'undefined' ? window.innerHeight : 800) / LH) + 8
  const chip = on => ({ flex: '0 0 auto', padding: '5px 9px', borderRadius: 20, fontSize: 12, border: 'none', background: on ? 'var(--blue)' : 'var(--bg2)', color: on ? 'white' : 'var(--text-muted)' })
  const viewBtn = { padding: '5px 10px', borderRadius: 20, fontSize: 12, border: '0.5px solid var(--border-md)', background: 'rgba(255,255,255,0.9)', color: 'var(--text)' }
  // граница между 3D-окном и кодом: тянем вверх — больше кода, вниз — больше симуляции
  const dragStart = e => { e.currentTarget.setPointerCapture?.(e.pointerId); dragRef.current = { y: e.clientY, h: viewH } }
  const dragMove = e => { const d = dragRef.current; if (d) setViewH(Math.round(Math.max(120, Math.min(window.innerHeight - 230, d.h + e.clientY - d.y)))) }
  const dragEnd = () => { dragRef.current = null }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flex: '0 0 auto' }}>
        <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title || 'Симулятор'}</div>
        <span style={{ fontSize: 11, color: 'var(--text-hint)', whiteSpace: 'nowrap' }}>{fmtTime(t)} / {fmtTime(prog.time)}</span>
        {onDownload && <button type="button" onClick={onDownload} style={{ ...viewBtn, color: 'var(--teal)', borderColor: 'var(--teal)' }}>⬇ Скачать</button>}
        {onClose && <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, color: 'var(--text-muted)', padding: '0 4px' }}>×</button>}
      </div>
      <div ref={wrapRef} style={{ position: 'relative', flex: '0 0 auto', height: viewH, background: 'var(--bg3)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
        <div ref={mountRef} />
        <div style={{ position: 'absolute', top: 6, right: 6, display: 'flex', gap: 4 }}>
          <button type="button" style={viewBtn} onClick={() => api.current?.setView('iso')}>3D</button>
          <button type="button" style={viewBtn} onClick={() => api.current?.setView('top')}>Сверху</button>
        </div>
      </div>
      <div style={{ flex: '0 0 auto' }}>
        <div style={{ display: 'flex', gap: 5, overflowX: 'auto', marginTop: 6, paddingBottom: 2 }}>
          {LAYERS.filter(l => l.groups.some(g => data.groups[g])).map(l => (
            <button key={l.id} type="button" onClick={() => setVis(v => ({ ...v, [l.id]: !v[l.id] }))}
              style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 5, padding: '5px 9px', borderRadius: 20, fontSize: 12, whiteSpace: 'nowrap', border: '0.5px solid ' + (vis[l.id] ? l.css : 'var(--border-md)'), background: vis[l.id] ? 'var(--bg)' : 'var(--bg2)', color: vis[l.id] ? 'var(--text)' : 'var(--text-hint)', textDecoration: vis[l.id] ? 'none' : 'line-through' }}>
              <i style={{ width: 9, height: 9, borderRadius: 5, background: vis[l.id] ? l.css : 'var(--gray-mid)' }} />{l.label}
            </button>
          ))}
        </div>
        <input type="range" min={0} max={prog.time || 1} step="any" value={t} onChange={e => { setPlaying(false); seek(e.target.value) }} style={{ width: '100%', padding: 0, margin: '6px 0 4px', border: 'none' }} />
        <div style={{ display: 'flex', gap: 5, alignItems: 'center', overflowX: 'auto' }}>
          <button type="button" onClick={() => { if (t >= prog.time) seek(0); setSel(-1); setPlaying(p => !p) }}
            style={{ flex: '0 0 auto', padding: '7px 14px', borderRadius: 20, border: 'none', background: 'var(--blue)', color: 'white', fontSize: 14, fontWeight: 500 }}>{playing ? '⏸ Пауза' : '▶ Пуск'}</button>
          <button type="button" onClick={() => { setPlaying(false); seek(0) }} style={chip(false)}>⏮</button>
          <button type="button" onClick={() => { setPlaying(false); seek(prog.time) }} style={chip(false)}>⏭</button>
          <span style={{ flex: 1 }} />
          {SPEEDS.map(s => <button key={s} type="button" onClick={() => setSpeed(s)} style={chip(speed === s)}>×{s}</button>)}
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 6, fontSize: 12, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
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
      </div>
      <div onPointerDown={dragStart} onPointerMove={dragMove} onPointerUp={dragEnd} onPointerCancel={dragEnd} title="Потяните вверх или вниз"
        style={{ flex: '0 0 auto', height: 22, marginTop: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, cursor: 'row-resize', touchAction: 'none', userSelect: 'none', color: 'var(--text-hint)', fontSize: 10 }}>
        <span>▲</span><i style={{ width: 54, height: 5, borderRadius: 3, background: 'var(--gray-mid)' }} /><span>▼</span>
      </div>
      <div ref={codeRef} onScroll={e => setScrollTop(e.currentTarget.scrollTop)}
        style={{ flex: '1 1 0', minHeight: 60, overflowY: 'auto', background: 'var(--bg2)', borderRadius: 'var(--radius)', fontFamily: 'monospace', fontSize: 11, WebkitOverflowScrolling: 'touch' }}>
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
    </div>
  )
}
