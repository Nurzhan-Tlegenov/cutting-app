import { LABEL_POS, getLabelTpl, QR_PARTS, labelQr } from '../lib/labelMaker'
import QrPartsEditor from './QrPartsEditor'
import { D6_QR_DEFAULT, DRILL_DIR_DEFAULT } from '../lib/drill6Xml'
import DirPathEditor, { routerDirDefault } from './DirPathEditor'
import TplInput from './TplInput'
import FileNamesSettings from './FileNamesSettings'
import { useAuth } from '../context/AuthContext'
import { NAME_PARTS, NAME_TPL_DEFAULT, programName, FOLDER_PARTS, FOLDER_TPL_DEFAULT, folderName } from '../lib/orderUtils'
import { useState, useRef, useEffect } from 'react'
import { learnFromProgram, readProgramFile } from '../lib/gcodeLearn'
import { normOps, sameName, secondPost, backupPost, setSecondPost, DEFAULT_MILL, DEFAULT_DRILL, KINDS, isDrill6, isBeamSaw, isRouterPost, activePost, routerPost, drillPosts, toggleUse6, newId, saveSnapshot, applySnapshot, removeSnapshot, renameSnapshot, forkShared } from '../lib/cncSettings'
import { holeToolFor, grooveOpFor } from '../lib/gcode'

// Вкладки настроек ЧПУ: «Основные» и «Команды» (постпроцессор), «Инструменты» (база), «Обработка» (контуры).
// cnc — настройки целиком, onChange(cnc) — сохранить.

const num = v => { const x = Number(String(v ?? '').replace(',', '.')); return isFinite(x) ? x : 0 }
const r1 = v => String(Math.round(num(v) * 10) / 10)

