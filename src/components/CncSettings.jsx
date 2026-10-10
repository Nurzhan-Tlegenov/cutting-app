import { LABEL_POS, getLabelTpl, QR_PARTS, labelQr } from '../lib/labelMaker'
import QrPartsEditor from './QrPartsEditor'
import { D6_QR_DEFAULT, D6_FOLDER_DEFAULT, drill6Folders } from '../lib/drill6Xml'
import { useAuth } from '../context/AuthContext'
import { NAME_PARTS, NAME_TPL_DEFAULT, programName, FOLDER_PARTS, FOLDER_TPL_DEFAULT, folderName } from '../lib/orderUtils'
import { useState } from 'react'
import { DEFAULT_MILL, DEFAULT_DRILL, DEFAULT_POST, DEFAULT_DRILL6, KINDS, isDrill6, activePost, routerPost, pickPost, toggleUse6, newId } from '../lib/cncSettings'
import { holeToolFor, grooveOpFor } from '../lib/gcode'

// Вкладки настроек ЧПУ: «Основные» и «Команды» (постпроцессор), «Инструменты» (база), «Обработка» (контуры).
// cnc — настройки целиком, onChange(cnc) — сохранить.

const num = v => { const x = Number(String(v ?? '').replace(',', '.')); return isFinite(x) ? x : 0 }
const r1 = v => String(Math.round(num(v) * 10) / 10)

function Num({ label, value, onChange, unit, hint }) {
  return (
    <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', minWidth: 0 }}>
      {label}{unit ? <span style={{ color: 'var(--text-hint)' }}>, {unit}</span> : null}
      <input type="text" inputMode="decimal" key={String(value ?? '')} defaultValue={value ?? ''}
        onBlur={e => { const s = e.target.value.replace(',', '.').trim(); const v = s === '' || !isFinite(Number(s)) ? '' : Number(s); if (v !== (value ?? '')) onChange(v) }}
        style={{ marginTop: 3, padding: '8px 10px' }} />
      {hint && <span style={{ display: 'block', fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>{hint}</span>}
    </label>
  )
}
// число со знаком: на телефонной цифровой клавиатуре минуса часто нет — знак меняется кнопкой «±»
function SignedNum({ label, value, onChange, unit }) {
  const v = Number(value) || 0
  return (
    <div style={{ minWidth: 0 }}>
      <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)' }}>{label}{unit ? <span style={{ color: 'var(--text-hint)' }}>, {unit}</span> : null}</span>
      <div style={{ display: 'flex', gap: 4, marginTop: 3 }}>
        <button type="button" title="Сменить знак" onClick={() => onChange(-v)}
          style={{ flex: '0 0 40px', border: '0.5px solid var(--border-md)', borderRadius: 'var(--radius)', background: v < 0 ? 'var(--amber-light)' : 'var(--bg2)', color: 'var(--text)', fontSize: 16, cursor: 'pointer' }}>{v < 0 ? '−' : '+'}</button>
        <input type="text" inputMode="decimal" key={String(v)} defaultValue={v ? String(Math.abs(v)).replace('.', ',') : ''} placeholder="0"
          onBlur={e => { const s = e.target.value.replace(',', '.').trim(); const n = s === '' || !isFinite(Number(s)) ? 0 : Number(s); const out = s.startsWith('-') ? n : (v < 0 ? -Math.abs(n) : Math.abs(n)); if (out !== v) onChange(out) }}
          style={{ flex: 1, minWidth: 0, padding: '8px 10px' }} />
      </div>
    </div>
  )
}
function Seg({ value, options, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {options.map(([v, l]) => (
        <button key={v} type="button" onClick={() => onChange(v)}
          style={{ flex: 1, padding: '7px 6px', borderRadius: 'var(--radius)', fontSize: 12, border: '0.5px solid ' + (value === v ? 'var(--blue)' : 'var(--border-md)'), background: value === v ? 'var(--blue-light)' : 'var(--bg)', color: value === v ? 'var(--blue-dark)' : 'var(--text-muted)' }}>{l}</button>
      ))}
    </div>
  )
}
const toolLabel = t => `T${t.t} · ${t.name || (t.type === 'mill' ? 'Фреза' : 'Сверло')} Ø${r1(t.d)}`
function ToolSelect({ cnc, value, onChange, only, auto, maxD, empty }) {
  // maxD — диаметр отверстия: инструмент больше него выбрать нельзя
  const list = (cnc.tools || []).filter(t => (!only || t.type === only) && (!(maxD > 0) || num(t.d) <= maxD + 0.05))
  const lost = value && value !== 'none' && !list.some(t => t.id === value)
  return (
    <select value={lost ? '' : value || ''} onChange={e => onChange(e.target.value)} style={{ padding: '8px 10px', fontSize: 14, borderColor: !auto && !empty && (!value || lost) ? 'var(--amber)' : undefined }}>
      <option value="">{empty || (auto ? `Авто${auto === true ? '' : ': ' + auto}` : '— не назначен —')}</option>
      {auto && <option value="none">Не обрабатывать</option>}
      {list.map(t => <option key={t.id} value={t.id}>{toolLabel(t)}</option>)}
    </select>
  )
}
const Hint = ({ children }) => <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: '4px 0 0' }}>{children}</p>
const Title = ({ children }) => <div style={{ fontWeight: 500, fontSize: 14, marginBottom: 8 }}>{children}</div>

