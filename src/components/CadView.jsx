import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { sceneBox } from '../lib/cadModel'

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

export default function CadView({ parts, selected, onSelect, xray = false, fitKey = 0, style }) {
  const box = useRef(null)
  const st = useRef(null)
  const sel = useRef(onSelect)
  useEffect(() => { sel.current = onSelect }, [onSelect])

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
    const grid = new THREE.GridHelper(10000, 50, 0xb8c0c8, 0xdde2e7)
    scene.add(grid)
    const group = new THREE.Group(); scene.add(group)
    let raf = 0, alive = true
    const tick = () => { if (!alive) return; controls.update(); renderer.render(scene, camera); raf = requestAnimationFrame(tick) }
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
    let down = null
    const ray = new THREE.Raycaster()
    const onDown = e => { down = { x: e.clientX, y: e.clientY, t: Date.now() } }
    const onUp = e => {
      if (!down) return
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), dt = Date.now() - down.t
      down = null
      if (moved > 6 || dt > 450) return
      const r = renderer.domElement.getBoundingClientRect()
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera)
      const hit = ray.intersectObjects(group.children.filter(o => o.isMesh), false)[0]
      sel.current?.(hit ? hit.object.userData.itemId : null, hit ? hit.object.userData.pid : null)
    }
    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointerup', onUp)
    st.current = { renderer, scene, camera, controls, group, grid, fitted: false }
    return () => {
      alive = false; cancelAnimationFrame(raf); ro.disconnect()
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointerup', onUp)
      controls.dispose(); renderer.dispose()
      group.traverse(o => { o.geometry?.dispose?.(); o.material?.dispose?.() })
      el.removeChild(renderer.domElement)
    }
  }, [])

  // детали
  useEffect(() => {
    const s = st.current
    if (!s) return
    const { group } = s
    for (const o of [...group.children]) { group.remove(o); o.geometry?.dispose?.(); o.material?.dispose?.() }
    for (const p of parts || []) {
      const b = p.place.aabb
      const sx = b[3] - b[0], sy = b[4] - b[1], sz = b[5] - b[2]
      if (!(sx > 0 && sy > 0 && sz > 0)) continue
      const geo = new THREE.BoxGeometry(sx, sy, sz)
      const lk = lookOf(p.material)
      const isSel = selected && p.item.id === selected
      const op = xray ? Math.min(lk.opacity, 0.35) : lk.opacity
      const mat = new THREE.MeshStandardMaterial({
        color: isSel ? new THREE.Color(lk.color).lerp(new THREE.Color('#3b82f6'), 0.45) : lk.color,
        roughness: p.kind === 'profile' || p.kind === 'hw' ? 0.35 : 0.8, metalness: p.kind === 'profile' || p.kind === 'hw' ? 0.6 : 0,
        transparent: op < 1, opacity: op, depthWrite: op >= 1,
      })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.position.set(b[0] + sx / 2, b[1] + sy / 2, b[2] + sz / 2)
      mesh.userData = { itemId: p.item.id, pid: p.pid }
      group.add(mesh)
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: isSel ? '#1d4ed8' : '#5b6672', transparent: true, opacity: isSel ? 1 : 0.55 }))
      edges.position.copy(mesh.position)
      group.add(edges)
    }
    if (!s.fitted && parts?.length) { fit(s, parts); s.fitted = true }
  }, [parts, selected, xray])

  // «Показать всё»
  useEffect(() => { if (fitKey && st.current) fit(st.current, parts || []) }, [fitKey]) // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={box} style={{ position: 'relative', width: '100%', height: '100%', minHeight: 200, background: 'linear-gradient(#f4f6f8, #e6eaee)', borderRadius: 8, overflow: 'hidden', ...style }} />
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
  s.grid.position.set(c.x, 0, c.z)
}