// как будут называться папки выгрузки — на примере заказа
const DIR_EXAMPLE = { total: 3, order: { order_name: 'Кухня Ивановых', order_number: '261007_005' }, material: 'ЛДСП Белый', thickness: 16, client: 'Марат' }
const dirPreview = tpl => String(tpl || '').split('/').map(t => t.trim()).filter(Boolean).map(t => folderName(t, DIR_EXAMPLE)).filter(Boolean)

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
// empty — пустое поле — отдельное значение '' (например, «не уходить» в конце программы), а не 0
function SignedNum({ label, value, onChange, unit, empty = false }) {
  const blank = empty && (value === '' || value == null)
  const v = Number(value) || 0
  return (
    <div style={{ minWidth: 0 }}>
      <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)' }}>{label}{unit ? <span style={{ color: 'var(--text-hint)' }}>, {unit}</span> : null}</span>
      <div style={{ display: 'flex', gap: 4, marginTop: 3 }}>
        <button type="button" title="Сменить знак" onClick={() => onChange(-v)}
          style={{ flex: '0 0 40px', border: '0.5px solid var(--border-md)', borderRadius: 'var(--radius)', background: v < 0 ? 'var(--amber-light)' : 'var(--bg2)', color: 'var(--text)', fontSize: 16, cursor: 'pointer' }}>{v < 0 ? '−' : '+'}</button>
        <input type="text" inputMode="decimal" key={blank ? 'blank' : String(v)} defaultValue={blank ? '' : v ? String(Math.abs(v)).replace('.', ',') : (empty ? '0' : '')} placeholder={empty ? '' : '0'}
          onBlur={e => { const s = e.target.value.replace(',', '.').replace('−', '-').trim(); if (empty && s === '') { if (!blank) onChange(''); return } const n = s === '' || !isFinite(Number(s)) ? 0 : Number(s); const out = s.startsWith('-') ? n : (v < 0 ? -Math.abs(n) : Math.abs(n)); if (out !== v || blank) onChange(out) }}
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
    // от последних настроек (onChange(prev => …)): правки подряд не затирают друг друга
    if (foreign) { onChange(c => (c.posts.some(q => q.id === post.id && q.shared) ? forkShared(c, post, patch) : { ...c, posts: c.posts.map(q => (q.id === c.post ? { ...q, ...patch } : q)) })); return }
    onChange(c => ({ ...c, posts: c.posts.map(p => (p.id === post.id ? { ...p, ...patch } : p)) }))
  }
  const drill = isDrill6(post), saw = isBeamSaw(post)
  const routers = cnc.posts.filter(isRouterPost)
  const router = routerPost(cnc)
  const setKind = kind => {
    if (kind === (post.kind || 'router')) return
    if (isRouterPost(post) && routers.length < 2) { window.alert(`Это единственный раскроечный станок. Чтобы добавить другой: «Выбрать ▾» → «+ Присадочный 6-стор.»${cnc.posts.some(isBeamSaw) ? ' или «+ Пильный центр»' : ''}.`); return }
    if (saw && cnc.posts.filter(isBeamSaw).length < 2) { window.alert('Это единственный пильный центр. Чтобы добавить другой станок: «Выбрать ▾» → «+ Раскроечный станок» или «+ Присадочный 6-стор.».'); return }
    set(kind === 'drill6' ? { kind, ext: 'XML', nameTpl: '{NOMER}_{ZAKAZ}' } : kind === 'beamsaw' ? { kind, ext: 'xml', nameTpl: '{ZAKAZ}_{MAT}' } : { kind: 'router', ext: 'nc', nameTpl: NAME_TPL_DEFAULT })
  }
  const copy = () => { const p = { ...post, id: newId(), shared: false, forAll: false, ownerId: undefined, name: post.name + ' (копия)' }; onChange({ ...cnc, posts: [...cnc.posts, p], post: p.id }) }
  const del = () => {
    if (foreign || cnc.posts.length < 2) return
    if (isRouterPost(post) && !cnc.posts.some(p => p.id !== post.id && isRouterPost(p))) { window.alert('Это единственный раскроечный станок — его удалить нельзя.'); return }
    if (saw && !cnc.posts.some(p => p.id !== post.id && isBeamSaw(p))) { window.alert('Это единственный пильный центр — его удалить нельзя (можно переименовать и настроить).'); return }
    if (!window.confirm(`Удалить постпроцессор «${post.name}»?\nЕго настройки останутся в «Мои постпроцессоры» — их можно вернуть.`)) return
    const kept = backupPost(cnc, 'удаления')           // копия настроек — в «Мои постпроцессоры»
    const posts = kept.posts.filter(p => p.id !== post.id)
    onChange({ ...toggleUse6(kept, post.id, false), posts, post: posts[0].id, router: cnc.router === post.id ? '' : cnc.router })
  }
  const small = { padding: '6px 10px', borderRadius: 20, fontSize: 12, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)' }
  return (
    <>
      <div className="card" style={{ marginBottom: 10 }}>
        <Title>Постпроцессор</Title>
        <SaveSnapshotButton cnc={cnc} onChange={onChange} />
        <label className="label">Тип станка</label>
        <div style={{ marginBottom: 8 }}><Seg value={post.kind || 'router'} options={KINDS.filter(([k]) => k !== 'beamsaw' || cnc.posts.some(isBeamSaw)).map(([k]) => [k, k === 'drill6' ? 'Присадочный 6-стор.' : k === 'beamsaw' ? 'Пильный центр' : 'Раскроечный'])} onChange={setKind} /></div>
        <label className="label">Название</label>
        <input type="text" key={post.id} defaultValue={post.name} onBlur={e => { const v = e.target.value.trim(); if (v && v !== post.name) set({ name: v }) }} />
        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <button type="button" style={small} onClick={copy}>Копия</button>
          {!foreign && cnc.posts.length > 1 && <button type="button" style={{ ...small, color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={del}>Удалить</button>}
        </div>
        <Hint>Выбрать другой станок, добавить или удалить — кнопкой «Выбрать ▾» сверху.</Hint>
        {isMaster && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 10, cursor: 'pointer' }}>
            <input type="checkbox" checked={!!post.forAll || !!post.shared} onChange={e => set({ forAll: e.target.checked, shared: false })} style={{ width: 18, height: 18 }} />
            Для всех — постпроцессор виден всем пользователям
          </label>
        )}
        <Hint>Постпроцессор — это станок: его поле, высоты и команды. Инструменты и обработка контуров — общие для раскроечных станков.</Hint>
      </div>
      {/* выпуск программ: раскроечный станок (G-код по листам) и, по галочке, второй постпроцессор — любой из своих:
          второй раскроечный (свой G-код, например станок с присадочной головой) или шестисторонний (файлы по деталям).
          «Создать программы» в заказе выпускает оба, «Сохранить все файлы» — одним архивом, у каждого своя папка */}
      {(() => {
        const sec = secondPost(cnc)
        const others = cnc.posts.filter(p => p.id !== router?.id && !isBeamSaw(p))
        const sel = { width: '100%', padding: '7px 8px', fontSize: 14 }
        return (
          <div className="card" style={{ marginBottom: 10 }}>
            <Title>Выпуск управляющих программ</Title>
            <label className="label">Раскроечный станок (G-код по листам)</label>
            <select value={router?.id || ''} onChange={e => onChange({ ...cnc, router: e.target.value, ...(cnc.router2 === e.target.value ? { router2: '' } : {}) })} style={sel}>
              {routers.map(p => <option key={p.id} value={p.id}>{p.name}{p.drillHead ? ' — с присадочной головой' : ''}</option>)}
            </select>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 10, cursor: 'pointer' }}>
              <input type="checkbox" checked={!!sec} disabled={!others.length}
                onChange={e => onChange(e.target.checked ? setSecondPost(cnc, (others.find(isDrill6) || others[0]).id) : setSecondPost(cnc, ''))} style={{ width: 18, height: 18 }} />
              Выпускать и вторым постпроцессором
            </label>
            {sec && (
              <select value={sec.id} onChange={e => onChange(setSecondPost(cnc, e.target.value))} style={{ ...sel, marginTop: 6 }}>
                {others.map(p => <option key={p.id} value={p.id}>{p.name} — {isDrill6(p) ? 'шестисторонний (XML по деталям)' : p.drillHead ? 'раскроечный с присадочной головой (G-код)' : 'раскроечный (G-код)'}</option>)}
              </select>
            )}
            <Hint>{!others.length ? 'Второго станка пока нет — добавьте его: «Выбрать ▾» сверху → «+ Раскроечный станок» или «+ Присадочный 6-стор.».'
              : sec ? `«Создать программы» в заказе выпустит G-код «${router?.name}» и ${isDrill6(sec) ? 'файлы по деталям' : 'G-код'} «${sec.name}». «Сохранить все файлы» — одним разом, у каждого станка своя папка.`
                : 'Только раскроечный станок. Включите галочку, чтобы вместе с ним выпускать программы для второго станка.'}</Hint>
          </div>
        )
      })()}
      {drill && <Drill6Basic post={post} set={set} router={router} />}
      {saw && <BeamSawPostBasic post={post} set={set} />}
      <FileNamesSettings />
      {!drill && !saw && <>
      <div className="card" style={{ marginBottom: 10 }}>
        <Title>Присадочная голова</Title>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={!!post.drillHead} onChange={e => set({ drillHead: e.target.checked })} style={{ width: 18, height: 18, flex: '0 0 auto', marginTop: 1 }} />
          У станка есть сверлильно-присадочная голова (кроме фрезерного шпинделя)
        </label>
        <Hint>{post.drillHead
          ? 'Свёрла, отмеченные в «Инструментах» как «в присадочной голове», включаются своей командой (Команды → «Присадочная голова») и сверлят все отверстия одним проходом по листу, меняясь на ходу. Потом работает шпиндель. Остальные свёрла и фрезы — через шпиндель, как обычно.'
          : 'Только шпиндель с автосменой: все свёрла и фрезы включаются одной командой смены инструмента.'}</Hint>
      </div>
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
          <SignedNum label="Начало X" unit="мм" value={post.originX} onChange={v => set({ originX: v })} />
          <SignedNum label="Начало Y" unit="мм" value={post.originY} onChange={v => set({ originY: v })} />
        </div>
        <Hint>Начало — где на станке лежит левый нижний угол листа. X — ширина листа, Y — длина. Обработка идёт от этой точки в пределах поля.</Hint>
        <div className="row2" style={{ marginTop: 8 }}>
          <SignedNum empty label="Конечное положение X" unit="мм" value={post.endX} onChange={v => set({ endX: v })} />
          <SignedNum empty label="Конечное положение Y" unit="мм" value={post.endY} onChange={v => set({ endY: v })} />
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
        {/* заглубление фрезы (сквозной рез контура) — не здесь, а во вкладке «Обработка» → «Контур детали», рядом с остальной обработкой контура */}
        <div className="row2" style={{ marginTop: 8 }}>
          <SignedNum label="Заглубление сверла в стол" unit="мм" value={-Math.abs(Number(post.drillOver) || 0)} onChange={v => set({ drillOver: Math.abs(v) })} />
        </div>
        {/* название управляющей программы — собирается из частей */}
        <div style={{ marginTop: 10 }}>
          <label className="label">Название управляющей программы</label>
          <TplInput value={post.nameTpl || NAME_TPL_DEFAULT} def={NAME_TPL_DEFAULT} parts={NAME_PARTS} onChange={v => set({ nameTpl: v })} />
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
        {/* папки выгрузки — матрёшка: вложенные папки и их имена */}
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-muted)' }}>
          <label className="label">📁 Папки для G-кода раскроя{<span style={{ marginLeft: 6, fontSize: 10.5, padding: '1px 7px', borderRadius: 9, background: 'var(--blue-light)', color: 'var(--blue-dark)', whiteSpace: 'nowrap', fontWeight: 500 }}>фрезер · .{post.ext || 'nc'}</span>}</label>
          {(() => { const def = routerDirDefault(post, drillPosts(cnc).length > 0), v = post.dirPath ?? def
            return <DirPathEditor value={v} def={def} preview={dirPreview(v)} onChange={x => set({ dirPath: x })} /> })()}
          <Hint>Куда складываются G-код и файлы бирок при «Сохранить все файлы» (и в архиве). «+ вложенная папка» — папка внутри папки.</Hint>
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

