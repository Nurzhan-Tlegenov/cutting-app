import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { sceneBox, isFigured, partEdges, partVerts } from '../lib/cadModel'
import { contourSegments, segmentSide } from '../lib/edgeLength'
import { verticesToPolygon } from '../lib/trueShapeNesting'
import { detailHoles } from '../lib/partHoles'

// фигурная деталь: контур и вырезы из правки -> выдавливание на толщину в системе детали, затем матрица детали
function figuredGeometry(sp) {
  const { W, L, T, m } = sp.place
  const verts = sp.ov?.vertices?.length > 2 ? sp.ov.vertices : sp.shape?.length > 2 ? sp.shape : [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: L }, { x: 0, y: L }]
  const pts = verticesToPolygon(verts).map(p => (Array.isArray(p) ? p : [p.x, p.y]))
  if (pts.length < 3) return null
  const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)))
  let holes
  try { holes = detailHoles({ width: W, length: L, contour: JSON.stringify({ holes: (sp.ov?.holes || []).filter(h => h.type !== 'pocket') }) }) } catch { holes = [] }
  for (const h of holes) if (h?.length > 2) shape.holes.push(new THREE.Path(h.map(p => new THREE.Vector2(p.x ?? p[0], p.y ?? p[1]))))
  const geo = new THREE.ExtrudeGeometry(shape, { depth: T, bevelEnabled: false, curveSegments: 6 })
  const M = new THREE.Matrix4().set(m[0], m[1], m[2], m[9], m[3], m[4], m[5], m[10], m[6], m[7], m[8], m[11], 0, 0, 0, 1)
  geo.applyMatrix4(M)
  return geo
}

// подпись размера — спрайт с текстом
function label(text, h) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64
  const g = c.getContext('2d')
  g.fillStyle = 'rgba(255,255,255,0.92)'; g.fillRect(0, 8, 256, 48)
  g.fillStyle = '#1d4ed8'; g.font = '600 38px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 128, 33)
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }))
  sp.scale.set(h * 4, h, 1); sp.renderOrder = 10
  return sp
}