// ─── А. Основные ────────────────────────────────────────────────────────────
export function CncBasic({ cnc, onChange, isMaster = false }) {
  const { user } = useAuth()
  const labelSize = (() => { const t = getLabelTpl(user); return { w: Number(t?.w) || 0, h: Number(t?.h) || 0 } })()
  const post = activePost(cnc)
  const foreign = !!post.shared && !isMaster          // общий постпроцессор: правка делает свою копию
  const set = patch => {
    if (foreign) { const p = { ...post, ...patch, id: newId(), shared: false, forAll: false, ownerId: undefined, name: patch.name || post.name + ' (мой)' }; onChange({ ...cnc, posts: [...cnc.posts, p], post: p.id }); return }
    onChange({ ...cnc, posts: cnc.posts.map(p => (p.id === post.id ? { ...p, ...patch } : p)) })
  }
  const add = kind => {
    const p = kind === 'drill6' ? { ...DEFAULT_DRILL6(), name: `Шестисторонний ${cnc.posts.filter(isDrill6).length + 1}` } : { ...DEFAULT_POST(), name: `Постпроцессор ${cnc.posts.length + 1}` }
    // новый присадочный сразу включён в выпуск — его и добавляют, чтобы выпускать программы
    onChange({ ...(kind === 'drill6' ? toggleUse6(cnc, p.id, true) : cnc), posts: [...cnc.posts, p], post: p.id })
  }
  const drill = isDrill6(post)
  const routers = cnc.posts.filter(p => !isDrill6(p)), drills = cnc.posts.filter(isDrill6)
  const router = routerPost(cnc)
  const setKind = kind => {
    if (kind === post.kind || (kind === 'drill6') === drill) return
    if (!drill && routers.length < 2) { window.alert('Это единственный раскроечный станок. Чтобы добавить присадочный, нажмите «+ Присадочный».'); return }
    set(kind === 'drill6' ? { kind, ext: 'XML', nameTpl: '{NOMER}_{ZAKAZ}' } : { kind: 'router', ext: 'nc', nameTpl: NAME_TPL_DEFAULT })
  }
  const copy = () => { const p = { ...post, id: newId(), shared: false, forAll: false, ownerId: undefined, name: post.name + ' (копия)' }; onChange({ ...cnc, posts: [...cnc.posts, p], post: p.id }) }
  const del = () => {
    if (foreign || cnc.posts.length < 2) return
    if (!isDrill6(post) && !cnc.posts.some(p => p.id !== post.id && !isDrill6(p))) { window.alert('Это единственный раскроечный станок — его удалить нельзя.'); return }
    if (!window.confirm(`Удалить постпроцессор «${post.name}»?`)) return
    const posts = cnc.posts.filter(p => p.id !== post.id)
    onChange({ ...toggleUse6(cnc, post.id, false), posts, post: posts[0].id, router: cnc.router === post.id ? '' : cnc.router })
  }
  const small = { padding: '6px 10px', borderRadius: 20, fontSize: 12, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)' }
  return (
    <>
      <div className="card" style={{ marginBottom: 10 }}>
        <Title>Постпроцессор</Title>
        <select value={post.id} onChange={e => onChange(pickPost(cnc, e.target.value))} style={{ marginBottom: 8 }}>
          {cnc.posts.map(p => <option key={p.id} value={p.id}>{isDrill6(p) ? '⬡ ' : ''}{p.name}{p.shared || p.forAll ? ' · общий' : ''}</option>)}
        </select>
        <label className="label">Тип станка</label>
        <div style={{ marginBottom: 8 }}><Seg value={drill ? 'drill6' : 'router'} options={KINDS.map(([k]) => [k, k === 'drill6' ? 'Присадочный 6-стор.' : 'Раскроечный'])} onChange={setKind} /></div>
        <label className="label">Название</label>
        <input type="text" key={post.id} defaultValue={post.name} onBlur={e => { const v = e.target.value.trim(); if (v && v !== post.name) set({ name: v }) }} />
        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <button type="button" style={small} onClick={() => add('router')}>+ Раскроечный</button>
          <button type="button" style={small} onClick={() => add('drill6')}>+ Присадочный</button>
          <button type="button" style={small} onClick={copy}>Копия</button>
          {!foreign && cnc.posts.length > 1 && <button type="button" style={{ ...small, color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={del}>Удалить</button>}
        </div>
        {isMaster && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 10, cursor: 'pointer' }}>
            <input type="checkbox" checked={!!post.forAll || !!post.shared} onChange={e => set({ forAll: e.target.checked, shared: false })} style={{ width: 18, height: 18 }} />
            Для всех — постпроцессор виден всем пользователям
          </label>
        )}
        {foreign && <Hint>Это общий постпроцессор. Если изменить его настройки — у вас появится своя копия, общий останется как есть.</Hint>}
        <Hint>Постпроцессор — это станок: его поле, высоты и команды. Инструменты и обработка контуров — общие для раскроечных станков.</Hint>
      </div>
      {/* выпуск программ: одним раскроечным станком (G-код по листам) и сразу несколькими присадочными (файлы по деталям) */}
      <div className="card" style={{ marginBottom: 10 }}>
        <Title>Выпускать программы одновременно</Title>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Раскрой — G-код по листам:</div>
        {routers.map(p => (
          <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '3px 0', cursor: 'pointer' }}>
            <input type="radio" name="routerPost" checked={router?.id === p.id} onChange={() => onChange({ ...cnc, router: p.id })} style={{ width: 18, height: 18 }} />
            {p.name}
          </label>
        ))}
        <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '8px 0 4px' }}>Присадка — шестисторонний станок, файл на каждую деталь:</div>
        {!drills.length && <div style={{ fontSize: 12, color: 'var(--text-hint)' }}>Нет присадочных станков — добавьте кнопкой «+ Присадочный».</div>}
        {drills.map(p => (
          <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '3px 0', cursor: 'pointer' }}>
            <input type="checkbox" checked={(cnc.use6 || []).includes(p.id)} onChange={e => onChange(toggleUse6(cnc, p.id, e.target.checked))} style={{ width: 18, height: 18 }} />
            {p.name}
          </label>
        ))}
        <Hint>Кнопка «Создать программы» в заказе выпускает G-код выбранным раскроечным станком и, вместе с ним, файлы для каждого отмеченного присадочного.</Hint>
      </div>
      {drill && <Drill6Basic post={post} set={set} router={router} />}
      {!drill && <>
      <div className="card" style={{ marginBottom: 10 }}>
        <Title>Маркировочный стол</Title>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={!!post.labelTable} onChange={e => set({ labelTable: e.target.checked })} style={{ width: 18, height: 18, flex: '0 0 auto', marginTop: 1 }} />
          Создавать файлы для маркировочного стола
        </label>
        {post.labelTable && (
          <div style={{ marginTop: 10 }}>
            {/* размер бирки — из шаблона бирок, здесь только для справки */}
            <div style={{ fontSize: 12, color: 'var(--text-muted)', background: 'var(--bg2)', borderRadius: 'var(--radius)', padding: '7px 10px', marginBottom: 8 }}>
              Бирка по шаблону: ширина <b>{labelSize.w}</b> мм, высота <b>{labelSize.h}</b> мм. На столе она клеится шириной вдоль Y и высотой вдоль X: по X — {labelSize.h} мм, по Y — {labelSize.w} мм.
              <span style={{ display: 'block', fontSize: 11, color: 'var(--text-hint)' }}>Размер меняется в шаблоне бирок.</span>
            </div>
            <label className="label">Положение бирки на детали</label>
            <select value={post.labelPos || 'center'} onChange={e => set({ labelPos: e.target.value })} style={{ marginBottom: 4 }}>
              {LABEL_POS.map(([k, l]) => <option key={k} value={k}>{l}{k === 'center' ? '' : ' угол'}</option>)}
            </select>
            <Hint>Углы — как деталь лежит на столе: «нижний» — ближе к нулю по Y, «левый» — ближе к нулю по X. В углу бирка ставится целиком на деталь, краем по её краю. У фигурной детали берётся угол её габарита — там может не оказаться материала, тогда оставьте середину.</Hint>
            <div style={{ fontSize: 13, fontWeight: 500, margin: '10px 0 4px' }}>Коррекция положения бирки</div>
            <div className="row2">
              <SignedNum label="По X" unit="мм" value={post.labelDX} onChange={v => set({ labelDX: v })} />
              <SignedNum label="По Y" unit="мм" value={post.labelDY} onChange={v => set({ labelDY: v })} />
            </div>
            <Hint>Если стол клеит бирку со сдвигом, укажите, на сколько её переместить: «+» — в сторону увеличения координаты (от нуля стола), «−» — к нулю. Например, бирка ложится на 5 мм дальше по Y, чем нужно, — поставьте по Y «−» 5. Коррекция считается от выбранного положения бирки (середины или угла) и сдвигает все бирки во всех файлах стола; на программу раскроя это не влияет.</Hint>
          </div>
        )}
        <Hint>Для станков со маркировочным столом. Когда включено, при создании G-кода вместе с управляющими программами становятся доступны файлы бирок: список листов (List_….xml), бирки по листам (Label_N_….cyc) и картинки бирок. Вид бирки настраивается в заказе, в разделе «Бирки».</Hint>
      </div>
      <div className="card" style={{ marginBottom: 10 }}>
        <Title>Рабочее поле станка</Title>
        <div className="row2">
          <Num label="Поле X" unit="мм" value={post.fieldX} onChange={v => set({ fieldX: v })} />
          <Num label="Поле Y" unit="мм" value={post.fieldY} onChange={v => set({ fieldY: v })} />
        </div>
        <div className="row2" style={{ marginTop: 8 }}>
          <Num label="Начало X" unit="мм" value={post.originX} onChange={v => set({ originX: v })} />
          <Num label="Начало Y" unit="мм" value={post.originY} onChange={v => set({ originY: v })} />
        </div>
        <Hint>Начало — где на станке лежит левый нижний угол листа. X — ширина листа, Y — длина. Обработка идёт от этой точки в пределах поля.</Hint>
        <div className="row2" style={{ marginTop: 8 }}>
          <Num label="Конечное положение X" unit="мм" value={post.endX} onChange={v => set({ endX: v })} />
          <Num label="Конечное положение Y" unit="мм" value={post.endY} onChange={v => set({ endY: v })} />
        </div>
        <Hint>Куда уходит шпиндель в конце программы (на высоте безопасности). По умолчанию X0 Y0. Пустое поле — не уходить.</Hint>
      </div>
      <div className="card" style={{ marginBottom: 10 }}>
        <Title>Скругления и дуги</Title>
        <Seg value={post.arcs === 'ij' ? 'ij' : 'lines'} options={[['lines', 'Плавная линия G1'], ['ij', 'Дуга G2 / G3']]} onChange={v => set({ arcs: v })} />
        <Hint>{post.arcs === 'ij'
          ? 'Скругление идёт одной командой дуги: G2 — по часовой, G3 — против, I и J — смещение центра от начала дуги. Перед работой проверьте на обрезке, что станок ведёт дугу правильно.'
          : 'Скругление идёт очень мелкими отрезками — отклонение от дуги не больше 0,005 мм, граней на детали нет. Работает на любом станке.'}</Hint>
      </div>
      <div className="card" style={{ marginBottom: 10 }}>
        <Title>Высоты и скорости</Title>
        <label className="label">Ноль по Z — от какой пласти</label>
        <Seg value={post.zRef === 'top' ? 'top' : 'bottom'} options={[['bottom', 'От нижней (стол)'], ['top', 'От верхней пласти']]} onChange={v => set({ zRef: v })} />
        <Hint>{post.zRef === 'top'
          ? 'Z = 0 — верхняя пласть листа. Глубина идёт в минус: сквозной рез — на толщину материала плюс заглубление.'
          : 'Z = 0 — поверхность жертвенного стола (нижняя пласть). Сквозной рез и сквозные отверстия уходят ниже нуля на заглубление.'}</Hint>
        <div style={{ height: 8 }} />
        <div className="row2">
          <Num label="Высота безопасности Z" unit="мм" value={post.safeZ} onChange={v => set({ safeZ: v })} hint={post.zRef === 'top' ? 'над верхней пластью листа' : 'от жертвенного стола'} />
          <Num label="Холостые перемещения" unit="мм/мин" value={post.rapid} onChange={v => set({ rapid: v })} hint="для расчёта времени" />
        </div>
        <div className="row2" style={{ marginTop: 8 }}>
          <Num label="Заглубление фрезы в стол" unit="мм" value={post.millOver} onChange={v => set({ millOver: v })} />
          <Num label="Заглубление сверла в стол" unit="мм" value={post.drillOver} onChange={v => set({ drillOver: v })} />
        </div>
        {/* название управляющей программы — собирается из частей */}
        <div style={{ marginTop: 10 }}>
          <label className="label">Название управляющей программы</label>
          <input type="text" key={post.id + (post.nameTpl || '')} defaultValue={post.nameTpl || NAME_TPL_DEFAULT} id={'nameTpl' + post.id}
            onBlur={e => { const v = e.target.value.trim() || NAME_TPL_DEFAULT; if (v !== post.nameTpl) set({ nameTpl: v }) }} style={{ fontFamily: 'monospace', fontSize: 13 }} />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 6 }}>
            {NAME_PARTS.map(([code, label]) => (
              <button key={code} type="button" title={`Добавить в название: ${label}`}
                onClick={() => { const cur = (post.nameTpl || NAME_TPL_DEFAULT).replace(/_+$/, ''); set({ nameTpl: cur + (cur ? '_' : '') + code }) }}
                style={{ padding: '4px 9px', borderRadius: 20, fontSize: 11, border: '0.5px solid var(--blue-mid)', background: 'transparent', color: 'var(--blue)' }}>+ {label}</button>
            ))}
            <button type="button" onClick={() => set({ nameTpl: NAME_TPL_DEFAULT })} style={{ padding: '4px 9px', borderRadius: 20, fontSize: 11, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)' }}>↺ как было</button>
          </div>
          <Hint>
            Части в фигурных скобках подставляются сами, между ними можно писать свой текст. Получится, например:{' '}
            <b style={{ fontFamily: 'monospace' }}>{programName(post.nameTpl, { n: 1, total: 3, order: { order_name: 'Кухня Ивановых', order_number: '261007_005' }, material: 'ЛДСП Белый', thickness: 16, client: 'Марат' })}.{post.ext || 'nc'}</b>.
            Название всегда латиницей; номер листа обязателен — если его убрать, он встанет в начало.
          </Hint>
        </div>
        {/* название папки заказа — тот же конструктор */}
        <div style={{ marginTop: 10 }}>
          <label className="label">Название папки заказа</label>
          <input type="text" key={post.id + 'f' + (post.folderTpl || '')} defaultValue={post.folderTpl || FOLDER_TPL_DEFAULT}
            onBlur={e => { const v = e.target.value.trim() || FOLDER_TPL_DEFAULT; if (v !== post.folderTpl) set({ folderTpl: v }) }} style={{ fontFamily: 'monospace', fontSize: 13 }} />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 6 }}>
            {FOLDER_PARTS.map(([code, label]) => (
              <button key={code} type="button" title={`Добавить в название папки: ${label}`}
                onClick={() => { const cur = (post.folderTpl || FOLDER_TPL_DEFAULT).replace(/_+$/, ''); set({ folderTpl: cur + (cur ? '_' : '') + code }) }}
                style={{ padding: '4px 9px', borderRadius: 20, fontSize: 11, border: '0.5px solid var(--blue-mid)', background: 'transparent', color: 'var(--blue)' }}>+ {label}</button>
            ))}
            <button type="button" onClick={() => set({ folderTpl: FOLDER_TPL_DEFAULT })} style={{ padding: '4px 9px', borderRadius: 20, fontSize: 11, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)' }}>↺ как было</button>
          </div>
          <Hint>
            В эту папку складываются программы и файлы бирок заказа, внутри — папка материала. Получится, например:{' '}
            <b style={{ fontFamily: 'monospace' }}>{folderName(post.folderTpl, { total: 3, order: { order_name: 'Кухня Ивановых', order_number: '261007_005' }, material: 'ЛДСП Белый', thickness: 16, client: 'Марат' })}</b>.
            Имя клиента берётся из заказа; если его нет — эта часть пропускается.
          </Hint>
        </div>
        <div style={{ marginTop: 8, maxWidth: 160 }}>
          <label className="label">Расширение файла</label>
          <input type="text" key={post.id + post.ext} defaultValue={post.ext} onBlur={e => { const v = e.target.value.replace(/[^a-z0-9]/gi, '').slice(0, 8); if (v && v !== post.ext) set({ ext: v }) }} />
        </div>
      </div>
      </>}
    </>
  )
}