// ─── Пильный центр (XML для KDT) ─────────────────────────────────────────────
// Одна программа на материал: дерево резов по всем листам раскроя «Пильный центр β». Выпускается в окне ЧПУ заказа,
// когда раскрой посчитан под пильный центр. Бирки — галочкой там же (у пилы нет маркировочного стола).
const BEAM_NAME_DEFAULT = '{ZAKAZ}_{MAT}'
const BEAM_DIR_DEFAULT = '{ZAKAZ}/{MAT}'
function BeamSawPostBasic({ post, set }) {
  const ex = { total: 3, order: { order_name: 'Кухня Ивановых', order_number: '261007_005' }, material: 'ЛДСП Белый', thickness: 16, client: 'Марат' }
  const dirPreview = v => String(v || '').split('/').map(t => t.trim()).filter(Boolean).map(t => folderName(t, ex))   // массив уровней (DirPathEditor сам соединяет)
  const dir = post.dirPath ?? BEAM_DIR_DEFAULT
  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <Title>Пильный центр · программа XML</Title>
      <Hint>Программа для пильного центра KDT: дерево резов по всем листам материала — полосы, поперечные резы, детали, деловые обрезки, таблица деталей для бирок. Выпускается в окне ЧПУ заказа, если раскрой посчитан как «Пильный центр β».</Hint>
      <div style={{ marginTop: 10 }}>
        <label className="label">Название программы</label>
        <TplInput value={post.nameTpl || BEAM_NAME_DEFAULT} def={BEAM_NAME_DEFAULT} parts={NAME_PARTS.filter(([code]) => code !== '{N}')} onChange={v => set({ nameTpl: v })} />
        <Hint>Например: <b style={{ fontFamily: 'monospace' }}>{programName(post.nameTpl || BEAM_NAME_DEFAULT, { ...ex, n: null })}.{post.ext || 'xml'}</b> — латиницей, один файл на материал.</Hint>
      </div>
      <div style={{ marginTop: 10 }}>
        <label className="label">📁 Папки для программы пилы</label>
        <DirPathEditor value={dir} def={BEAM_DIR_DEFAULT} preview={dirPreview(dir)} onChange={x => set({ dirPath: x })} />
        <Hint>Бирки (если отмечено «Бирки вместе с программами») ложатся рядом — в папку с тем же названием и словом «Etiketki» в конце.</Hint>
      </div>
      <div style={{ marginTop: 10 }}>
        <label className="label">Бирки — по готовности деталей</label>
        <Hint>Порядок бирок — как детали выходят со станка: полоса режется поперёк, готовая деталь — бирка сразу, кусок с подрезкой откладывается и дорезается после полосы. На бирке эскиз, кромки и размеры — как деталь лежит на выходе; для этого нужно знать, в какую сторону станок поворачивает заготовку между уровнями.</Hint>
        <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
          {[['cw', 'Поворот по часовой'], ['ccw', 'Против часовой']].map(([v, l]) => (
            <button key={v} type="button" onClick={() => set({ labelTurn: v })}
              style={{ padding: '5px 10px', borderRadius: 16, fontSize: 12, border: `1px solid ${(post.labelTurn || 'cw') === v ? 'var(--blue)' : 'var(--border-md)'}`, background: (post.labelTurn || 'cw') === v ? 'var(--blue-light)' : 'transparent', color: (post.labelTurn || 'cw') === v ? 'var(--blue)' : 'var(--text-muted)' }}>{l}</button>
          ))}
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
            <input type="checkbox" checked={!!post.labelFlip} onChange={e => set({ labelFlip: e.target.checked })} /> ещё на 180°
          </label>
        </div>
        <Hint>Если бирки выходят вверх ногами или боком — переключите сторону поворота или добавьте 180°. Проверяется на первом листе.</Hint>
      </div>
    </div>
  )
}

