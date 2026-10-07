import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { buildModel } from '../lib/model3d'
import { useAuth } from '../context/AuthContext'
import { getUserSettings, saveUserSettings } from '../lib/userSettings'
import { loadTextures, saveTexture, deleteTexture, fileToTexture, textureKey } from '../lib/materialTextures'
import { orderParts, segFace, edgeTargetAt, applyEdgeOps, findJoints, partGroups, applyJoints, clearJoints, jointsDone, contourOf, BUILTIN_SCHEMES, schemeFace, schemeEdge } from '../lib/model3dEdit'
import { loadHardwarePresets, saveHardwarePreset } from '../lib/hardwarePresets'
import { blockTree, partBox, hardwareLinks, movingSet, sweepLimits, clampMove, moveModel } from '../lib/model3dMove'
import ShareLinkBox from './ShareLinkBox'
import { lazyRetry } from '../lib/lazyRetry'
const ContourEditor = lazyRetry(() => import('./ContourEditor'))

// Просмотр 3D-модели заказа (детали, импортированные из Базиса или Астры).
// Вращение — пальцем, масштаб — щипком, сдвиг — двумя пальцами,
// двойной тап по двери или ящику — открыть/закрыть (анимация из модели Базиса).
// Долгое нажатие на деталь — меню: оставить только деталь / блок / корпус, выбрать несколько, править.
// Если передан onDetailsChange — модель можно править: кромка по видимым торцам, присадка по стыкам.
const VIEWS = [['front', 'Спереди', [0, 0, 1]], ['back', 'Сзади', [0, 0, -1]], ['left', 'Слева', [-1, 0, 0]], ['right', 'Справа', [1, 0, 0]],
  ['top', 'Сверху', [0, 1, 0.0001]], ['bottom', 'Снизу', [0, -1, 0.0001]], ['iso', 'Изометрия', [0.75, 0.5, 1]]]
const LABELS = [['none', 'Без подписей'], ['pos', 'Позиция'], ['des', 'Обозначение'], ['name', 'Наименование'], ['block', 'Блоки']]
// куб видов: грань -> откуда смотреть
const CUBE = [['Перед', [0, 0, 1], ''], ['Зад', [0, 0, -1], 'rotateY(180deg)'], ['Право', [1, 0, 0], 'rotateY(90deg)'], ['Лево', [-1, 0, 0], 'rotateY(-90deg)'],
  ['Верх', [0, 1, 0.0001], 'rotateX(90deg)'], ['Низ', [0, -1, 0.0001], 'rotateX(-90deg)']]
const AXES = [['← → Влево-вправо', 'X'], ['↑ ↓ Вверх-вниз', 'Y'], ['Вперёд-назад', 'Z']]
const HOLD_MS = 550
const labelText = (p, mode) => {
  if (mode === 'name') return p.name || ''
  const num = p.inOrder && p.di >= 0 ? String(p.di + 1) : ''
  if (mode === 'pos') return p.pos || num
  if (mode === 'des') return p.des || p.pos || num
  return ''
}
// подпись детали — картинка с текстом, всегда повёрнута к зрителю и одного размера на экране
function labelTexture(text) {
  const cv = document.createElement('canvas')
  const g = cv.getContext('2d')
  const font = '600 30px system-ui, -apple-system, Segoe UI, Roboto, sans-serif'
  g.font = font
  const t = text.length > 22 ? text.slice(0, 21) + '…' : text
  const w = Math.ceil(g.measureText(t).width) + 20, h = 44
  cv.width = w; cv.height = h
  g.font = font
  g.fillStyle = 'rgba(255,255,255,0.9)'
  g.beginPath(); g.roundRect(0, 0, w, h, 10); g.fill()
  g.strokeStyle = 'rgba(24,95,165,0.55)'; g.lineWidth = 2
  g.beginPath(); g.roundRect(1, 1, w - 2, h - 2, 9); g.stroke()
  g.fillStyle = '#12314f'; g.textBaseline = 'middle'; g.textAlign = 'center'
  g.fillText(t, w / 2, h / 2 + 1)
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  return { tex, aspect: w / h }
}
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