// ─── Шестисторонний присадочный станок (XML) ───────────────────────────────
function Drill6Basic({ post, set, router }) {
  const { user } = useAuth()
  const exampleCtx = { total: 3, order: { order_name: 'Кухня Ивановых', order_number: '261007_005' }, material: 'ЛДСП Белый', thickness: 16, client: 'Марат' }
  // код с бирки: что в нём сейчас (шаблон бирок аккаунта)
  const ltpl = getLabelTpl(user)
  const labelQrSet = { ...D6_QR_DEFAULT, ...ltpl.qr, parts: (ltpl.qr?.parts || []).filter(k => k !== 'link') }
  const labelQrParts = QR_PARTS.filter(([k]) => labelQrSet.parts.includes(k)).map(([, l]) => l.toLowerCase()).join(' + ')
  const labelHasQr = (ltpl.items || []).some(i => i.type === 'qr')
  const exampleInfo = { order: 'Кухня Ивановых', des: 'КБ.01.003', name: 'Боковина', pos: '3', prefix: 'Шкаф', materialName: 'ЛДСП Белый', length: 720, width: 560, thickness: 16, sheet: 2, num: 5 }
  const example = q => labelQr({ qr: { ...q, parts: (q.parts || []).filter(k => k !== 'link') } }, exampleInfo)
  return (
    <>
      <div className="card" style={{ marginBottom: 10 }}>
        <Title>Деталь на станке</Title>
        {/* лицевая пласть — синхронно с фрезерным ЧПУ, отдельной настройки нет */}
        <div style={{ fontSize: 12, color: 'var(--text-muted)', background: 'var(--bg2)', borderRadius: 'var(--radius)', padding: '7px 10px', marginTop: 8 }}>
          Деталь кладётся на станок так же, как лежала на фрезерном ЧПУ{router ? <> «{router.name}»</> : null}: <b>лицевой пластью вверх</b> (Face 5) — той, на которую клеится этикетка. Отсканировали — и программа совпадает, переворачивать деталь не нужно.
          <span style={{ display: 'block', marginTop: 4 }}>Положение — само: <b>длинной стороной вдоль станка</b> (по X), и если кромка с одной длинной стороны — <b>кромкой вверх</b> (Face 1). Длинная сторона — главнее.</span>
          <span style={{ display: 'block', fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>Деталь только поворачивается, не переворачивается. Высота отверстий в торец берётся из детали («от пласти» — от лицевой).</span>
        </div>
        <div style={{ marginTop: 8 }}>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', minWidth: 0, maxWidth: 200 }}>Инструмент для пазов и фрезеровки
            <input type="text" key={post.id + (post.d6Tool || '')} defaultValue={post.d6Tool || 'T2'} onBlur={e => { const v = e.target.value.trim() || 'T2'; if (v !== post.d6Tool) set({ d6Tool: v }) }} style={{ marginTop: 3, padding: '8px 10px' }} />
            <span style={{ display: 'block', fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>как в станке, например T2</span>
          </label>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 10, cursor: 'pointer' }}>
          <input type="checkbox" checked={!!post.d6All} onChange={e => set({ d6All: e.target.checked })} style={{ width: 18, height: 18 }} />
          Выводить и детали без обработки
        </label>
        <Hint>На станок уходит вся обработка детали: отверстия в пласти и торцы, пазы, фигурный контур, вырезы, выемки, фрезеровка фасада — даже то, что уже сделал фрезерный ЧПУ на раскрое. Лишнее отключается фильтром на стойке станка (например, всю обработку верхней пласти Face 5).</Hint>
      </div>
      <div className="card" style={{ marginBottom: 10 }}>
        <Title>Имя файла и папка</Title>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={post.d6Name !== 'own'} onChange={e => set({ d6Name: e.target.checked ? 'label' : 'own', ...(e.target.checked || post.d6Qr ? {} : { d6Qr: { ...labelQrSet } }) })} style={{ width: 18, height: 18, flex: '0 0 auto', marginTop: 1 }} />
          <span>Имя файла = код QR с бирки <span style={{ color: 'var(--text-hint)' }}>(рекомендуется)</span></span>
        </label>
        {post.d6Name !== 'own' ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', background: 'var(--bg2)', borderRadius: 'var(--radius)', padding: '7px 10px', marginTop: 8 }}>
            Все программы присадки выпускаются с именем, которое зашито в QR-код бирки: на станке бирку сканируют — и открывается программа этой детали.
            <span style={{ display: 'block', marginTop: 4 }}>Сейчас в QR бирки: <b>{labelQrParts || '— ничего не выбрано —'}</b>{labelQrSet.latin ? ', латиницей' : ''}. Например: <b style={{ fontFamily: 'monospace' }}>{example(labelQrSet)}.{post.ext || 'XML'}</b></span>
            {!labelHasQr && <span style={{ display: 'block', marginTop: 4, color: 'var(--amber)' }}>На бирке сейчас нет QR-кода — добавьте его в шаблоне бирок, иначе сканировать будет нечего.</span>}
            {!labelQrSet.latin && <span style={{ display: 'block', marginTop: 4, color: 'var(--amber)' }}>По спецификации станка код — только латиница и цифры: в шаблоне бирок включите «Перевести в латиницу».</span>}
            {!(labelQrSet.parts || []).some(k => k === 'des' || k === 'pos' || k === 'num') && <span style={{ display: 'block', marginTop: 4, color: 'var(--amber)' }}>В коде нет обозначения детали — у разных деталей он совпадёт. Добавьте в QR бирки «Обозначение детали».</span>}
            <span style={{ display: 'block', fontSize: 11, color: 'var(--text-hint)', marginTop: 4 }}>Код меняется в шаблоне бирок (заказ → Бирки → «Что зашито в QR-код»). Файл выпускается на каждую деталь с биркой.</span>
          </div>
        ) : (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>Своё имя файла — тем же конструктором, что и QR бирки. Например, когда бирки или программы делает другая программа и имена должны совпасть с её кодом.</div>
            <QrPartsEditor value={post.d6Qr || D6_QR_DEFAULT} exclude={['link']} onChange={v => set({ d6Qr: v })} preview={`${example(post.d6Qr || D6_QR_DEFAULT)}.${post.ext || 'XML'}`} />
          </div>
        )}
        <label className="label" style={{ marginTop: 12 }}>Папка для XML-файлов</label>
        <input type="text" key={post.id + 'd6f' + (post.d6Folder ?? '')} defaultValue={post.d6Folder ?? D6_FOLDER_DEFAULT}
          onBlur={e => { const v = e.target.value.trim(); if (v !== (post.d6Folder ?? D6_FOLDER_DEFAULT)) set({ d6Folder: v }) }} style={{ fontFamily: 'monospace', fontSize: 13 }} />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 6 }}>
          {[...NAME_PARTS.filter(([c]) => c !== '{N}'), ['/', 'вложенная папка']].map(([code, label]) => (
            <button key={code} type="button" onClick={() => { const cur = (post.d6Folder ?? D6_FOLDER_DEFAULT).replace(/_+$/, ''); set({ d6Folder: code === '/' ? cur + '/' : cur + (cur && !cur.endsWith('/') ? '_' : '') + code }) }}
              style={{ padding: '4px 9px', borderRadius: 20, fontSize: 11, border: '0.5px solid var(--blue-mid)', background: 'transparent', color: 'var(--blue)' }}>+ {label}</button>
          ))}
          <button type="button" onClick={() => set({ d6Folder: D6_FOLDER_DEFAULT })} style={{ padding: '4px 9px', borderRadius: 20, fontSize: 11, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)' }}>↺ как было</button>
        </div>
        <Hint>Куда складываются XML-файлы при сохранении (и в архиве). «/» — вложенная папка; любой свой текст можно вписать. Пусто — файлы без папки. Получится, например: <b style={{ fontFamily: 'monospace' }}>{drill6Folders(post, exampleCtx).join(' / ') || '— без папки —'}</b></Hint>
        <div style={{ marginTop: 8, maxWidth: 160 }}>
          <label className="label">Расширение файла</label>
          <input type="text" key={post.id + post.ext} defaultValue={post.ext || 'XML'} onBlur={e => { const v = e.target.value.replace(/[^a-z0-9]/gi, '').slice(0, 8); if (v && v !== post.ext) set({ ext: v }) }} />
        </div>
        <Hint>Формат SWJ (как у вашего станка): размеры детали с кромкой, отверстия в пласть сверху и снизу, отверстия в 4 торца, пазы, толщина кромки по сторонам.</Hint>
      </div>
    </>
  )
}