// ─── Шестисторонний присадочный станок (XML) ───────────────────────────────
function Drill6Basic({ post, set, router }) {
  const { user } = useAuth()
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
        <Hint>Инструменты станка, пазы (в пласти и в торце, по ширине), выемки, вырезы и фигурный край с направлением обхода — на вкладках «Инструменты» и «Обработка». По умолчанию везде «авто»: инструмент подбирает система управления станка.</Hint>
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
        <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)' }}>
          <label className="label">📁 Папки для программ присадки{<span style={{ marginLeft: 6, fontSize: 10.5, padding: '1px 7px', borderRadius: 9, background: 'var(--amber-light)', color: 'var(--amber)', whiteSpace: 'nowrap', fontWeight: 500 }}>шестисторонний · .{post.ext || 'XML'}</span>}</label>
          <DirPathEditor value={post.dirPath ?? DRILL_DIR_DEFAULT} def={DRILL_DIR_DEFAULT} preview={dirPreview(post.dirPath ?? DRILL_DIR_DEFAULT)} onChange={x => set({ dirPath: x })} />
          <Hint>Куда складываются XML-файлы при сохранении (и в архиве). «+ вложенная папка» — папка внутри папки.</Hint>
        </div>
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
// «Сохранить»: текущие настройки открытого постпроцессора — в «Мои постпроцессоры» под своим именем.
// Настройки и так запоминаются при каждой правке; эта кнопка откладывает удачный вариант, чтобы вернуться к нему
// после других проб. Показывается в «Основных» и в «Командах» — для присадочного и для фрезерного.
export function SaveSnapshotButton({ cnc, onChange }) {
  const post = activePost(cnc)
  const [done, setDone] = useState('')
  // свежие настройки: ввели новое название и сразу нажали «Сохранить» — переименование применяется при уходе из поля,
  // а нажатие видело бы ещё старые настройки и записало их поверх (новое имя и своя копия общего станка терялись)
  const cur = useRef({ cnc, onChange })
  useEffect(() => { cur.current = { cnc, onChange } })
  const save = () => {
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur()
    setTimeout(() => {
      const { cnc: c, onChange: ch } = cur.current, p = activePost(c)
      const def = p.name
      const name = window.prompt('Сохранить настройки постпроцессора под именем:\n(то же имя — сохранённое перезапишется)', def)
      if (name === null) return
      const nm = (name || def).trim()
      const over = (c.saved || []).some(x => sameName(x.name, nm))
      ch(prev => saveSnapshot(prev, nm))
      setDone(over ? `Перезаписано: «${nm}»` : `Сохранено: «${nm}»`)
      setTimeout(() => setDone(''), 4000)
    }, 60)
  }
  return (
    <div style={{ marginBottom: 8 }}>
      <button type="button" className="btn-primary" onClick={save} style={{ padding: '8px 14px', fontSize: 13 }}>💾 Сохранить настройки</button>
      <Hint>{done || `Запомнить текущие настройки «${post.name}», чтобы потом к ним вернуться (Выбрать ▾ → ↺ у станка). То же имя — перезапись.`}</Hint>
    </div>
  )
}

