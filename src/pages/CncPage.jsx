import { nestingFaults, FAULT_TITLE } from '../lib/nestingCheck'
import ShareBadge from '../components/ShareBadge'
import { cutDetails, parseEdgeTypes } from '../lib/edgeCut'
import { useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react'
import { createPortal } from 'react-dom'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import BottomNav from '../components/BottomNav'
import { CncBasic, CncCommands, CncTools, CncOps } from '../components/CncSettings'
import PostPicker from '../components/PostPicker'
import { useKeptState } from '../hooks/useKeptState'
import { savedNestings, sheetGeo } from '../lib/savedNesting'
import { routerPost, drillPosts, isDrill6, isBeamSaw, sawPost, postView, postBack, secondRouter, secondPost, setSecondPost, activePost } from '../lib/cncSettings'
import { getUserSettings, saveUserSettings } from '../lib/userSettings'
import { useCnc } from '../hooks/useCnc'
import { buildDrill6Files, drill6Folders, drill6Qr, DRILL_DIR_DEFAULT, drill6Layers } from '../lib/drill6Xml'
import Drill6Ops from '../components/Drill6Ops'
import DirPathEditor, { routerDirDefault } from '../components/DirPathEditor'
import Drill6Viewer from '../components/Drill6Viewer'
import { buildSheetGcode, collectLayers, partFeatures, holeToolFor, pocketKey, grooveOpFor, skipOf } from '../lib/gcode'
import { getLabelTpl, buildLabelFiles, buildLabelsPdf, labelInfo, labelQr, buildBeamEmfLabels } from '../lib/labelMaker'
import CncLoader from '../components/CncLoader'
import { orderTitle, toLatin, programName, folderName } from '../lib/orderUtils'
import { orderClient } from '../lib/productionApi'
import SaveFilesDialog from '../components/SaveFilesDialog'
import { productionMark, orderMarks } from '../lib/productionApi'
import PdfSetup from '../components/PdfSetup'
import { buildNestingPdf } from '../lib/nestingPdf'
import { userSameAlpha } from '../lib/sameParts'
import { userPdfTpl, statsAndQuote, pdfSummaryOf } from '../lib/pdfSummary'
import { parseGcode, fmtTime } from '../lib/gcodeSim'
import SimLinksBox from '../components/SimLinksBox'
import { packSim, getSimShare, saveSimShare, deleteSimShare, simShareUrl } from '../lib/simShare'

// ЧПУ: листы принятого раскроя → управляющая программа (G-код) + симулятор.
// Настройки (постпроцессор, инструменты, обработка контуров, команды) идут за аккаунтом.
import { lazyRetry } from '../lib/lazyRetry'
import { useBackClose } from '../lib/backStack'
import { saveBeamSawXml, buildBeamSawXml } from '../lib/beamSawXml'
import { beamLabelSeq, beamExitPart } from '../lib/beamSawLabels'
import { fileNamesOf } from '../lib/fileNames'
import { fileNameOf, FILE_NAME_PARTS, FILE_NAME_DEFAULTS } from '../lib/orderUtils'
import TplInput from '../components/TplInput'
const GcodeSimulator = lazyRetry(() => import('../components/GcodeSimulator'))   // 3D — подгружается при открытии
const TABS = [['sheets', 'Листы'], ['ops', 'Обработка'], ['tools', 'Инструменты'], ['basic', 'Основные'], ['cmd', 'Команды']]
const num = v => { const x = Number(String(v ?? '').replace(',', '.')); return isFinite(x) ? x : 0 }
// имена программ и папок — строго латиницей: станки и флешки кириллицу читают не везде
const latinExt = s => String(s || '').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'XML'
const safeName = s => toLatin(String(s || '')).replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '')