export default function Model3D({ details, scene: savedScene = null, title, onClose, onDetailsChange = null, edgeNames = null, orderId, readOnly = false, sharedTextures = null, editPath = '', materialThickness = 16, actions = null, focus = null, onSceneChange = null, edgeTypes = null, onEdgeTypesChange = null, onEdgeNamesChange = null }) {
  const hostRef = useRef(null)
  const auth = useAuth()
  const user = auth?.user || null
  const navigate = useNavigate()
  const editable = !!onDetailsChange && !readOnly
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
  const [view, setViewState] = useState(() => ({ xray: 0.28, bandOn: true, bandColor: '#ff6a00', bandOp: 0.7, wireColor: '#185fa5', wireW: 1, wireOp: 1, label: 'none', ...(getUserSettings(user).view3d || {}) }))
  const setView = patch => setViewState(v => { const n = { ...v, ...patch }; saveUserSettings({ view3d: n }, user); return n })
  const [hidden, setHidden] = useState(() => new Set())   // скрытые материалы
  const [showSet, setShowSet] = useState(false)           // выпадающая панель настроек вида
  const [hl, setHl] = useState('')                        // подсветка присадки: '' | 'front' (лицевая) | 'back' (изнанка)
  const [picked, setPicked] = useState(null)
  const [error, setError] = useState('')
  const [hiddenPids, setHiddenPids] = useState(() => new Set())  // потушенные детали (остальное — «оставить только…»)
  const [sel, setSel] = useState(() => new Set())                // выбранные детали
  const [multi, setMulti] = useState(false)                      // выбор нескольких деталей тапами
  const [menu, setMenu] = useState(null)                         // меню долгого нажатия: { pid }
  const [showViews, setShowViews] = useState(false)
  const [explode, setExplode] = useState(0)                      // взрыв-схема: 0..1
  const [showExplode, setShowExplode] = useState(false)
  const [tool, setToolState] = useState('')                      // '' | 'edge' (кромка) | 'drill' (присадка)
  const [edgeValue, setEdgeValue] = useState('default')          // какая кромка ставится
  const [schemes, setSchemes] = useState([])                     // база фурнитуры пользователя
  const [schemeId, setSchemeId] = useState('')
  const [jOff, setJOff] = useState(() => new Set())              // стыки, с которых галочка снята
  const [jOn, setJOn] = useState(() => new Set())                // стыки, включённые вручную (тонкие детали по умолчанию выключены)
  const [showShare, setShowShare] = useState(false)
  const [toast, setToast] = useState('')
  const [editing, setEditing] = useState(null)                   // правка детали в редакторе контура: { di, draft }
  const [undoN, setUndoN] = useState(0)
  const [newScheme, setNewScheme] = useState(null)               // форма «новый крепёж» (создаётся прямо в 3D)
  const [showTree, setShowTree] = useState(false)                // структура модели (блоки и детали) — панель слева
  const [openNodes, setOpenNodes] = useState(() => new Set())
  const [moveAxis, setMoveAxis] = useState(0)                    // перемещение: свободная ось (0 — X, 1 — Y, 2 — Z), остальные закреплены
  const [moveVec, setMoveVec] = useState([0, 0, 0])              // ещё не применённый сдвиг выбранного, мм
  const cubeRef = useRef(null)
  const dragRef = useRef(null)
  const historyRef = useRef([])
  const camRef = useRef(null)                                    // положение камеры — чтобы не сбрасывалось после правки
  const liveRef = useRef({})
  const toastTimer = useRef(0)
  const say = msg => { setToast(msg); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 3200) }
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
    // линии каркаса — «толстые» (обычные линии в WebGL всегда в 1 пиксель)
    const lineMat = new LineMaterial({ color: 0x3a3a36, linewidth: 1, transparent: true, opacity: 1 })
    const fatEdges = (geo, angle) => { const g = new LineSegmentsGeometry(); const e = new THREE.EdgesGeometry(geo, angle); g.setPositions(e.attributes.position.array); e.dispose(); return new LineSegments2(g, lineMat) }
    const hlMat = new THREE.MeshBasicMaterial({ color: 0x00a651 })
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
    const bandMat = new THREE.MeshBasicMaterial({ color: 0xff6a00, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 })
    // выбранные детали
    const selMat = new THREE.MeshStandardMaterial({ color: 0x185fa5, emissive: 0x0c447c, roughness: 0.8, side: THREE.DoubleSide })
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
    // pid — имя штуки: по нему деталь тушится, выбирается и раздвигается (взрыв-схема) со всем, что на ней есть
    const reg = (o, kind, ctx, anim, mat = '', pid = '') => { o.__kind = kind; o.__ctx = ctx; o.__mat = mat; o.__anim = anim ? anim.g : 0; o.__pid = pid; o.__base = o.position.clone(); o.__shown = true; all.push(o); parentOf(anim).add(o); return o }
    const recs = new Map()                     // pid -> { p, center (середина детали в модели) }

    const cyl = new THREE.CylinderGeometry(1, 1, 1, 14)
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
      mesh.__mat0 = mesh.material
      const edge = fatEdges(geo, 20)
      edge.applyMatrix4(mat4)
      const pid = p.pid
      reg(mesh, 'panel', !p.inOrder, p.anim, p.material, pid); reg(edge, 'edge', !p.inOrder, p.anim, p.material, pid)
      meshes.push(mesh); lines.push(edge)
      {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
        for (const [x, y] of p.outline) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
        recs.set(pid, { p, center: new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, p.t / 2).applyMatrix4(mat4) })
      }
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
        reg(bm, 'band', !p.inOrder, p.anim, p.material, pid); extraGeos.push(bg)
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
        skin.__mat0 = skin.material
        const se = fatEdges(sg, 12)
        se.applyMatrix4(mat4)
        reg(skin, 'panel', !p.inOrder, p.anim, p.material, pid); reg(se, 'edge', !p.inOrder, p.anim, p.material, pid)
        meshes.push(skin); lines.push(se)
      }
      // отверстия: тёмный цилиндр, чуть выступающий из поверхности — виден и снаружи, и «на просвет»
      const drillLists = new Map()             // сторона ('front' | 'back' | '') -> матрицы отверстий этой детали
      for (const d of p.drills) {
        const dir = new THREE.Vector3(d.d[0], d.d[1], d.d[2]).normalize()
        const start = new THREE.Vector3(d.p[0], d.p[1], d.p[2])
        const local = new THREE.Matrix4().compose(
          start.clone().addScaledVector(dir, d.len / 2 - 0.2),
          new THREE.Quaternion().setFromUnitVectors(yAxis, dir),
          new THREE.Vector3(d.r, d.len + 0.4, d.r))
        const key = d.side || ''
        if (!drillLists.has(key)) drillLists.set(key, [])
        drillLists.get(key).push(local)
      }
      for (const [side, list] of drillLists) {
        const inst = new THREE.InstancedMesh(cyl, darkMat, list.length)
        list.forEach((mx, i) => inst.setMatrixAt(i, mx))
        inst.instanceMatrix.needsUpdate = true
        inst.frustumCulled = false
        inst.applyMatrix4(mat4)
        reg(inst, 'drill', !p.inOrder, p.anim, p.material, pid).__side = side
      }
      // пазы и фрезеровка: тёмная вставка в пласть
      for (const g of p.grooves) {
        const gs = new THREE.Shape(g.poly.map(([x, y]) => new THREE.Vector2(x, y)))
        const gg = new THREE.ExtrudeGeometry(gs, { depth: g.depth + 0.4, bevelEnabled: false })
        gg.translate(0, 0, g.z > p.t / 2 ? p.t - g.depth : -0.4)
        const gm = new THREE.Mesh(gg, g.decor ? decorMat : grooveMat)
        gm.applyMatrix4(mat4)
        reg(gm, 'groove', !p.inOrder, p.anim, p.material, pid); extraGeos.push(gg)
      }
    }
    extraGeos.push(cyl)
    // фурнитура, у которой в модели есть форма (петли, ручки, опоры, навесы…)
    let hwN = 0
    for (const hw of model.hardware) {
      const pos = new Float32Array(hw.groups.reduce((n, g) => n + g.pos.length, 0))
      let o = 0
      hw.groups.forEach(g => { pos.set(g.pos, o); o += g.pos.length })
      const hg = new THREE.BufferGeometry()
      hg.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      hg.computeVertexNormals()
      hg.computeBoundingBox()
      extraGeos.push(hg)
      for (const it of hw.inst) {
        const hm = new THREE.Mesh(hg, hwMat)
        const m4 = mat4Of(it.m)
        hm.applyMatrix4(m4)
        const pid = 'h' + hwN++
        hm.userData = { name: hw.name, des: '', size: '', t: null, product: (it.b || '').split(' / ')[0], block: it.b || '', hardware: true, anim: it.anim, pid, di: -1 }
        hm.__mat0 = hwMat
        reg(hm, 'hw', true, it.anim, '', pid); meshes.push(hm)
        recs.set(pid, { p: hm.userData, center: hg.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(m4) })
      }
    }

    // камера по габариту модели
    const box = new THREE.Box3().setFromObject(root)
    const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3())
    const radius = box.isEmpty() ? 1000 : Math.max(box.getSize(new THREE.Vector3()).length() / 2, 100)
    // две камеры: перспектива и аксонометрия (параллельная проекция)
    const persp = new THREE.PerspectiveCamera(35, 1, radius / 50, radius * 40)
    const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -radius * 40, radius * 40)
    let camera = persp
    const tanHalf = Math.tan((persp.fov * Math.PI) / 360)
    const st0 = { viewH: 300, camera: persp }  // то, что нужно ещё до готовности stateRef
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.copy(center)
    controls.enableDamping = true
    // Вписать в экран то, что сейчас показано; dir — откуда смотреть (нет — как смотрим сейчас)
    const fit = (dir) => {
      root.updateMatrixWorld(true)
      const b = new THREE.Box3()
      for (const o of meshes) if (o.__shown) b.expandByObject(o)
      const c = b.isEmpty() ? center.clone() : b.getCenter(new THREE.Vector3())
      const r = b.isEmpty() ? radius : Math.max(b.getSize(new THREE.Vector3()).length() / 2, 50)
      const d = dir ? new THREE.Vector3(dir[0], dir[1], dir[2]) : camera.position.clone().sub(controls.target)
      if (d.lengthSq() < 1e-9) d.set(0.75, 0.5, 1)
      // на узком экране ограничивает ширина, а не высота
      if (camera === ortho) {
        ortho.top = (r * 1.02) / Math.min(1, persp.aspect); ortho.bottom = -ortho.top
        ortho.left = -ortho.top * persp.aspect; ortho.right = ortho.top * persp.aspect
        ortho.zoom = 1; ortho.updateProjectionMatrix()
        camera.position.copy(c).add(d.normalize().multiplyScalar(r * 3))
      } else {
        const half = (persp.fov * Math.PI) / 360
        const halfMin = Math.min(half, Math.atan(Math.tan(half) * persp.aspect))
        camera.position.copy(c).add(d.normalize().multiplyScalar(r / Math.sin(halfMin) * 1.02))
      }
      controls.target.copy(c)
      controls.update()
    }
    const resetView = () => fit([0.75, 0.5, 1])
    const resize = () => {
      const w = host.clientWidth || 300, h = host.clientHeight || 300
      renderer.setSize(w, h, false)
      renderer.domElement.style.width = '100%'
      renderer.domElement.style.height = '100%'
      persp.aspect = w / h
      persp.updateProjectionMatrix()
      ortho.left = -ortho.top * persp.aspect; ortho.right = ortho.top * persp.aspect
      ortho.updateProjectionMatrix()
      lineMat.resolution.set(w, h)
      st0.viewH = h
      st0.sizeLabels?.()
    }
    resize()
    // перспектива <-> аксонометрия: тот же вид, тот же масштаб у точки, вокруг которой вращаем
    const setProj = kind => {
      const next = kind === 'ortho' ? ortho : persp
      if (next === camera) return
      const dir = camera.position.clone().sub(controls.target)
      const dist = dir.length() || 1
      if (next === ortho) {
        ortho.top = dist * tanHalf; ortho.bottom = -ortho.top; ortho.zoom = 1
        ortho.position.copy(camera.position)
      } else persp.position.copy(controls.target).add(dir.multiplyScalar((ortho.top / ortho.zoom / tanHalf) / dist))
      next.quaternion.copy(camera.quaternion)
      camera = next; st0.camera = next; controls.object = next
      resize(); controls.update()
    }
    // после правки модель собирается заново — камера остаётся там, где была
    if (camRef.current) {
      const cr = camRef.current
      if (cr.ortho) { camera = ortho; st0.camera = ortho; controls.object = ortho; ortho.top = cr.top; ortho.bottom = -cr.top; ortho.zoom = cr.zoom; resize() }
      camera.position.copy(cr.pos); controls.target.copy(cr.target); controls.update()
    }
    else resetView()
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

    let raf = 0, last = performance.now(), lastZoom = 0, cubeTr = ''
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
      if (camera === ortho && ortho.zoom !== lastZoom) { lastZoom = ortho.zoom; st0.sizeLabels?.() }
      // куб видов повёрнут так же, как модель (у CSS ось Y смотрит вниз)
      const cube = cubeRef.current
      if (cube) {
        const e = camera.matrixWorldInverse.elements, f = v => Math.round(v * 1e4) / 1e4
        const tr = `matrix3d(${f(e[0])},${f(-e[1])},${f(e[2])},0,${f(-e[4])},${f(e[5])},${f(-e[6])},0,${f(e[8])},${f(-e[9])},${f(e[10])},0,0,0,0,1)`
        if (tr !== cubeTr) { cubeTr = tr; cube.style.transform = tr }
      }
      renderer.render(scene, camera)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    // тап по детали — показать, что это; двойной тап по двери/ящику — открыть или закрыть;
    // долгое нажатие — меню детали (оставить только её / блок / корпус, выбрать несколько, править)
    const ray = new THREE.Raycaster()
    const hitAt = (e, list) => {
      const r = renderer.domElement.getBoundingClientRect()
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera)
      root.updateMatrixWorld(true)
      return ray.intersectObjects(list || meshes.filter(x => x.__shown), false)[0] || null
    }
    let down = null, lastTap = { g: 0, t: 0 }, holdTimer = 0, pointers = 0
    // перемещение блока: тянем выбранное пальцем — оно едет только вдоль свободной оси
    let drag = null
    const endDrag = () => { if (!drag) return; drag = null; controls.enabled = true; liveRef.current.moveEnd?.() }
    const onDown = e => {
      pointers++
      clearTimeout(holdTimer)
      if (pointers > 1) { down = null; endDrag(); return }
      if (liveRef.current.moveSet) {
        const hit = hitAt(e)
        if (hit && liveRef.current.moveSet.has(hit.object.__pid)) {
          const mb = liveRef.current.moveBegin()
          // сколько пикселей на экране занимает сдвиг на 100 мм вдоль оси
          const r = renderer.domElement.getBoundingClientRect()
          const p0 = hit.point.clone().project(camera)
          const p1 = hit.point.clone().add(new THREE.Vector3(mb.axis === 0 ? 100 : 0, mb.axis === 1 ? 100 : 0, mb.axis === 2 ? 100 : 0)).project(camera)
          const vx = (p1.x - p0.x) * r.width / 2, vy = -(p1.y - p0.y) * r.height / 2
          if (vx * vx + vy * vy < 16) { liveRef.current.say?.('С этого вида ось движения смотрит на вас — поверните модель или выберите другой вид'); return }
          drag = { x: e.clientX, y: e.clientY, vx, vy, len2: vx * vx + vy * vy }
          controls.enabled = false
          down = null
          return
        }
      }
      down = { x: e.clientX, y: e.clientY, t: Date.now(), held: false }
      const d0 = down
      holdTimer = setTimeout(() => {
        if (down !== d0) return
        const hit = hitAt(e)
        if (!hit) return
        d0.held = true
        liveRef.current.onHold?.(hit)
      }, HOLD_MS)
    }
    const onMove = e => {
      if (drag) { liveRef.current.moveTo?.((((e.clientX - drag.x) * drag.vx + (e.clientY - drag.y) * drag.vy) / drag.len2) * 100); return }
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) { clearTimeout(holdTimer); down = null }
    }
    const onCancel = () => { pointers = Math.max(0, pointers - 1); clearTimeout(holdTimer); down = null; endDrag() }
    const onUp = e => {
      pointers = Math.max(0, pointers - 1)
      clearTimeout(holdTimer)
      if (drag) { endDrag(); return }
      const d0 = down
      down = null
      if (!d0 || d0.held || Math.hypot(e.clientX - d0.x, e.clientY - d0.y) > 8 || Date.now() - d0.t > 400) return
      // в режиме присадки сначала — тап по пятну стыка
      const jm = stateRef.current?.jointMeshes
      if (jm?.length) {
        const jh = hitAt(e, jm)
        if (jh) { liveRef.current.onJointTap?.(jh.object.__jkey); return }
      }
      const hit = hitAt(e)
      const g = hit ? hit.object.__anim : 0
      const now = Date.now()
      if (g && lastTap.g === g && now - lastTap.t < 500 && !liveRef.current.tool) {
        const an = anims.get(g)
        an.target = an.target ? 0 : 1
        lastTap = { g: 0, t: 0 }
        return
      }
      lastTap = { g, t: now }
      liveRef.current.onTap?.(hit, !!g)
    }
    const el = renderer.domElement
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onCancel)
    el.addEventListener('contextmenu', e => e.preventDefault())

    // торец виден с текущего вида: смотрит на зрителя и ничем не заслонён
    const vDir = new THREE.Vector3(), vO = new THREE.Vector3()
    const faceVisible = (face, a, b, T) => {
      vDir.copy(camera.position).sub(controls.target).normalize()
      if (face.normal[0] * vDir.x + face.normal[1] * vDir.y + face.normal[2] * vDir.z < 0.7) return false
      root.updateMatrixWorld(true)
      const shown = meshes.filter(x => x.__shown)
      let free = 0
      for (const t of [0.2, 0.5, 0.8]) {
        vO.set(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)
        vO.x += face.up[0] * T / 2 + face.normal[0] * 0.6; vO.y += face.up[1] * T / 2 + face.normal[1] * 0.6; vO.z += face.up[2] * T / 2 + face.normal[2] * 0.6
        ray.set(vO, vDir)
        if (!ray.intersectObjects(shown, false).length) free++
      }
      return free >= 2
    }

    stateRef.current = Object.assign(st0, {
      materials, meshes, lines, lineMat, hwMat, bandMat, roomMat, darkMat, hlMat, selMat, all, resetView, fit, recs, root, faceVisible, setProj,
      labels: [], jointMeshes: [], jointGroup: null,
      openAll: (open) => anims.forEach(st => { st.target = open ? 1 : 0 }),
      reskin: () => materials.forEach(skin),
    })
    return () => {
      camRef.current = { pos: camera.position.clone(), target: controls.target.clone(), ortho: camera === ortho, top: ortho.top, zoom: ortho.zoom }
      clearTimeout(holdTimer)
      cancelAnimationFrame(raf)
      ro?.disconnect()
      controls.dispose()
      meshes.forEach(x => { if (x.__kind === 'panel') x.geometry.dispose() })
      lines.forEach(x => x.geometry.dispose())
      materials.forEach(x => { x.map?.dispose(); x.dispose() })
      extraGeos.forEach(x => x.dispose())
      darkMat.dispose(); grooveMat.dispose(); decorMat.dispose(); hwMat.dispose(); bandMat.dispose(); roomMat.dispose(); lineMat.dispose(); hlMat.dispose(); selMat.dispose()
      st0.labels?.forEach(sp => { sp.material.map?.dispose(); sp.material.dispose() })
      st0.jointMeshes?.forEach(m => { m.geometry.dispose(); m.material.dispose() })
      renderer.dispose()
      renderer.domElement.remove()
      stateRef.current = null
    }
  }, [model, parts])

  useEffect(() => { stateRef.current?.setProj(view.proj === 'ortho' ? 'ortho' : 'persp') }, [view.proj, model])

  // ─── Данные для правки и выбора ───────────────────────────────────────────
  const byPid = useMemo(() => new Map(parts.map(p => [p.pid, p])), [parts])
  const tree = useMemo(() => blockTree(parts), [parts])
  const hwLinks = useMemo(() => hardwareLinks(model), [model])
  // что едет при перемещении: выбранные детали и фурнитура их блоков
  const moveSet = useMemo(() => (tool === 'move' && sel.size ? movingSet(sel, parts, hwLinks) : null), [tool, sel, parts, hwLinks])
  const boxes = useMemo(() => (tool === 'move' ? parts.filter(p => p.outline.length > 2).map(p => ({ pid: p.pid, p, ...partBox(p) })) : []), [tool, parts])
  const editParts = useMemo(() => orderParts(details), [details])           // детали заказа по штукам
  const editByPid = useMemo(() => new Map(editParts.map(p => [p.pid, p])), [editParts])
  const joints = useMemo(() => (tool === 'drill' ? findJoints(editParts) : []), [tool, editParts])
  const doneJoints = useMemo(() => (tool === 'drill' ? jointsDone(details, editParts, joints) : new Set()), [tool, details, editParts, joints])
  const explodeRef = useRef(0)
  const fitNext = useRef(false)                                              // вписать в экран после смены показанного
  const groupsRef = useRef(null)                                             // корпуса — считаются при первом долгом нажатии
  useEffect(() => { groupsRef.current = null }, [editParts])
  const groupOf = pid => {
    if (!groupsRef.current) groupsRef.current = partGroups(editParts, findJoints(editParts, 2.5))
    const g = groupsRef.current.get(pid)
    if (g == null) return []
    return [...groupsRef.current].filter(([, k]) => k === g).map(([q]) => q)
  }
  const pidShown = pid => {
    const p = byPid.get(pid)
    return !hiddenPids.has(pid) && !(p?.material && hidden.has(p.material)) && (scope === 'all' || !p || p.inOrder)
  }
  // отмечены детали — работаем только с ними: стыки между отмеченными (у одной отмеченной — все её стыки)
  const inScope = pid => !sel.size || sel.has(pid)
  const jointInScope = j => !sel.size || (sel.size === 1 ? sel.has(j.a) || sel.has(j.b) : sel.has(j.a) && sel.has(j.b))
  const shownJoints = joints.filter(j => pidShown(j.a) && pidShown(j.b) && jointInScope(j))
  const jointOn = j => j.ok && (j.thin ? jOn.has(j.key) : !jOff.has(j.key))
  const activeJoints = shownJoints.filter(jointOn)

  // режим показа и состав (вся модель / только заказ)
  useEffect(() => {
    const st = stateRef.current
    if (!st) return
    const xray = mode === 'xray', wire = mode === 'wire'
    st.materials.forEach(m => {
      const base = m.userData.baseOpacity ?? 1
      m.transparent = xray || base < 1; m.opacity = xray ? Math.min(base, view.xray) : base; m.depthWrite = !(xray || base < 1); m.needsUpdate = true
    })
    st.bandMat.color.set(view.bandColor); st.bandMat.opacity = tool === 'edge' ? Math.max(view.bandOp, 0.85) : view.bandOp
    st.hwMat.wireframe = wire
    st.selMat.transparent = xray; st.selMat.opacity = xray ? 0.5 : 1; st.selMat.depthWrite = !xray; st.selMat.needsUpdate = true
    const vis = o => {
      // __shown — деталь показана (не потушена); в каркасе сама панель не рисуется, но остаётся «показанной»
      o.__shown = (scope === 'all' || !o.__ctx) && !(o.__mat && hidden.has(o.__mat)) && !(o.__pid && hiddenPids.has(o.__pid))
      o.visible = o.__shown && !(wire && o.__kind === 'panel') && (o.__kind !== 'band' || tool === 'edge' || (wire && view.bandOn))
    }
    st.all.forEach(vis)
    st.lineMat.color.set(wire ? view.wireColor : 0x3a3a36)
    st.lineMat.linewidth = wire ? view.wireW : 1
    st.lineMat.opacity = wire ? view.wireOp : 1
    st.lineMat.needsUpdate = true
    // подсветка присадки: лицевая — зелёным, изнанка — фиолетовым (одновременно только одна)
    st.hlMat.color.set(hl === 'back' ? 0x9c27b0 : 0x00a651)
    st.all.forEach(o => { if (o.__kind === 'drill') o.material = hl && o.__side === hl ? st.hlMat : st.darkMat })
    if (fitNext.current) { fitNext.current = false; st.fit() }
  }, [mode, scope, model, view, hidden, hl, hiddenPids, tool])

  // подписи на деталях: позиция / обозначение / наименование — что выбрал пользователь
  useEffect(() => {
    const st = stateRef.current
    if (!st) return
    st.labels.forEach(sp => { sp.parent?.remove(sp); sp.material.map?.dispose(); sp.material.dispose() })
    st.labels = []
    st.sizeLabels = () => {
      const cam = st.camera                                                                 // 22 px высотой на экране
      const k = cam.isOrthographicCamera ? (22 * (cam.top - cam.bottom)) / cam.zoom / (st.viewH || 300) : (22 * 2 * Math.tan((cam.fov * Math.PI) / 360)) / (st.viewH || 300)
      st.labels.forEach(sp => sp.scale.set(k * sp.__aspect, k, 1))
    }
    if (view.label === 'block') {
      // подписи блоков (изделий): одна на блок, в середине его деталей
      const groups = new Map()
      for (const [pid, rec] of st.recs) {
        const name = rec.p.hardware ? '' : rec.p.product || String(rec.p.block || '').split(' / ')[0]
        if (!name) continue
        if (!groups.has(name)) groups.set(name, { box: new THREE.Box3(), pids: [] })
        const g = groups.get(name)
        g.box.expandByPoint(rec.center); g.pids.push(pid)
      }
      for (const [name, g] of groups) {
        const { tex, aspect } = labelTexture(name)
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, sizeAttenuation: false, transparent: true }))
        sp.position.copy(g.box.getCenter(new THREE.Vector3()))
        sp.renderOrder = 20
        sp.__aspect = aspect; sp.__pids = g.pids; sp.__kind = 'label'; sp.__shown = true
        st.root.add(sp)
        st.labels.push(sp)
      }
      st.sizeLabels()
    } else if (view.label && view.label !== 'none') {
      const cache = new Map()
      for (const [pid, rec] of st.recs) {
        if (rec.p.hardware) continue
        const text = labelText(rec.p, view.label)
        if (!text) continue
        if (!cache.has(text)) cache.set(text, labelTexture(text))
        const { tex, aspect } = cache.get(text)
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, sizeAttenuation: false, transparent: true }))
        sp.position.copy(rec.center)
        sp.renderOrder = 20
        sp.__aspect = aspect; sp.__pid = pid; sp.__kind = 'label'; sp.__ctx = !rec.p.inOrder; sp.__mat = rec.p.material || ''; sp.__base = rec.center.clone(); sp.__shown = true
        const mesh = st.meshes.find(m => m.__pid === pid)
        ;(mesh?.parent || st.root).add(sp)
        st.labels.push(sp)
      }
      st.sizeLabels()
    }
    // видимость и взрыв применяются следующими эффектами
  }, [view.label, model])

  // выбранные детали — синим
  useEffect(() => {
    const st = stateRef.current
    if (!st) return
    st.meshes.forEach(o => { o.material = sel.has(o.__pid) ? st.selMat : o.__mat0 })
  }, [sel, model])

  // подписи живут отдельно от сцены: видимость для них — после того, как они созданы
  useEffect(() => {
    const st = stateRef.current
    if (!st) return
    st.labels.forEach(o => {
      o.visible = o.__shown = o.__pids
        ? o.__pids.some(q => { const p = st.recs.get(q)?.p; return !hiddenPids.has(q) && !(p?.material && hidden.has(p.material)) && (scope === 'all' || p?.inOrder) })
        : (scope === 'all' || !o.__ctx) && !(o.__mat && hidden.has(o.__mat)) && !hiddenPids.has(o.__pid)
    })
  }, [view.label, model, scope, hidden, hiddenPids])

  // взрыв-схема: каждая деталь отъезжает от центра показанного на долю своего расстояния до него.
  // Выпуклые детали, которые не пересекались, при таком разъезде пересечься не могут.
  useEffect(() => {
    const st = stateRef.current
    if (!st) return
    const box = new THREE.Box3()
    for (const [pid, rec] of st.recs) if (!hiddenPids.has(pid) && !(rec.p.material && hidden.has(rec.p.material)) && (scope === 'all' || rec.p.inOrder)) box.expandByPoint(rec.center)
    const c = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3())
    const k = explode * 1.6
    const move = o => {
      const rec = o.__pid ? st.recs.get(o.__pid) : null
      if (!rec || !o.__base) return
      o.position.copy(o.__base)
      if (k > 0) o.position.addScaledVector(rec.center.clone().sub(c), k)
      if (moveSet?.has(o.__pid)) { o.position.x += moveVec[0]; o.position.y += moveVec[1]; o.position.z += moveVec[2] }
    }
    st.all.forEach(move)
    st.labels.forEach(move)
    // раздвинутая модель должна оставаться в кадре
    if (explodeRef.current !== explode) { explodeRef.current = explode; st.fit() }
  }, [explode, model, hiddenPids, hidden, scope, view.label, moveSet, moveVec])

  // пятна стыков (режим «Присадка»): оранжевые — будет присадка, серые — выключены, зелёные — уже стоит
  useEffect(() => {
    const st = stateRef.current
    if (!st) return
    st.jointMeshes.forEach(m => { m.parent?.remove(m); m.geometry.dispose(); m.material.dispose() })
    st.jointMeshes = []
    if (tool !== 'drill') return
    for (const j of shownJoints) {
      const g = new THREE.BufferGeometry()
      const q = j.quad
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([...q[0], ...q[1], ...q[2], ...q[0], ...q[2], ...q[3]]), 3))
      const on = jointOn(j), done = doneJoints.has(j.key)
      const color = !j.ok ? 0xb0b0b0 : on ? (done ? 0x00a651 : 0xff6a00) : (done ? 0x7fbf9a : 0x8a8a8a)
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: on ? 0.9 : 0.4, side: THREE.DoubleSide, depthTest: false, depthWrite: false }))
      m.renderOrder = 10
      m.__jkey = j.key
      st.root.add(m)
      st.jointMeshes.push(m)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, joints, doneJoints, jOff, jOn, hiddenPids, hidden, scope, model, sel])

  const [opened, setOpened] = useState(false)

  // свои текстуры материалов
  const uid = user?.id || null
  useEffect(() => {
    let alive = true
    if (sharedTextures) {          // просмотр по ссылке: картинки материалов владельца заказа
      Promise.resolve().then(() => { if (!alive) return; texRef.current = sharedTextures; setTex(sharedTextures); stateRef.current?.reskin() })
      return () => { alive = false }
    }
    loadTextures(user).then(({ map, cloud }) => {
      if (!alive) return
      texRef.current = map; setTex(map); setTexCloud(cloud)
      stateRef.current?.reskin()
    })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, sharedTextures])
  const isRoom = n => /^(стена|стены|пол|потолок)/i.test(n)
  const allMats = useMemo(() => { const m = new Map(); parts.forEach(p => { if (p.material) m.set(p.material, (m.get(p.material) || 0) + 1) }); return [...m.entries()] }, [parts])
  const matNames = useMemo(() => allMats.map(m => m[0]), [allMats])
  const hasBands = useMemo(() => parts.some(p => p.bands?.length), [parts])
  const hasSides = useMemo(() => parts.some(p => p.drills?.some(d => d.side)), [parts])
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
  // ─── Показ: оставить только выбранное, виды ───────────────────────────────
  const everyPid = () => [...(stateRef.current?.recs.keys() || [])]
  const isolate = pids => {
    const keep = new Set(pids)
    fitNext.current = true
    setHiddenPids(new Set(everyPid().filter(q => !keep.has(q))))
    setMenu(null); setMulti(false); setSel(new Set()); setPicked(null)
  }
  const showAll = () => { fitNext.current = true; setHiddenPids(new Set()); setMenu(null) }
  // ─── Деталь в модели (focus = { di, des }): сначала видна только она, затем — вверх по структуре:
  // блок → изделие → вся модель. Сама деталь всё время подсвечена, чтобы её было видно среди остальных.
  const focusPids = useMemo(() => {
    if (!focus) return []
    const mine = parts.filter(p => p.inOrder)
    const byDes = focus.des ? mine.filter(p => p.des === focus.des) : []
    return (byDes.length ? byDes : mine.filter(p => focus.di != null && p.di === Number(focus.di))).map(p => p.pid)
  }, [parts, focus?.di, focus?.des])                             // eslint-disable-line react-hooks/exhaustive-deps
  const levels = useMemo(() => {
    if (!focusPids.length) return []
    const p = parts.find(q => q.pid === focusPids[0]), out = [{ label: 'Деталь', pids: focusPids }]
    const add = (label, pids) => { if (pids.length > out[out.length - 1].pids.length) out.push({ label, pids }) }
    if (p.block) add(`Блок «${p.block}»`, parts.filter(q => q.block === p.block || String(q.block || '').startsWith(p.block + ' / ')).map(q => q.pid))
    if (p.product) add(`Изделие «${p.product}»`, parts.filter(q => q.product === p.product).map(q => q.pid))
    out.push({ label: 'Вся модель', pids: null })
    return out
  }, [parts, focusPids])
  const [level, setLevel] = useState(0)
  const goLevel = i => {
    const L = levels[i]
    if (!L) return
    const all = everyPid().length ? everyPid() : parts.map(q => q.pid)
    const keep = L.pids ? new Set(L.pids) : null
    fitNext.current = true
    setLevel(i); setHiddenPids(new Set(keep ? all.filter(q => !keep.has(q)) : [])); setSel(new Set(focusPids)); setMenu(null); setMulti(false)
    // поднялись от детали к блоку — детали чуть раздвинуты (взрыв 20 %), чтобы было видно соединения; сама деталь — без взрыва
    if (i === 0) setExplode(0); else if (level === 0) { setExplode(0.2); if (mode === 'solid') setMode('xray') }
  }
  useEffect(() => { if (levels.length) goLevel(0) }, [focusPids.join('|')])   // eslint-disable-line react-hooks/exhaustive-deps
  const hidePids = pids => { setHiddenPids(h => new Set([...h, ...pids])); setSel(new Set()); setPicked(null); setMenu(null); setMulti(false) }
  const shownCount = everyPid().filter(q => !hiddenPids.has(q)).length
  const lookFrom = dir => { stateRef.current?.fit(dir); setShowViews(false) }

  // ─── Правка заказа из 3D ──────────────────────────────────────────────────
  const change = (next, nextScene) => {
    historyRef.current.push({ details, scene: savedScene })
    if (historyRef.current.length > 30) historyRef.current.shift()
    setUndoN(historyRef.current.length)
    if (nextScene !== undefined && nextScene !== savedScene) onSceneChange?.(nextScene)
    onDetailsChange(next)
  }
  const undo = () => {
    const prev = historyRef.current.pop()
    setUndoN(historyRef.current.length)
    if (!prev) return
    if (prev.scene !== savedScene) onSceneChange?.(prev.scene)
    onDetailsChange(prev.details)
  }
  const modeBefore = useRef('')
  const setTool = t => {
    const next = tool === t ? '' : t
    if (next) { setExplode(0); setShowExplode(false); setMulti(false); setShowViews(false); setShowShare(false); setPicked(null); setMenu(null) }   // отмеченные детали остаются: инструмент работает по ним
    // двигаем при закрытых дверях и ящиках; несохранённый сдвиг при выходе сбрасывается
    if (next === 'move') { stateRef.current?.openAll(false); setOpened(false) }
    setMoveVec([0, 0, 0])
    // стыки и отверстия внутри корпуса видны только «на просвет»
    if (next === 'drill' && mode === 'solid') { modeBefore.current = 'solid'; setMode('xray') }
    if (tool === 'drill' && next !== 'drill' && modeBefore.current) { setMode(modeBefore.current); modeBefore.current = '' }
    setToolState(next)
  }
  const edgeList = useMemo(() => {
    const names = new Set(edgeNames || [])
    for (const d of details || []) {
      const e = d.edges || { top: d.edge_top, right: d.edge_right, bottom: d.edge_bottom, left: d.edge_left }
      for (const v of Object.values(e)) if (v && v !== 'default' && v !== 'false' && v !== true) names.add(String(v))
    }
    return [...names]
  }, [details, edgeNames])
  // толщина кромки обязательна: без неё не посчитать подрезку и размер в раскрой
  const edgeType = edgeTypes?.[edgeValue] || null
  const numOf = v => Number(String(v ?? '').replace(',', '.')) || 0
  const patchEdgeType = p => onEdgeTypesChange?.({ ...(edgeTypes || {}), [edgeValue]: { t: '', trim: false, joint: 0, ...(edgeTypes?.[edgeValue] || {}), ...p } })
  const edgeReady = () => {
    if (!edgeTypes || !onEdgeTypesChange || numOf(edgeType?.t) > 0) return true
    say('Укажите толщину кромки — без неё кромка не ставится')
    return false
  }
  const tapEdge = hit => {
    if (!hit) return
    const p = hit.object.userData
    if (!p?.inOrder || !(p.di >= 0)) { say('Кромка ставится только на детали заказа'); return }
    const n = hit.face?.normal
    if (!n || Math.abs(n.z) > 0.5) { say('Это пласть. Нажмите на торец детали'); return }
    const local = hit.object.worldToLocal(hit.point.clone())
    const t = edgeTargetAt(details[p.di], p.ii, [local.x, local.y])
    if (!t) return
    const on = t.hole != null ? !!contourOf(details[p.di])?.holes?.[t.hole]?.edge : !!editByPid.get(p.pid)?.segs.find(x => x.i === t.seg)?.on
    if (!on && !edgeReady()) return
    change(applyEdgeOps(details, [{ pid: p.pid, ...t, value: on ? null : edgeValue }]))
  }
  // «Закромить видимые»: торцы показанных деталей, которые смотрят на зрителя и ничем не закрыты
  const bandVisible = value => {
    const st = stateRef.current
    if (!st) return
    if (value && !edgeReady()) return
    const ops = []
    for (const ep of editParts) {
      if (!pidShown(ep.pid) || !inScope(ep.pid)) continue
      for (const sg of ep.segs) {
        if (sg.arc || (value ? sg.on : !sg.on)) continue
        const face = segFace(ep, sg)
        if (st.faceVisible(face, face.quad[0], face.quad[1], ep.f.T)) ops.push({ pid: ep.pid, seg: sg.i, value })
      }
    }
    if (!ops.length) { say((value ? 'С этого вида нет открытых торцов без кромки' : 'С этого вида нет торцов с кромкой') + (sel.size ? ' у отмеченных деталей' : '')); return }
    change(applyEdgeOps(details, ops))
    say(`${value ? 'Закромлено торцов' : 'Кромка снята с торцов'}: ${ops.length}`)
  }

  // присадка: база фурнитуры пользователя + встроенные схемы
  const uidForSchemes = user?.id || null
  useEffect(() => {
    if (tool !== 'drill' || !uidForSchemes) return
    let alive = true
    loadHardwarePresets(uidForSchemes).then(list => { if (alive) setSchemes(list.filter(h => schemeFace(h) || schemeEdge(h))) })
    return () => { alive = false }
  }, [tool, uidForSchemes])
  const allSchemes = [...schemes, ...BUILTIN_SCHEMES]
  const scheme = allSchemes.find(x => String(x.id) === schemeId) || schemes.find(h => schemeFace(h) && schemeEdge(h)) || BUILTIN_SCHEMES[0]
  const placeDrill = () => {
    if (!activeJoints.length) { say('Нет выбранных стыков — нажмите на пятно стыка, чтобы включить его'); return }
    const r = applyJoints(details, activeJoints, scheme)
    change(r.details)
    say(`Присадка: стыков ${r.joints}, отверстий ${r.holes}` + (r.flipped ? ` · перевёрнуто лицом вверх: ${r.flipped}` : '') + (r.unmatched ? ` · на ${r.unmatched} стык. отверстия не сошлись — проверьте схему` : ''))
  }
  const removeDrill = () => {
    const list = activeJoints.filter(j => doneJoints.has(j.key))
    if (!list.length) { say('На выбранных стыках нет присадки, поставленной в 3D'); return }
    const r = clearJoints(details, list)
    change(r.details)
    say(`Присадка убрана со стыков: ${r.joints}`)
  }
  // новый крепёж — прямо из 3D, в ту же базу фурнитуры, что и в редакторе контура
  const blankScheme = () => ({ name: '', faceD: 7, faceDepth: 16, through: true, edgeD: 5, edgeDepth: 40, offset: 50, mirror: true, pair: false, pairFaceD: 8, pairFaceDepth: 12, pairEdgeD: 8, pairEdgeDepth: 20, pairGap: 32 })
  const saveScheme = async () => {
    const f = newScheme, n = k => numOf(f[k])
    const name = String(f.name || '').trim()
    if (!name) { say('Назовите крепёж'); return }
    if (!(n('faceD') > 0) || !(n('edgeD') > 0) || !(n('edgeDepth') > 0) || (!f.through && !(n('faceDepth') > 0))) { say('Заполните диаметры и глубины отверстий'); return }
    const pairF = f.pair ? { pairEnabled: true, pairD: n('pairFaceD'), pairDepth: n('pairFaceDepth'), pairAxis: 'x', pairGap: n('pairGap') || 32, pairMirrorSwap: false } : {}
    const pairE = f.pair ? { pairEnabled: true, pairD: n('pairEdgeD'), pairDepth: n('pairEdgeDepth'), pairGap: n('pairGap') || 32, pairMirrorSwap: false } : {}
    const spec = {
      face: { d: n('faceD'), depth: f.through ? 100 : n('faceDepth'), faceSide: 'front', sides: ['left'], offsets: { left: n('offset') }, mirrorX: !!f.mirror, ...pairF },
      edge: { d: n('edgeD'), depth: n('edgeDepth'), edgeSide: 'left', alongFrom: 'start', offsetAlong: n('offset'), mirrorY: !!f.mirror, ...pairE },
    }
    const saved = await saveHardwarePreset(user?.id, name, spec)
    const item = saved || { id: 'local:' + Date.now(), name, ...spec }
    setSchemes(list => [...list.filter(x => String(x.id) !== String(item.id) && x.name.toLowerCase() !== name.toLowerCase()), item])
    setSchemeId(String(item.id)); setNewScheme(null)
    say(saved ? `Крепёж «${name}» записан в базу фурнитуры` : `Крепёж «${name}» добавлен только на этот сеанс — в базу записать не удалось`)
  }
  const setAllJoints = on => {
    if (on) { setJOff(new Set()); setJOn(new Set(shownJoints.filter(j => j.ok && j.thin).map(j => j.key))) }
    else { setJOn(new Set()); setJOff(new Set(shownJoints.filter(j => j.ok && !j.thin).map(j => j.key))) }
  }

  // правка одной детали в редакторе контура (паз, вырез, своя присадка…)
  const openEditor = pid => {
    const p = byPid.get(pid)
    const d = p && p.di >= 0 ? details[p.di] : null
    setMenu(null)
    if (!d) return
    setEditing({ di: p.di, draft: { w: d.w, h: d.h, name: d.name, contour: contourOf(d), edges: { ...(d.edges || {}) } } })
  }
  const closeEditor = () => {
    const ed = editing
    setEditing(null)
    if (!ed) return
    const d = details[ed.di]
    if (JSON.stringify([contourOf(d), d.edges]) === JSON.stringify([ed.draft.contour, ed.draft.edges])) return
    change(details.map((x, i) => (i === ed.di ? { ...x, contour: ed.draft.contour, edges: ed.draft.edges } : x)))
  }

  // ─── Структура и перемещение блоков ───────────────────────────────────────
  const toggleSel = pids => { setPicked(null); setSel(prev => { const n = new Set(prev); if (pids.every(q => n.has(q))) pids.forEach(q => n.delete(q)); else pids.forEach(q => n.add(q)); return n }) }
  const toggleHide = pids => setHiddenPids(prev => { const n = new Set(prev); if (pids.every(q => n.has(q))) pids.forEach(q => n.delete(q)); else pids.forEach(q => n.add(q)); return n })
  const toggleNode = key => setOpenNodes(prev => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n })
  const startMove = pids => {
    const list = pids ? [...pids] : [...sel]
    setMenu(null)
    if (!list.length) { setShowTree(true); say('Отметьте в структуре блок или детали, которые нужно подвинуть'); return }
    if (pids) setSel(new Set(list))
    setShowTree(false)
    if (tool !== 'move') setTool('move')
  }
  // запретные интервалы сдвига вдоль оси — от текущего (ещё не применённого) положения
  const limitsFor = axis => {
    if (!moveSet) return []
    const sh = b => ({ min: b.min.map((v, k) => v + moveVec[k]), max: b.max.map((v, k) => v + moveVec[k]) })
    return sweepLimits(boxes.filter(b => moveSet.has(b.pid)).map(sh), boxes.filter(b => !moveSet.has(b.pid)), axis)
  }
  const stopName = s => [s.p.des, s.p.name].filter(Boolean).join(' ') || 'деталь'
  const nudge = step => {
    const r = clampMove(limitsFor(moveAxis), 0, step)
    setMoveVec(v => v.map((x, k) => (k === moveAxis ? Math.round((x + r.t) * 10) / 10 : x)))
    if (r.stop) say(`Упор — вплотную к «${stopName(r.stop)}»`)
  }
  const applyMove = () => {
    if (!moveSet || !moveVec.some(v => v)) { setTool('move'); return }
    const mv = { parts: new Set(), ids: new Set(), sceneParts: new Set(), extras: new Set(), hardware: new Set() }
    for (const pid of moveSet) {
      const p = byPid.get(pid)
      if (!p) continue
      if (p.di >= 0) mv.parts.add(`${p.di}:${p.ii}`); else if (p.si != null) mv.sceneParts.add(`${p.si}:${p.ii}`); else if (p.xi != null) mv.extras.add(p.xi)
      if (p.id != null) mv.ids.add(p.id)
    }
    for (const l of hwLinks) if (moveSet.has(l.pid)) mv.hardware.add(l.hi)
    const r = moveModel(details, savedScene, mv, moveVec)
    change(r.details, r.scene)
    say(`Сдвинуто: ${AXES.map(([, n], k) => (moveVec[k] ? `${n} ${moveVec[k] > 0 ? '+' : ''}${moveVec[k]}` : '')).filter(Boolean).join(' · ')} мм. Не забудьте сохранить заказ`)
    setToolState(''); setMoveVec([0, 0, 0])
  }

  // что делать по тапу и долгому нажатию — сцена спрашивает это в момент события
  liveRef.current = {
    tool, say,
    moveSet,
    moveBegin: () => { dragRef.current = { axis: moveAxis, limits: limitsFor(moveAxis), start: moveVec[moveAxis], cur: 0, stop: null }; return { axis: moveAxis } },
    moveTo: t => {
      const dg = dragRef.current
      if (!dg) return
      const r = clampMove(dg.limits, dg.cur, Math.round(t * 10) / 10)
      dg.cur = r.t
      const val = Math.round((dg.start + r.t) * 10) / 10
      setMoveVec(v => (v[dg.axis] === val ? v : v.map((x, k) => (k === dg.axis ? val : x))))
      if (r.stop && r.stop !== dg.stop) { say(`Упор — вплотную к «${stopName(r.stop)}»`); try { navigator.vibrate?.(8) } catch { /* без вибрации */ } }
      dg.stop = r.stop
    },
    moveEnd: () => { dragRef.current = null },
    onTap: (hit, canOpen) => {
      setMenu(null); setShowViews(false)
      if (tool === 'move') return
      if (tool === 'edge') { tapEdge(hit); return }
      const p = hit?.object.userData
      if (tool === 'drill') { setPicked(p?.pid ? { ...p } : null); return }      // отмеченные детали — область работы, тап их не сбрасывает
      if (multi) {
        if (!p?.pid) return
        setSel(prev => { const n = new Set(prev); if (n.has(p.pid)) n.delete(p.pid); else n.add(p.pid); return n })
        return
      }
      if (p?.pid) { setSel(new Set([p.pid])); setPicked({ ...p, canOpen: canOpen && !tool }) } else { setSel(new Set()); setPicked(null) }
    },
    onHold: hit => {
      const p = hit.object.userData
      if (!p?.pid || tool === 'move') return
      try { navigator.vibrate?.(12) } catch { /* без вибрации */ }
      if (!sel.has(p.pid)) { setSel(multi ? new Set([...sel, p.pid]) : new Set([p.pid])); setPicked({ ...p }) }
      setMenu({ pid: p.pid })
    },
    onJointTap: key => {
      const j = joints.find(x => x.key === key)
      if (!j) return
      if (!j.ok) { say('Этот стык пропущен: ' + j.why); return }
      const flip = prev => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n }
      if (j.thin) setJOn(flip); else setJOff(flip)
    },
  }

  const chip = active => ({
    flex: 1, padding: '7px 4px', borderRadius: 20, border: 'none', fontSize: 12, cursor: 'pointer',
    background: active ? 'var(--blue)' : 'var(--bg2)', color: active ? 'white' : 'var(--text-muted)',
  })
  const smallBtn = { padding: '4px 9px', flex: 'none', borderRadius: 20, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)', fontSize: 12, whiteSpace: 'nowrap' }
  const toolChip = active => ({ ...chip(active), flex: 'none', padding: '4px 10px', whiteSpace: 'nowrap' })
  const wideBtn = primary => ({ flex: 1, padding: '9px 8px', borderRadius: 'var(--radius)', fontSize: 13, cursor: 'pointer', border: primary ? 'none' : '0.5px solid var(--border-md)', background: primary ? 'var(--blue)' : 'transparent', color: primary ? 'white' : 'var(--text-muted)' })
  const sheet = { position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 3, background: 'var(--bg)', borderTop: '0.5px solid var(--border-md)', padding: '10px 14px', boxShadow: '0 -4px 16px rgba(0,0,0,0.08)' }
  const dock = { background: 'var(--bg)', borderTop: '0.5px solid var(--border-md)', padding: '10px 14px' }      // панель инструмента под моделью
  const menuBtn = { display: 'block', width: '100%', textAlign: 'left', padding: '11px 4px', background: 'none', border: 'none', borderTop: '0.5px solid var(--border)', fontSize: 14, color: 'var(--text)', cursor: 'pointer' }

  // меню долгого нажатия
  const menuPart = menu ? byPid.get(menu.pid) || stateRef.current?.recs.get(menu.pid)?.p : null
  const menuGroup = menu && menuPart?.inOrder ? groupOf(menu.pid) : []
  const menuBlock = menuPart?.block ? parts.filter(q => q.block === menuPart.block || q.block.startsWith(menuPart.block + ' / ')).map(q => q.pid) : []
  const menuProduct = menuPart?.product && menuPart.block !== menuPart.product ? parts.filter(q => q.product === menuPart.product).map(q => q.pid) : []

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 960, background: 'var(--bg2)', display: 'flex', flexDirection: 'column' }}>
      {/* шапка и панели — в сжатом виде: на телефоне модели нужно как можно больше экрана */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', background: 'var(--bg)' }}>
        {onClose && <button type="button" onClick={onClose}
          style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 22, padding: '0 4px 0 0', lineHeight: 1 }}>←</button>}
        <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {title || '3D-модель'} <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--text-hint)' }}>· {count} дет.</span>
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
      <div style={{ display: 'flex', gap: 5, padding: '0 10px 5px', background: 'var(--bg)', overflowX: 'auto', alignItems: 'center' }}>
        {MODES.map(([id, label]) => <button key={id} type="button" style={toolChip(mode === id)} onClick={() => setMode(id)}>{label}</button>)}
        <button type="button" title="Настройки вида" onClick={() => setShowSet(v => !v)} style={toolChip(showSet)}>⚙ {showSet ? '▴' : '▾'}</button>
        {/* вся модель или только детали заказа — одной кнопкой */}
        {model.hasContext && <button type="button" style={toolChip(scope === 'order')} onClick={() => setScope(scope === 'order' ? 'all' : 'order')}>Только детали заказа</button>}
      </div>
      {actions?.length > 0 && (
        <div style={{ display: 'flex', gap: 5, padding: '0 10px 5px', background: 'var(--bg)' }}>
          {actions.map(a => (
            <button key={a.label} type="button" onClick={a.onClick}
              style={{ flex: 1, padding: '6px 4px', borderRadius: 'var(--radius)', fontSize: 12, fontWeight: 500, cursor: 'pointer',
                border: a.primary ? 'none' : '0.5px solid var(--blue-mid)', background: a.primary ? 'var(--blue)' : 'transparent', color: a.primary ? 'white' : 'var(--blue)' }}>
              {a.label}
            </button>
          ))}
        </div>
      )}
      {levels.length > 1 && (
        <div style={{ display: 'flex', gap: 5, padding: '0 10px 5px', background: 'var(--bg)', alignItems: 'center', overflowX: 'auto' }}>
          {level < levels.length - 1 && (
            <button type="button" onClick={() => goLevel(level + 1)}
              style={{ flex: 'none', padding: '5px 11px', borderRadius: 20, border: 'none', background: 'var(--blue)', color: 'white', fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap' }}>⬆ Вверх по структуре</button>
          )}
          {levels.map((L, i) => (
            <button key={i} type="button" onClick={() => goLevel(i)}
              style={{ flex: 'none', padding: '4px 10px', borderRadius: 20, fontSize: 12, whiteSpace: 'nowrap', border: '0.5px solid ' + (i === level ? 'var(--blue)' : 'var(--border-md)'),
                background: i === level ? 'var(--blue-light)' : 'transparent', color: i === level ? 'var(--blue-dark)' : 'var(--text-muted)' }}>{L.label}</button>
          ))}
        </div>
      )}
      {/* инструменты: виды, подписи, взрыв-схема, правка, ссылка */}
      <div style={{ display: 'flex', gap: 5, padding: '0 10px 6px', background: 'var(--bg)', overflowX: 'auto', alignItems: 'center', borderBottom: '0.5px solid var(--border)' }}>
        <button type="button" style={toolChip(showTree)} onClick={() => setShowTree(v => !v)}>☰ Структура</button>
        <button type="button" style={toolChip(showViews)} onClick={() => setShowViews(v => !v)}>Виды {showViews ? '▴' : '▾'}</button>
        <select value={view.label || 'none'} onChange={e => setView({ label: e.target.value })} title="Что писать на деталях"
          style={{ width: 'auto', flex: 'none', padding: '3px 8px', fontSize: 12, borderRadius: 20, color: view.label && view.label !== 'none' ? 'var(--blue)' : 'var(--text-muted)', borderColor: view.label && view.label !== 'none' ? 'var(--blue)' : 'var(--border-md)' }}>
          {LABELS.map(([id, label]) => <option key={id} value={id}>{id === 'none' ? 'Подписи: нет' : `Подписи: ${label.toLowerCase()}`}</option>)}
        </select>
        <button type="button" style={toolChip(showExplode || explode > 0)} onClick={() => { if (tool) setTool(tool); setShowExplode(v => !v) }}>Взрыв</button>
        {editable && <button type="button" style={toolChip(tool === 'edge')} onClick={() => setTool('edge')}>Кромка</button>}
        {editable && <button type="button" style={toolChip(tool === 'drill')} onClick={() => setTool('drill')}>Крепёж</button>}
        {editable && <button type="button" style={toolChip(tool === 'move')} onClick={() => (tool === 'move' ? setTool('move') : startMove())}>✥ Двигать</button>}
        {editable && undoN > 0 && <button type="button" style={toolChip(false)} onClick={undo}>↶ Отменить</button>}
        {!editable && !readOnly && editPath && <button type="button" style={toolChip(false)} onClick={() => navigate(editPath)}>✎ Править</button>}
        {!readOnly && orderId !== undefined && <button type="button" style={toolChip(showShare)} onClick={() => setShowShare(v => !v)}>🔗 Ссылка</button>}
      </div>
      <div ref={hostRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {error && <p className="error-text" style={{ padding: 20 }}>{error}</p>}
        {/* куб видов: нажатие на грань — смотреть с этой стороны; под ним — перспектива или аксонометрия */}
        {!error && (
          <div style={{ position: 'absolute', right: 6, top: 6, zIndex: 1, width: 78, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, userSelect: 'none' }}>
            <div style={{ width: 78, height: 78, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div ref={cubeRef} style={{ width: 46, height: 46, position: 'relative', transformStyle: 'preserve-3d' }}>
                {CUBE.map(([label, dir, tr]) => (
                  <div key={label} onClick={() => lookFrom(dir)}
                    style={{ position: 'absolute', inset: 0, transform: `${tr} translateZ(23px)`, backfaceVisibility: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: 'rgba(255,255,255,0.92)', border: '1px solid var(--blue-mid)', color: 'var(--blue-dark)', fontSize: 10, fontWeight: 500, cursor: 'pointer' }}>{label}</div>
                ))}
              </div>
            </div>
            <button type="button" onClick={() => setView({ proj: view.proj === 'ortho' ? 'persp' : 'ortho' })} title="Перспектива или аксонометрия (параллельная проекция)"
              style={{ ...smallBtn, padding: '3px 6px', fontSize: 10, background: 'var(--bg)', color: 'var(--blue)', borderColor: 'var(--blue-mid)' }}>
              {view.proj === 'ortho' ? 'Аксонометрия' : 'Перспектива'}
            </button>
            <button type="button" onClick={() => stateRef.current?.resetView()} title="Изометрия, вся модель"
              style={{ ...smallBtn, padding: '3px 6px', fontSize: 10, background: 'var(--bg)' }}>⌂ Изометрия</button>
          </div>
        )}
        {/* структура модели: изделия → блоки → детали */}
        {showTree && (
          <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, zIndex: 7, width: 'min(84%, 330px)', display: 'flex', flexDirection: 'column', background: 'var(--bg)', borderRight: '0.5px solid var(--border-md)', boxShadow: '4px 0 16px rgba(0,0,0,0.10)' }}>
            <div style={{ display: 'flex', alignItems: 'center', padding: '8px 10px 4px' }}>
              <div style={{ flex: 1, fontSize: 14, fontWeight: 500 }}>Структура модели</div>
              <button type="button" onClick={() => setShowTree(false)} style={{ background: 'none', border: 'none', fontSize: 18, color: 'var(--text-hint)' }}>✕</button>
            </div>
            <div style={{ display: 'flex', gap: 4, padding: '0 10px 6px', alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: 'var(--text-hint)', flexShrink: 0 }}>Подписи:</span>
              {[['none', 'нет'], ['block', 'блоки'], ['des', 'детали']].map(([id, label]) => (
                <button key={id} type="button" style={{ ...toolChip((view.label || 'none') === id || (id === 'des' && ['pos', 'name'].includes(view.label))), padding: '3px 9px', fontSize: 11 }} onClick={() => setView({ label: id })}>{label}</button>
              ))}
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '0 6px', borderTop: '0.5px solid var(--border)' }}>
              {(() => {
                const mark = (on, some) => ({ width: 18, height: 18, flexShrink: 0, borderRadius: 4, border: '1px solid ' + (on || some ? 'var(--blue)' : 'var(--border-md)'), background: on ? 'var(--blue)' : some ? 'var(--blue-light)' : 'transparent', color: 'white', fontSize: 12, lineHeight: '16px', textAlign: 'center', padding: 0 })
                const eye = off => ({ background: 'none', border: 'none', padding: '4px 6px', fontSize: 13, color: off ? 'var(--text-hint)' : 'var(--blue)', flexShrink: 0 })
                const partRow = (p, depth) => {
                  const off = hiddenPids.has(p.pid)
                  return (
                    <div key={p.pid} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 0 5px ' + (depth * 14 + 22) + 'px', opacity: off ? 0.5 : 1 }}>
                      <button type="button" style={mark(sel.has(p.pid))} onClick={() => toggleSel([p.pid])}>{sel.has(p.pid) ? '✓' : ''}</button>
                      <div onClick={() => toggleSel([p.pid])} style={{ flex: 1, minWidth: 0, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}>
                        {p.des || p.pos ? <b style={{ fontWeight: 500 }}>{p.des || p.pos} </b> : ''}{p.name || 'Деталь'}{p.size ? <span style={{ color: 'var(--text-hint)' }}> · {p.size}</span> : ''}
                      </div>
                      <button type="button" style={eye(off)} onClick={() => toggleHide([p.pid])}>{off ? '○' : '●'}</button>
                    </div>
                  )
                }
                const nodeRow = (n, depth) => {
                  const open = openNodes.has(n.key)
                  const on = n.pids.every(q => sel.has(q)), some = !on && n.pids.some(q => sel.has(q))
                  const off = n.pids.every(q => hiddenPids.has(q))
                  return (
                    <div key={n.key}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 0 6px ' + depth * 14 + 'px', borderTop: depth ? 'none' : '0.5px solid var(--border)', opacity: off ? 0.5 : 1 }}>
                        <button type="button" onClick={() => toggleNode(n.key)} style={{ background: 'none', border: 'none', padding: 0, width: 16, fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }}>{open ? '▾' : '▸'}</button>
                        <button type="button" style={mark(on, some)} onClick={() => toggleSel(n.pids)}>{on ? '✓' : some ? '–' : ''}</button>
                        <div onClick={() => toggleNode(n.key)} style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: depth ? 400 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}>
                          {n.name} <span style={{ fontWeight: 400, color: 'var(--text-hint)' }}>· {n.pids.length}</span>
                        </div>
                        <button type="button" style={eye(off)} onClick={() => toggleHide(n.pids)}>{off ? '○' : '●'}</button>
                      </div>
                      {open && n.children.map(c => nodeRow(c, depth + 1))}
                      {open && n.parts.map(p => partRow(p, depth + 1))}
                    </div>
                  )
                }
                return (
                  <>
                    {tree.children.map(c => nodeRow(c, 0))}
                    {tree.parts.length > 0 && tree.children.length > 0 && <div style={{ fontSize: 11, color: 'var(--text-hint)', padding: '8px 0 2px', borderTop: '0.5px solid var(--border)' }}>Вне блоков</div>}
                    {tree.parts.map(p => partRow(p, -1))}
                  </>
                )
              })()}
            </div>
            <div style={{ padding: '8px 10px', borderTop: '0.5px solid var(--border-md)' }}>
              <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 6 }}>
                {sel.size ? `Отмечено деталей: ${sel.size}` : 'Галочка — отметить блок или деталь, ● — показать или скрыть'}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {editable && <button type="button" disabled={!sel.size} onClick={() => startMove()} style={{ ...smallBtn, background: 'var(--blue)', color: 'white', border: 'none', opacity: sel.size ? 1 : 0.5 }}>✥ Двигать</button>}
                {editable && <button type="button" disabled={!sel.size} onClick={() => { setShowTree(false); if (tool !== 'edge') setTool('edge') }} style={{ ...smallBtn, color: 'var(--blue)', borderColor: 'var(--blue)', opacity: sel.size ? 1 : 0.5 }}>Кромка</button>}
                {editable && <button type="button" disabled={!sel.size} onClick={() => { setShowTree(false); if (tool !== 'drill') setTool('drill') }} style={{ ...smallBtn, color: 'var(--blue)', borderColor: 'var(--blue)', opacity: sel.size ? 1 : 0.5 }}>Крепёж</button>}
                <button type="button" disabled={!sel.size} onClick={() => { const keep = new Set(sel); isolate(keep); setSel(keep); setShowTree(false) }} style={{ ...smallBtn, opacity: sel.size ? 1 : 0.5 }}>Оставить только их</button>
                <button type="button" disabled={!sel.size} onClick={() => setSel(new Set())} style={{ ...smallBtn, opacity: sel.size ? 1 : 0.5 }}>Снять отметки</button>
                {hiddenPids.size > 0 && <button type="button" onClick={showAll} style={{ ...smallBtn, color: 'var(--blue)', borderColor: 'var(--blue)' }}>Показать всё</button>}
              </div>
            </div>
          </div>
        )}
        {showViews && (
          <div style={{ position: 'absolute', left: 8, right: 8, top: 8, zIndex: 2, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, background: 'var(--bg)', border: '0.5px solid var(--border-md)', borderRadius: 'var(--radius)', padding: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.08)' }}>
            {VIEWS.map(([id, label, dir]) => <button key={id} type="button" style={{ ...smallBtn, padding: '8px 4px' }} onClick={() => lookFrom(dir)}>{label}</button>)}
            <button type="button" style={{ ...smallBtn, padding: '8px 4px' }} onClick={() => lookFrom(null)}>Вписать</button>
          </div>
        )}
        {(hiddenPids.size > 0 || multi) && !showViews && (
          <div style={{ position: 'absolute', left: 8, right: 90, top: 8, zIndex: 1, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', pointerEvents: 'none' }}>
            {hiddenPids.size > 0 && (
              <button type="button" onClick={showAll} style={{ ...smallBtn, pointerEvents: 'auto', background: 'var(--bg)', color: 'var(--blue)', borderColor: 'var(--blue)' }}>
                Показано {shownCount} из {shownCount + hiddenPids.size} · показать всё
              </button>
            )}
            {multi && (
              <>
                <span style={{ ...smallBtn, background: 'var(--bg)', color: 'var(--text)' }}>Выбрано: {sel.size}</span>
                <button type="button" disabled={!sel.size} onClick={() => isolate(sel)} style={{ ...smallBtn, pointerEvents: 'auto', background: 'var(--blue)', color: 'white', border: 'none', opacity: sel.size ? 1 : 0.5 }}>Оставить только их</button>
                <button type="button" disabled={!sel.size} onClick={() => hidePids(sel)} style={{ ...smallBtn, pointerEvents: 'auto', background: 'var(--bg)' }}>Скрыть</button>
                {editable && <button type="button" disabled={!sel.size} onClick={() => { if (tool !== 'edge') setTool('edge') }} style={{ ...smallBtn, pointerEvents: 'auto', background: 'var(--bg)', color: 'var(--blue)', borderColor: 'var(--blue)', opacity: sel.size ? 1 : 0.5 }}>Кромка</button>}
                {editable && <button type="button" disabled={!sel.size} onClick={() => { if (tool !== 'drill') setTool('drill') }} style={{ ...smallBtn, pointerEvents: 'auto', background: 'var(--bg)', color: 'var(--blue)', borderColor: 'var(--blue)', opacity: sel.size ? 1 : 0.5 }}>Крепёж</button>}
                <button type="button" onClick={() => { setMulti(false); setSel(new Set()); setPicked(null) }} style={{ ...smallBtn, pointerEvents: 'auto', background: 'var(--bg)' }}>Готово</button>
              </>
            )}
          </div>
        )}
        {toast && (
          <div style={{ position: 'absolute', left: '50%', top: hiddenPids.size || multi ? 52 : 12, transform: 'translateX(-50%)', zIndex: 4, maxWidth: '90%', background: 'rgba(30,30,28,0.88)', color: 'white', fontSize: 12, padding: '7px 12px', borderRadius: 16, textAlign: 'center', pointerEvents: 'none' }}>{toast}</div>
        )}
        {showSet && (
          <div style={{ position: 'absolute', left: 0, right: 0, top: 0, zIndex: 2, maxHeight: '70%', overflowY: 'auto', background: 'var(--bg)', borderBottom: '0.5px solid var(--border-md)', padding: '10px 14px 6px', boxShadow: '0 4px 16px rgba(0,0,0,0.08)' }}>
            <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 4 }}>Полупрозрачный</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
              <span style={{ width: 96, flexShrink: 0 }}>Прозрачность</span>
              <input type="range" min="5" max="90" step="1" value={Math.round((1 - view.xray) * 100)} style={{ flex: 1 }}
                onChange={e => setView({ xray: 1 - Number(e.target.value) / 100 })} />
              <span style={{ width: 38, textAlign: 'right' }}>{Math.round((1 - view.xray) * 100)}%</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-hint)', margin: '8px 0 4px' }}>Каркас</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
              <span style={{ width: 96, flexShrink: 0 }}>Цвет линий</span>
              <input type="color" value={view.wireColor} onChange={e => setView({ wireColor: e.target.value })}
                style={{ width: 40, height: 26, padding: 0, border: '0.5px solid var(--border-md)', borderRadius: 6, background: 'none' }} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
              <span style={{ width: 96, flexShrink: 0 }}>Толщина</span>
              <input type="range" min="0.5" max="6" step="0.5" value={view.wireW} style={{ flex: 1 }} onChange={e => setView({ wireW: Number(e.target.value) })} />
              <span style={{ width: 38, textAlign: 'right' }}>{view.wireW}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
              <span style={{ width: 96, flexShrink: 0 }}>Прозрачность</span>
              <input type="range" min="0" max="90" step="1" value={Math.round((1 - view.wireOp) * 100)} style={{ flex: 1 }} onChange={e => setView({ wireOp: 1 - Number(e.target.value) / 100 })} />
              <span style={{ width: 38, textAlign: 'right' }}>{Math.round((1 - view.wireOp) * 100)}%</span>
            </div>
            {hasBands && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 5, width: 96, flexShrink: 0, margin: 0 }}>
                  <input type="checkbox" checked={view.bandOn} onChange={e => setView({ bandOn: e.target.checked })} style={{ width: 'auto' }} />
                  Кромка
                </label>
                <input type="color" value={view.bandColor} disabled={!view.bandOn} onChange={e => setView({ bandColor: e.target.value })}
                  style={{ width: 40, height: 26, padding: 0, border: '0.5px solid var(--border-md)', borderRadius: 6, background: 'none', flexShrink: 0 }} />
                <input type="range" min="0" max="90" step="1" value={Math.round((1 - view.bandOp) * 100)} disabled={!view.bandOn} style={{ flex: 1 }}
                  onChange={e => setView({ bandOp: 1 - Number(e.target.value) / 100 })} />
                <span style={{ width: 38, textAlign: 'right' }}>{Math.round((1 - view.bandOp) * 100)}%</span>
              </div>
            )}
            {hasSides && (
              <>
                <div style={{ fontSize: 11, color: 'var(--text-hint)', margin: '8px 0 4px' }}>Присадка — с какой стороны она сейчас</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted)', marginBottom: 6, flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 5, margin: 0 }}>
                    <input type="checkbox" checked={hl === 'front'} onChange={e => setHl(e.target.checked ? 'front' : '')} style={{ width: 'auto' }} />
                    <span style={{ color: '#00a651' }}>●</span> Подсветить лицевую
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 5, margin: 0 }}>
                    <input type="checkbox" checked={hl === 'back'} onChange={e => setHl(e.target.checked ? 'back' : '')} style={{ width: 'auto' }} />
                    <span style={{ color: '#9c27b0' }}>●</span> Подсветить нелицевую
                  </label>
                </div>
              </>
            )}
          </div>
        )}
        {showMats && (
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 5, maxHeight: '62%', overflowY: 'auto', background: 'var(--bg)', borderTop: '0.5px solid var(--border-md)', padding: '10px 14px', boxShadow: '0 -4px 16px rgba(0,0,0,0.08)' }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
              <div style={{ flex: 1, fontSize: 14, fontWeight: 500 }}>Материалы</div>
              <button type="button" onClick={() => setShowMats(false)} style={{ background: 'none', border: 'none', fontSize: 18, color: 'var(--text-hint)' }}>✕</button>
            </div>
            <p style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 8 }}>
              Галочка — показывать детали из этого материала в модели. Снимите её, чтобы «потушить» материал и рассмотреть остальное.
              {!readOnly && ' Картинка декора ляжет на все детали материала и запомнится по его названию.'}
            </p>
            {allMats.length > 1 && (
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                <button type="button" style={smallBtn} onClick={() => setHidden(new Set())}>Показать все</button>
                <button type="button" style={smallBtn} onClick={() => setHidden(new Set(matNames))}>Скрыть все</button>
              </div>
            )}
            {!texCloud && !readOnly && (
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
                    {!isRoom(name) && !readOnly && <button type="button" style={smallBtn} disabled={texBusy === name}
                      onClick={() => { pickFor.current = name; fileRef.current?.click() }}>
                      {texBusy === name ? '…' : t ? 'Заменить' : 'Загрузить'}
                    </button>}
                  </div>
                  {t && !readOnly && (
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
        {/* меню детали (долгое нажатие) */}
        {menu && menuPart && (
          <div style={{ ...sheet, zIndex: 6, maxHeight: '70%', overflowY: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
              <div style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {menuPart.des ? `${menuPart.des} · ` : ''}{menuPart.name || 'Деталь'}{menuPart.size ? ` — ${menuPart.size}` : ''}
              </div>
              <button type="button" onClick={() => setMenu(null)} style={{ background: 'none', border: 'none', fontSize: 18, color: 'var(--text-hint)' }}>✕</button>
            </div>
            {sel.size > 1 && sel.has(menu.pid) && <button type="button" style={menuBtn} onClick={() => isolate(sel)}>Оставить только выбранные ({sel.size})</button>}
            {menuBlock.length > 1 && <button type="button" style={menuBtn} onClick={() => isolate(menuBlock)}>Оставить только блок «{menuPart.block}» ({menuBlock.length} дет.)</button>}
            {menuProduct.length > menuBlock.length && <button type="button" style={menuBtn} onClick={() => isolate(menuProduct)}>Оставить только изделие «{menuPart.product}» ({menuProduct.length} дет.)</button>}
            {menuGroup.length > 1 && <button type="button" style={menuBtn} onClick={() => isolate(menuGroup)}>Оставить только корпус ({menuGroup.length} дет.)</button>}
            <button type="button" style={menuBtn} onClick={() => isolate([menu.pid])}>Оставить только эту деталь</button>
            <button type="button" style={menuBtn} onClick={() => { setMulti(true); setSel(new Set([...(multi ? sel : []), menu.pid])); setMenu(null) }}>Выбрать несколько деталей…</button>
            <button type="button" style={menuBtn} onClick={() => hidePids([menu.pid])}>Скрыть деталь</button>
            {editable && sel.size > 1 && sel.has(menu.pid) && <button type="button" style={menuBtn} onClick={() => { setMenu(null); if (tool !== 'edge') setTool('edge') }}>Кромка на отмеченные ({sel.size})</button>}
            {editable && sel.size > 1 && sel.has(menu.pid) && <button type="button" style={menuBtn} onClick={() => { setMenu(null); if (tool !== 'drill') setTool('drill') }}>Крепёж на отмеченные ({sel.size})</button>}
            {editable && menuPart.product && <button type="button" style={menuBtn} onClick={() => startMove(parts.filter(q => q.product === menuPart.product).map(q => q.pid))}>✥ Двигать блок «{menuPart.product}»</button>}
            {editable && sel.size > 1 && sel.has(menu.pid) && <button type="button" style={menuBtn} onClick={() => startMove()}>✥ Двигать выбранные ({sel.size})</button>}
            {editable && !menuPart.hardware && <button type="button" style={menuBtn} onClick={() => startMove([menu.pid])}>✥ Двигать только эту деталь</button>}
            {editable && menuPart.inOrder && menuPart.di >= 0 && <button type="button" style={menuBtn} onClick={() => openEditor(menu.pid)}>Править деталь: контур, паз, присадка…</button>}
            {hiddenPids.size > 0 && <button type="button" style={{ ...menuBtn, color: 'var(--blue)' }} onClick={showAll}>Показать всё</button>}
          </div>
        )}
      </div>
      {/* взрыв-схема */}
      {showExplode && !tool && !showMats && !menu && (
        <div style={{ ...dock, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }}>Взрыв</span>
          <input type="range" min="0" max="100" step="1" value={Math.round(explode * 100)} style={{ flex: 1 }} onChange={e => setExplode(Number(e.target.value) / 100)} />
          <span style={{ fontSize: 12, color: 'var(--text-muted)', width: 36, textAlign: 'right' }}>{Math.round(explode * 100)}%</span>
          <button type="button" style={smallBtn} onClick={() => { setExplode(0); setShowExplode(false) }}>Собрать</button>
        </div>
      )}
      {/* перемещение блоков: одна ось свободна, остальные закреплены; упор — вплотную к соседним деталям */}
      {tool === 'move' && !showMats && !menu && (
        <div style={dock}>
          <div style={{ display: 'flex', gap: 5, marginBottom: 8 }}>
            {AXES.map(([label], k) => <button key={k} type="button" style={chip(moveAxis === k)} onClick={() => setMoveAxis(k)}>{label}</button>)}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--text-muted)' }}>
              Сдвиг, мм: {AXES.map(([, n], k) => <span key={n} style={{ marginRight: 8, color: k === moveAxis ? 'var(--blue)' : undefined, fontWeight: k === moveAxis ? 500 : 400 }}>{n} {moveVec[k] > 0 ? '+' : ''}{moveVec[k]}</span>)}
            </span>
            {[-10, -1, 1, 10].map(v => <button key={v} type="button" style={{ ...smallBtn, padding: '5px 9px' }} disabled={!moveSet} onClick={() => nudge(v)}>{v > 0 ? '+' : '−'}{Math.abs(v)}</button>)}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" style={{ ...wideBtn(true), opacity: moveVec.some(v => v) ? 1 : 0.5 }} disabled={!moveVec.some(v => v)} onClick={applyMove}>Применить</button>
            <button type="button" style={wideBtn(false)} onClick={() => setTool('move')}>Отмена</button>
            <button type="button" style={{ ...wideBtn(false), flex: 'none' }} onClick={() => setShowTree(true)}>☰ Выбор</button>
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: '8px 0 0' }}>
            {moveSet ? `Двигается: ${sel.size} дет.${moveSet.size > sel.size ? ` и фурнитура (${moveSet.size - sel.size})` : ''}. ` : 'Ничего не отмечено — нажмите «Выбор». '}
            Тяните отмеченное пальцем: оно едет только вдоль выбранной оси, по остальным закреплено, и останавливается вплотную к соседним деталям (зазор 0). Детали, которые уже вошли друг в друга, развести можно — обратно не заедут.
          </p>
        </div>
      )}
      {/* кромка */}
      {tool === 'edge' && !showMats && !menu && (
        <div style={dock}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }}>Кромка</span>
            <select value={edgeValue} onChange={e => {
              if (e.target.value !== '+') { setEdgeValue(e.target.value); return }
              const name = (window.prompt('Название кромки (например: ПВХ 2 мм)') || '').trim()
              if (name) { setEdgeValue(name); onEdgeNamesChange?.(prev => (prev.includes(name) ? prev : [...prev, name])) }
            }} style={{ flex: 1, padding: '6px 8px', fontSize: 13 }}>
              <option value="default">Кромка (без названия)</option>
              {[...new Set([...edgeList, ...(edgeValue !== 'default' ? [edgeValue] : [])])].map(n => <option key={n} value={n}>{n}</option>)}
              <option value="+">+ другая…</option>
            </select>
          </div>
          {edgeTypes && onEdgeTypesChange && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 12, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
              <span style={{ color: numOf(edgeType?.t) > 0 ? undefined : 'var(--danger)' }}>Толщина, мм</span>
              <input type="text" inputMode="decimal" value={edgeType?.t ?? ''} onChange={e => patchEdgeType({ t: e.target.value })}
                style={{ width: 56, padding: '4px 6px', fontSize: 12, textAlign: 'center', borderColor: numOf(edgeType?.t) > 0 ? undefined : 'var(--danger)' }} />
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, margin: 0 }}>
                <input type="checkbox" checked={!!edgeType?.trim} onChange={e => patchEdgeType({ trim: e.target.checked })} style={{ width: 'auto' }} />Подрезка
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, margin: 0 }}>
                <input type="checkbox" checked={numOf(edgeType?.joint) > 0 || edgeType?.joint === ''} onChange={e => patchEdgeType({ joint: e.target.checked ? 0.5 : 0 })} style={{ width: 'auto' }} />Прифуговка
              </label>
              {(numOf(edgeType?.joint) > 0 || edgeType?.joint === '') && (
                <input type="text" inputMode="decimal" value={edgeType.joint} onChange={e => patchEdgeType({ joint: e.target.value })} style={{ width: 50, padding: '4px 6px', fontSize: 12, textAlign: 'center' }} />
              )}
            </div>
          )}
          {sel.size > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 12, color: 'var(--blue)' }}>
              <span style={{ flex: 1 }}>Только отмеченные детали: {sel.size}</span>
              <button type="button" style={smallBtn} onClick={() => setSel(new Set())}>Все детали</button>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" style={wideBtn(true)} onClick={() => bandVisible(edgeValue)}>Закромить видимые торцы</button>
            <button type="button" style={wideBtn(false)} onClick={() => bandVisible(null)}>Снять с видимых</button>
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: '8px 0 0' }}>
            Отметьте детали (или оставьте нужный блок), выберите вид на кубе и нажмите «Закромить» — кромка встанет на торцы, которые смотрят на вас. Тап по торцу — поставить или снять.
          </p>
        </div>
      )}
      {/* присадка по стыкам */}
      {tool === 'drill' && !showMats && !menu && (
        <div style={dock}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }}>Крепёж</span>
            <select value={String(scheme.id)} onChange={e => setSchemeId(e.target.value)} style={{ flex: 1, padding: '6px 8px', fontSize: 13 }}>
              {schemes.length > 0 && <optgroup label="Моя база фурнитуры">
                {schemes.map(h => <option key={h.id} value={String(h.id)}>{h.name}{!schemeEdge(h) ? ' (только пласть)' : !schemeFace(h) ? ' (только торец)' : ''}</option>)}
              </optgroup>}
              <optgroup label="Готовые схемы">
                {BUILTIN_SCHEMES.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
              </optgroup>
            </select>
            <button type="button" style={{ ...smallBtn, color: 'var(--blue)', borderColor: 'var(--blue)' }} onClick={() => setNewScheme(blankScheme())}>+ Новый</button>
          </div>
          {sel.size > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 12, color: 'var(--blue)' }}>
              <span style={{ flex: 1 }}>Стыки только отмеченных деталей: {sel.size}</span>
              <button type="button" style={smallBtn} onClick={() => setSel(new Set())}>Все стыки модели</button>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" style={wideBtn(true)} onClick={placeDrill}>Установить крепёж · стыков {activeJoints.length}</button>
            <button type="button" style={wideBtn(false)} onClick={removeDrill}>Убрать</button>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
            <button type="button" style={smallBtn} onClick={() => setAllJoints(true)}>Все стыки</button>
            <button type="button" style={smallBtn} onClick={() => setAllJoints(false)}>Ни одного</button>
            <span style={{ fontSize: 11, color: 'var(--text-hint)' }}>
              <span style={{ color: '#ff6a00' }}>■</span> поставить · <span style={{ color: '#00a651' }}>■</span> уже стоит · <span style={{ color: '#8a8a8a' }}>■</span> пропустить
            </span>
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: '8px 0 0' }}>
            Подсвечены стыки: торец одной детали прилегает к пласти другой. Тап по стыку — включить или выключить. В пласти появится линия разметки с присадкой, в торце — ответные отверстия.
          </p>
        </div>
      )}
      {/* новый крепёж и его схема — без перехода в редактор контура */}
      {newScheme && (() => {
        const f = newScheme, set = p => setNewScheme(v => ({ ...v, ...p }))
        const num = (key, w = 58) => <input type="text" inputMode="decimal" value={f[key]} onChange={e => set({ [key]: e.target.value })} style={{ width: w, padding: '5px 6px', fontSize: 13, textAlign: 'center' }} />
        const line = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 12, color: 'var(--text-muted)', flexWrap: 'wrap' }
        const cap = { width: 92, flexShrink: 0 }
        return (
          <div style={{ position: 'fixed', inset: 0, zIndex: 965, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'flex-end' }} onClick={() => setNewScheme(null)}>
            <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxHeight: '88%', overflowY: 'auto', background: 'var(--bg)', borderRadius: '14px 14px 0 0', padding: '12px 14px calc(12px + env(safe-area-inset-bottom))' }}>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
                <div style={{ flex: 1, fontSize: 15, fontWeight: 500 }}>Новый крепёж</div>
                <button type="button" onClick={() => setNewScheme(null)} style={{ background: 'none', border: 'none', fontSize: 18, color: 'var(--text-hint)' }}>✕</button>
              </div>
              <input type="text" placeholder="Название: Конфирмат 7×50, Эксцентрик…" value={f.name} onChange={e => set({ name: e.target.value })} style={{ marginBottom: 10 }} />
              <div style={line}><span style={cap}>В пласть</span>Ø {num('faceD')}
                {!f.through && <>глубина {num('faceDepth')}</>}
                <label style={{ display: 'flex', alignItems: 'center', gap: 5, margin: 0 }}><input type="checkbox" checked={f.through} onChange={e => set({ through: e.target.checked })} style={{ width: 'auto' }} />сквозное</label>
              </div>
              <div style={line}><span style={cap}>В торец</span>Ø {num('edgeD')} глубина {num('edgeDepth')}</div>
              <div style={line}><span style={cap}>Отступ от края</span>{num('offset')} мм
                <label style={{ display: 'flex', alignItems: 'center', gap: 5, margin: 0 }}><input type="checkbox" checked={f.mirror} onChange={e => set({ mirror: e.target.checked })} style={{ width: 'auto' }} />и с другого края</label>
              </div>
              <label style={{ ...line, margin: '0 0 8px' }}><input type="checkbox" checked={f.pair} onChange={e => set({ pair: e.target.checked })} style={{ width: 'auto' }} />Второе отверстие рядом (например, шкант к конфирмату)</label>
              {f.pair && (
                <>
                  <div style={line}><span style={cap}>Шаг до второго</span>{num('pairGap')} мм</div>
                  <div style={line}><span style={cap}>Второе в пласть</span>Ø {num('pairFaceD')} глубина {num('pairFaceDepth')}</div>
                  <div style={line}><span style={cap}>Второе в торец</span>Ø {num('pairEdgeD')} глубина {num('pairEdgeDepth')}</div>
                </>
              )}
              <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: '2px 0 10px' }}>
                Схема ставится на стык «торец к пласти»: отверстия в пласти одной детали и ответные в торце другой, на заданном отступе от края стыка. Крепёж запишется в вашу базу фурнитуры и будет доступен и в редакторе контура.
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" style={wideBtn(true)} onClick={saveScheme}>Сохранить крепёж</button>
                <button type="button" style={wideBtn(false)} onClick={() => setNewScheme(null)}>Отмена</button>
              </div>
            </div>
          </div>
        )
      })()}
      {/* ссылка для клиента */}
      {showShare && !showMats && !menu && (
        <div style={dock}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
            <div style={{ flex: 1, fontSize: 14, fontWeight: 500 }}>Ссылка для клиента</div>
            <button type="button" onClick={() => setShowShare(false)} style={{ background: 'none', border: 'none', fontSize: 18, color: 'var(--text-hint)' }}>✕</button>
          </div>
          {orderId
            ? <ShareLinkBox orderId={orderId} note={editable ? 'По ссылке открывается сохранённый заказ: правки появятся у клиента после «Сохранить».' : ''} />
            : <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>Сначала сохраните заказ — ссылка создаётся на сохранённый заказ.</p>}
        </div>
      )}
      <div style={{ padding: '8px 14px calc(8px + env(safe-area-inset-bottom))', background: 'var(--bg)', borderTop: '0.5px solid var(--border)', fontSize: 12, minHeight: 38 }}>
        {picked
          ? <span><b>{picked.des ? `${picked.des} · ` : ''}{picked.name}</b>{picked.size ? ` — ${picked.size}` : ''}{picked.t ? ` · ${picked.t} мм` : ''}{picked.material && !picked.hardware ? ` · ${picked.material}` : ''}{picked.block || picked.product ? ` · ${picked.block || picked.product}` : ''}{picked.canOpen ? ' · двойной тап — открыть/закрыть' : ''}</span>
          : <span style={{ color: 'var(--text-hint)' }}>Палец — вращать · щипок — масштаб · два пальца — сдвиг · тап — что это · долгое нажатие — оставить только деталь или блок{hasAnim ? ' · двойной тап по двери или ящику — открыть' : ''}</span>}
      </div>
      {editing && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 970, background: 'var(--bg2)', overflowY: 'auto' }}>
          <Suspense fallback={null}>
            <ContourEditor detail={editing.draft} materialThickness={contourOf(details[editing.di])?.meta?.thickness || materialThickness}
              onUpdate={u => setEditing(ed => (ed ? { ...ed, draft: { ...ed.draft, contour: u.contour, edges: u.edges || ed.draft.edges } } : ed))}
              onClose={closeEditor} />
          </Suspense>
        </div>
      )}
    </div>
  )
}