// ─── Команды ────────────────────────────────────────────────────────────────
export function CncCommands({ cnc, onChange, isMaster = false }) {
  const post = activePost(cnc)
  const set = patch => {
    if (post.shared && !isMaster) { const p = { ...post, ...patch, id: newId(), shared: false, forAll: false, ownerId: undefined, name: post.name + ' (мой)' }; onChange({ ...cnc, posts: [...cnc.posts, p], post: p.id }); return }
    onChange({ ...cnc, posts: cnc.posts.map(p => (p.id === post.id ? { ...p, ...patch } : p)) })
  }
  const Box = ({ k, label, rows = 3 }) => (
    <div style={{ marginBottom: 10 }}>
      <label className="label">{label}</label>
      <textarea key={post.id + k} defaultValue={post[k]} rows={rows} spellCheck={false}
        onBlur={e => { if (e.target.value !== post[k]) set({ [k]: e.target.value }) }}
        style={{ fontFamily: 'monospace', fontSize: 13, resize: 'vertical' }} />
    </div>
  )
  if (isDrill6(post)) return (
    <div className="card">
      <Title>Команды · {post.name}</Title>
      <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Шестисторонний станок читает программу в XML — команды G-кода ему не нужны. Настройки этого станка — на вкладке «Основные».</p>
    </div>
  )
  return (
    <div className="card">
      <Title>Команды · {post.name}</Title>
      {Box({ k: 'cmdStart', label: 'Начало программы' })}
      {Box({ k: 'cmdToolStart', label: 'Смена инструмента — начало', rows: 5 })}
      {Box({ k: 'cmdToolEnd', label: 'Смена инструмента — конец' })}
      {Box({ k: 'cmdEnd', label: 'Конец программы' })}
      <Hint>Каждая команда — с новой строки. В смене инструмента вместо {'{T}'} подставляется номер инструмента в магазине, вместо {'{S}'} — обороты шпинделя.</Hint>
    </div>
  )
}