// Вкладка «Мои постпроцессоры»: сохранённые настройки — применить к открытому постпроцессору, добавить новым, переименовать, удалить
export function CncSaved({ cnc, onChange }) {
  const post = activePost(cnc)
  const kindOf = s => (s.kind === 'drill6' ? 'Присадочный 6-стор.' : s.kind === 'beamsaw' ? 'Пильный центр' : 'Раскроечный')
  const same = s => (post.kind || 'router') === (s.kind || 'router') && !post.shared
  const when = t => (t ? new Date(t).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '')
  const small = { padding: '6px 10px', borderRadius: 20, fontSize: 12, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)' }
  const apply = (s, asNew) => {
    if (!asNew && !window.confirm(`Применить «${s.name}» к открытому постпроцессору «${post.name}»? Его текущие настройки заменятся.`)) return
    onChange(applySnapshot(cnc, s.id, asNew))
  }
  const list = [...(cnc.saved || [])].sort((a, b) => (b.at || 0) - (a.at || 0))
  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <Title>Мои постпроцессоры</Title>
      {!list.length ? <Hint>Пока пусто. Настройте постпроцессор и нажмите «Сохранить настройки» — вариант появится здесь.</Hint> : (
        <>
          <Hint>{`Открыт: ${post.name} (${isDrill6(post) ? 'присадочный' : isBeamSaw(post) ? 'пильный центр' : 'раскроечный'}).`}</Hint>
          <Hint>«Применить» — настройки варианта станут настройками открытого постпроцессора (имя остаётся). «Новым» — добавить отдельным постпроцессором.</Hint>
          {list.map(s => (
            <div key={s.id} style={{ padding: '8px 0', borderTop: '0.5px solid var(--border)' }}>
              <div style={{ fontSize: 13.5, fontWeight: 500 }}>{s.kind === 'drill6' ? '⬡ ' : ''}{s.name}</div>
              <div style={{ fontSize: 11, color: 'var(--text-hint)' }}><span>{kindOf(s)}</span> · {when(s.at)}{s.kind === 'router' ? <span>{` · поле ${s.post.fieldX}×${s.post.fieldY}`}</span> : null}{s.ops ? <span> · с обработкой контуров</span> : null}</div>
              <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                {same(s) && <button type="button" style={{ ...small, color: 'white', background: 'var(--blue)', border: 'none' }} onClick={() => apply(s, false)}>{`Применить к «${post.name}»`}</button>}
                <button type="button" style={{ ...small, color: 'var(--blue)', borderColor: 'var(--blue)' }} onClick={() => apply(s, true)}>+ Новым постпроцессором</button>
                <button type="button" style={small} onClick={() => { const n = window.prompt('Название', s.name); if (n && n.trim()) onChange(renameSnapshot(cnc, s.id, n.trim())) }}>Переименовать</button>
                <button type="button" style={{ ...small, color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={() => { if (window.confirm(`Удалить сохранённый вариант «${s.name}»?`)) onChange(removeSnapshot(cnc, s.id)) }}>Удалить</button>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  )
}

// Самонастройка (мастер-аккаунт): загрузить готовую управляющую программу станка из другой программы раскроя —
// приложение «срисует» служебные команды (начало, смена инструмента, конец — для шпинделя и присадочной головы)
// и настроит постпроцессор целиком: свои инструменты с номерами, диаметрами, оборотами и подачами, врезание фрезы,
// высоту безопасности. Инструменты привязываются к этому постпроцессору и не смешиваются с инструментами других станков.
function LearnFromProgram({ post, onApply, tools = [] }) {
  const file = useRef(null)
  const [res, setRes] = useState(null)        // { ...learnFromProgram, ext, fileName }
  const [err, setErr] = useState('')
  const pick = async e => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    setErr(''); setRes(null)
    if (f.size > 30 * 1024 * 1024) { setErr('Файл больше 30 МБ — возьмите программу поменьше (хватит одного листа).'); return }
    try {
      const { text, ext } = await readProgramFile(f)
      const r = learnFromProgram(text)
      if (!r.ok) { setErr(r.warnings.join(' ')); return }
      setRes({ ...r, ext, fileName: f.name })
    } catch (x) { setErr(`Файл не прочитался: ${x?.message || x}`) }
  }
  const apply = () => {
    if (!window.confirm(`Настроить «${post.name}» по программе «${res.fileName}»?\nКоманды и инструменты этого постпроцессора заменятся. Обработка (проходы, вход фрезы, глубина реза, мелкие детали, пазы, отверстия) не меняется — её настраиваете вы во вкладке «Обработка». Инструменты других станков не тронутся.\nТекущие настройки станка сохранятся в «Мои постпроцессоры».`)) return
    onApply({
      cmdStart: res.cmdStart, cmdToolStart: res.cmdToolStart, cmdToolEnd: res.cmdToolEnd, cmdEnd: res.cmdEnd,
      ...(res.arcs ? { arcs: res.arcs } : {}),
      ...(res.park ? { endX: res.park.x ?? 0, endY: res.park.y ?? 0 } : {}),   // парковка в конце программы — «конечное положение»
      ...(res.ext && /^(nc|tap|cnc|gcode|ngc|txt|mpf|iso|ptp|anc|eia|h|g)$/i.test(res.ext) ? { ext: res.ext } : {}),
      // два вида смены: присадочная голова — свои команды, у станка включается голова
      ...(res.head ? { drillHead: true, cmdHeadStart: res.head.cmdHeadStart, cmdHeadEnd: res.head.cmdHeadEnd } : { drillHead: false }),
      ...(res.learned?.post.safeZ != null ? { safeZ: res.learned.post.safeZ } : {}),
      ...(res.learned?.post.zRef ? { zRef: res.learned.post.zRef } : {}),
      // заглубление фрезы (глубину реза контура) самонастройка не трогает: его задают во вкладке «Обработка»
      learnedFrom: res.fileName, learnedAt: Date.now(),
    }, res.learned)
    setRes(null)
  }
  const pre = { fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap', background: 'var(--bg2)', borderRadius: 8, padding: '6px 8px', margin: '2px 0 8px', minHeight: 18 }
  return (
    <div style={{ marginBottom: 12, paddingBottom: 10, borderBottom: '0.5px solid var(--border)' }}>
      <input ref={file} type="file" style={{ display: 'none' }} onChange={pick} />
      <button type="button" onClick={() => file.current?.click()}
        style={{ width: '100%', padding: '9px 12px', borderRadius: 12, border: '1px dashed var(--blue)', background: 'var(--blue-light)', color: 'var(--blue-dark)', fontSize: 13, cursor: 'pointer' }}>
        📂 Загрузить управляющую программу — срисовать команды
      </button>
      <Hint>Возьмите готовую УП этого станка из другой программы (лучше лист, где есть и сверление, и раскрой). Приложение срисует команды (номер инструмента → {'{T}'}, обороты → {'{S}'}), узнает присадочную голову, создаст инструменты этого станка с оборотами и подачами и настроит врезание и высоты.</Hint>
      {post.learnedFrom && !res && <Hint>{`Команды срисованы с «${post.learnedFrom}»${post.learnedAt ? ` · ${new Date(post.learnedAt).toLocaleDateString('ru-RU')}` : ''}.`}</Hint>}
      {err && <p style={{ fontSize: 12, color: 'var(--danger)', margin: '6px 0 0' }}>{err}</p>}
      {res && (
        <div style={{ marginTop: 8, padding: 10, borderRadius: 12, border: '1px solid var(--blue)' }}>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>Найдено в «{res.fileName}»</div>
          {res.report.map((l, i) => <div key={i} style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>• {l}</div>)}
          {res.warnings.map((l, i) => <div key={'w' + i} style={{ fontSize: 11.5, color: 'var(--amber)' }}>⚠ {l}</div>)}
          {!!res.learned?.tools.length && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 2 }}>Инструменты этого постпроцессора{tools.some(t => t.postId === post.id) ? ' (заменят прежние срисованные)' : ''}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto auto', columnGap: 8, rowGap: 2, fontSize: 12, background: 'var(--bg2)', borderRadius: 8, padding: '6px 8px' }}>
                {res.learned.tools.map(t => [
                  <b key={t.t + 'a'} style={{ fontFamily: 'monospace' }}>T{t.t}</b>,
                  <span key={t.t + 'b'}>{t.type === 'mill' ? 'Фреза' : 'Сверло'} {t.d ? 'Ø' + t.d : <span style={{ color: 'var(--amber)' }}>Ø?</span>}{t.head ? <span style={{ color: 'var(--amber)' }}> · голова</span> : ''}</span>,
                  <span key={t.t + 'c'} style={{ color: 'var(--text-muted)' }}>{t.rpm ? `S${t.rpm}` : ''}</span>,
                  <span key={t.t + 'd'} style={{ color: 'var(--text-muted)' }}>{t.feed ? `F${t.feed}` : ''}{t.inFeed ? ` / вход F${t.inFeed}` : ''}</span>,
                ])}
              </div>
            </div>
          )}
          {[['Начало программы', res.cmdStart], [res.head ? 'Смена инструмента (шпиндель) — начало' : 'Смена инструмента — начало', res.cmdToolStart], [res.head ? 'Смена инструмента (шпиндель) — конец' : 'Смена инструмента — конец', res.cmdToolEnd],
            ...(res.head ? [['Смена сверла в голове — начало', res.head.cmdHeadStart], ['Смена сверла в голове — конец', res.head.cmdHeadEnd]] : []),
            ['Конец программы', res.cmdEnd]].map(([l, v]) => (
            <div key={l} style={{ marginTop: 6 }}>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{l}</div>
              <div style={pre}>{v || <span style={{ color: 'var(--text-hint)' }}>— пусто —</span>}</div>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <button type="button" className="btn-primary" onClick={apply} style={{ flex: 1, padding: '8px 12px', fontSize: 13 }}>Настроить постпроцессор</button>
            <button type="button" onClick={() => setRes(null)} style={{ padding: '8px 14px', borderRadius: 20, fontSize: 13, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)' }}>Отмена</button>
          </div>
          <Hint>Потом всё правится вручную: команды — ниже, инструменты и обработка — на своих вкладках. Проверьте на симуляторе и на станке, прежде чем резать.</Hint>
        </div>
      )}
    </div>
  )
}

export function CncCommands({ cnc, onChange, isMaster = false }) {
  const post = activePost(cnc)
  const set = patch => {
    if (post.shared && !isMaster) { const p = { ...post, ...patch, id: newId(), shared: false, forAll: false, ownerId: undefined, name: post.name + ' (мой)' }; onChange({ ...cnc, posts: [...cnc.posts, p], post: p.id }); return }
    onChange({ ...cnc, posts: cnc.posts.map(p => (p.id === post.id ? { ...p, ...patch } : p)) })
  }
  // Настроить постпроцессор по программе — одним изменением: команды и режимы станка, свои инструменты
  // (привязаны к этому постпроцессору, у других станков не видны) и своя обработка контуров
  const applyLearned = (patch, learned) => {
    const c0 = backupPost(cnc, 'самонастройки')        // копия как было — в «Мои постпроцессоры»
    const lt = learned?.tools || []
    const made = lt.map(x => {
      const base = x.type === 'mill' ? DEFAULT_MILL() : DEFAULT_DRILL()
      const pick = (v, def) => (v != null && v !== '' ? v : def)
      return {
        ...base, id: newId(), postId: post.id, t: x.t, d: x.d || '',
        name: `${x.type === 'mill' ? 'Фреза' : 'Сверло'}${x.d ? ` Ø${x.d}` : ''} (T${x.t})`,
        rpm: pick(x.rpm, base.rpm), feed: pick(x.feed, base.feed),
        ...(x.type === 'mill' ? { inFeed: pick(x.inFeed, base.inFeed), maxPass: pick(x.maxPass, base.maxPass) } : { inHead: !!x.head }),
      }
    })
    const keep = (c0.tools || []).filter(t => t.postId !== post.id)
    const main = made.find(t => t.type === 'mill' && Math.round(num(t.t)) === learned?.ops.mainT) || made.find(t => t.type === 'mill')
    // Самонастройка берёт команды и инструменты станка (и высоты Z). Обработку она не настраивает: проходы, вход
    // фрезы и угол, глубина, мелкие детали, пазы, выемки, отверстия, «что выводить» — как задал пользователь во вкладке
    // «Обработка». Меняется только, КАКИМ инструментом: у станка теперь свои инструменты (назначения по слоям,
    // указывавшие на прежние инструменты, — на «авто»).
    const base = normOps(post.ownOps || c0.ops)
    const ids = new Set(made.map(t => t.id))
    const keepTool = m => Object.fromEntries(Object.entries(m || {}).map(([k, v]) => [k, v && v.tool && !ids.has(v.tool) ? { ...v, tool: '' } : v]))
    const own = !made.length ? post.ownOps : normOps({
      ...base,
      outer: { ...base.outer, tool: main?.id || '' },
      cutout: { ...base.cutout, tool: main?.id || '' },
      groove: { ...base.groove, tool: main?.id || '' },
      grooves: keepTool(base.grooves), pockets: keepTool(base.pockets), holes: keepTool(base.holes),
    })
    onChange({ ...c0, tools: made.length ? [...keep, ...made] : c0.tools, posts: c0.posts.map(p => (p.id === post.id ? { ...p, ...patch, ...(own ? { ownOps: own } : {}) } : p)) })
  }
  const Box = ({ k, label, rows = 3 }) => (
    <div style={{ marginBottom: 10 }}>
      <label className="label">{label}</label>
      <textarea key={post.id + k + (post[k] || '')} defaultValue={post[k]} rows={rows} spellCheck={false}
        onBlur={e => { if (e.target.value !== post[k]) set({ [k]: e.target.value }) }}
        style={{ fontFamily: 'monospace', fontSize: 13, resize: 'vertical' }} />
    </div>
  )
  if (isBeamSaw(post)) return (
    <div className="card">
      <Title>Команды · {post.name}</Title>
      <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Пильный центр читает программу в XML — команды G-кода ему не нужны. Настройки — на вкладке «Основные», правила раскроя пильного центра — в кабинете производства.</p>
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
      {isMaster && <LearnFromProgram post={post} tools={cnc.tools || []} onApply={applyLearned} />}
      {Box({ k: 'cmdStart', label: 'Начало программы' })}
      {Box({ k: 'cmdToolStart', label: 'Смена инструмента — начало', rows: 5 })}
      {Box({ k: 'cmdToolEnd', label: 'Смена инструмента — конец' })}
      {Box({ k: 'cmdEnd', label: 'Конец программы' })}
      {post.drillHead && (
        <div style={{ margin: '4px 0 10px', padding: '8px 10px', borderRadius: 12, background: 'var(--amber-light)' }}>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6 }}>Присадочная голова</div>
          {Box({ k: 'cmdHeadStart', label: 'Смена сверла в голове — начало', rows: 4 })}
          {Box({ k: 'cmdHeadEnd', label: 'Смена сверла в голове — конец (включение головы)' })}
          <Hint>Для свёрл «в присадочной голове». Остальные инструменты — командами смены выше (шпиндель).</Hint>
        </div>
      )}
      <Hint>Каждая команда — с новой строки. В смене инструмента вместо {'{T}'} подставляется номер инструмента в магазине, вместо {'{S}'} — обороты шпинделя.</Hint>
      <div style={{ marginTop: 10 }}><SaveSnapshotButton cnc={cnc} onChange={onChange} /></div>
    </div>
  )
}

// ─── Б. База инструментов ───────────────────────────────────────────────────
export function CncTools({ cnc, onChange }) {
  const [edit, setEdit] = useState(null)       // инструмент в форме
  const tools = cnc.tools || []
  const headPost = cnc.posts.find(p => isRouterPost(p) && p.drillHead)     // станок с присадочной головой (если есть)
  const ap = activePost(cnc)
  const ownSet = tools.length > 0 && tools.every(t => t.postId && t.postId === ap?.id)   // свои инструменты постпроцессора (см. postTools.js)
  const save = () => {
    const t = { ...edit, name: (edit.name || '').trim() || (edit.type === 'mill' ? 'Фреза' : 'Сверло') + ' ' + r1(edit.d) + ' мм' }
    onChange({ ...cnc, tools: tools.some(x => x.id === t.id) ? tools.map(x => (x.id === t.id ? t : x)) : [...tools, t] })
    setEdit(null)
  }
  const del = t => { if (window.confirm(`Удалить инструмент «${t.name}»?`)) { onChange({ ...cnc, tools: tools.filter(x => x.id !== t.id) }); setEdit(null) } }
  // новое сверло у станка с присадочной головой — сразу «в присадочной голове» (галочку можно снять)
  const newDrill = () => ({ ...DEFAULT_DRILL(), ...(headPost ? { inHead: true } : {}) })
  const create = () => {
    const nextT = Math.max(0, ...tools.map(t => num(t.t))) + 1
    setEdit({ ...(tools.some(t => t.type === 'mill') ? newDrill() : DEFAULT_MILL()), t: nextT })
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
          onChange={v => setEdit(x => (v === x.type ? x : { ...(v === 'mill' ? DEFAULT_MILL() : newDrill()), id: x.id, t: x.t, d: x.d, name: '' }))} />
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
          <>
            <div style={{ marginTop: 8 }}>
              <Num label="4. Максимальная глубина за один проход" unit="мм" value={edit.maxPass} onChange={v => e('maxPass', v)}
                hint="Глубже — обработка делится на несколько проходов." />
            </div>
            <div style={{ marginTop: 8 }}>
              <Num label="Высота режущей кромки" unit="мм" value={edit.edgeH ?? ''} onChange={v => e('edgeH', v)}
                hint="Ограничение глубины фрезы: глубже кромки она не режет. Если материал с заглублением глубже — при выпуске программы будет предупреждение. Пусто — без ограничения." />
              {num(edit.edgeH) > 0 && num(edit.maxPass) > num(edit.edgeH) && <p style={{ fontSize: 11, color: 'var(--amber)', marginTop: 3 }}>Глубина за проход больше высоты режущей кромки.</p>}
            </div>
          </>
        )}
        {!mill && headPost && (
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, marginTop: 10, cursor: 'pointer' }}>
            <input type="checkbox" checked={!!edit.inHead} onChange={ev => e('inHead', ev.target.checked)} style={{ width: 18, height: 18, flex: '0 0 auto', marginTop: 1 }} />
            <span>Стоит в присадочной голове<span style={{ display: 'block', fontSize: 11, color: 'var(--text-hint)' }}>{`Включается командой головы у «${headPost.name}». Без галочки — сверло в шпинделе.`}</span></span>
          </label>
        )}
        <div className="row2" style={{ marginTop: 8 }}>
          <Num label={`${mill ? 5 : 4}. Обороты шпинделя`} unit="об/мин" value={edit.rpm} onChange={v => e('rpm', v)} />
          <Num label={`${mill ? 6 : 5}. Основная подача`} unit="мм/мин" value={edit.feed} onChange={v => e('feed', v)} hint="в материале" />
        </div>
        {!mill && (
          <>
            <div className="row2" style={{ marginTop: 8 }}>
              <Num label="6. Подача врезания" unit="мм/мин" value={edit.inFeed ?? ''} onChange={v => e('inFeed', v)} />
              <Num label="Глубина врезания" unit="мм" value={edit.inLen ?? ''} onChange={v => e('inLen', v)} />
            </div>
            <Hint>Сверло входит в материал на подаче врезания и на глубине врезания плавно разгоняется до основной — так пласть не скалывается. Пусто — сразу на основной подаче.</Hint>
            {num(edit.inFeed) > 0 && num(edit.inFeed) >= num(edit.feed) && <p style={{ fontSize: 11, color: 'var(--amber)', marginTop: 3 }}>Подача врезания не меньше основной — разгона не будет.</p>}
          </>
        )}
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
      {ownSet && <p style={{ fontSize: 12, color: 'var(--text-muted)', background: 'var(--blue-light)', borderRadius: 10, padding: '7px 10px', margin: '0 0 10px' }}>{`Инструменты постпроцессора «${ap.name}»${ap.learnedFrom ? ` — срисованы с «${ap.learnedFrom}»` : ''}. Они только у этого станка: у других постпроцессоров не видны.`}</p>}
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
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{t.name}{headPost && t.type === 'drill' && t.inHead ? <span style={{ fontSize: 10.5, fontWeight: 500, marginLeft: 6, padding: '1px 7px', borderRadius: 9, background: 'var(--amber-light)', color: 'var(--amber)' }}>голова</span> : null}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>Ø{r1(t.d)} · {t.rpm} об/мин · подача {t.feed}{type === 'mill' ? ` · проход до ${r1(t.maxPass)} мм${num(t.edgeH) > 0 ? ` · кромка ${r1(t.edgeH)} мм` : ''}` : (num(t.inFeed) > 0 ? ` · врезание ${t.inFeed}` : '')}</div>
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
  // Глубина сквозного реза контура — заглубление фрезы ниже стола у раскроечного станка, которым выпускается G-код.
  // Задаётся только здесь (на «Основных» её нет), рядом с остальной обработкой контура; самонастройка её не трогает.
  const rp = routerPost(cnc)
  const setRouter = patch => {
    if (!rp) return
    if (rp.shared) {                       // общий постпроцессор не правим — делаем свою копию (как на «Основных»)
      onChange(forkShared(cnc, rp, patch)); return
    }
    onChange({ ...cnc, posts: cnc.posts.map(p => (p.id === rp.id ? { ...p, ...patch } : p)) })
  }
  const T0 = 16
  const cutDepth = (
    <div style={{ marginTop: 8 }}>
      <SignedNum label="Сквозной рез — ниже стола (заглубление)" unit="мм" value={-Math.abs(Number(rp?.millOver) || 0)} onChange={v => setRouter({ millOver: Math.abs(v) })} />
      <Hint>{(() => {
        const m = Math.abs(Number(rp?.millOver) || 0), top = rp?.zRef === 'top'
        const z = top ? -(T0 + m) : -m
        return `Низ реза в программе: Z${String(Math.round(z * 100) / 100).replace('-', '−')}${top ? ` (Z0 — верх листа; пример для листа ${T0} мм)` : ' (Z0 — стол)'}. `
          + (m ? 'Фреза уходит в жертвенный стол — деталь прорезается насквозь.' : 'Сейчас 0 — фреза доходит ровно до стола: деталь может не прорезаться. Обычно 0,2–0,5 мм.')
          + ` Станок: ${rp?.name || '—'}.`
      })()}</Hint>
    </div>
  )
  const set = (k, patch) => onChange({ ...cnc, ops: { ...ops, [k]: { ...ops[k], ...patch } } })
  const setMap = (k, key, patch) => onChange({ ...cnc, ops: { ...ops, [k]: { ...ops[k], [key]: { ...ops[k]?.[key], ...patch } } } })
  const hasTool = id => (cnc.tools || []).some(t => t.id === id)
  const skip = { contour: false, face: false, holes: false, ...ops.skip }
  const setSkip = patch => onChange({ ...cnc, ops: { ...ops, skip: { ...skip, ...patch } } })
  const offStyle = off => (off ? { opacity: 0.45 } : null)
  const OffNote = ({ on }) => (on ? <p style={{ fontSize: 12, color: 'var(--amber)', marginBottom: 6 }}>Отключено — в программу не попадает (см. «Что выводить в программу»).</p> : null)
  const Contour = ({ k, title, note, extra, off }) => (
    <div className="card" style={{ marginBottom: 10, ...offStyle(off) }}>
      <OffNote on={off} />
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
      {cutDepth}
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
      <div className="card" style={{ marginBottom: 10 }}>
        <Title>Что выводить в программу</Title>
        {[
          ['contour', 'Резать только прямоугольники', 'Вырезы внутренние и наружные, скругления и фигурный край не режутся — каждая деталь вырезается прямоугольником по своему габариту.'],
          ['face', 'Без пазов и выемок с лица', 'Пазы и выемки с лицевой стороны в программу не попадают.'],
          ['holes', 'Без отверстий (присадки)', 'Все отверстия в пласть в программу не попадают.'],
        ].map(([k, label, hint]) => (
          <div key={k} style={{ marginBottom: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, cursor: 'pointer' }}>
              <input type="checkbox" checked={!!skip[k]} onChange={e => setSkip({ [k]: e.target.checked })} style={{ width: 18, height: 18 }} />
              {label}{layers && k === 'contour' && layers.cutouts ? <span style={{ fontSize: 12, color: 'var(--text-hint)' }}> · вырезов в заказе {layers.cutouts}</span> : null}
              {layers && k === 'face' && (layers.grooves || layers.pockets.length) ? <span style={{ fontSize: 12, color: 'var(--text-hint)' }}> · пазов {layers.grooves}, выемок {layers.pockets.reduce((a, l) => a + l.count, 0)}</span> : null}
              {layers && k === 'holes' && layers.holes.length ? <span style={{ fontSize: 12, color: 'var(--text-hint)' }}> · отверстий {layers.holes.reduce((a, l) => a + l.count, 0)}</span> : null}
            </label>
            <Hint>{hint}</Hint>
          </div>
        ))}
        {skip.contour && <Hint>Раскрой должен быть сделан по габаритам: если фигурные детали уложены вплотную друг в друга, при создании программы будет предупреждение.</Hint>}
      </div>
      {Contour({ k: 'outer', title: '1. Контур детали', note: skip.contour ? 'Фреза идёт снаружи прямоугольника по габариту детали.' : 'Фреза идёт снаружи контура.', extra: outerExtra })}
      {Contour({ k: 'cutout', title: '2. Контур выреза', note: 'Фреза всегда идёт внутри контура. Глубина сквозного выреза — та же, что у контура детали.', off: skip.contour, extra: cutDepth })}
      <div className="card" style={{ marginBottom: 10, ...offStyle(skip.face) }}>
        <OffNote on={skip.face} />
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
      <div className="card" style={{ marginBottom: 10, ...offStyle(skip.face) }}>
        <OffNote on={skip.face} />
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
      <div className="card" style={offStyle(skip.holes) || undefined}>
        <OffNote on={skip.holes} />
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
