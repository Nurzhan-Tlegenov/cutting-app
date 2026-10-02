import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { buildModelParts } from '../lib/model3d'

// Просмотр 3D-модели заказа (детали, импортированные из Базиса).
// Вращение — пальцем, масштаб — щипком, сдвиг — двумя пальцами.
const MODES = [['solid', 'Сплошной'], ['xray', 'Полупрозрачный'], ['wire', 'Каркас']]
const PALETTE = ['#cbb89a', '#a9b7c4', '#d9d4c7', '#b9c8a8', '#d2b3a2', '#bdb5d6']

export default function Model3D({ details, title, onClose }) {
  const hostRef = useRef(null)
  const stateRef = useRef(null)
  const [mode, setMode] = useState('solid')
  const [picked, setPicked] = useState(null)
  const [error, setError] = useState('')
  const parts = useMemo(() => buildModelParts(details), [details])
  const count = parts.length

  useEffect(() => {
    const host = hostRef.current
    let renderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true })
    } catch {
      Promise.resolve().then(() => setError('На этом устройстве не удалось включить 3D-графику.'))
      return
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setClearColor(0xf1efe8)
    host.appendChild(renderer.domElement)
    renderer.domElement.style.touchAction = 'none'

    const scene = new THREE.Scene()
    scene.add(new THREE.HemisphereLight(0xffffff, 0xb8b5a8, 1.8))
    const sun = new THREE.DirectionalLight(0xffffff, 1.9)
    scene.add(sun)

    const group = new THREE.Group()
    scene.add(group)
    const materials = new Map()
    const meshes = [], lines = []
    const lineMat = new THREE.LineBasicMaterial({ color: 0x3a3a36 })
    const matFor = name => {
      if (!materials.has(name)) {
        materials.set(name, new THREE.MeshStandardMaterial({
          color: PALETTE[materials.size % PALETTE.length], roughness: 0.85, metalness: 0, side: THREE.DoubleSide,
        }))
      }
      return materials.get(name)
    }
    for (const p of parts) {
      if (p.outline.length < 3) continue
      const shape = new THREE.Shape(p.outline.map(([x, y]) => new THREE.Vector2(x, y)))
      for (const h of p.holes) if (h.length > 2) shape.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))))
      const geo = new THREE.ExtrudeGeometry(shape, { depth: p.t, bevelEnabled: false, curveSegments: 1 })
      const m = p.m
      const mat4 = new THREE.Matrix4().set(
        m[0], m[1], m[2], m[9],
        m[3], m[4], m[5], m[10],
        m[6], m[7], m[8], m[11],
        0, 0, 0, 1)
      const mesh = new THREE.Mesh(geo, matFor(p.material))
      mesh.applyMatrix4(mat4)
      mesh.userData = p
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), lineMat)
      edge.applyMatrix4(mat4)
      group.add(mesh); group.add(edge)
      meshes.push(mesh); lines.push(edge)
    }

    // камера по габариту модели
    const box = new THREE.Box3().setFromObject(group)
    const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3())
    const radius = box.isEmpty() ? 1000 : Math.max(box.getSize(new THREE.Vector3()).length() / 2, 100)
    const camera = new THREE.PerspectiveCamera(35, 1, radius / 50, radius * 40)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.copy(center)
    controls.enableDamping = true
    const resetView = () => {
      // на узком экране ограничивает ширина, а не высота
      const half = (camera.fov * Math.PI) / 360
      const halfMin = Math.min(half, Math.atan(Math.tan(half) * camera.aspect))
      const dist = radius / Math.sin(halfMin) * 1.02
      camera.position.copy(center).add(new THREE.Vector3(0.75, 0.5, 1).normalize().multiplyScalar(dist))
      controls.target.copy(center)
      controls.update()
    }
    const resize = () => {
      const w = host.clientWidth || 300, h = host.clientHeight || 300
      renderer.setSize(w, h, false)
      renderer.domElement.style.width = '100%'
      renderer.domElement.style.height = '100%'
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    resize()
    resetView()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null
    ro?.observe(host)

    let raf = 0
    const tick = () => {
      controls.update()
      sun.position.copy(camera.position)     // свет «от зрителя» — грани читаются с любой стороны
      renderer.render(scene, camera)
      raf = requestAnimationFrame(tick)
    }
    tick()

    // тап по детали — показать, что это
    const ray = new THREE.Raycaster()
    let down = null
    const onDown = e => { down = { x: e.clientX, y: e.clientY, t: Date.now() } }
    const onUp = e => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6 || Date.now() - down.t > 400) return
      const r = renderer.domElement.getBoundingClientRect()
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera)
      const hit = ray.intersectObjects(meshes.filter(x => x.visible), false)[0]
      const st = stateRef.current
      if (st.sel) { st.sel.material = st.selMat; st.sel = null }
      if (hit) {
        st.sel = hit.object; st.selMat = hit.object.material
        const hi = hit.object.material.clone(); hi.color.set('#185FA5'); hi.emissive?.set('#0C447C')
        hit.object.material = hi
        setPicked(hit.object.userData)
      } else setPicked(null)
    }
    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointerup', onUp)

    stateRef.current = { materials, meshes, lines, lineMat, resetView, sel: null, selMat: null }
    return () => {
      cancelAnimationFrame(raf)
      ro?.disconnect()
      controls.dispose()
      meshes.forEach(x => x.geometry.dispose())
      lines.forEach(x => x.geometry.dispose())
      materials.forEach(x => x.dispose())
      lineMat.dispose()
      renderer.dispose()
      renderer.domElement.remove()
      stateRef.current = null
    }
  }, [parts])

  // режим показа
  useEffect(() => {
    const st = stateRef.current
    if (!st) return
    const xray = mode === 'xray', wire = mode === 'wire'
    st.materials.forEach(m => { m.transparent = xray; m.opacity = xray ? 0.28 : 1; m.depthWrite = !xray; m.needsUpdate = true })
    if (st.sel) { st.sel.material.transparent = xray; st.sel.material.opacity = xray ? 0.5 : 1; st.sel.material.depthWrite = !xray; st.sel.material.needsUpdate = true }
    st.meshes.forEach(x => { x.visible = !wire })
    st.lineMat.color.set(wire ? 0x185fa5 : 0x3a3a36)
  }, [mode, parts])

  const chip = active => ({
    flex: 1, padding: '7px 4px', borderRadius: 20, border: 'none', fontSize: 12, cursor: 'pointer',
    background: active ? 'var(--blue)' : 'var(--bg2)', color: active ? 'white' : 'var(--text-muted)',
  })

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 960, background: 'var(--bg2)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: 'var(--bg)', borderBottom: '0.5px solid var(--border)' }}>
        <button type="button" onClick={onClose}
          style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 22, padding: 0, lineHeight: 1 }}>←</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 500 }}>3D-модель</div>
          <div style={{ fontSize: 11, color: 'var(--text-hint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {title ? `${title} · ` : ''}{count} дет.
          </div>
        </div>
        <button type="button" onClick={() => stateRef.current?.resetView()}
          style={{ padding: '5px 10px', borderRadius: 20, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)', fontSize: 12 }}>
          ⟲ Вид
        </button>
      </div>
      <div style={{ display: 'flex', gap: 6, padding: '8px 14px', background: 'var(--bg)' }}>
        {MODES.map(([id, label]) => <button key={id} type="button" style={chip(mode === id)} onClick={() => setMode(id)}>{label}</button>)}
      </div>
      <div ref={hostRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {error && <p className="error-text" style={{ padding: 20 }}>{error}</p>}
      </div>
      <div style={{ padding: '8px 14px calc(8px + env(safe-area-inset-bottom))', background: 'var(--bg)', borderTop: '0.5px solid var(--border)', fontSize: 12, minHeight: 38 }}>
        {picked
          ? <span><b>{picked.des ? `${picked.des} · ` : ''}{picked.name}</b> — {picked.size} · {picked.t} мм{picked.product ? ` · ${picked.product}` : ''}</span>
          : <span style={{ color: 'var(--text-hint)' }}>Палец — вращать · щипок — масштаб · два пальца — сдвиг · тап по детали — что это</span>}
      </div>
    </div>
  )
}