// ─── Б. База инструментов ───────────────────────────────────────────────────
export function CncTools({ cnc, onChange }) {
  const [edit, setEdit] = useState(null)       // инструмент в форме
  const tools = cnc.tools || []
  const save = () => {
    const t = { ...edit, name: (edit.name || '').trim() || (edit.type === 'mill' ? 'Фреза' : 'Сверло') + ' ' + r1(edit.d) + ' мм' }
    onChange({ ...cnc, tools: tools.some(x => x.id === t.id) ? tools.map(x => (x.id === t.id ? t : x)) : [...tools, t] })
    setEdit(null)
  }
  const del = t => { if (window.confirm(`Удалить инструмент «${t.name}»?`)) { onChange({ ...cnc, tools: tools.filter(x => x.id !== t.id) }); setEdit(null) } }
  const create = () => {
    const nextT = Math.max(0, ...tools.map(t => num(t.t))) + 1
    setEdit({ ...(tools.some(t => t.type === 'mill') ? DEFAULT_DRILL() : DEFAULT_MILL()), t: nextT })
  }
  const e = (k, v) => setEdit(x => ({ ...x, [k]: v }))
  if (edit) {
    const mill = edit.type === 'mill'
    const dupT = tools.find(t => t.id !== edit.id && num(t.t) === num(edit.t))
    return (
      <div className="card">
        <Title>{tools.some(t => t.id === edit.id) ? 'Инструмент' : 'Новый инструмент'}</Title>
        <label className="label">Тип</label>
        <Seg value={edit.type} options={[['mill', 'Фреза'], ['drill', 'Сверло']]}
          onChange={v => setEdit(x => (v === x.type ? x : { ...(v === 'mill' ? DEFAULT_MILL() : DEFAULT_DRILL()), id: x.id, t: x.t, d: x.d, name: '' }))} />
        <div style={{ marginTop: 10 }}>
          <label className="label">1. Наименование</label>
          <input type="text" value={edit.name} placeholder={mill ? 'Компрессионная 6 мм' : 'Сверло 8 мм'} onChange={ev => e('name', ev.target.value)} />
        </div>
        <div className="row2" style={{ marginTop: 8 }}>
          <Num label="2. Номер в магазине T" value={edit.t} onChange={v => e('t', v)} />
          <Num label="3. Диаметр" unit="мм" value={edit.d} onChange={v => e('d', v)} />
        </div>
        {dupT && <p style={{ fontSize: 11, color: 'var(--amber)', marginTop: 3 }}>Номер T{edit.t} уже занят: {dupT.name}</p>}
        {mill && (
          <div style={{ marginTop: 8 }}>
            <Num label="4. Максимальная глубина за один проход" unit="мм" value={edit.maxPass} onChange={v => e('maxPass', v)}
              hint="Глубже — обработка делится на несколько проходов." />
          </div>
        )}
        <div className="row2" style={{ marginTop: 8 }}>
          <Num label={`${mill ? 5 : 4}. Обороты шпинделя`} unit="об/мин" value={edit.rpm} onChange={v => e('rpm', v)} />
          <Num label={`${mill ? 6 : 5}. Основная подача`} unit="мм/мин" value={edit.feed} onChange={v => e('feed', v)} hint="в материале" />
        </div>
        {mill && (
          <>
            <div className="row2" style={{ marginTop: 8 }}>
              <Num label="7. Подача входа" unit="мм/мин" value={edit.inFeed} onChange={v => e('inFeed', v)} />
              <Num label="Длина разгона" unit="мм" value={edit.inLen} onChange={v => e('inLen', v)} />
            </div>
            <Hint>Фреза погружается на подаче входа, затем на длине разгона подача плавно растёт до основной.</Hint>
            <div className="row2" style={{ marginTop: 8 }}>
              <Num label="8. Подача выхода" unit="мм/мин" value={edit.outFeed} onChange={v => e('outFeed', v)} />
              <Num label="Длина торможения" unit="мм" value={edit.outLen} onChange={v => e('outLen', v)} />
            </div>
            <Hint>В конце контура на этой длине подача плавно снижается до подачи выхода.</Hint>
            <div style={{ marginTop: 8 }}>
              <Num label="9. Выборка и паз: шаг (перекрытие)" unit="мм" value={edit.step} onChange={v => e('step', v)}
                hint="Если паз или выборка шире фрезы — на сколько смещается фреза между проходами. Проходы идут вдоль длинной стороны с припуском 2 мм, последним — обход по периметру по часовой." />
            </div>
          </>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button type="button" className="btn-primary" onClick={save} disabled={!(num(edit.d) > 0) || !(num(edit.feed) > 0)}>Сохранить</button>
          <button type="button" className="btn-secondary" onClick={() => setEdit(null)}>Отмена</button>
        </div>
        {tools.some(t => t.id === edit.id) && (
          <button type="button" onClick={() => del(edit)} style={{ width: '100%', marginTop: 8, padding: 9, background: 'transparent', border: '1px solid var(--danger)', color: 'var(--danger)', borderRadius: 'var(--radius)', fontSize: 13 }}>Удалить инструмент</button>
        )}
      </div>
    )
  }
  return (
    <>
      {[['mill', 'Фрезы'], ['drill', 'Свёрла']].map(([type, title]) => {
        const list = tools.filter(t => t.type === type).sort((a, b) => num(a.t) - num(b.t))
        return (
          <div key={type} style={{ marginBottom: 12 }}>
            <p className="section-title">{title}</p>
            {!list.length && <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>Пока нет.</p>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {list.map(t => (
                <div key={t.id} className="card" onClick={() => setEdit({ ...t })} style={{ padding: '10px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontFamily: 'monospace', fontWeight: 600, fontSize: 13, background: 'var(--blue-light)', color: 'var(--blue-dark)', padding: '3px 7px', borderRadius: 6 }}>T{t.t}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{t.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>Ø{r1(t.d)} · {t.rpm} об/мин · подача {t.feed}{type === 'mill' ? ` · проход до ${r1(t.maxPass)} мм` : ''}</div>
                  </div>
                  <span style={{ color: 'var(--text-hint)' }}>›</span>
                </div>
              ))}
            </div>
          </div>
        )
      })}
      <button type="button" className="btn-primary" onClick={create}>+ Создать инструмент</button>
    </>
  )
}

// ─── Обработка контуров ─────────────────────────────────────────────────────
export function CncOps({ cnc, onChange, layers }) {
  const ops = cnc.ops
  const set = (k, patch) => onChange({ ...cnc, ops: { ...ops, [k]: { ...ops[k], ...patch } } })
  const setMap = (k, key, patch) => onChange({ ...cnc, ops: { ...ops, [k]: { ...ops[k], [key]: { ...ops[k]?.[key], ...patch } } } })
  const hasTool = id => (cnc.tools || []).some(t => t.id === id)
  const Contour = ({ k, title, note, extra }) => (
    <div className="card" style={{ marginBottom: 10 }}>
      <Title>{title}</Title>
      <label className="label">Инструмент</label>
      <ToolSelect cnc={cnc} only="mill" value={ops[k].tool} onChange={v => set(k, { tool: v })} />
      {note && <Hint>{note}</Hint>}
      <label className="label" style={{ marginTop: 8 }}>Направление обхода</label>
      <Seg value={ops[k].dir} options={[['ccw', '↺ Против часовой'], ['cw', '↻ По часовой']]} onChange={v => set(k, { dir: v })} />
      <label className="label" style={{ marginTop: 8 }}>Вход фрезы</label>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <div style={{ flex: 1 }}><Seg value={ops[k].entry} options={[['ramp', 'Под наклоном'], ['straight', 'Прямо']]} onChange={v => set(k, { entry: v })} /></div>
        {ops[k].entry === 'ramp' && (
          <div style={{ width: 84, display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="text" inputMode="decimal" key={String(ops[k].angle)} defaultValue={ops[k].angle}
              onBlur={e => { const v = Math.max(1, Math.min(89, num(e.target.value) || 45)); if (v !== ops[k].angle) set(k, { angle: v }) }} style={{ padding: '7px 8px', textAlign: 'center' }} />
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>°</span>
          </div>
        )}
      </div>
      {extra}
    </div>
  )
  // вход фрезы: под наклоном (с углом) или прямо
  const Entry = (op, def, onSet) => {
    const entry = op.entry || def, angle = op.angle ?? 45
    return (
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <div style={{ flex: 1 }}><Seg value={entry} options={[['ramp', 'Под наклоном'], ['straight', 'Прямо']]} onChange={v => onSet({ entry: v, angle })} /></div>
        {entry === 'ramp' && (
          <div style={{ width: 84, display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="text" inputMode="decimal" key={String(angle)} defaultValue={angle}
              onBlur={e => { const v = Math.max(1, Math.min(89, num(e.target.value) || 45)); if (v !== angle) onSet({ angle: v }) }} style={{ padding: '7px 8px', textAlign: 'center' }} />
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>°</span>
          </div>
        )}
      </div>
    )
  }
  const o = ops.outer, twoPass = (Number(o.passes) || 1) > 1
  const outerExtra = (
    <>
      <div className="divider" />
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 8, cursor: 'pointer' }}>
        <input type="checkbox" checked={o.smallFirst !== false} onChange={e => set('outer', { smallFirst: e.target.checked })} style={{ width: 18, height: 18 }} />
        Мелкие детали вырезать первыми
      </label>
      <div className="row2">
        <Num label="Мелкая деталь — площадь до" unit="м²" value={o.smallArea} onChange={v => set('outer', { smallArea: v })} />
        <Num label="или ширина до" unit="мм" value={o.smallSide ?? 150} onChange={v => set('outer', { smallSide: v })} />
      </div>
      <Hint>Мелкой считается деталь с малой площадью или узкая полоса — вакуум держит их слабо. Если галочка стоит, сначала режутся все мелкие детали листа, и только потом крупные. Среди мелких первыми идут те, что дальше от крупных деталей, последними — прилегающие к крупной: в момент реза мелкая деталь ещё держится за нетронутого соседа. Последним у мелкой детали режется отрезок, отделяющий её от ещё не отрезанного соседа (чем он крупнее, тем лучше). Крупные детали режутся кратчайшим маршрутом: из двух соседних раньше — та, что заметно меньше, самая большая деталь листа — последней. У любой детали, мелкой и крупной, последним режется отрезок, вдоль которого ещё не резали соседей, — он отделяет её от самого крупного нетронутого куска (детали или обрезка), и на нём подача снижается.</Hint>
      <div style={{ marginTop: 8 }}>
        <Num label="Количество проходов" value={o.passes} onChange={v => set('outer', { passes: Math.max(1, Math.min(6, Math.round(Number(v) || 1))) })} />
      </div>
      {twoPass && (
        <>
          <div className="row2" style={{ marginTop: 8 }}>
            <Num label="Припуск по контуру" unit="мм" value={o.sideAllow} onChange={v => set('outer', { sideAllow: v })} />
            <Num label="Остаток по глубине" unit="мм" value={o.leftover} onChange={v => set('outer', { leftover: v })} />
          </div>
          <Hint>Первые проходы идут с припуском и не дорезают материал на «остаток» — на основной подаче. Последний проход режет начисто и насквозь — по настройкам фрезы (подача входа, разгон, торможение на выходе).</Hint>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-muted)', marginTop: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={!!o.smallOnly} onChange={e => set('outer', { smallOnly: e.target.checked })} style={{ width: 18, height: 18 }} />
            Несколько проходов — только для мелких деталей
          </label>
        </>
      )}
    </>
  )
  return (
    <>
      {!(cnc.tools || []).length && <p style={{ fontSize: 13, color: 'var(--amber)', marginBottom: 10 }}>Сначала создайте инструменты на вкладке «Инструменты».</p>}
      {Contour({ k: 'outer', title: '1. Контур детали', note: 'Фреза идёт снаружи контура.', extra: outerExtra })}
      {Contour({ k: 'cutout', title: '2. Контур выреза', note: 'Фреза всегда идёт внутри контура.' })}
      <div className="card" style={{ marginBottom: 10 }}>
        <Title>3. Пазы{layers ? <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text-hint)' }}> · в заказе {layers.grooves} шт.</span> : null}</Title>
        <label className="label">Инструмент — общий для всех пазов</label>
        <ToolSelect cnc={cnc} only="mill" value={ops.groove.tool} onChange={v => set('groove', { tool: v })} />
        <label className="label" style={{ marginTop: 8 }}>Вход фрезы</label>
        {Entry(ops.groove, 'straight', patch => set('groove', patch))}
        {layers?.grooveLayers?.map(l => (
          <div key={l.key} style={{ marginTop: 10, paddingTop: 10, borderTop: '0.5px solid var(--border)' }}>
            <label className="label">Паз {r1(l.width)} × {r1(l.depth)} мм <span style={{ color: 'var(--text-hint)' }}>(ширина × глубина) · {l.count} шт.</span></label>
            <ToolSelect cnc={cnc} only="mill" maxD={l.width} value={ops.grooves?.[l.key]?.tool} empty={hasTool(ops.groove.tool) ? 'Как общий' : '— не назначен —'} onChange={v => setMap('grooves', l.key, { tool: v })} />
            {hasTool(grooveOpFor(ops, l.key).tool) && num((cnc.tools || []).find(t => t.id === grooveOpFor(ops, l.key).tool)?.d) > l.width + 0.05 && (
              <p style={{ fontSize: 11, color: 'var(--amber)', marginTop: 3 }}>Общая фреза шире этого паза — выберите фрезу для слоя.</p>
            )}
          </div>
        ))}
      </div>
      <div className="card" style={{ marginBottom: 10 }}>
        <Title>4. Выемки</Title>
        {!layers && <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>Выемки настраиваются по глубине — в заказе, где видно, какие глубины в нём есть.</p>}
        {layers && !layers.pockets.length && <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>В этом заказе выемок нет.</p>}
        {layers?.pockets.map(l => (
          <div key={l.key} style={{ marginBottom: 8 }}>
            <label className="label">Выемка глубиной {r1(l.depth)} мм <span style={{ color: 'var(--text-hint)' }}>· {l.count} шт.</span></label>
            <ToolSelect cnc={cnc} only="mill" value={ops.pockets?.[l.key]?.tool} onChange={v => setMap('pockets', l.key, { tool: v })} />
            <label className="label" style={{ marginTop: 6 }}>Ход фрезы</label>
            <Seg value={ops.pockets?.[l.key]?.mode === 'spiral' ? 'spiral' : 'zigzag'} options={[['zigzag', 'Вдоль длинной стороны'], ['spiral', 'По спирали от центра']]} onChange={v => setMap('pockets', l.key, { mode: v })} />
            {ops.pockets?.[l.key]?.mode === 'spiral' && (
              <div style={{ marginTop: 6 }}>
                <Seg value={ops.pockets?.[l.key]?.dir === 'ccw' ? 'ccw' : 'cw'} options={[['cw', '↻ По часовой'], ['ccw', '↺ Против часовой']]} onChange={v => setMap('pockets', l.key, { dir: v })} />
                <Hint>Фреза начинает в центре выемки и расходится к контуру; последний виток — сам контур.</Hint>
              </div>
            )}
            <label className="label" style={{ marginTop: 6 }}>Вход фрезы</label>
            {Entry(ops.pockets?.[l.key] || {}, 'straight', patch => setMap('pockets', l.key, patch))}
          </div>
        ))}
      </div>
      <div className="card">
        <Title>5. Отверстия</Title>
        {!layers && <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>Отверстия по диаметру и глубине настраиваются в заказе. Если сверло не назначено — берётся сверло того же диаметра из «Инструментов».</p>}
        {layers && !layers.holes.length && <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>В этом заказе отверстий в пласть нет.</p>}
        {layers?.holes.map((l, i) => {
          const o = ops.holes?.[l.key] || {}
          const auto = holeToolFor({ key: l.key, d: l.d }, { ...cnc, ops: { ...ops, holes: { ...ops.holes, [l.key]: { ...o, tool: '' } } } })
          const none = !o.tool && !auto || (o.tool && o.tool !== 'none' && !hasTool(o.tool))
          return (
            <div key={l.key} style={{ paddingTop: i ? 10 : 0, marginTop: i ? 10 : 0, borderTop: i ? '0.5px solid var(--border)' : 'none' }}>
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
                Ø{r1(num(o.d) || l.d)} × {r1(num(o.depth) || l.depth)}{l.through && !num(o.depth) ? ' (сквозное)' : ''} <span style={{ fontWeight: 400, color: 'var(--text-hint)' }}>· {l.count} шт.</span>
                {(num(o.d) || num(o.depth)) ? <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--amber)' }}> · изменено, в детали Ø{r1(l.d)} × {r1(l.depth)}</span> : null}
              </div>
              <ToolSelect cnc={cnc} maxD={num(o.d) || l.d} value={none && !o.tool ? '' : o.tool} auto={auto ? toolLabel(auto) : 'нет сверла Ø' + r1(num(o.d) || l.d)} onChange={v => setMap('holes', l.key, { tool: v })} />
              {none && <p style={{ fontSize: 11, color: 'var(--amber)', marginTop: 3 }}>Инструмент не назначен — эти отверстия в программу не попадут.</p>}
              <Hint>В списке — только инструменты не больше диаметра отверстия.</Hint>
              <div className="row2" style={{ marginTop: 6 }}>
                <Num label="Диаметр" unit="мм" value={o.d ?? ''} onChange={v => setMap('holes', l.key, { d: v })} hint={`как в детали: ${r1(l.d)}`} />
                <Num label="Глубина" unit="мм" value={o.depth ?? ''} onChange={v => setMap('holes', l.key, { depth: v })} hint={`как в детали: ${r1(l.depth)}`} />
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}
