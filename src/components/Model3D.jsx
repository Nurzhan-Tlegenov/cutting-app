import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { buildModel } from '../lib/model3d'
import { useAuth } from '../context/AuthContext'
import { getUserSettings, saveUserSettings } from '../lib/userSettings'
import { loadTextures, saveTexture, deleteTexture, fileToTexture, textureKey } from '../lib/materialTextures'

// Просмотр 3D-модели заказа (детали, импортированные из Базиса или Астры).
// Вращение — пальцем, масштаб — щипком, сдвиг — двумя пальцами,
// двойной тап по двери или ящику — открыть/закрыть (анимация из модели Базиса).
const MODES = [['solid', 'Сплошной'], ['xray', 'Полупрозрачный'], ['wire', 'Каркас']]
const PALETTE = ['#cbb89a', '#a9b7c4', '#d9d4c7', '#b9c8a8', '#d2b3a2', '#bdb5d6']

// Картинок текстур в файле Базиса нет. Если пользователь загрузил свою картинку для материала —
// берём её; иначе цвет и рисунок подбираем по названию материала.
// [шаблон, цвет, вид]: wood — древесный рисунок вдоль текстуры, metal, glass, stone
const NAME_LOOKS = [
  [/вотан/i, '#b98f5e', 'wood'], [/сонома/i, '#cdb894', 'wood'], [/венге/i, '#45302a', 'wood'], [/орех/i, '#7d563a', 'wood'],
  [/ясень/i, '#d8c7a6', 'wood'], [/бук/i, '#d6a977', 'wood'], [/вишн/i, '#9a4f33', 'wood'], [/ольха/i, '#c08a55', 'wood'],
  [/сосна/i, '#e0c48f', 'wood'], [/кл[её]н/i, '#e3cfa5', 'wood'], [/крафт/i, '#c69a5e', 'wood'], [/дуб/i, '#c8a777', 'wood'],
  [/дерев|шпон|массив/i, '#c2a077', 'wood'],
  [/стекл|зеркал/i, '#bcd4de', 'glass'],
  [/хром|никел|нерж|алюм|сталь|металл(?!ик)/i, '#b9bdc2', 'metal'],
  [/камень|мрамор|гранит|бетон/i, '#a9a59c', 'stone'],
  [/графит|антрацит/i, '#55585c'], [/ч[её]рн/i, '#2e2e30'], [/бел/i, '#f1f0ea'], [/сер|грэй|грей|gray|grey|титан/i, '#93969a'],
  [/оранж/i, '#e8862e'], [/красн|бордо/i, '#b53a2e'], [/син|голуб/i, '#4a6fa5'], [/зел[её]н|олив/i, '#6a8f62'],
  [/ж[её]лт/i, '#e2c444'], [/беж|крем|ваниль|слонов/i, '#e5d8bf'], [/коричн|шоколад/i, '#6b4a36'],
]

function woodTexture(hex) {
  const cv = document.createElement('canvas')
  cv.width = cv.height = 256
  const g = cv.getContext('2d')
  g.fillStyle = hex
  g.fillRect(0, 0, 256, 256)
  // волокна вдоль X: тёмные и светлые волнистые штрихи (псевдослучайно, но одинаково при каждом запуске)
  let seed = 7
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
  for (let i = 0; i < 90; i++) {
    const y = rnd() * 256, amp = 1 + rnd() * 3, ph = rnd() * 6.28, dark = rnd() < 0.7
    g.strokeStyle = dark ? `rgba(60,35,10,${0.05 + rnd() * 0.13})` : `rgba(255,245,225,${0.05 + rnd() * 0.1})`
    g.lineWidth = 0.6 + rnd() * 1.8
    g.beginPath()
    for (let x = 0; x <= 256; x += 16) { const yy = y + Math.sin(ph + (x / 256) * Math.PI * 2) * amp; if (x) g.lineTo(x, yy); else g.moveTo(x, yy) }
    g.stroke()
  }
  const tex = new THREE.CanvasTexture(cv)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  tex.repeat.set(1 / 700, 1 / 350)      // UV панели — в мм
  return tex
}

