import { useState } from 'react'
import { DEFAULT_MILL, DEFAULT_DRILL, DEFAULT_POST, activePost, newId } from '../lib/cncSettings'
import { holeToolFor } from '../lib/gcode'

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
function ToolSelect({ cnc, value, onChange, only, auto }) {
  const list = (cnc.tools || []).filter(t => !only || t.type === only)
  const lost = value && value !== 'none' && !list.some(t => t.id === value)
  return (
    <select value={lost ? '' : value || ''} onChange={e => onChange(e.target.value)} style={{ padding: '8px 10px', fontSize: 14, borderColor: !auto && (!value || lost) ? 'var(--amber)' : undefined }}>
      <option value="">{auto ? `Авто${auto === true ? '' : ': ' + auto}` : '— не назначен —'}</option>
      {auto && <option value="none">Не обрабатывать</option>}
      {list.map(t => <option key={t.id} value={t.id}>{toolLabel(t)}</option>)}
    </select>
  )
}
const Hint = ({ children }) => <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: '4px 0 0' }}>{children}</p>
const Title = ({ children }) => <div style={{ fontWeight: 500, fontSize: 14, marginBottom: 8 }}>{children}</div>

// ─── А. Основные ────────────────────────────────────────────────────────────
export function CncBasic({ cnc, onChange }) {
  const post = activePost(cnc)
  const set = patch => onChange({ ...cnc, posts: cnc.posts.map(p => (p.id === post.id ? { ...p, ...patch } : p)) })
  const add = () => { const p = { ...DEFAULT_POST(), name: `Постпроцессор ${cnc.posts.length + 1}` }; onChange({ ...cnc, posts: [...cnc.posts, p], post: p.id }) }
  const copy = () => { const p = { ...post, id: newId(), name: post.name + ' (копия)' }; onChange({ ...cnc, posts: [...cnc.posts, p], post: p.id }) }
  const del = () => { if (cnc.posts.length < 2 || !window.confirm(`Удалить постпроцессор «${post.name}»?`)) return; const posts = cnc.posts.filter(p => p.id !== post.id); onChange({ ...cnc, posts, post: posts[0].id }) }
  const small = { padding: '6px 10px', borderRadius: 20, fontSize: 12, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)' }
  return (
    <>
      <div className="card" style={{ marginBottom: 10 }}>
        <Title>Постпроцессор</Title>
        <select value={post.id} onChange={e => onChange({ ...cnc, post: e.target.value })} style={{ marginBottom: 8 }}>
          {cnc.posts.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <label className="label">Название</label>
        <input type="text" key={post.id} defaultValue={post.name} onBlur={e => { const v = e.target.value.trim(); if (v && v !== post.name) set({ name: v }) }} />
        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <button type="button" style={small} onClick={add}>+ Новый</button>
          <button type="button" style={small} onClick={copy}>Копия</button>
          {cnc.posts.length > 1 && <button type="button" style={{ ...small, color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={del}>Удалить</button>}
        </div>
        <Hint>Постпроцессор — это станок: его поле, высоты и команды. Инструменты и обработка контуров — общие.</Hint>
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
      </div>
      <div className="card" style={{ marginBottom: 10 }}>
        <Title>Высоты и скорости</Title>
        <div className="row2">
          <Num label="Высота безопасности Z" unit="мм" value={post.safeZ} onChange={v => set({ safeZ: v })} hint="от жертвенного стола" />
          <Num label="Холостые перемещения" unit="мм/мин" value={post.rapid} onChange={v => set({ rapid: v })} hint="для расчёта времени" />
        </div>
        <div className="row2" style={{ marginTop: 8 }}>
          <Num label="Заглубление фрезы в стол" unit="мм" value={post.millOver} onChange={v => set({ millOver: v })} />
          <Num label="Заглубление сверла в стол" unit="мм" value={post.drillOver} onChange={v => set({ drillOver: v })} />
        </div>
        <Hint>Z = 0 — поверхность жертвенного стола. Сквозной рез и сквозные отверстия уходят ниже нуля на заглубление.</Hint>
        <div style={{ marginTop: 8, maxWidth: 160 }}>
          <label className="label">Расширение файла</label>
          <input type="text" key={post.id + post.ext} defaultValue={post.ext} onBlur={e => { const v = e.target.value.replace(/[^a-z0-9]/gi, '').slice(0, 8); if (v && v !== post.ext) set({ ext: v }) }} />
        </div>
      </div>
    </>
  )
}

// ─── Команды ────────────────────────────────────────────────────────────────
export function CncCommands({ cnc, onChange }) {
  const post = activePost(cnc)
  const set = patch => onChange({ ...cnc, posts: cnc.posts.map(p => (p.id === post.id ? { ...p, ...patch } : p)) })
  const Box = ({ k, label, rows = 3 }) => (
    <div style={{ marginBottom: 10 }}>
      <label className="label">{label}</label>
      <textarea key={post.id + k} defaultValue={post[k]} rows={rows} spellCheck={false}
        onBlur={e => { if (e.target.value !== post[k]) set({ [k]: e.target.value }) }}
        style={{ fontFamily: 'monospace', fontSize: 13, resize: 'vertical' }} />
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
  const Contour = ({ k, title, note }) => (
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
    </div>
  )
  return (
    <>
      {!(cnc.tools || []).length && <p style={{ fontSize: 13, color: 'var(--amber)', marginBottom: 10 }}>Сначала создайте инструменты на вкладке «Инструменты».</p>}
      {Contour({ k: 'outer', title: '1. Контур детали', note: 'Фреза идёт снаружи контура.' })}
      {Contour({ k: 'cutout', title: '2. Контур выреза', note: 'Фреза всегда идёт внутри контура.' })}
      <div className="card" style={{ marginBottom: 10 }}>
        <Title>3. Пазы{layers ? <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text-hint)' }}> · в заказе {layers.grooves} шт.</span> : null}</Title>
        <ToolSelect cnc={cnc} only="mill" value={ops.groove.tool} onChange={v => set('groove', { tool: v })} />
      </div>
      <div className="card" style={{ marginBottom: 10 }}>
        <Title>4. Выемки</Title>
        {!layers?.pockets.length && <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>В этом заказе выемок нет.</p>}
        {layers?.pockets.map(l => (
          <div key={l.key} style={{ marginBottom: 8 }}>
            <label className="label">Глубина {r1(l.depth)} мм · {l.count} шт.</label>
            <ToolSelect cnc={cnc} only="mill" value={ops.pockets?.[l.key]?.tool} onChange={v => setMap('pockets', l.key, { tool: v })} />
          </div>
        ))}
      </div>
      <div className="card">
        <Title>5. Отверстия</Title>
        {!layers?.holes.length && <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>В этом заказе отверстий в пласть нет.</p>}
        {layers?.holes.map((l, i) => {
          const o = ops.holes?.[l.key] || {}
          const auto = holeToolFor({ key: l.key, d: l.d }, { ...cnc, ops: { ...ops, holes: { ...ops.holes, [l.key]: { ...o, tool: '' } } } })
          const none = !o.tool && !auto || (o.tool && o.tool !== 'none' && !hasTool(o.tool))
          return (
            <div key={l.key} style={{ paddingTop: i ? 10 : 0, marginTop: i ? 10 : 0, borderTop: i ? '0.5px solid var(--border)' : 'none' }}>
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
                Ø{r1(l.d)} × {r1(l.depth)}{l.through ? ' (сквозное)' : ''} <span style={{ fontWeight: 400, color: 'var(--text-hint)' }}>· {l.count} шт.</span>
              </div>
              <ToolSelect cnc={cnc} value={none && !o.tool ? '' : o.tool} auto={auto ? toolLabel(auto) : 'нет сверла Ø' + r1(num(o.d) || l.d)} onChange={v => setMap('holes', l.key, { tool: v })} />
              {none && <p style={{ fontSize: 11, color: 'var(--amber)', marginTop: 3 }}>Инструмент не назначен — эти отверстия в программу не попадут.</p>}
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
