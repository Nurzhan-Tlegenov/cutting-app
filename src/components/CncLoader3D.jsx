import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { SHEET, makeLayout, pointAt } from '../lib/loaderLayout'

// Экран ожидания в 3D — в стиле симулятора: станок с ЧПУ режет лист, камера идёт за шпинделем.
// Раскладка каждый раз новая, рез — от края листа к центру. Нажатие — новый лист.
const { W, H } = SHEET
const T = 1.6            // толщина листа (в единицах сцены: лист 200 × 132)
const SAFE = 7           // высота переездов над листом
const CUT = 46, RAPID = 150, PLUNGE = 0.35   // скорости: рез, холостой ход (ед./с) и время погружения (с)
const K = 6              // точек рисунка листа на единицу

function sheetTexture() {
  const cv = document.createElement('canvas'); cv.width = W * K; cv.height = H * K
  const g = cv.getContext('2d')
  const clear = () => {
    g.fillStyle = '#F4F1EA'; g.fillRect(0, 0, cv.width, cv.height)
    // лёгкая фактура ламината
    for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(${120 + Math.random() * 60 | 0},${110 + Math.random() * 50 | 0},90,${0.03 + Math.random() * 0.04})`; g.fillRect(Math.random() * cv.width, Math.random() * cv.height, 20 + Math.random() * 90, 1) }
  }
  clear()
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4
  // рез: светлая кромка среза (сердцевина плиты) и тёмное дно — видна глубина
  const cut = pts => {                                     // весь пройденный путь по детали — одной линией, без «бусин» на стыках
    g.lineCap = 'round'; g.lineJoin = 'miter'
    for (const [w, c] of [[1.25, '#B69364'], [0.8, '#4A3A28']]) {
      g.strokeStyle = c; g.lineWidth = w * K
      g.beginPath()
      pts.forEach((q, i) => { if (i) g.lineTo(q[0] * K, (H - q[1]) * K); else g.moveTo(q[0] * K, (H - q[1]) * K) })
      g.stroke()
    }
    tex.needsUpdate = true
  }
  return { tex, cut, clear: () => { clear(); tex.needsUpdate = true } }
}

function woodTexture() {
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 256
  const g = cv.getContext('2d')
  g.fillStyle = '#8B7658'; g.fillRect(0, 0, 256, 256)
  for (let i = 0; i < 1400; i++) { g.fillStyle = `rgba(${60 + Math.random() * 80 | 0},${45 + Math.random() * 60 | 0},30,${0.05 + Math.random() * 0.08})`; g.fillRect(Math.random() * 256, Math.random() * 256, 1 + Math.random() * 3, 1 + Math.random() * 2) }
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(6, 4)
  return tex
}

export default function CncLoader3D({ fallback }) {
  const mountRef = useRef(null)
  const next = useRef(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    let renderer
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }) } catch { Promise.resolve().then(() => setFailed(true)); return }
    const w = mount.clientWidth || 320, h = Math.round(w * 0.68)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setSize(w, h)
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15
    const el = renderer.domElement
    el.style.display = 'block'; el.style.borderRadius = '14px'
    mount.appendChild(el)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0xD9D5CA)
    scene.fog = new THREE.Fog(0xD9D5CA, 190, 420)
    scene.add(new THREE.HemisphereLight(0xffffff, 0xa39b8c, 1.9))
    const sun = new THREE.DirectionalLight(0xfff4e0, 2.0)
    sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024); sun.shadow.bias = -0.0015; sun.shadow.radius = 3
    Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, near: 10, far: 400 })
    scene.add(sun, sun.target)
    const camera = new THREE.PerspectiveCamera(38, w / h, 1, 900)
    camera.up.set(0, 0, 1)

    const trash = []
    const keep = x => { trash.push(x); return x }
    const std = (color, o = {}) => keep(new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1, ...o }))
    const mesh = (geo, mat, cast = true) => { const m = new THREE.Mesh(keep(geo), mat); m.castShadow = cast; m.receiveShadow = true; return m }

    // жертвенный стол и станина
    const table = mesh(new THREE.BoxGeometry(W + 46, H + 46, 5), std(0xffffff, { map: keep(woodTexture()), roughness: 0.95 }), false)
    table.position.set(W / 2, H / 2, -2.5); scene.add(table)
    const bed = mesh(new THREE.BoxGeometry(W + 70, H + 60, 9), std(0x56626E, { roughness: 0.5, metalness: 0.3 }), false)
    bed.position.set(W / 2, H / 2, -9.6); scene.add(bed)
    const floor = mesh(new THREE.PlaneGeometry(1400, 1400), std(0xC9C4B8, { roughness: 1 }), false)
    floor.position.set(W / 2, H / 2, -14.2); scene.add(floor)
    // лист: сердцевина + верх с рисунком, в котором проявляется рез
    const sheetTex = sheetTexture(); keep(sheetTex.tex)
    const core = mesh(new THREE.BoxGeometry(W, H, T), std(0xB69364, { roughness: 0.9 }))
    core.position.set(W / 2, H / 2, T / 2); scene.add(core)
    const top = mesh(new THREE.PlaneGeometry(W, H), std(0xffffff, { map: sheetTex.tex, roughness: 0.42 }), false)
    top.position.set(W / 2, H / 2, T + 0.02); scene.add(top)

    // портал: балка едет по Y, каретка со шпинделем — по X
    const steel = std(0x6B7783, { roughness: 0.35, metalness: 0.3 }), light = std(0xE9ECEF, { roughness: 0.35, metalness: 0.3 })
    const gantry = new THREE.Group(); scene.add(gantry)
    const beam = mesh(new THREE.BoxGeometry(W + 64, 9, 11), light); beam.position.set(W / 2, 11, 31); gantry.add(beam)
    const stripe = mesh(new THREE.BoxGeometry(W + 64, 0.4, 2.2), std(0x185FA5, { roughness: 0.4 }), false); stripe.position.set(W / 2, 6.4, 31); gantry.add(stripe)
    for (const x of [-27, W + 27]) { const leg = mesh(new THREE.BoxGeometry(8, 12, 40), steel); leg.position.set(x, 11, 10.5); gantry.add(leg) }
    for (const z of [28, 34]) { const rail = mesh(new THREE.BoxGeometry(W + 56, 0.8, 1.1), steel, false); rail.position.set(W / 2, 6.3, z); gantry.add(rail) }
    const head = new THREE.Group(); scene.add(head)             // каретка (X, Y — как у фрезы; Z — отдельно у шпинделя)
    const plate = mesh(new THREE.BoxGeometry(15, 2.4, 26), steel); plate.position.set(0, 5, 27); head.add(plate)
    const spindle = new THREE.Group(); head.add(spindle)
    const bodyM = mesh(new THREE.CylinderGeometry(4.6, 4.6, 19, 40), std(0xDADDE1, { roughness: 0.25, metalness: 0.3 })); bodyM.rotation.x = Math.PI / 2; bodyM.position.z = 17.5; spindle.add(bodyM)
    const cap = mesh(new THREE.CylinderGeometry(4.9, 4.9, 3, 40), std(0x3A4149, { roughness: 0.5, metalness: 0.4 })); cap.rotation.x = Math.PI / 2; cap.position.z = 28.5; spindle.add(cap)
    const clamp = mesh(new THREE.BoxGeometry(11.5, 7.5, 5), steel); clamp.position.set(0, 2.2, 16); spindle.add(clamp)
    const nose = mesh(new THREE.CylinderGeometry(2.1, 3.6, 3.4, 32), std(0x9AA2AB, { roughness: 0.3, metalness: 0.3 })); nose.rotation.x = Math.PI / 2; nose.position.z = 6.3; spindle.add(nose)
    const nut = mesh(new THREE.CylinderGeometry(1.5, 1.9, 1.8, 6), std(0x30363D, { roughness: 0.4, metalness: 0.3 })); nut.rotation.x = Math.PI / 2; nut.position.z = 3.8; spindle.add(nut)
    const bit = mesh(new THREE.CylinderGeometry(0.42, 0.42, 3.2, 12), std(0xC9CED4, { roughness: 0.2, metalness: 0.3 })); bit.rotation.x = Math.PI / 2; bit.position.z = 1.5; spindle.add(bit)
    const flute = mesh(new THREE.BoxGeometry(0.95, 0.16, 2.6), std(0x6E7780, { metalness: 0.3, roughness: 0.3 }), false); flute.position.z = 1.4; spindle.add(flute)

    // стружка
    const N = 110, pos = new Float32Array(N * 3), vel = new Float32Array(N * 3), life = new Float32Array(N)
    const chipGeo = keep(new THREE.BufferGeometry()); chipGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    const chips = new THREE.Points(chipGeo, keep(new THREE.PointsMaterial({ color: 0xE6CFA2, size: 0.75, sizeAttenuation: true, transparent: true, opacity: 0.95 })))
    chips.frustumCulled = false; scene.add(chips)
    for (let i = 0; i < N; i++) pos[i * 3 + 2] = -50

    // программа: переезд → погружение → обход контура → подъём
    let steps, total, parts, seed = Math.floor(Math.random() * 1e9), t0 = 0
    const program = () => {
      parts = makeLayout(seed)
      steps = []; let t = 0.4, from = [W / 2, H + 14]
      parts.forEach(r => {
        const a = r.pts[0], travel = Math.hypot(a[0] - from[0], a[1] - from[1]) / RAPID
        steps.push({ r, from, tA: t, tB: t + travel, tC: t + travel + PLUNGE, tD: t + travel + PLUNGE + r.per / CUT, tE: t + travel + PLUNGE * 2 + r.per / CUT })
        t += travel + PLUNGE * 2 + r.per / CUT; from = a
      })
      total = t + 1.2; sheetTex.clear(); t0 = 0
    }
    program()
    const state = el2 => {                                    // -> [x, y, z, режет]
      for (const s of steps) {
        if (el2 < s.tA) break
        const a = s.r.pts[0]
        if (el2 < s.tB) { const k = (el2 - s.tA) / Math.max(1e-6, s.tB - s.tA), e = k * k * (3 - 2 * k); return [s.from[0] + (a[0] - s.from[0]) * e, s.from[1] + (a[1] - s.from[1]) * e, SAFE, false] }
        if (el2 < s.tC) return [a[0], a[1], SAFE - (SAFE + 0.3) * (el2 - s.tB) / PLUNGE, false, s]
        if (el2 < s.tD) { const q = pointAt(s.r, (el2 - s.tC) * CUT); return [q[0], q[1], -0.3, true, s] }
        if (el2 < s.tE) return [a[0], a[1], -0.3 + (SAFE + 0.3) * (el2 - s.tD) / PLUNGE, false, s]
      }
      const l = steps[steps.length - 1]
      return el2 < steps[0].tA ? [W / 2, H + 14, SAFE, false] : [l.r.pts[0][0], l.r.pts[0][1], SAFE, false]
    }

    const camPos = new THREE.Vector3(W / 2 - 60, -70, 70), camAim = new THREE.Vector3(W / 2, H / 2, 0)
    let raf = 0, prev = 0
    const frame = now => {
      raf = requestAnimationFrame(frame)
      if (!prev) prev = now
      const dt = Math.min(0.05, (now - prev) / 1000); prev = now
      t0 += dt
      if (t0 > total || next.current) { next.current = false; seed = (seed * 31 + 7) >>> 0; program() }
      const [x, y, z, cutting, st] = state(t0)
      if (cutting) {
        // пройденный путь: вершины контура, которые фреза уже миновала, и её текущее положение
        const d = (t0 - st.tC) * CUT, path = [st.r.pts[0]]
        let acc = 0
        for (let i = 0; i < 4; i++) {
          const a = st.r.pts[i], b = st.r.pts[(i + 1) % 4]
          acc += Math.hypot(b[0] - a[0], b[1] - a[1])
          if (acc < d) path.push(b)
        }
        path.push([x, y]); sheetTex.cut(path)
      }
      head.position.set(x, y, 0); gantry.position.y = y
      spindle.position.z = z + T
      bit.rotation.y += dt * 60; flute.rotation.z += dt * 60; nut.rotation.y += dt * 60
      // стружка летит из-под фрезы
      for (let i = 0; i < N; i++) {
        life[i] -= dt
        if (life[i] <= 0 && cutting && Math.random() < 0.5) {
          const a = Math.random() * Math.PI * 2, v = 6 + Math.random() * 16
          pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = T + 0.2
          vel[i * 3] = Math.cos(a) * v; vel[i * 3 + 1] = Math.sin(a) * v; vel[i * 3 + 2] = 6 + Math.random() * 14
          life[i] = 0.5 + Math.random() * 0.7
        } else if (life[i] > 0) {
          vel[i * 3 + 2] -= 60 * dt
          pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt
          pos[i * 3 + 2] = Math.max(T + 0.12, pos[i * 3 + 2] + vel[i * 3 + 2] * dt)
          if (pos[i * 3 + 2] <= T + 0.13) { vel[i * 3] *= 0.9; vel[i * 3 + 1] *= 0.9 }
        } else pos[i * 3 + 2] = -50
      }
      chipGeo.attributes.position.needsUpdate = true
      // камера следит за шпинделем: чуть сзади-сбоку и сверху, плавно, с лёгким облётом
      const sway = Math.sin(now / 5200) * 0.35 - 0.55
      const want = new THREE.Vector3(x + Math.sin(sway) * 88, y - Math.cos(sway) * 88, 58 + Math.sin(now / 3900) * 6)
      const ease = 1 - Math.pow(0.04, dt)
      camPos.lerp(want, ease); camAim.lerp(new THREE.Vector3(x, y, 8), 1 - Math.pow(0.002, dt))
      camera.position.copy(camPos); camera.lookAt(camAim)
      sun.position.set(x - 60, y - 45, 120); sun.target.position.set(x, y, 0)
      renderer.render(scene, camera)
    }
    raf = requestAnimationFrame(frame)
    const onResize = () => { const nw = mount.clientWidth || w, nh = Math.round(nw * 0.68); renderer.setSize(nw, nh); camera.aspect = nw / nh; camera.updateProjectionMatrix() }
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(raf); window.removeEventListener('resize', onResize)
      trash.forEach(x => x.dispose?.())
      renderer.dispose(); renderer.forceContextLoss?.()
      el.remove()
    }
  }, [])

  if (failed) return fallback
  return <div ref={mountRef} onClick={() => { next.current = true }} role="img" aria-label="Станок с ЧПУ режет лист"
    style={{ width: 'min(100%, 420px)', cursor: 'pointer', boxShadow: '0 6px 24px rgba(0,0,0,0.12)', borderRadius: 14, WebkitTapHighlightColor: 'transparent' }} />
}