function download(name, data, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const a = document.createElement('a')
  a.href = url; a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export default function CncPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user, isMaster, cabinet } = useAuth()
  const toOrders = () => navigate(cabinet === 'production' ? '/production' : '/orders')   // «К заказам» — в список своего кабинета
  const labelTpl = useMemo(() => getLabelTpl(user), [user])
  const [labelBusy, setLabelBusy] = useState(false)
  // «Бирки вместе с программами» — для станков без маркировочного стола: файлы бирок (как у стола) и PDF всех бирок
  // ложатся отдельной папкой рядом с программами (имя папки программ + «_Etiketki»). Запоминается за аккаунтом.
  const [withLabels, setWithLabelsState] = useState(() => !!getUserSettings(user).cncWithLabels)
  const setWithLabels = on => { setWithLabelsState(on); saveUserSettings({ cncWithLabels: on }, user); setBuilt(null) }
  // карты раскроя PDF — вместе с программами (в папку программ): кто-то до сих пор печатает карты
  const [withMaps, setWithMapsState] = useState(() => !!getUserSettings(user).cncWithMaps)
  const setWithMaps = on => { setWithMapsState(on); saveUserSettings({ cncWithMaps: on }, user) }
  const [mapsBusy, setMapsBusy] = useState('')
  const [order, setOrder] = useState(null)
  const [clientName, setClientName] = useState('')   // имя заказчика — для названий программ и папки
  useEffect(() => { let alive = true; orderClient(id).then(r => { if (alive && !r.error) setClientName(r.data?.full_name || '') }); return () => { alive = false } }, [id])
  const [details, setDetails] = useState([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useKeptState('tab', 'sheets')
  const [matKey, setMatKey] = useState('')
  const [picked, setPicked] = useState(null)        // выбранные листы (индексы); null — все
  const [built, setBuilt] = useState(null)          // { for: cnc, files: [{ si, name, text, lines, time, warnings, empty }] }
  const [search] = useSearchParams()
  const simSi = search.get('sim')                   // лист в симуляторе — в адресе: кнопка «назад» телефона закрывает симулятор, а не страницу
  const [pendingBuild, setPendingBuild] = useState(false)
  const restored = useRef(false)
  const [linksTick, setLinksTick] = useState(0)

  useEffect(() => {
    let alive = true
    ;(async () => {
      const { data: o } = await supabase.from('orders').select('*').eq('id', id).single()
      const { data: d } = await supabase.from('order_details').select('*').eq('order_id', id).order('sort_order')
      if (!alive) return
      setOrder(o || null); setDetails(cutDetails(d || [], parseEdgeTypes(o?.edge_types)))   /* заготовки: с учётом кромки, как в раскрое */; setLoading(false)
    })()
    return () => { alive = false }
  }, [id])

  const mats = useMemo(() => savedNestings(order, details), [order, details])
  const mat = mats.find(m => m.key === matKey) || mats[0] || null
  // сохранённый раскрой проверяется ещё раз: пересечение деталей или зазор меньше реза — это брак, G-код по нему не выпускается
  const faults = useMemo(() => (order && mat ? nestingFaults(order, [mat]) : []), [order, mat])
  const layers = useMemo(() => (mat ? collectLayers(mat.sheets, mat.details, mat.thickness) : null), [mat])
  // настройки ЧПУ — общие с окном «Настройки постпроцессора» в кабинете производства; после правки программы создаются заново
  const { cnc, change, ready: cncReady } = useCnc(() => setBuilt(null), order?.production_id || null)
  const post = routerPost(cnc)                       // раскроечный станок: G-код по листам
  const drills = drillPosts(cnc)                     // присадочные станки, выпускающие программы вместе с ним
  // инструменты и обработка, которые видит раскроечный станок (у настроенного по чужой программе — свои, см. postTools.js)
  const rview = useMemo(() => postView({ ...cnc, post: post.id }), [cnc, post.id])
  const r2raw = secondRouter(cnc)                    // второй раскроечный станок: его G-код — вместе с основным, в свою папку
  // раскрой под пильный центр β: программа — XML для пилы (постпроцессор «Пильный центр»), а не G-код по листам
  const beamMat = !!mat?.result?.beamSaw
  const saw = sawPost(cnc)
  const r2 = beamMat ? null : r2raw
  const machine = beamMat && saw ? saw : post        // чем выпускаются программы этого раскроя
  const r2view = useMemo(() => (r2 ? postView({ ...cnc, post: r2.id }) : null), [cnc, r2?.id])   // eslint-disable-line react-hooks/exhaustive-deps
  // вкладки «Инструменты» и «Обработка» — для постпроцессора, открытого в настройках
  const tview = useMemo(() => postView(cnc), [cnc])
  // открыт шестисторонний станок — на «Инструментах» и «Обработке» его настройки и слои этого заказа
  const open6 = activePost(cnc), drill6Open = isDrill6(open6)
  const layers6 = useMemo(() => (mat && drill6Open ? drill6Layers(mat.details, mat.thickness, open6, parseEdgeTypes(order?.edge_types)) : null), [mat, drill6Open, open6, order?.edge_types])
  const tchange = v => change(postBack(cnc, v))
  const sel = mat ? (picked ?? mat.sheets.map((_, i) => i)) : []
  const toggle = i => { setPicked(sel.includes(i) ? sel.filter(x => x !== i) : [...sel, i].sort((a, b) => a - b)); setBuilt(null) }

  // что не назначено — видно сразу, до создания программы
  const pre = useMemo(() => {
    if (!layers) return []
    const w = [], has = t => (rview.tools || []).some(x => x.id === t), sk = skipOf(rview.ops)
    if (!has(rview.ops.outer.tool)) w.push('контур детали')
    if (layers.cutouts && !sk.contour && !has(rview.ops.cutout.tool)) w.push(`контур выреза (${layers.cutouts} шт.)`)
    if (!sk.face) layers.grooveLayers.forEach(l => { if (!has(grooveOpFor(rview.ops, l.key).tool)) w.push(`пазы ${l.width} × ${l.depth} (${l.count} шт.)`) })
    if (!sk.face) layers.pockets.forEach(l => { if (!has(rview.ops.pockets?.[pocketKey(l.depth)]?.tool)) w.push(`выемки глубиной ${l.depth} (${l.count} шт.)`) })
    if (!sk.holes) layers.holes.forEach(l => { if (!holeToolFor(l, rview)) w.push(`отверстия Ø${l.d} × ${l.depth} (${l.count} шт.)`) })
    return w
  }, [layers, rview])

  // название программы собирается по шаблону постпроцессора (заказ, материал, номер листа… — что выбрал пользователь)
  const nameCtx = n => ({ n, total: mat?.sheets?.length || 0, order, material: mat?.name || order?.material_name || '', thickness: mat?.thickness, client: clientName })
  const baseName = () => programName(post.nameTpl, nameCtx(null))                    // общая часть — для бирок
  const fileBase = kind => fileNameOf(kind, fileNamesOf(user)[kind], nameCtx(null))
  // имя архива «Сохранить все файлы» — конструктор прямо здесь, над папками (та же настройка аккаунта, что в «Имена файлов»)
  const [zipTpl, setZipTpl] = useState(() => fileNamesOf(user).zip)
  const [zipEdit, setZipEdit] = useState(false)
  const changeZipTpl = v => { setZipTpl(v); saveUserSettings({ fileNames: { ...fileNamesOf(user), zip: v } }, user) }   // имена PDF карт и архивов — по настройке аккаунта («Имена файлов»)
  const fileName = si => `${programName(post.nameTpl, nameCtx(si + 1))}.${post.ext || 'nc'}`
  const beamName = () => `${programName(saw?.nameTpl || '{ZAKAZ}_{MAT}', nameCtx(null))}.${saw?.ext || 'xml'}`
  const build = () => {
    if (faults.length) return                              // раскрой с нарушением реза — программы не создаём
    if (beamMat && saw) return buildBeam()
    const files = sel.map(si => {
      const sheet = mat.sheets[si], geo = sheetGeo(order, mat.result, sheet)
      const r = buildSheetGcode({ sheet, geo, details: mat.details, thickness: mat.thickness, cnc: { ...cnc, post: post.id } })
      return { si, name: fileName(si), text: r.text, kinds: r.kinds, opIds: r.opIds, lines: r.lines, warnings: r.warnings, empty: r.empty, zShift: r.zShift, scored: r.scored || 0, time: parseGcode(r.text, { rapid: num(post.rapid) || 20000, zShift: r.zShift }).time }
    })
    // второй раскроечный станок — свой G-код тех же листов (свои инструменты, команды, имя файла)
    const second = r2 ? { post: r2, files: sel.map(si => {
      const sheet = mat.sheets[si], geo = sheetGeo(order, mat.result, sheet)
      const r = buildSheetGcode({ sheet, geo, details: mat.details, thickness: mat.thickness, cnc: { ...cnc, post: r2.id } })
      return { second: true, si, name: `${programName(r2.nameTpl, nameCtx(si + 1))}.${r2.ext || 'nc'}`, text: r.text, kinds: r.kinds, opIds: r.opIds, lines: r.lines, warnings: r.warnings, empty: r.empty, zShift: r.zShift, time: parseGcode(r.text, { rapid: num(r2.rapid) || 20000, zShift: r.zShift }).time }
    }) } : null
    // шестисторонние присадочные станки: файл на каждую деталь материала (по готовой детали, с кромкой)
    const drill = drills.map(p => ({ post: p, ...buildDrill6Files({ mat, order, post: p, labelTpl, makeCode: (si, pi, q) => labelQr({ qr: q }, labelInfo(order, mat, si, pi)) }), folders: drill6Folders(p, nameCtx(null)) }))
    setBuilt({ files, drill, second }); setSaved('')
    // маркировка: файлы маркировочного стола для тех же листов (на линии сначала бирки, потом раскрой)
    const ok = files.filter(f => !f.empty)
    makeLabels(files, ok.map(f => ({ si: f.si, nc: f.name })))
  }
  // Бирки к программам: у станка с маркировочным столом — файлы стола рядом с G-кодом (как было);
  // у станка без него, если отмечено «Бирки вместе с программами», — те же файлы и PDF всех бирок, отдельной папкой
  const makeLabels = (files, sheets) => {
    const table = !!machine?.labelTable
    if (!sheets.length || (!table && !withLabels)) return
    setLabelBusy(true)
    const m = { ...mat }
    // пильный центр: бирки по готовности деталей и в положении выхода со станка (beamSawLabels.js)
    const beamOpts = beamMat && saw ? { seqOf: beamLabelSeq, partOf: (sheet, pi) => beamExitPart(sheet.placed[pi], sheet, saw) } : {}
    Promise.all([
      buildLabelFiles({ order, mat: m, base: baseName(), post: machine, tpl: labelTpl, sheets, ...beamOpts }),
      table ? Promise.resolve(null) : buildLabelsPdf({ order, mat: m, tpl: labelTpl, ...beamOpts }).catch(() => null),
    ])
      .then(([labels, pdf]) => setBuilt(b => (b && b.files === files ? { ...b, labels: pdf ? [...labels, { name: `Birki_${baseName()}.pdf`, data: pdf }] : labels, labelsOwnDir: !table } : b)))
      .catch(() => {})
      .finally(() => setLabelBusy(false))
  }
  // Пильный центр: одна программа XML на материал по выбранным листам (дерево резов), бирки — по галочке
  const buildBeam = () => {
    const sub = { ...mat, sheets: sel.map(si => mat.sheets[si]) }
    let text = '', error = '', xml = null
    try { xml = buildBeamSawXml({ order, mat: sub, geoOf: sh => sheetGeo(order, mat.result, sh) }); text = xml.text } catch (e) { error = String(e?.message || e) }
    const files = [{ si: -1, beam: true, name: beamName(), text: text ? '\uFEFF' + text : '', kinds: [], opIds: [], lines: 0, warnings: error ? [`Программа пилы не собрана: ${error}`] : [
      ...(xml?.droppedOffcuts ? [`Деловых обрезков, отмеченных вручную поперёк реза, — ${xml.droppedOffcuts}: в программу они не вошли (останутся остатком листа)`] : []),
      ...(xml?.wideStrips?.length ? [`Полоса шире максимальной (${xml.maxStrip} мм) после правки карты вручную — ${xml.wideStrips.join('; ')}. Программа собрана; проверьте, возьмёт ли станок такую полосу`] : []),
    ], empty: !text, time: 0 }]
    const drill = drills.map(p => ({ post: p, ...buildDrill6Files({ mat, order, post: p, labelTpl, makeCode: (si, pi, q) => labelQr({ qr: q }, labelInfo(order, mat, si, pi)) }), folders: drill6Folders(p, nameCtx(null)) }))
    setBuilt({ files, drill, second: null, beam: true }); setSaved('')
    // бирки — файлами EMF с именами по кодам деталей программы, рядом с программой (как у программ KDT): станок печатает
    // бирку, когда выдаёт деталь с этим кодом; порядок и положение — как деталь выходит (beamSawLabels.js)
    if (text && withLabels) {
      setLabelBusy(true)
      buildBeamEmfLabels({ order, mat, tpl: labelTpl, rows: xml.rows, offRows: xml.offRows, sheetIdx: i => sel[i], partOf: (sheet, pi) => beamExitPart(sheet.placed[pi], sheet, saw) })
        .then(labels => setBuilt(b => (b && b.files === files ? { ...b, labels, labelsOwnDir: false } : b)))
        .catch(() => {})
        .finally(() => setLabelBusy(false))
    }
  }
  // Созданные программы не теряются при выходе из заказа и приложения: запоминаем, какие листы были созданы,
  // и при возвращении создаём их заново теми же настройками (программа однозначно получается из раскроя и настроек).
  const memKey = `cnc:${user?.id || ''}:${id}`
  useEffect(() => {
    if (restored.current || loading || !cncReady) return
    restored.current = true
    let m = null
    try { m = JSON.parse(localStorage.getItem(memKey) || 'null') } catch { m = null }
    if (!m) return
    if (m.matKey) setMatKey(m.matKey)
    if (Array.isArray(m.picked)) setPicked(m.picked)
    if (m.built) setPendingBuild(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, cncReady])
  useEffect(() => {
    if (!pendingBuild || !mat) return
    setPendingBuild(false)
    if (sel.length && sel.every(i => i < mat.sheets.length)) build()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingBuild, mat, picked])
  useEffect(() => {
    if (!restored.current || pendingBuild) return
    try { localStorage.setItem(memKey, JSON.stringify({ matKey, picked, built: !!built })) } catch { /* без памяти */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [built, picked, matKey, pendingBuild])
  // ?sim=3 — программа основного станка для листа 3, ?sim=2:3 — второго раскроечного
  const sim = (simSi != null && (String(simSi).startsWith('2:')
    ? built?.second?.files.find(f => `2:${f.si}` === simSi && !f.empty)
    : built?.files.find(f => String(f.si) === simSi && !f.empty))) || null
  // пока открыт симулятор — страница под ним не прокручивается
  useEffect(() => {
    if (!sim) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [!!sim])   // eslint-disable-line react-hooks/exhaustive-deps
  const openSim = f => navigate(`?sim=${f.second ? '2:' : ''}${f.si}`)
  const closeSim = () => navigate(-1)
  const [saved, setSaved] = useState('')
  // пометки на заказе в кабинете производства: «G-код создан» и «файлы сохранены»
  const mark = what => { productionMark(id, what).then(r => { if (r.at) setOrder(o => (o ? { ...o, ...(what === 'gcode' ? { gcode_at: r.at, files_saved_at: null } : { files_saved_at: r.at, gcode_at: o.gcode_at || r.at }) } : o)) }) }
  const savedDone = msg => { setSaved(msg); mark('files') }
  // все файлы — отдельными файлами (не архивом): в выбранную папку, а где браузер этого не умеет — загрузками по одному
  // сохранение нескольких файлов — через вопрос «по отдельности или архивом»; сначала маркировка, потом раскрой
  const [saveAsk, setSaveAsk] = useState(null)      // { files, zipName }
  const [xmlView, setXmlView] = useState(null)      // открыт просмотр XML присадки: { title, files }
  const [pdfAsk, setPdfAsk] = useState(false)        // открыт конструктор PDF карт раскроя
  const labelFiles = () => (built.labels || []).map(f => ({ name: f.name, data: f.data }))
  // «Сохранить все файлы» — и фрезер, и шестисторонний станок: в архиве две папки — «<заказ>_<пометка фрезера>»
  // (G-код, маркировка, внутри — папка материала) и «<папка присадки>_<пометка станка>» (XML по деталям)
  // Папки выгрузки — матрёшка, которую пользователь собирает сам: уровни через «/», в каждом — части имени
  // ({ZAKAZ}, {MAT}, …) и свой текст. Своя у фрезера и у каждого шестистороннего станка.
  const pathOf = tpl => String(tpl || '').split('/').map(t => t.trim()).filter(Boolean).map(t => folderName(t, nameCtx(null))).filter(Boolean)
  // по умолчанию — как раньше («папка заказа»/материал); с шестисторонним станком — с пометкой фрезера
  const routerDef = () => routerDirDefault(post, drills.length > 0 || !!r2)
  // второй раскроечный: по умолчанию «<заказ>_CNC_2/<материал>» — чтобы не смешаться с файлами основного станка
  const r2Def = () => `${r2?.folderTpl || '{ZAKAZ}'}_CNC_2/{MAT}`
  const r2Dir = () => pathOf(r2?.dirPath ?? r2Def())
  const routerDir = () => (beamMat && saw ? pathOf(saw.dirPath ?? '{ZAKAZ}/{MAT}') : pathOf(post.dirPath ?? routerDef()))
  // папка бирок для станка без маркировочного стола: та же, что у программ, со словом «Etiketki» в конце
  const labelsDir = () => { const d = routerDir(); return d.length ? [...d.slice(0, -1), `${d[d.length - 1]}_${folderName('Этикетки', nameCtx(null))}`] : [folderName('Этикетки', nameCtx(null))] }
  const drillDir = r => pathOf(r.post.dirPath ?? DRILL_DIR_DEFAULT)
  const setPostPath = (id, v) => change({ ...cnc, posts: cnc.posts.map(q => (q.id === id ? { ...q, dirPath: v } : q)) })
  const saveAll = async () => {
    const rd = routerDir()
    let maps = null
    if (withMaps && mat) {
      // PDF карт по листам этого материала — тем же оформлением, что «PDF карт» (шаблон листа аккаунта)
      setMapsBusy('Готовим карты PDF…')
      try {
        // страница статистики и сметы — как у кнопки «PDF карт» на раскрое (галочка «Смета» под ней): раньше в архив
        // с программами она не попадала, хотя галочка стояла
        let summary = null
        if (getUserSettings(user).pdfEstimate) {
          try {
            const { stats, quote } = await statsAndQuote({ order, mats: [mat], method: order.cutting_method || 'nesting' })
            summary = pdfSummaryOf(stats, quote, getUserSettings(user).pdfSummary || {})
          } catch { summary = null }
        }
        maps = { name: `${fileBase('maps')}.pdf`, data: await buildNestingPdf({ order, mat, summary, tpl: userPdfTpl(user), same: userSameAlpha(user), statsPage: !!getUserSettings(user).pdfStatsPage, onProgress: (a, b) => setMapsBusy(`Карты PDF: ${a} из ${b}`) }), dir: [] }
      } catch { maps = null } finally { setMapsBusy('') }
    }
    const files = [...labelFiles().map(f => ({ ...f, dir: built.labelsOwnDir ? labelsDir() : rd })), ...built.files.filter(f => !f.empty).map(f => ({ name: f.name, data: f.text, dir: rd }))]
    for (const r of built.drill || []) { const dd = drillDir(r); files.push(...r.files.map(f => ({ name: f.name, data: f.data, dir: dd }))) }
    if (built.second) { const d2 = pathOf(built.second.post.dirPath ?? `${built.second.post.folderTpl || '{ZAKAZ}'}_CNC_2/{MAT}`); files.push(...built.second.files.filter(f => !f.empty).map(f => ({ name: f.name, data: f.text, dir: d2 }))) }
    if (maps) files.unshift(maps)          // PDF карт — в корень архива, рядом с папками станков
    setSaveAsk({ files, zipName: `${fileBase('zip')}.zip` })
  }
  const allCount = () => built.files.filter(f => !f.empty).length + (built.labels?.length || 0) + (built.drill || []).reduce((a, r) => a + r.files.length, 0) + (built.second?.files.filter(f => !f.empty).length || 0)
  const simView = useMemo(() => {
    if (!sim || !mat) return null
    const sheet = mat.sheets[sim.si], geo = sheetGeo(order, mat.result, sheet)
    const ox = num(post.originX), oy = num(post.originY)
    const outlines = sheet.placed.map(p => partFeatures(p, mat.details[p.detailIndex], mat.thickness, skipOf(rview.ops)).outline.map(([x, y]) => [ox + geo.marginL + p.x + x, oy + geo.marginB + p.y + y]))
    return { sheet: { x: ox, y: oy, w: geo.sheetW, l: geo.sheetL }, outlines }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sim])
  // ссылка на симуляцию: снимок программы этого листа, открывается без входа
  const [share, setShare] = useState(null)          // null — окно закрыто; { busy, code, error, copied }
  useBackClose(!!share, () => setShare(null))
  useEffect(() => { setShare(null) }, [simSi])
  const openShare = async () => {
    setShare({ busy: true })
    const r = await getSimShare(id, sim.name)
    setShare({ code: r.code || '', error: r.error || '' })
  }
  const makeShare = async () => {
    setShare(x => ({ ...x, busy: true, error: '' }))
    const tools = Object.fromEntries(((simV || rview).tools || []).map(x => [num(x.t), num(x.d)]))
    const payload = packSim({ text: sim.text, kinds: sim.kinds, opIds: sim.opIds, sheet: simView?.sheet, outlines: simView?.outlines, thickness: mat.thickness, rapid: num(simP?.rapid) || 20000, tools, head: simHead, zShift: sim.zShift })
    const r = await saveSimShare(id, sim.name, user.id, payload)
    setShare(x => ({ ...x, busy: false, code: r.code || x.code, error: r.error || '', fresh: !r.error }))
    setLinksTick(t => t + 1)
  }
  const closeShare = async () => {
    if (!window.confirm('Закрыть доступ? Ссылка перестанет открываться.')) return
    const r = await deleteSimShare(share.code)
    setShare(x => (r.error ? { ...x, error: r.error } : { code: '', error: '' }))
    setLinksTick(t => t + 1)
  }
  const copyShare = async () => {
    const url = simShareUrl(share.code)
    try { await navigator.clipboard.writeText(url); setShare(x => ({ ...x, copied: true })) } catch { window.prompt('Скопируйте ссылку', url) }
  }
  // симулятор: диаметры и свёрла головы — того станка, чья программа открыта
  const simV = sim?.second ? r2view : rview, simP = sim?.second ? r2 : post
  const toolDia = useMemo(() => { const m = new Map(((simV || rview).tools || []).map(x => [num(x.t), num(x.d)])); return t => m.get(t) || 0 }, [simV, rview])
  const simHead = useMemo(() => (simP?.drillHead ? ((simV || rview).tools || []).filter(t => t.type === 'drill' && t.inHead).map(t => Math.round(num(t.t))) : []), [simP, simV, rview])

  if (loading) return <div className="page"><CncLoader label="Открываем ЧПУ…" /></div>
  if (!order) return <div className="page"><p>Заказ не найден</p></div>
  const warnings = built ? [...new Set([...built.files.flatMap(f => f.warnings), ...(built.second?.files || []).flatMap(f => f.warnings.map(w => `${built.second.post.name}: ${w}`))])] : []
  const chip = on => ({ flex: '0 0 auto', padding: '7px 12px', borderRadius: 20, border: 'none', fontSize: 13, background: on ? 'var(--blue)' : 'var(--bg)', color: on ? 'white' : 'var(--text-muted)' })
  const small = { padding: '6px 11px', borderRadius: 20, fontSize: 12, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)', whiteSpace: 'nowrap' }

  return (
    <div className="page" style={{ paddingBottom: 100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, paddingTop: 4 }}>
        <button onClick={() => navigate(-1)} style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 22, padding: 0 }}>←</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 500 }}>ЧПУ</div>
          <div style={{ fontSize: 12, color: 'var(--text-hint)' }}><span>{orderTitle(order)}</span>{mat ? ` · ${mat.label}` : ''}</div>
          <ShareBadge orderId={order.id} style={{ marginTop: 3 }} />
        </div>
        {order && <div style={{ display: 'flex', gap: 4, flex: '0 0 auto' }}>{orderMarks(order).map(m => <span key={m.key} title={m.text} style={{ fontSize: 11, lineHeight: '16px', borderRadius: 9, padding: '0 7px', whiteSpace: 'nowrap', border: `0.5px solid ${m.on ? 'var(--blue)' : 'var(--border-md)'}`, background: m.on ? 'var(--blue)' : 'transparent', color: m.on ? 'white' : 'var(--text-hint)' }}>{m.short}</span>)}</div>}
        <button type="button" onClick={toOrders} style={{ flex: '0 0 auto', padding: '6px 11px', borderRadius: 20, fontSize: 12, border: '0.5px solid var(--blue)', background: 'transparent', color: 'var(--blue)', whiteSpace: 'nowrap' }}>К заказам</button>
      </div>
      <div data-tour="cnc-tabs" style={{ display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 12, paddingBottom: 2 }}>
        {TABS.map(([k, l]) => <button key={k} type="button" onClick={() => setTab(k)} style={chip(tab === k)}>{l}{k === 'ops' && pre.length ? ' ⚠' : ''}</button>)}
      </div>

      {tab === 'sheets' && (!mat ? (
        <div className="card"><p style={{ fontSize: 13, color: 'var(--text-muted)' }}>У заказа нет сохранённого раскроя. Откройте раскрой, выберите вариант — и возвращайтесь.</p>
          <button className="btn-primary" style={{ marginTop: 10 }} onClick={() => navigate(`/orders/${id}/nesting`)}>Открыть раскрой</button></div>
      ) : (
        <>
          {mats.length > 1 && (
            <div style={{ marginBottom: 10 }}>
              <label className="label">Материал</label>
              <select value={mat.key} onChange={e => { setMatKey(e.target.value); setPicked(null); setBuilt(null) }}>
                {mats.map(m => <option key={m.key} value={m.key}>{m.label} — листов {m.sheets.length}</option>)}
              </select>
            </div>
          )}
          <div className="card" data-tour="cnc-post" style={{ marginBottom: 10, padding: '10px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--text-muted)' }}>
                {beamMat ? <>
                  <div>Раскрой под пильный центр — постпроцессор: <b style={{ color: 'var(--text)' }}>{saw?.name || '—'}</b></div>
                  <div>Материал: {mat.name || '—'} · {mat.thickness} мм · программа XML на все листы</div>
                </> : <>
                  <div>Постпроцессор: <b style={{ color: 'var(--text)' }}>{post.name}</b></div>
                  <div>Материал: {mat.name || '—'} · {mat.thickness} мм · поле {post.fieldX}×{post.fieldY}</div>
                </>}
              </div>
              <button type="button" style={small} onClick={() => { if (beamMat && saw) change({ ...cnc, post: saw.id }); setTab('basic') }}>Настроить</button>
            </div>
            {/* второй постпроцессор — выбирается прямо здесь, при выпуске программ: любой из своих станков (не для пильного центра) */}
            {/* пильный центр — вторым только шестисторонний (файлы по деталям); раскроечный — любой из своих */}
            {cnc.posts.some(p => (beamMat ? isDrill6(p) : p.id !== post.id && !isBeamSaw(p))) && (() => {
              const sec = secondPost(cnc)
              return (
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: '0.5px solid var(--border)' }}>
                  <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 2 }}>Вместе с ним — второй постпроцессор:</label>
                  <select value={sec?.id || ''} onChange={e => change(setSecondPost(cnc, e.target.value))} style={{ width: '100%', padding: '6px 8px', fontSize: 13 }}>
                    <option value="">— нет —</option>
                    {cnc.posts.filter(p => (beamMat ? isDrill6(p) : p.id !== post.id && !isBeamSaw(p))).map(p => <option key={p.id} value={p.id}>{p.name} — {isDrill6(p) ? 'шестисторонний, XML' : p.drillHead ? 'с присадочной головой, G-код' : 'раскроечный, G-код'}</option>)}
                  </select>
                  {/* что выйдет для шестистороннего станка: расширение и имя файла (= код QR бирки); папки — матрёшка, собирается здесь */}
                  {drills.map(p => {
                    let example
                    try { example = mat?.sheets?.[0]?.placed?.length ? labelQr({ qr: drill6Qr(p, labelTpl) }, labelInfo(order, mat, 0, 0)) : '' } catch { example = '' }
                    return (
                      <div key={'i' + p.id} style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '6px 0 6px', lineHeight: 1.5 }}>
                        <div>Файлы: <b>.{latinExt(p.ext || 'XML')}</b> — по файлу на деталь; имя = код QR бирки, например <b style={{ fontFamily: 'monospace', color: 'var(--text)' }}>{example || '—'}.{latinExt(p.ext || 'XML')}</b></div>
                        <DirPathEditor value={p.dirPath ?? DRILL_DIR_DEFAULT} def={DRILL_DIR_DEFAULT} preview={pathOf(p.dirPath ?? DRILL_DIR_DEFAULT)} onChange={v => setPostPath(p.id, v)} />
                      </div>
                    )
                  })}
                  {r2 && (
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '6px 0 6px', lineHeight: 1.5 }}>
                      <div>{r2.name}: G-код по листам, файлы <b>.{r2.ext || 'nc'}</b>{r2.drillHead ? ' (присадочная голова + шпиндель)' : ''}</div>
                      <DirPathEditor value={r2.dirPath ?? r2Def()} def={r2Def()} preview={r2Dir()} onChange={v => setPostPath(r2.id, v)} />
                    </div>
                  )}
                  {sec && (
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)', paddingTop: 6, borderTop: '0.5px dashed var(--border)' }}>
                      <div>Основной ({post.name}): файлы <b>.{post.ext || 'nc'}</b></div>
                      <DirPathEditor value={post.dirPath ?? routerDef()} def={routerDef()} preview={routerDir()} onChange={v => setPostPath(post.id, v)} />
                      <div style={{ color: 'var(--text-hint)' }}>«Сохранить все файлы» кладёт программы обоих станков в одну выгрузку — каждую в свои папки.</div>
                    </div>
                  )}
                </div>
              )
            })()}
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: '0.5px solid var(--border)', fontSize: 12, color: 'var(--text-muted)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>📦 Архив: <b style={{ fontFamily: 'monospace', color: 'var(--text)', wordBreak: 'break-all' }}>{fileBase('zip')}.zip</b></div>
                <button type="button" style={small} onClick={() => setZipEdit(x => !x)}>{zipEdit ? 'Готово' : 'Изменить'}</button>
              </div>
              {zipEdit && (
                <TplInput value={zipTpl} def={FILE_NAME_DEFAULTS.zip} parts={FILE_NAME_PARTS} onChange={changeZipTpl} style={{ marginTop: 6 }}
                  hint={<div style={{ fontSize: 10.5, color: 'var(--text-hint)', marginTop: 4 }}>Имя архива «Сохранить все файлы». Внутри — PDF карт (если отмечено) и папки станков. Латиницей; пустая часть (нет клиента) пропускается.</div>} />
              )}
            </div>
          </div>
          <SimLinksBox orderId={id} refresh={linksTick} style={{ marginBottom: 10, padding: '10px 12px' }} />
          {pre.length > 0 && !beamMat && (
            <div className="card" style={{ marginBottom: 10, border: '1px solid var(--amber)', background: 'var(--amber-light)', padding: '10px 12px' }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--amber)', marginBottom: 4 }}>⚠ Не назначен инструмент</div>
              {pre.map(w => <div key={w} style={{ fontSize: 12, color: 'var(--text-muted)' }}>· {w}</div>)}
              <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 4 }}>Программу создать можно — эти операции в неё не попадут.</div>
              <button type="button" style={{ ...small, marginTop: 6 }} onClick={() => setTab((cnc.tools || []).length ? 'ops' : 'tools')}>{(cnc.tools || []).length ? 'Назначить' : 'Создать инструменты'}</button>
            </div>
          )}
          <div data-tour="cnc-sheets" style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
            <p className="section-title" style={{ marginBottom: 0, flex: 1 }}>Листы ({sel.length} из {mat.sheets.length})</p>
            <button type="button" style={{ ...small, marginRight: 6 }} title="Карты раскроя: листы с деталями, размерами и кромкой; на последней странице — статистика раскроя и стоимость работ (что выводить, выбираете сами)"
              onClick={() => setPdfAsk(true)}>PDF карт</button>
            {mat.result?.beamSaw && (
              <button type="button" style={{ ...small, marginRight: 6 }} title="β Программа для пильного центра KDT: XML с деревом резов — по всем листам этого материала"
                onClick={() => saveBeamSawXml({ order, mat, geoOf: sh => sheetGeo(order, mat.result, sh) }).catch(e => window.alert('Не удалось собрать XML для пилы: ' + (e?.message || e)))}>XML пилы</button>
            )}
            <button type="button" style={small} onClick={() => { setPicked(sel.length === mat.sheets.length ? [] : null); setBuilt(null) }}>{sel.length === mat.sheets.length ? 'Снять все' : 'Выбрать все'}</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
            {mat.sheets.map((sh, i) => {
              const g = sheetGeo(order, mat.result, sh), on = sel.includes(i), f = built?.files.find(x => x.si === i), f2 = built?.second?.files.find(x => x.si === i)
              return (
                <div key={i} className="card" style={{ padding: '9px 12px', borderColor: on ? 'var(--blue)' : undefined }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                    <input type="checkbox" checked={on} onChange={() => toggle(i)} style={{ width: 20, height: 20, flex: '0 0 auto' }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 500 }}>{sh.stock === 'offcut' ? 'Обрезок' : 'Лист'} {i + 1}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>{g.sheetL}×{g.sheetW} · деталей {sh.placed.length}</div>
                    </div>
                  </label>
                  {f && (
                    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '0.5px solid var(--border)' }}>
                      <div style={{ fontSize: 12, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 6 }}>{f.empty ? 'пусто — нет назначенных инструментов' : `${f.lines} строк · ≈ ${fmtTime(f.time)}${f.scored ? ` · шинковка: ${f.scored} надс.` : ''}`}</div>
                      {!f.empty && (
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button type="button" onClick={() => openSim(f)} style={{ ...small, background: 'var(--blue-light)', color: 'var(--blue-dark)', borderColor: 'var(--blue)' }}>▶ Симулятор</button>
                          <button type="button" onClick={() => { download(f.name, f.text); mark('files') }} style={{ ...small, background: 'var(--teal-light)', color: 'var(--teal)', borderColor: 'var(--teal)' }}>⬇ Скачать</button>
                        </div>
                      )}
                    </div>
                  )}
                  {f2 && (
                    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '0.5px dashed var(--border)' }}>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{built.second.post.name}</div>
                      <div style={{ fontSize: 12, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f2.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 6 }}>{f2.empty ? 'пусто — у этого станка не назначены инструменты' : `${f2.lines} строк · ≈ ${fmtTime(f2.time)}`}</div>
                      {!f2.empty && (
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button type="button" onClick={() => openSim(f2)} style={{ ...small, background: 'var(--blue-light)', color: 'var(--blue-dark)', borderColor: 'var(--blue)' }}>▶ Симулятор</button>
                          <button type="button" onClick={() => { download(f2.name, f2.text); mark('files') }} style={{ ...small, background: 'var(--teal-light)', color: 'var(--teal)', borderColor: 'var(--teal)' }}>⬇ Скачать</button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          {warnings.length > 0 && (
            <div className="card" style={{ marginBottom: 10, border: '1px solid var(--amber)', padding: '10px 12px' }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--amber)', marginBottom: 4 }}>Предупреждения</div>
              {warnings.map(w => <div key={w} style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 2 }}>· {w}</div>)}
            </div>
          )}
          {machine?.labelTable && (
            <p style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 10 }}>
              🏷 Вместе с G-кодом будут созданы файлы маркировочного стола (бирка {labelTpl.w}×{labelTpl.h} мм).{' '}
              <span style={{ color: 'var(--blue)', cursor: 'pointer' }} onClick={() => navigate(`/orders/${id}/labels`)}>Шаблон бирки</span>
              {' · '}<span style={{ color: 'var(--blue)', cursor: 'pointer' }} onClick={() => setTab('basic')}>отключить</span>
            </p>
          )}
          {faults.length > 0 && (
            <div style={{ padding: 8, marginBottom: 8, borderRadius: 'var(--radius)', background: 'rgba(220,53,69,0.08)', border: '1px solid rgba(220,53,69,0.4)' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#dc3545', marginBottom: 4 }}>⛔ {FAULT_TITLE}</div>
              {faults.slice(0, 10).map((e, i) => <div key={i} style={{ fontSize: 11, color: '#a71d2a', padding: '1px 0' }}>• {e}</div>)}
              <div style={{ fontSize: 11, color: '#a71d2a', marginTop: 5, fontWeight: 500 }}>G-код не создаётся. Откройте раскрой и исправьте раскладку или верните заказ заказчику на доработку.</div>
              <button type="button" className="btn-secondary" style={{ marginTop: 6 }} onClick={() => navigate(`/orders/${id}/nesting`)}>Открыть раскрой</button>
            </div>
          )}
          {/* у станка без маркировочного стола — бирки вместе с программами, отдельной папкой */}
          {!machine?.labelTable && (
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, marginBottom: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={withLabels} onChange={e => setWithLabels(e.target.checked)} style={{ width: 18, height: 18, flex: '0 0 auto', marginTop: 1 }} />
              <span>🏷 Бирки вместе с программами
                <span style={{ display: 'block', fontSize: 11, color: 'var(--text-hint)' }}>{beamMat && saw ? <>Пильный центр: бирка на каждую деталь файлом EMF с именем по коду детали (1.emf, 2.emf …) — в папке программы: <b style={{ fontFamily: 'monospace' }}>{routerDir().join(' / ')}</b>.</> : <>Файлы бирок и PDF всех бирок для печати — отдельной папкой рядом с программами: <b style={{ fontFamily: 'monospace' }}>{labelsDir().join(' / ')}</b>.</>} <span style={{ color: 'var(--blue)', cursor: 'pointer' }} onClick={e => { e.preventDefault(); navigate(`/orders/${id}/labels`) }}>Шаблон бирки</span></span>
              </span>
            </label>
          )}
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, marginBottom: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={withMaps} onChange={e => setWithMaps(e.target.checked)} style={{ width: 18, height: 18, flex: '0 0 auto', marginTop: 1 }} />
            <span>📄 Карты раскроя (PDF) вместе с программами
              <span style={{ display: 'block', fontSize: 11, color: 'var(--text-hint)' }}>При «Сохранить все файлы» — PDF карт всех листов материала — в самый верх архива, рядом с папками станков: <b style={{ fontFamily: 'monospace' }}>{fileBase('maps')}.pdf</b>. Для тех, кто печатает карты.</span>
            </span>
          </label>
          {mapsBusy && <CncLoader compact label={mapsBusy} />}
          <button data-tour="cnc-build" className="btn-primary" disabled={!sel.length || faults.length > 0 || (beamMat && !saw)} onClick={() => { if (faults.length) return; build(); mark('gcode') }}>{beamMat ? (built ? '↻ Создать программу пилы заново' : `Создать программу пилы (XML${drills.length ? ' + присадка' : ''})`) : built ? (drills.length || r2 ? '↻ Создать программы заново' : '↻ Создать G-код заново') : r2 ? `Создать программы (${post.name} + ${r2.name})` : (drills.length ? `Создать программы (G-код + ${drills.length > 1 ? 'присадка ×' + drills.length : 'присадка'})` : 'Создать G-код')}</button>
          {built?.beam && built.files.map(f => (
            <div key={f.name} className="card" style={{ marginTop: 8, padding: '9px 12px' }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>🪚 {saw?.name || 'Пильный центр'}</div>
              <div style={{ fontSize: 11, color: f.empty ? 'var(--danger)' : 'var(--text-hint)', marginBottom: 6 }}>
                {f.empty ? f.warnings.join(' ') : `Программа XML: листов ${sel.length}, файл ${f.name}. Папка: ${routerDir().join(' / ') || '—'}.`}
              </div>
              {!f.empty && <button type="button" onClick={() => { download(f.name, f.text, 'application/xml'); mark('files') }} style={{ ...small, background: 'var(--teal-light)', color: 'var(--teal)', borderColor: 'var(--teal)' }}>⬇ {f.name}</button>}
            </div>
          ))}
          {labelBusy && <CncLoader compact label="Рисуем бирки…" />}
          {built?.labels?.length > 0 && (
            <div className="card" style={{ marginTop: 8, padding: '9px 12px' }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>{built.beam || built.labelsOwnDir ? 'Бирки' : 'Маркировочный стол'}</div>
              <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 6 }}>
                {built.beam
                  ? <>Файлов: {built.labels.length} — бирка на каждую деталь (1.emf, 2.emf … по коду детали в программе) и на деловые обрезки (OC1.emf …), рядом с программой пилы: <b style={{ fontFamily: 'monospace' }}>{routerDir().join(' / ')}</b>. Станок печатает бирку, когда выдаёт деталь.</>
                  : built.labelsOwnDir
                  ? <>Файлов: {built.labels.length} — картинки бирок, бирки по листам, список листов и PDF всех бирок для печати. Папка: <b style={{ fontFamily: 'monospace' }}>{labelsDir().join(' / ')}</b>.</>
                  : <>Файлов: {built.labels.length} — список листов (List), бирки по листам (Label_N.cyc), картинки бирок и листов. На линии сначала идёт маркировка, затем раскрой.</>}
              </div>
              <button type="button" onClick={() => setSaveAsk({ files: labelFiles(), zipName: `Birki_${fileBase('zip')}.zip`, ...(built.beam ? { folders: routerDir() } : built.labelsOwnDir ? { folders: labelsDir() } : {}) })} style={{ ...small, background: 'var(--teal-light)', color: 'var(--teal)', borderColor: 'var(--teal)' }}>⬇ Сохранить файлы маркировки</button>
            </div>
          )}
          {built?.drill?.map(r => (
            <div key={r.post.id} className="card" style={{ marginTop: 8, padding: '9px 12px' }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>⬡ {r.post.name}</div>
              <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 6 }}>
                {r.files.length ? `Файлов: ${r.files.length} — по одному на каждую деталь с биркой; имя файла = код детали (${r.post.d6Name === 'own' ? 'своё имя' : 'код QR бирки'}): ${r.files[0].name}${r.files.length > 1 ? ' …' : ''}. Папка: ${drillDir(r).join(' / ') || '—'}.` : 'Нет деталей с обработкой.'}
                {r.skipped > 0 ? ` Без обработки: ${r.skipped} — не выводятся.` : ''}
              </div>
              {r.warnings.length > 0 && (
                <details style={{ marginBottom: 6 }}>
                  <summary style={{ fontSize: 11, color: 'var(--amber)', cursor: 'pointer' }}>Предупреждения: {r.warnings.length}</summary>
                  {r.warnings.slice(0, 30).map(w => <div key={w} style={{ fontSize: 11, color: 'var(--text-muted)' }}>· {w}</div>)}
                </details>
              )}
              {r.files.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button type="button" onClick={() => setXmlView({ title: r.post.name, files: r.files })} style={{ ...small, background: 'var(--blue-light)', color: 'var(--blue-dark)', borderColor: 'var(--blue)' }}>👁 Просмотр</button>
                  <button type="button" onClick={() => setSaveAsk({ files: r.files.map(f => ({ name: f.name, data: f.data })), zipName: `${safeName(r.post.name) || 'drill6'}_${fileBase('zip')}.zip`, folders: drillDir(r) })}
                    style={{ ...small, background: 'var(--teal-light)', color: 'var(--teal)', borderColor: 'var(--teal)' }}>⬇ Сохранить файлы ({r.files.length})</button>
                  {r.files.length === 1 && <button type="button" onClick={() => { download(r.files[0].name, r.files[0].data, 'text/xml'); mark('files') }} style={small}>⬇ {r.files[0].name}</button>}
                </div>
              )}
            </div>
          ))}
          {built && allCount() > 1 && (
            <>
              <button data-tour="cnc-save" className="btn-secondary" style={{ marginTop: 8 }} onClick={saveAll} disabled={!!mapsBusy}>⬇ Сохранить все файлы ({allCount() + (withMaps ? 1 : 0)})</button>
              {((built.drill || []).some(r => r.files.length) || built.second || withMaps) && (
                <p style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 4 }}>
                  В архиве <b style={{ fontFamily: 'monospace' }}>{fileBase('zip')}.zip</b>: {withMaps && <><b style={{ fontFamily: 'monospace' }}>{fileBase('maps')}.pdf</b>; </>}папки: <b style={{ fontFamily: 'monospace' }}>{routerDir()[0]}</b> — фрезер (G-код{built.labels?.length ? ', маркировка' : ''}){(built.drill || []).filter(r => r.files.length).map(r => <span key={r.post.id}>; <b style={{ fontFamily: 'monospace' }}>{drillDir(r).join('/')}</b> — {r.post.name}</span>)}{built.second && <span>; <b style={{ fontFamily: 'monospace' }}>{pathOf(built.second.post.dirPath ?? `${built.second.post.folderTpl || '{ZAKAZ}'}_CNC_2/{MAT}`).join('/')}</b> — {built.second.post.name}</span>}
                </p>
              )}
            </>
          )}
          {saved && built && <p style={{ fontSize: 12, color: 'var(--teal)', marginTop: 6, textAlign: 'center' }}>{saved}</p>}
          {saved && built && <button type="button" className="btn-secondary" style={{ marginTop: 8 }} onClick={toOrders}>← Перейти к заказам</button>}
        </>
      ))}
      {(tab === 'tools' || tab === 'ops') && drill6Open && <Drill6Ops cnc={cnc} onChange={change} isMaster={isMaster} part={tab} layers={layers6} />}
      {tab === 'ops' && !drill6Open && <CncOps cnc={tview} onChange={tchange} layers={layers} />}
      {tab === 'tools' && !drill6Open && <CncTools cnc={tview} onChange={tchange} />}
      {tab !== 'sheets' && <PostPicker cnc={cnc} onChange={change} isMaster={isMaster} />}
      {tab === 'basic' && <CncBasic cnc={cnc} onChange={change} isMaster={isMaster} />}
      {tab === 'cmd' && <CncCommands cnc={cnc} onChange={change} isMaster={isMaster} />}

      {/* симулятор — поверх всего экрана: выносится прямо в body (иначе при прокрученной странице снизу виднелось окно заказа) */}
      {sim && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'var(--bg)', zIndex: 1100, padding: 10, boxSizing: 'border-box', height: '100dvh', overscrollBehavior: 'contain' }}>
          <div style={{ maxWidth: 1100, margin: '0 auto', height: '100%' }}>
            <Suspense fallback={<CncLoader label="Запускаем симулятор…" />}>
              <GcodeSimulator key={sim.name} text={sim.text} kinds={sim.kinds} opIds={sim.opIds} title={sim.name} thickness={mat.thickness} rapid={num(simP?.rapid) || 20000} zShift={sim.zShift}
                toolDia={toolDia} headTools={simHead} onClose={closeSim} onDownload={() => { download(sim.name, sim.text); mark('files') }} onShare={openShare} sheet={simView?.sheet} outlines={simView?.outlines} />
            </Suspense>
          </div>
        </div>, document.body
      )}
      {sim && share && createPortal(
        <div onClick={() => setShare(null)} style={{ position: 'fixed', inset: 0, zIndex: 1150, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div onClick={e => e.stopPropagation()} className="card" style={{ width: '100%', maxWidth: 480, borderRadius: '16px 16px 0 0', paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
              <div style={{ flex: 1, fontWeight: 500 }}>Ссылка на симуляцию</div>
              <button type="button" onClick={() => setShare(null)} style={{ background: 'none', border: 'none', fontSize: 22, color: 'var(--text-muted)', padding: 0 }}>×</button>
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>По ссылке симуляция этого листа открывается без входа в приложение — только просмотр. Ссылка хранит снимок программы: после изменения настроек или раскроя обновите её.</p>
            {share.error && <p className="error-text" style={{ marginBottom: 8 }}>{share.error}</p>}
            {share.busy && !share.code ? <p style={{ fontSize: 13, color: 'var(--text-hint)' }}>Подождите…</p> : share.code ? (
              <>
                <input readOnly value={simShareUrl(share.code)} onFocus={e => e.target.select()} style={{ fontSize: 13, marginBottom: 8 }} />
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button type="button" className="btn-primary" style={{ flex: 1, padding: 10, fontSize: 14 }} onClick={copyShare}>{share.copied ? '✓ Скопировано' : 'Копировать'}</button>
                  {navigator.share && <button type="button" className="btn-secondary" style={{ flex: 1, padding: 10, fontSize: 14 }} onClick={() => navigator.share({ title: sim.name, url: simShareUrl(share.code) }).catch(() => {})}>Поделиться</button>}
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <button type="button" className="btn-secondary" style={{ flex: 1, padding: 9, fontSize: 13 }} disabled={share.busy} onClick={makeShare}>{share.busy ? 'Обновление…' : share.fresh ? '✓ Снимок обновлён' : '↻ Обновить снимок'}</button>
                  <button type="button" onClick={closeShare} style={{ flex: 1, padding: 9, fontSize: 13, background: 'transparent', border: '1px solid var(--danger)', color: 'var(--danger)', borderRadius: 'var(--radius)' }}>Закрыть доступ</button>
                </div>
              </>
            ) : (
              <button type="button" className="btn-primary" disabled={share.busy} onClick={makeShare}>{share.busy ? 'Создание…' : '🔗 Создать ссылку'}</button>
            )}
          </div>
        </div>, document.body
      )}
      {xmlView && <Drill6Viewer title={xmlView.title} files={xmlView.files} onClose={() => setXmlView(null)} />}
      {pdfAsk && mat && <PdfSetup order={order} mat={mat} method={order?.cutting_method || 'nesting'} fileName={`${fileBase('maps')}.pdf`} onClose={() => setPdfAsk(false)} />}
      {saveAsk && <SaveFilesDialog files={saveAsk.files} zipName={saveAsk.zipName} onClose={() => setSaveAsk(null)} onDone={savedDone}
        folders={saveAsk.folders || routerDir()} />}
      <BottomNav />
    </div>
  )
}