// 3D-сцена конструктора: детали — бруски (все детали пока прямоугольные и стоят по осям).
// Вращение — пальцем / левой кнопкой, сдвиг — двумя пальцами / правой кнопкой, масштаб — щипком / колёсиком.
// Короткое нажатие на деталь — выбрать элемент (корпус, панель, профиль), по пустому месту — снять выбор.
const LOOKS = [
  [/стекл|зеркал/i, '#a9d3e3', 0.35], [/профил|труб|металл|сталь|алюм|ножк|опор/i, '#9aa0a6', 1], [/хдф|двп|hdf/i, '#c9ae86', 1],
  [/ч[её]рн|графит|антрацит/i, '#45474a', 1], [/бел/i, '#f2f1ec', 1], [/сер/i, '#a3a6aa', 1], [/дуб|сонома|ясень|бук|орех|вотан/i, '#c8a777', 1],
]
const PAL = ['#d9cdb4', '#b8c5d0', '#c9d6b8', '#d8bcae', '#c6bfdc']
function lookOf(material) {
  for (const [re, c, o] of LOOKS) if (re.test(material || '')) return { color: c, opacity: o }
  let h = 0
  for (const ch of String(material || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return { color: PAL[h % PAL.length], opacity: 1 }
}

export default function CadView({ parts, selected, selectedPid = null, onSelect, onDrag, xray = false, fitKey = 0, holes = [], room = null, dims = true, openings = [], selectedOpening = null, labels = [], onLabel, moveMode = false, edgeLook = null, hiPids = null, children, style }) {
  const box = useRef(null)
  const st = useRef(null)
  const sel = useRef(onSelect)
  const drag = useRef(onDrag)
  const selId = useRef(selected)
  const moveRef = useRef(moveMode)
  useEffect(() => { sel.current = onSelect; drag.current = onDrag; selId.current = selected; moveRef.current = moveMode }, [onSelect, onDrag, selected, moveMode])
  // размеры проёмов — кнопки поверх 3D: каждый кадр ставим их в проекцию точки проёма на экран
  // анимация дверей и ящиков: id -> { g: группа, a: анимация }, цель (0 закрыто / 1 открыто) и текущее положение
  const animObjs = useRef(new Map())
  const hiRef = useRef(hiPids)
  useEffect(() => { hiRef.current = hiPids }, [hiPids])
  const animTarget = useRef(new Map())
  const animProg = useRef(new Map())
  const labelEls = useRef(new Map())
  const labelsRef = useRef(labels)
  useEffect(() => { labelsRef.current = labels }, [labels])

  // один раз: рендерер, камера, свет, пол
  useEffect(() => {
    const el = box.current
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    el.appendChild(renderer.domElement)
    renderer.domElement.style.display = 'block'
    renderer.domElement.style.touchAction = 'none'
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(40, 1, 10, 200000)
    camera.position.set(2500, 2000, 4000)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.12
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f96, 2.2))
    const dl = new THREE.DirectionalLight(0xffffff, 1.4); dl.position.set(3000, 5000, 4000); scene.add(dl)
    const dl2 = new THREE.DirectionalLight(0xffffff, 0.5); dl2.position.set(-4000, 2000, -2000); scene.add(dl2)
    // оси координат в углу (как в CAD-программах): X — красная, Y — зелёная, Z — синяя; начало — левый нижний задний угол
    const grid = new THREE.Group()        // (пол-сетку убрали; объект оставлен для совместимости)
    const axScene = new THREE.Scene(), axCam = new THREE.PerspectiveCamera(40, 1, 1, 100)
    const axLabel = (txt, color) => {
      const c = document.createElement('canvas'); c.width = 64; c.height = 64
      const g = c.getContext('2d'); g.fillStyle = color; g.font = '700 44px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(txt, 32, 34)
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false })); s.scale.set(0.5, 0.5, 1); return s
    }
    ;[[[1, 0, 0], '#dc2626', 'X'], [[0, 1, 0], '#16a34a', 'Y'], [[0, 0, 1], '#2563eb', 'Z']].forEach(([d, c, n]) => {
      const v = new THREE.Vector3(...d)
      axScene.add(new THREE.ArrowHelper(v, new THREE.Vector3(), 1, c, 0.25, 0.12))
      const l = axLabel(n, c); l.position.copy(v.clone().multiplyScalar(1.35)); axScene.add(l)
    })
    // небольшая метка начала координат в самой сцене
    const origin = new THREE.AxesHelper(150); origin.material.depthTest = false; origin.renderOrder = 5; scene.add(origin)
    const group = new THREE.Group(); scene.add(group)
    const extra = new THREE.Group(); scene.add(extra)   // присадка и стены комнаты — без выбора нажатием
    let raf = 0, alive = true
    const tick = () => {
      if (!alive) return
      controls.update()
      for (const [id, { g, a }] of animObjs.current) {
        const tg = animTarget.current.get(id) || 0
        let pr = animProg.current.get(id) || 0
        if (pr === tg && !g.userData.dirty) continue
        pr = tg > pr ? Math.min(tg, pr + 0.035) : Math.max(tg, pr - 0.035)
        animProg.current.set(id, pr); g.userData.dirty = false
        const e = pr < 0.5 ? 2 * pr * pr : 1 - Math.pow(-2 * pr + 2, 2) / 2
        if (a.kind === 'rot') g.quaternion.setFromAxisAngle(new THREE.Vector3(...a.axis).normalize(), a.ang * e)
        else g.position.set(a.dir[0] * a.dist * e, a.dir[1] * a.dist * e, a.dir[2] * a.dist * e)
      }
      const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight
      renderer.setViewport(0, 0, w, h); renderer.setScissorTest(false)
      renderer.render(scene, camera)
      // мини-оси в правом нижнем углу поворачиваются вместе с камерой (слева — кнопки проёмов)
      const s = Math.min(90, Math.round(Math.min(w, h) * 0.22))
      axCam.position.copy(camera.position).sub(controls.target).setLength(4.2); axCam.lookAt(0, 0, 0); axCam.up.copy(camera.up)
      renderer.autoClear = false; renderer.clearDepth()
      renderer.setScissorTest(true); renderer.setScissor(w - s - 4, 22, s, s); renderer.setViewport(w - s - 4, 22, s, s)
      renderer.render(axScene, axCam)
      renderer.setScissorTest(false); renderer.autoClear = true
      for (const l of labelsRef.current || []) {
        const el = labelEls.current.get(l.id)
        if (!el) continue
        const v = new THREE.Vector3(...l.p).project(camera)
        const vis = v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05
        el.style.display = vis ? 'block' : 'none'
        if (vis) el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -50%)`
      }
      raf = requestAnimationFrame(tick)
    }
    tick()
    const resize = () => {
      const w = el.clientWidth || 300, h = el.clientHeight || 300
      renderer.setSize(w, h, false)
      renderer.domElement.style.width = w + 'px'; renderer.domElement.style.height = h + 'px'
      camera.aspect = w / h; camera.updateProjectionMatrix()
    }
    resize()
    const ro = new ResizeObserver(resize); ro.observe(el)
    // короткое нажатие без сдвига — выбор
    // Выбранный элемент можно тащить пальцем / мышью по полу (плоскость XZ на высоте точки касания);
    // вращение камеры в это время выключено. Второй палец (щипок) — отменяет перетаскивание.
    let down = null, dragging = null
    const ray = new THREE.Raycaster()
    const pick = e => {
      const r = renderer.domElement.getBoundingClientRect()
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera)
    }
    const onFloor = (e, y) => { pick(e); const p = new THREE.Vector3(); return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), p) ? p : null }
    const pointers = new Set()
    // все детали, включая вложенные в группы анимации
    const meshes = (f = () => true) => { const l = []; group.traverse(o => { if (o.isMesh && f(o)) l.push(o) }); return l }
    let lastTap = null   // двойной тап по двери / ящику — открыть или закрыть (анимация)
    let lp = 0           // удержание пальца на детали — свойства её параметрического блока
    const clearLp = () => { clearTimeout(lp); lp = 0 }
    renderer.domElement.addEventListener('contextmenu', e => e.preventDefault())
    const onDown = e => {
      pointers.add(e.pointerId)
      if (pointers.size > 1) { clearLp(); if (dragging) { drag.current?.(dragging.id, 'cancel', 0, 0); dragging = null; controls.enabled = true } down = null; return }
      down = { x: e.clientX, y: e.clientY, t: Date.now() }
      clearLp()
      lp = setTimeout(() => {
        lp = 0
        if (!down || dragging?.moved) return
        pick({ clientX: down.x, clientY: down.y })
        const hb = ray.intersectObjects(meshes(o => o.userData.pid), false).find(h => h.object.userData.blk)
        if (!hb) return
        down = null
        if (dragging) { drag.current?.(dragging.id, 'cancel', 0, 0); dragging = null; controls.enabled = true }
        navigator.vibrate?.(15)
        sel.current?.(hb.object.userData.itemId, hb.object.userData.pid, null, { blk: hb.object.userData.blk })
      }, 520)
      if (!moveRef.current || !selId.current || !drag.current) return   // двигаем только в режиме «Двигать» — иначе пальцы вращают и масштабируют
      pick(e)
      const hit = ray.intersectObjects(meshes(o => !o.userData.ghost), false)[0]
      if (!hit || hit.object.userData.itemId !== selId.current) return
      const start = onFloor(e, hit.point.y)
      if (!start) return
      dragging = { id: selId.current, y: hit.point.y, start, moved: false }
      controls.enabled = false
      drag.current(dragging.id, 'start', 0, 0)
    }
    const onMove = e => {
      if (lp && down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) clearLp()
      if (!dragging) return
      const p = onFloor(e, dragging.y)
      if (!p) return
      const dx = p.x - dragging.start.x, dz = p.z - dragging.start.z
      if (!dragging.moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6) return
      dragging.moved = true
      drag.current?.(dragging.id, 'move', dx, dz)
    }
    const onUp = e => {
      pointers.delete(e.pointerId)
      clearLp()
      if (dragging) {
        const was = dragging; dragging = null; controls.enabled = true
        if (was.moved) { drag.current?.(was.id, 'end', 0, 0); down = null; return }
        drag.current?.(was.id, 'cancel', 0, 0)
      }
      if (!down) return
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), dt = Date.now() - down.t
      down = null
      if (moved > 6 || dt > 450) return
      pick(e)
      const now = Date.now()
      const dbl = lastTap && now - lastTap.t < 380 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30
      lastTap = dbl ? null : { t: now, x: e.clientX, y: e.clientY }
      if (dbl) {
        // по двойному тапу видны и полупрозрачные фасады; проёмы пропускаем — ищем дверь или ящик
        const ha = ray.intersectObjects(meshes(o => o.userData.pid), false).find(h => h.object.userData.anim)
        if (ha) { const id = ha.object.userData.anim; animTarget.current.set(id, (animTarget.current.get(id) || 0) > 0.5 ? 0 : 1); return }
      }
      // деталь выбранного блока (даже за проёмом или полупрозрачная) — в приоритете: тап по ней не сбрасывает блок
      const hb = hiRef.current?.size ? ray.intersectObjects(meshes(o => hiRef.current.has(o.userData.pid)), false)[0] : null
      const hit = hb || ray.intersectObjects(meshes(o => !o.userData.ghost), false)[0]
      sel.current?.(hit ? hit.object.userData.itemId : null, hit ? hit.object.userData.pid || null : null, hit ? hit.object.userData.opening || null : null)
    }
    renderer.domElement.addEventListener('pointerdown', onDown, { capture: true })
    renderer.domElement.addEventListener('pointermove', onMove)
    renderer.domElement.addEventListener('pointerup', onUp)
    renderer.domElement.addEventListener('pointercancel', onUp)
    st.current = { renderer, scene, camera, controls, group, extra, grid, fitted: false }
    return () => {
      alive = false; cancelAnimationFrame(raf); ro.disconnect()
      renderer.domElement.removeEventListener('pointerdown', onDown, { capture: true })
      renderer.domElement.removeEventListener('pointermove', onMove)
      renderer.domElement.removeEventListener('pointerup', onUp)
      renderer.domElement.removeEventListener('pointercancel', onUp)
      controls.dispose(); renderer.dispose()
      group.traverse(o => { o.geometry?.dispose?.(); o.material?.dispose?.() })
      extra.traverse(o => { o.geometry?.dispose?.(); o.material?.dispose?.() })
      el.removeChild(renderer.domElement)
    }
  }, [])

  // детали
  useEffect(() => {
    const s = st.current
    if (!s) return
    const { group } = s
    for (const o of [...group.children]) { group.remove(o); o.traverse(c => { c.geometry?.dispose?.(); c.material?.dispose?.() }) }
    animObjs.current = new Map()
    // группа анимации: дверь (поворот вокруг оси петель) или ящик (выезд) со всем, что на них (ручка, короб, подвижная часть направляющей)
    const pivotOf = a => (a.kind === 'rot' ? a.p : [0, 0, 0])
    const holder = a => {
      if (!a) return { g: group, off: [0, 0, 0] }
      let o = animObjs.current.get(a.id)
      if (!o) {
        const g = new THREE.Group(); g.position.set(...pivotOf(a)); g.userData.dirty = true
        group.add(g); o = { g, a }; animObjs.current.set(a.id, o)
      }
      return { g: o.g, off: pivotOf(a) }
    }
    const ghostFronts = (openings || []).length > 0
    for (const o of openings || []) {
      const b = o.aabb, sx = b[3] - b[0], sy = b[4] - b[1], sz = b[5] - b[2]
      if (!(sx > 1 && sy > 1 && sz > 1)) continue
      const on = o.id === selectedOpening
      if (!o.leaf && !on) continue
      const m = new THREE.Mesh(new THREE.BoxGeometry(sx - 2, sy - 2, sz - 2), new THREE.MeshBasicMaterial({ color: on ? '#2563eb' : '#60a5fa', transparent: true, opacity: on ? 0.28 : 0.07, depthWrite: false }))
      m.position.set(b[0] + sx / 2, b[1] + sy / 2, b[2] + sz / 2)
      m.userData = { itemId: o.item, opening: o.id }
      group.add(m)
      if (on) { const e = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), new THREE.LineBasicMaterial({ color: '#1d4ed8' })); e.position.copy(m.position); group.add(e) }
    }
    for (const p of parts || []) {
      const b = p.place.aabb
      const sx = b[3] - b[0], sy = b[4] - b[1], sz = b[5] - b[2]
      if (!(sx > 0 && sy > 0 && sz > 0)) continue
      const fig = isFigured(p) ? figuredGeometry(p) : null
      const geo = fig || new THREE.BoxGeometry(sx, sy, sz)
      const lk = lookOf(p.material)
      const isSel = selected && p.item.id === selected
      const isPart = selectedPid && p.pid === selectedPid
      const isBlk = !isPart && hiPids?.has?.(p.pid)
      const ghost = ghostFronts && p.role === 'фасад' && p.item.id === selected
      const op = ghost ? 0.18 : xray ? Math.min(lk.opacity, 0.35) : lk.opacity
      const mat = new THREE.MeshStandardMaterial({
        color: isPart ? new THREE.Color(lk.color).lerp(new THREE.Color('#f59e0b'), 0.6) : isBlk ? new THREE.Color(lk.color).lerp(new THREE.Color('#f59e0b'), 0.35) : isSel ? new THREE.Color(lk.color).lerp(new THREE.Color('#3b82f6'), 0.45) : lk.color,
        roughness: p.kind === 'profile' || p.kind === 'hw' ? 0.35 : 0.8, metalness: p.kind === 'profile' || p.kind === 'hw' ? 0.6 : 0,
        transparent: op < 1, opacity: op, depthWrite: op >= 1,
      })
      const mesh = new THREE.Mesh(geo, mat)
      const { g: hg, off } = holder(p.anim)
      if (!fig) mesh.position.set(b[0] + sx / 2 - off[0], b[1] + sy / 2 - off[1], b[2] + sz / 2 - off[2])
      else mesh.position.set(-off[0], -off[1], -off[2])
      mesh.userData = { itemId: p.item.id, pid: p.pid, blk: p.blk || null, anim: p.anim?.id || null, ...(ghost ? { ghost: true } : {}) }
      hg.add(mesh)
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), new THREE.LineBasicMaterial({ color: isPart || isBlk ? '#b45309' : isSel ? '#1d4ed8' : '#5b6672', transparent: true, opacity: isSel ? 1 : 0.55 }))
      edges.position.copy(mesh.position)
      hg.add(edges)
    }
    // подсветка кромки: линии контура кромленых торцов (по низу и верху торца + вертикали на концах участка)
    if (edgeLook?.on) {
      const byG = new Map()   // линии по группам анимации (кромка едет вместе с дверью / ящиком)
      const v3 = (m, x, y, z) => new THREE.Vector3(m[0] * x + m[1] * y + m[2] * z + m[9], m[3] * x + m[4] * y + m[5] * z + m[10], m[6] * x + m[7] * y + m[8] * z + m[11])
      for (const sp of parts || []) {
        if (sp.kind !== 'sheet') continue
        const key = sp.anim?.id || ''
        if (!byG.has(key)) byG.set(key, { a: sp.anim, pts: [] })
        const pts = byG.get(key).pts
        const ed = partEdges(sp)
        const { W, L, T, m } = sp.place
        let segs
        try { segs = contourSegments(partVerts(sp)) } catch { segs = [] }
        for (const seg of segs) {
          const side = segmentSide(seg, W, L)
          if (!((side && ed?.[side]) || seg.edge)) continue
          for (const z of [0, T]) for (let i = 0; i + 1 < seg.pts.length; i++) pts.push(v3(m, seg.pts[i][0], seg.pts[i][1], z), v3(m, seg.pts[i + 1][0], seg.pts[i + 1][1], z))
          for (const q of [seg.pts[0], seg.pts[seg.pts.length - 1]]) pts.push(v3(m, q[0], q[1], 0), v3(m, q[0], q[1], T))
        }
      }
      const glow = !!edgeLook.glow
      for (const { a, pts } of byG.values()) {
        if (!pts.length) continue
        const mat = new THREE.LineBasicMaterial({ color: edgeLook.color || '#f97316', transparent: true, opacity: Math.max(0.1, Math.min(1, Number(edgeLook.opacity ?? 1))),
          blending: glow ? THREE.AdditiveBlending : THREE.NormalBlending, depthTest: !glow, toneMapped: false })
        const ls = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), mat)
        ls.renderOrder = 8
        const { g: hg, off } = holder(a)
        ls.position.set(-off[0], -off[1], -off[2])
        hg.add(ls)
      }
    }
    // размеры выбранного элемента: ширина — по низу спереди, высота — слева спереди, глубина — по низу слева
    const own = selected ? (parts || []).filter(p => p.item.id === selected) : []
    if (dims && own.length) {
      const b = sceneBox(own)
      const big = Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2])
      const off = Math.max(40, big * 0.06), lh = Math.max(35, big * 0.05)
      const lm = new THREE.LineBasicMaterial({ color: '#1d4ed8', depthTest: false, transparent: true })
      const line = (a, c) => { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...c)]), lm); l.renderOrder = 9; group.add(l) }
      const dim = (a, c, txt, at) => { line(a, c); const s = label(txt, lh); s.position.set(...at); group.add(s) }
      const r = v => String(Math.round(v * 10) / 10)
      dim([b[0], b[1], b[5] + off], [b[3], b[1], b[5] + off], r(b[3] - b[0]), [(b[0] + b[3]) / 2, b[1] + lh * 0.7, b[5] + off])
      dim([b[0] - off, b[1], b[5]], [b[0] - off, b[4], b[5]], r(b[4] - b[1]), [b[0] - off - lh * 1.6, (b[1] + b[4]) / 2, b[5]])
      dim([b[0] - off, b[1], b[2]], [b[0] - off, b[1], b[5]], r(b[5] - b[2]), [b[0] - off - lh * 1.6, b[1] + lh * 0.7, (b[2] + b[5]) / 2])
    }
    if (!s.fitted && parts?.length) { fit(s, parts); s.fitted = true }
  }, [parts, selected, selectedPid, xray, dims, openings, selectedOpening, edgeLook, hiPids])

  // присадка (цилиндры по оси отверстия) и комната (пол и три стены)
  useEffect(() => {
    const s = st.current
    if (!s) return
    const { extra } = s
    for (const o of [...extra.children]) { extra.remove(o); o.geometry?.dispose?.(); o.material?.dispose?.() }
    const list = (holes || []).slice(0, 4000)
    if (list.length) {
      const geo = new THREE.CylinderGeometry(1, 1, 1, 14)
      const mat = new THREE.MeshBasicMaterial({ color: '#c2410c' })
      const im = new THREE.InstancedMesh(geo, mat, list.length)
      const up = new THREE.Vector3(0, 1, 0), q = new THREE.Quaternion(), M = new THREE.Matrix4()
      list.forEach((h, i) => {
        const n = new THREE.Vector3(...h.n).normalize()
        q.setFromUnitVectors(up, n)
        const len = Math.min(h.depth, 60) + 0.6
        const c = new THREE.Vector3(...h.p).addScaledVector(n, len / 2 - 0.5)
        M.compose(c, q, new THREE.Vector3(h.d / 2, len, h.d / 2))
        im.setMatrixAt(i, M)
      })
      extra.add(im)
    }
    if (room) {
      const W = room.W, D = room.D, H = room.H, T = 80
      const wm = new THREE.MeshStandardMaterial({ color: '#e9e4da', transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false })
      const fm = new THREE.MeshStandardMaterial({ color: '#d8cbb3', side: THREE.DoubleSide })
      const add = (sx, sy, sz, x, y, z, m) => { const w = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), m); w.position.set(x, y, z); extra.add(w) }
      add(W + 2 * T, T, D + T, W / 2, -T / 2, D / 2 - T / 2, fm)   // пол
      add(W + 2 * T, H, T, W / 2, H / 2, -T / 2, wm)               // задняя стена
      add(T, H, D, -T / 2, H / 2, D / 2, wm)                       // левая
      add(T, H, D, W + T / 2, H / 2, D / 2, wm)                    // правая
    }
  }, [holes, room?.W, room?.D, room?.H, !!room]) // eslint-disable-line react-hooks/exhaustive-deps

  // «Показать всё»
  useEffect(() => { if (fitKey && st.current) fit(st.current, parts || []) }, [fitKey]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', minHeight: 200, borderRadius: 8, overflow: 'hidden', ...style }}>
      <div ref={box} style={{ position: 'absolute', inset: 0, background: 'linear-gradient(#f4f6f8, #e6eaee)' }} />
      {(labels || []).map(l => (
        <button key={l.id} type="button" ref={el => { if (el) labelEls.current.set(l.id, el); else labelEls.current.delete(l.id) }}
          onClick={() => onLabel?.(l.id)}
          style={{ position: 'absolute', left: 0, top: 0, display: 'none', padding: '2px 6px', fontSize: 12, fontWeight: 600, borderRadius: 6, cursor: 'pointer', whiteSpace: 'nowrap',
            border: `1px solid ${l.on ? '#1d4ed8' : '#93c5fd'}`, background: l.on ? '#1d4ed8' : 'rgba(255,255,255,0.9)', color: l.on ? 'white' : '#1d4ed8', zIndex: 2 }}>{l.text}</button>
      ))}
      {children}
    </div>
  )
}

function fit(s, parts) {
  const b = sceneBox(parts)
  const c = new THREE.Vector3((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2)
  const r = Math.max(400, Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2)
  const dist = r / Math.sin((s.camera.fov * Math.PI) / 360) * 1.05
  const dir = new THREE.Vector3(0.55, 0.42, 1).normalize()
  s.camera.position.copy(c.clone().add(dir.multiplyScalar(dist)))
  s.controls.target.copy(c)
  s.camera.near = Math.max(1, dist / 200); s.camera.far = dist * 50; s.camera.updateProjectionMatrix()
}