export default function Model3D({ details, scene: savedScene = null, title, onClose }) {
  const hostRef = useRef(null)
  const auth = useAuth()
  const user = auth?.user || null
  const texRef = useRef({})                      // свои текстуры: ключ материала -> { name, data, size, rot }
  const [tex, setTex] = useState({})
  const [texCloud, setTexCloud] = useState(true) // false — таблицы в базе нет, картинки только на этом устройстве
  const [showMats, setShowMats] = useState(false)
  const [texBusy, setTexBusy] = useState('')
  const fileRef = useRef(null)
  const pickFor = useRef('')
  const stateRef = useRef(null)
  const [mode, setMode] = useState('solid')
  // настройки вида идут за аккаунтом: прозрачность, подсветка кромки в каркасе
  const [view, setViewState] = useState(() => ({ xray: 0.28, bandOn: true, bandColor: '#ff6a00', bandOp: 0.7, ...(getUserSettings(user).view3d || {}) }))
  const setView = patch => setViewState(v => { const n = { ...v, ...patch }; saveUserSettings({ view3d: n }, user); return n })
  const [hidden, setHidden] = useState(() => new Set())   // скрытые материалы
  const [picked, setPicked] = useState(null)
  const [error, setError] = useState('')
  const model = useMemo(() => buildModel(details, savedScene), [details, savedScene])
  const parts = model.parts
  const [scope, setScope] = useState('all')      // 'all' — вся модель · 'order' — только детали заказа
  const count = parts.filter(p => scope === 'all' || p.inOrder).length
  const hasAnim = parts.some(p => p.anim) || model.hardware.some(h => h.inst.some(i => i.anim))

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

    const root = new THREE.Group()
    scene.add(root)
    const materials = new Map()
    const meshes = [], lines = []
    const lineMat = new THREE.LineBasicMaterial({ color: 0x3a3a36 })
    // стены/пол комнаты — светлые и полупрозрачные, чтобы не заслоняли мебель
    const roomMat = new THREE.MeshStandardMaterial({ color: 0xe6e3da, roughness: 1, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide })
    let paletteAt = 0
    const loader = new THREE.TextureLoader()
    // «одеть» материал: своя картинка пользователя, иначе рисунок/цвет по названию
    const skin = (m) => {
      const { name, texDir, kind, color } = m.userData
      if (m.map) { m.map.dispose(); m.map = null }
      const custom = texRef.current[textureKey(name)]
      if (custom?.data) {
        const size = Number(custom.size) > 0 ? Number(custom.size) : 600      // сколько мм занимает картинка по ширине
        const tex = loader.load(custom.data, t => {
          const iw = t.image?.width || 1, ih = t.image?.height || 1
          t.repeat.set(1 / size, 1 / (size * ih / iw))
        })
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping
        tex.colorSpace = THREE.SRGBColorSpace
        tex.repeat.set(1 / size, 1 / size)
        tex.rotation = ((texDir === 2 ? 1 : 0) + (custom.rot ? 1 : 0)) % 2 ? Math.PI / 2 : 0
        m.map = tex; m.color.set('#ffffff')
      } else if (kind === 'wood') {
        const tex = woodTexture(color)
        if (texDir === 2) tex.rotation = Math.PI / 2            // текстура вдоль Y панели
        m.map = tex; m.color.set('#ffffff')
      } else m.color.set(color)
      m.needsUpdate = true
    }
    const matFor = (name, texDir) => {
      if (/^(стена|стены|пол|потолок)/i.test(name || '')) return roomMat
      const look = NAME_LOOKS.find(l => l[0].test(name || ''))
      const kind = look?.[2] || ''
      const key = name + '|' + (texDir === 2 ? 2 : 1)
      if (!materials.has(key)) {
        // цвет материала из самой модели (в файле Астры он есть), иначе — по названию
        const color = model.colors?.[name] || (look ? look[1] : PALETTE[paletteAt++ % PALETTE.length])
        const m = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, side: THREE.DoubleSide })
        if (kind === 'metal') { m.metalness = 0.55; m.roughness = 0.4 }
        else if (kind === 'stone') { m.roughness = 0.6 }
        m.userData = { name, texDir, kind, color, baseOpacity: kind === 'glass' ? 0.45 : 1 }
        if (kind === 'glass') { m.transparent = true; m.opacity = 0.45; m.depthWrite = false }
        skin(m)
        materials.set(key, m)
      }
      return materials.get(key)
    }
    const darkMat = new THREE.MeshBasicMaterial({ color: 0x2b2a28 })
    const grooveMat = new THREE.MeshBasicMaterial({ color: 0x5a4630 })
    const decorMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false })
    const hwMat = new THREE.MeshStandardMaterial({ color: 0xa9adb3, roughness: 0.45, metalness: 0.35, side: THREE.DoubleSide })
    // торцы с кромкой — цветные ленты по контуру (видны в каркасе)
    const bandMat = new THREE.MeshBasicMaterial({ color: 0xff6a00, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false })
    const extraGeos = []                       // геометрия пазов и фурнитуры — для освобождения
    const all = []                             // все объекты сцены с пометками: kind и ctx (не входит в заказ)

    // Анимация из Базиса: всё, что входит в блок с анимацией, двигается одной группой
    const anims = new Map()                    // g -> { group, a, t (0..1), target }
    const parentOf = a => {
      if (!a) return root
      if (!anims.has(a.g)) {
        const g = new THREE.Group()
        g.matrixAutoUpdate = false
        root.add(g)
        anims.set(a.g, { group: g, a, t: 0, target: 0 })
      }
      return anims.get(a.g).group
    }
    const reg = (o, kind, ctx, anim, mat = '') => { o.__kind = kind; o.__ctx = ctx; o.__mat = mat; o.__anim = anim ? anim.g : 0; all.push(o); parentOf(anim).add(o); return o }

    const drillLists = new Map()               // «группа анимации|в заказе» -> матрицы отверстий
    const yAxis = new THREE.Vector3(0, 1, 0)
    const mat4Of = m => new THREE.Matrix4().set(m[0], m[1], m[2], m[9], m[3], m[4], m[5], m[10], m[6], m[7], m[8], m[11], 0, 0, 0, 1)
    for (const p of parts) {
      if (p.outline.length < 3) continue
      const shape = new THREE.Shape(p.outline.map(([x, y]) => new THREE.Vector2(x, y)))
      for (const h of p.holes) if (h.length > 2) shape.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))))
      // у фасада с объёмной фрезеровкой основа тоньше, а лицевая пласть — рельеф
      const geo = new THREE.ExtrudeGeometry(shape, { depth: p.carve ? p.t - p.carve.maxD : p.t, bevelEnabled: false, curveSegments: 1 })
      if (p.carve && !p.carve.top) geo.translate(0, 0, p.carve.maxD)
      const mat4 = mat4Of(p.m)
      const mesh = new THREE.Mesh(geo, matFor(p.material, p.texDir))
      mesh.applyMatrix4(mat4)
      mesh.userData = p
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), lineMat)
      edge.applyMatrix4(mat4)
      reg(mesh, 'panel', !p.inOrder, p.anim, p.material); reg(edge, 'edge', !p.inOrder, p.anim, p.material)
      meshes.push(mesh); lines.push(edge)
      if (p.bands?.length) {
        const pos = []
        for (const line of p.bands) for (let k = 1; k < line.length; k++) {
          const [ax, ay] = line[k - 1], [bx, by] = line[k]
          pos.push(ax, ay, 0, bx, by, 0, bx, by, p.t, ax, ay, 0, bx, by, p.t, ax, ay, p.t)
        }
        const bg = new THREE.BufferGeometry()
        bg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
        const bm = new THREE.Mesh(bg, bandMat)
        bm.applyMatrix4(mat4)
        reg(bm, 'band', !p.inOrder, p.anim, p.material); extraGeos.push(bg)
      }
      if (p.carve) {
        const sg = new THREE.BufferGeometry()
        sg.setAttribute('position', new THREE.BufferAttribute(p.carve.pos, 3))
        // UV как у основы — в мм по плоскости панели, чтобы текстура шла без шва
        const uv = new Float32Array((p.carve.pos.length / 3) * 2)
        for (let k = 0, q = 0; k < p.carve.pos.length; k += 3, q += 2) { uv[q] = p.carve.pos[k]; uv[q + 1] = p.carve.pos[k + 1] }
        sg.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
        sg.computeVertexNormals()
        const skin = new THREE.Mesh(sg, mesh.material)
        skin.applyMatrix4(mat4)
        skin.userData = p
        const se = new THREE.LineSegments(new THREE.EdgesGeometry(sg, 12), lineMat)
        se.applyMatrix4(mat4)
        reg(skin, 'panel', !p.inOrder, p.anim, p.material); reg(se, 'edge', !p.inOrder, p.anim, p.material)
        meshes.push(skin); lines.push(se)
      }
      // отверстия: тёмный цилиндр, чуть выступающий из поверхности — виден и снаружи, и «на просвет»
      for (const d of p.drills) {
        const dir = new THREE.Vector3(d.d[0], d.d[1], d.d[2]).normalize()
        const start = new THREE.Vector3(d.p[0], d.p[1], d.p[2])
        const local = new THREE.Matrix4().compose(
          start.clone().addScaledVector(dir, d.len / 2 - 0.2),
          new THREE.Quaternion().setFromUnitVectors(yAxis, dir),
          new THREE.Vector3(d.r, d.len + 0.4, d.r))
        const key = `${p.anim ? p.anim.g : 0}|${p.inOrder ? 1 : 0}|${p.material}`
        if (!drillLists.has(key)) drillLists.set(key, { list: [], anim: p.anim, ctx: !p.inOrder, mat: p.material })
        drillLists.get(key).list.push(mat4.clone().multiply(local))
      }
      // пазы и фрезеровка: тёмная вставка в пласть
      for (const g of p.grooves) {
        const gs = new THREE.Shape(g.poly.map(([x, y]) => new THREE.Vector2(x, y)))
        const gg = new THREE.ExtrudeGeometry(gs, { depth: g.depth + 0.4, bevelEnabled: false })
        gg.translate(0, 0, g.z > p.t / 2 ? p.t - g.depth : -0.4)
        const gm = new THREE.Mesh(gg, g.decor ? decorMat : grooveMat)
        gm.applyMatrix4(mat4)
        reg(gm, 'groove', !p.inOrder, p.anim, p.material); extraGeos.push(gg)
      }
    }
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 14)
    extraGeos.push(cyl)
    for (const { list, anim, ctx, mat } of drillLists.values()) {
      const inst = new THREE.InstancedMesh(cyl, darkMat, list.length)
      list.forEach((mx, i) => inst.setMatrixAt(i, mx))
      inst.instanceMatrix.needsUpdate = true
      inst.frustumCulled = false
      reg(inst, 'drill', ctx, anim, mat)
    }
    // фурнитура, у которой в модели есть форма (петли, ручки, опоры, навесы…)
    for (const hw of model.hardware) {
      const pos = new Float32Array(hw.groups.reduce((n, g) => n + g.pos.length, 0))
      let o = 0
      hw.groups.forEach(g => { pos.set(g.pos, o); o += g.pos.length })
      const hg = new THREE.BufferGeometry()
      hg.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      hg.computeVertexNormals()
      extraGeos.push(hg)
      for (const it of hw.inst) {
        const hm = new THREE.Mesh(hg, hwMat)
        hm.applyMatrix4(mat4Of(it.m))
        hm.userData = { name: hw.name, des: '', size: '', t: null, product: '', hardware: true, anim: it.anim }
        reg(hm, 'hw', true, it.anim); meshes.push(hm)
      }
    }

    // камера по габариту модели
    const box = new THREE.Box3().setFromObject(root)
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

    // положение группы анимации при доле открытия e (0 — закрыто, 1 — открыто)
    const va = new THREE.Vector3(), vb = new THREE.Vector3(), mA = new THREE.Matrix4(), mB = new THREE.Matrix4(), mR = new THREE.Matrix4()
    const applyAnim = (st) => {
      const { a } = st
      const e = st.t * st.t * (3 - 2 * st.t)                  // плавный разгон и остановка
      va.set(a.a[0], a.a[1], a.a[2]); vb.set(a.b[0], a.b[1], a.b[2])
      if (a.t === 2) st.group.matrix.makeTranslation((vb.x - va.x) * e, (vb.y - va.y) * e, (vb.z - va.z) * e)
      else {
        const axis = vb.clone().sub(va)
        if (axis.lengthSq() < 1e-9) { st.group.matrix.identity(); return }
        mR.makeRotationAxis(axis.normalize(), ((a.lim || 90) * Math.PI / 180) * e)
        mA.makeTranslation(va.x, va.y, va.z); mB.makeTranslation(-va.x, -va.y, -va.z)
        st.group.matrix.copy(mA).multiply(mR).multiply(mB)
      }
      st.group.matrixWorldNeedsUpdate = true
    }

    let raf = 0, last = performance.now()
    const tick = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000) || 0
      last = now
      anims.forEach(st => {
        if (st.t === st.target) return
        const step = dt / 0.7
        st.t = st.target > st.t ? Math.min(st.target, st.t + step) : Math.max(st.target, st.t - step)
        applyAnim(st)
      })
      controls.update()
      sun.position.copy(camera.position)     // свет «от зрителя» — грани читаются с любой стороны
      renderer.render(scene, camera)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    // тап по детали — показать, что это; двойной тап по двери/ящику — открыть или закрыть
    const ray = new THREE.Raycaster()
    let down = null, lastTap = { g: 0, t: 0 }
    const onDown = e => { down = { x: e.clientX, y: e.clientY, t: Date.now() } }
    const onUp = e => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8 || Date.now() - down.t > 400) return
      const r = renderer.domElement.getBoundingClientRect()
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera)
      const hit = ray.intersectObjects(meshes.filter(x => x.visible), false)[0]
      const st = stateRef.current
      const g = hit ? hit.object.__anim : 0
      const now = Date.now()
      if (g && lastTap.g === g && now - lastTap.t < 500) {
        const an = anims.get(g)
        an.target = an.target ? 0 : 1
        lastTap = { g: 0, t: 0 }
        return
      }
      lastTap = { g, t: now }
      if (st.sel) { st.sel.material = st.selMat; st.sel = null }
      if (hit) {
        st.sel = hit.object; st.selMat = hit.object.material
        const hi = hit.object.material.clone(); hi.map = null; hi.color.set('#185FA5'); hi.emissive?.set('#0C447C')
        hit.object.material = hi
        setPicked({ ...hit.object.userData, canOpen: !!g })
      } else setPicked(null)
    }
    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointerup', onUp)

    stateRef.current = {
      materials, meshes, lines, lineMat, hwMat, bandMat, roomMat, all, resetView, sel: null, selMat: null,
      openAll: (open) => anims.forEach(st => { st.target = open ? 1 : 0 }),
      reskin: () => materials.forEach(skin),
    }
    return () => {
      cancelAnimationFrame(raf)
      ro?.disconnect()
      controls.dispose()
      meshes.forEach(x => { if (x.__kind === 'panel') x.geometry.dispose() })
      lines.forEach(x => x.geometry.dispose())
      materials.forEach(x => { x.map?.dispose(); x.dispose() })
      extraGeos.forEach(x => x.dispose())
      darkMat.dispose(); grooveMat.dispose(); decorMat.dispose(); hwMat.dispose(); bandMat.dispose(); roomMat.dispose(); lineMat.dispose()
      renderer.dispose()
      renderer.domElement.remove()
      stateRef.current = null
    }
  }, [model, parts])

  // режим показа и состав (вся модель / только заказ)
  useEffect(() => {
    const st = stateRef.current
    if (!st) return
    const xray = mode === 'xray', wire = mode === 'wire'
    st.materials.forEach(m => {
      const base = m.userData.baseOpacity ?? 1
      m.transparent = xray || base < 1; m.opacity = xray ? Math.min(base, view.xray) : base; m.depthWrite = !(xray || base < 1); m.needsUpdate = true
    })
    st.bandMat.color.set(view.bandColor); st.bandMat.opacity = view.bandOp
    st.hwMat.wireframe = wire
    if (st.sel) { st.sel.material.transparent = xray; st.sel.material.opacity = xray ? 0.5 : 1; st.sel.material.depthWrite = !xray; st.sel.material.needsUpdate = true }
    st.all.forEach(o => {
      o.visible = (scope === 'all' || !o.__ctx) && !(wire && o.__kind === 'panel') && !(o.__mat && hidden.has(o.__mat))
        && (o.__kind !== 'band' || (wire && view.bandOn))
    })
    st.lineMat.color.set(wire ? 0x185fa5 : 0x3a3a36)
  }, [mode, scope, model, view, hidden])

  const [opened, setOpened] = useState(false)

  // свои текстуры материалов
  const uid = user?.id || null
  useEffect(() => {
    let alive = true
    loadTextures(user).then(({ map, cloud }) => {
      if (!alive) return
      texRef.current = map; setTex(map); setTexCloud(cloud)
      stateRef.current?.reskin()
    })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid])
  const isRoom = n => /^(стена|стены|пол|потолок)/i.test(n)
  const allMats = useMemo(() => { const m = new Map(); parts.forEach(p => { if (p.material) m.set(p.material, (m.get(p.material) || 0) + 1) }); return [...m.entries()] }, [parts])
  const matNames = useMemo(() => allMats.map(m => m[0]), [allMats])
  const hasBands = useMemo(() => parts.some(p => p.bands?.length), [parts])
  const toggleMat = name => setHidden(h => { const n = new Set(h); if (n.has(name)) n.delete(name); else n.add(name); return n })
  const applyTex = (name, t) => {
    const next = { ...texRef.current }
    if (t) next[textureKey(name)] = { name, ...t }; else delete next[textureKey(name)]
    texRef.current = next; setTex(next)
    stateRef.current?.reskin()
  }
  const onTexFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    const name = pickFor.current
    if (!file || !name) return
    setTexBusy(name)
    try {
      const data = await fileToTexture(file)
      const prev = texRef.current[textureKey(name)]
      const t = { data, size: prev?.size || 600, rot: !!prev?.rot }
      applyTex(name, t)
      const r = await saveTexture(user, name, t)
      setTexCloud(r.cloud)
    } catch (err) { setError(String(err?.message || err)) } finally { setTexBusy('') }
  }
  const changeTex = async (name, patch) => {
    const prev = texRef.current[textureKey(name)]
    if (!prev) return
    const t = { data: prev.data, size: prev.size, rot: prev.rot, ...patch }
    applyTex(name, t)
    const r = await saveTexture(user, name, t)
    setTexCloud(r.cloud)
  }
  const removeTex = async (name) => { applyTex(name, null); await deleteTexture(user, name) }
  const chip = active => ({
    flex: 1, padding: '7px 4px', borderRadius: 20, border: 'none', fontSize: 12, cursor: 'pointer',
    background: active ? 'var(--blue)' : 'var(--bg2)', color: active ? 'white' : 'var(--text-muted)',
  })
  const smallBtn = { padding: '5px 10px', borderRadius: 20, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)', fontSize: 12, whiteSpace: 'nowrap' }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 960, background: 'var(--bg2)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: 'var(--bg)', borderBottom: '0.5px solid var(--border)' }}>
        <button type="button" onClick={onClose}
          style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 22, padding: 0, lineHeight: 1 }}>←</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 500 }}>3D-модель</div>
          <div style={{ fontSize: 11, color: 'var(--text-hint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {title ? `${title} · ` : ''}{count} дет.
          </div>
        </div>
        {hasAnim && (
          <button type="button" style={smallBtn}
            onClick={() => { const o = !opened; setOpened(o); stateRef.current?.openAll(o) }}>
            {opened ? 'Закрыть всё' : 'Открыть всё'}
          </button>
        )}
        {matNames.length > 0 && <button type="button" style={{ ...smallBtn, ...(hidden.size ? { color: 'var(--blue)', borderColor: 'var(--blue)' } : {}) }} onClick={() => setShowMats(v => !v)}>Материалы{hidden.size ? ` · скрыто ${hidden.size}` : ''}</button>}
        <button type="button" style={smallBtn} onClick={() => stateRef.current?.resetView()}>⟲ Вид</button>
      </div>
      <div style={{ display: 'flex', gap: 6, padding: '8px 14px', background: 'var(--bg)' }}>
        {MODES.map(([id, label]) => <button key={id} type="button" style={chip(mode === id)} onClick={() => setMode(id)}>{label}</button>)}
      </div>
      {mode === 'xray' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 14px 8px', background: 'var(--bg)', fontSize: 12, color: 'var(--text-muted)' }}>
          <span style={{ flexShrink: 0 }}>Прозрачность</span>
          <input type="range" min="5" max="90" step="1" value={Math.round((1 - view.xray) * 100)} style={{ flex: 1 }}
            onChange={e => setView({ xray: 1 - Number(e.target.value) / 100 })} />
          <span style={{ width: 34, textAlign: 'right' }}>{Math.round((1 - view.xray) * 100)}%</span>
        </div>
      )}
      {mode === 'wire' && hasBands && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 14px 8px', background: 'var(--bg)', fontSize: 12, color: 'var(--text-muted)' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0, margin: 0 }}>
            <input type="checkbox" checked={view.bandOn} onChange={e => setView({ bandOn: e.target.checked })} style={{ width: 'auto' }} />
            Кромка
          </label>
          <input type="color" value={view.bandColor} disabled={!view.bandOn} onChange={e => setView({ bandColor: e.target.value })}
            style={{ width: 34, height: 26, padding: 0, border: '0.5px solid var(--border-md)', borderRadius: 6, background: 'none', flexShrink: 0 }} />
          <input type="range" min="10" max="100" step="1" value={Math.round(view.bandOp * 100)} disabled={!view.bandOn} style={{ flex: 1 }}
            onChange={e => setView({ bandOp: Number(e.target.value) / 100 })} />
          <span style={{ width: 34, textAlign: 'right' }}>{Math.round(view.bandOp * 100)}%</span>
        </div>
      )}
      {model.hasContext && (
        <div style={{ display: 'flex', gap: 6, padding: '0 14px 8px', background: 'var(--bg)' }}>
          {[['all', 'Вся модель'], ['order', 'Только детали заказа']].map(([id, label]) => (
            <button key={id} type="button" style={chip(scope === id)} onClick={() => setScope(id)}>{label}</button>
          ))}
        </div>
      )}
      <div ref={hostRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {error && <p className="error-text" style={{ padding: 20 }}>{error}</p>}
        {showMats && (
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '62%', overflowY: 'auto', background: 'var(--bg)', borderTop: '0.5px solid var(--border-md)', padding: '10px 14px', boxShadow: '0 -4px 16px rgba(0,0,0,0.08)' }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
              <div style={{ flex: 1, fontSize: 14, fontWeight: 500 }}>Материалы</div>
              <button type="button" onClick={() => setShowMats(false)} style={{ background: 'none', border: 'none', fontSize: 18, color: 'var(--text-hint)' }}>✕</button>
            </div>
            <p style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 8 }}>
              Галочка — показывать детали из этого материала в модели. Снимите её, чтобы «потушить» материал и рассмотреть остальное.
              Картинка декора ляжет на все детали материала и запомнится по его названию.
            </p>
            {allMats.length > 1 && (
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                <button type="button" style={smallBtn} onClick={() => setHidden(new Set())}>Показать все</button>
                <button type="button" style={smallBtn} onClick={() => setHidden(new Set(matNames))}>Скрыть все</button>
              </div>
            )}
            {!texCloud && (
              <p style={{ fontSize: 11, color: 'var(--amber)', background: 'var(--amber-light)', borderRadius: 'var(--radius)', padding: '6px 8px', marginBottom: 8 }}>
                Картинки пока сохраняются только на этом устройстве. Чтобы они шли за аккаунтом, выполните migration_material_textures.sql в Supabase.
              </p>
            )}
            <input ref={fileRef} type="file" accept="image/*" onChange={onTexFile} style={{ display: 'none' }} />
            {allMats.map(([name, cnt]) => {
              const t = tex[textureKey(name)]
              return (
                <div key={name} style={{ padding: '8px 0', borderTop: '0.5px solid var(--border)', opacity: hidden.has(name) ? 0.55 : 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input type="checkbox" checked={!hidden.has(name)} onChange={() => toggleMat(name)} style={{ width: 20, height: 20, flexShrink: 0 }} />
                    <div style={{ width: 40, height: 40, borderRadius: 6, flexShrink: 0, border: '0.5px solid var(--border-md)', background: t?.data ? `url(${t.data}) center/cover` : 'var(--bg2)' }} />
                    <div style={{ flex: 1, minWidth: 0, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name} <span style={{ color: 'var(--text-hint)' }}>· {cnt}</span></div>
                    {!isRoom(name) && <button type="button" style={smallBtn} disabled={texBusy === name}
                      onClick={() => { pickFor.current = name; fileRef.current?.click() }}>
                      {texBusy === name ? '…' : t ? 'Заменить' : 'Загрузить'}
                    </button>}
                  </div>
                  {t && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                      <span style={{ flexShrink: 0 }}>Ширина картинки, мм</span>
                      <input type="text" inputMode="numeric" defaultValue={t.size} style={{ width: 70, padding: '4px 6px', fontSize: 12 }}
                        onBlur={e => { const v = Number(e.target.value.replace(/[^0-9]/g, '')); if (v > 0 && v !== t.size) changeTex(name, { size: v }) }} />
                      <button type="button" style={smallBtn} onClick={() => changeTex(name, { rot: !t.rot })}>⟳ 90°</button>
                      <button type="button" style={{ ...smallBtn, color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={() => removeTex(name)}>Убрать</button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
      <div style={{ padding: '8px 14px calc(8px + env(safe-area-inset-bottom))', background: 'var(--bg)', borderTop: '0.5px solid var(--border)', fontSize: 12, minHeight: 38 }}>
        {picked
          ? <span><b>{picked.des ? `${picked.des} · ` : ''}{picked.name}</b>{picked.size ? ` — ${picked.size}` : ''}{picked.t ? ` · ${picked.t} мм` : ''}{picked.material && !picked.hardware ? ` · ${picked.material}` : ''}{picked.product ? ` · ${picked.product}` : ''}{picked.canOpen ? ' · двойной тап — открыть/закрыть' : ''}</span>
          : <span style={{ color: 'var(--text-hint)' }}>Палец — вращать · щипок — масштаб · два пальца — сдвиг · тап по детали — что это{hasAnim ? ' · двойной тап по двери или ящику — открыть' : ''}</span>}
      </div>
    </div>
  )
}
