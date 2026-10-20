// Инструменты и обработка шестистороннего присадочного станка (XML). Свои у каждого станка: номера инструментов
// у всех разные. Для каждого вида обработки — «авто» (инструмент выбирает система управления станка), один инструмент
// или (пазы) по ширине паза; у слоя заказа (паз ширина × глубина, выемка по глубине) — своё назначение.
// Направление обхода — у вырезов и фигурного края. Данные — в постпроцессоре: post.d6Tools, post.d6Ops (см. drill6Xml.js).
import { activePost, newId, forkShared } from '../lib/cncSettings'
import { d6OpsOf, resolveD6Tool } from '../lib/drill6Xml'
import { SaveSnapshotButton } from './CncSettings'

const num = v => { const x = Number(String(v ?? '').replace(',', '.')); return isFinite(x) ? x : 0 }
const r1 = v => Math.round(num(v) * 10) / 10
const Title = ({ children }) => <div style={{ fontWeight: 500, fontSize: 14, marginBottom: 8 }}>{children}</div>
const Hint = ({ children }) => <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: '4px 0 0' }}>{children}</p>
const KIND = { mill: 'Фреза', saw: 'Диск (пила)' }
const toolText = t => `${t.name}${t.kind === 'saw' ? ' · диск' : ' · фреза'}${num(t.d) > 0 ? ` ${t.kind === 'saw' ? '' : 'Ø'}${r1(t.d)}` : ''}`

function Seg({ value, options, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 4, background: 'var(--bg2)', borderRadius: 'var(--radius)', padding: 3 }}>
      {options.map(([v, l]) => (
        <button key={v} type="button" onClick={() => onChange(v)}
          style={{ flex: 1, padding: '7px 4px', border: 'none', borderRadius: 8, fontSize: 12, background: value === v ? 'var(--blue)' : 'transparent', color: value === v ? 'white' : 'var(--text-muted)' }}>{l}</button>
      ))}
    </div>
  )
}

function ToolSel({ tools, value, onChange, first, kinds }) {
  const list = tools.filter(t => !kinds || kinds.includes(t.kind || 'mill'))
  const lost = value && value !== 'auto' && !list.some(t => t.id === value)
  return (
    <select value={lost ? '' : value || ''} onChange={e => onChange(e.target.value)} style={{ padding: '8px 10px', fontSize: 14, borderColor: lost || (!value && !first) ? 'var(--amber)' : undefined }}>
      <option value="">{first || '— выберите инструмент —'}</option>
      {first && <option value="auto">Авто — назначает станок</option>}
      {list.map(t => <option key={t.id} value={t.id}>{toolText(t)}</option>)}
    </select>
  )
}

export default function Drill6Ops({ cnc, onChange, isMaster = false, layers = null, part = 'ops' }) {
  const post = activePost(cnc)
  const foreign = !!post.shared && !isMaster          // общий постпроцессор: правка делает свою копию
  const { ops, tools } = d6OpsOf(post)
  const set = patch => {
    if (foreign) { onChange(forkShared(cnc, post, patch)); return }       // своя копия общего станка, выпуск — ею
    onChange({ ...cnc, posts: cnc.posts.map(p => (p.id === post.id ? { ...p, ...patch } : p)) })
  }
  const setTools = list => set({ d6Tools: list, d6Ops: ops })
  const setOp = (cat, patch) => set({ d6Ops: { ...ops, [cat]: { ...ops[cat], ...patch } }, d6Tools: tools })
  const setLayer = (key, v) => { const l = { ...ops.layers }; if (v) l[key] = v; else delete l[key]; set({ d6Ops: { ...ops, layers: l }, d6Tools: tools }) }

  if (part === 'tools') {
    const upd = (id, patch) => setTools(tools.map(t => (t.id === id ? { ...t, ...patch } : t)))
    return (
      <>
        <div className="card" style={{ marginBottom: 10 }}>
          <Title>Инструменты станка · {post.name}</Title>
          <Hint>Свои у этого станка. Название — как инструмент называется в станке (например T2): оно пишется в программу. Нужны только для того, что вы хотите назначать сами; где выбрано «авто», инструмент подбирает система управления станка.</Hint>
          {!tools.length && <p style={{ fontSize: 12, color: 'var(--text-hint)', margin: '10px 0 0' }}>Инструментов нет — вся обработка идёт на «авто».</p>}
          {tools.map(t => (
            <div key={t.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.3fr) 76px 28px', gap: 6, alignItems: 'end', marginTop: 10 }}>
              <label style={{ fontSize: 11, color: 'var(--text-hint)', minWidth: 0 }}>В станке
                <input type="text" key={t.id + t.name} defaultValue={t.name} onBlur={e => { const v = e.target.value.trim(); if (v && v !== t.name) upd(t.id, { name: v }) }} style={{ marginTop: 2, padding: '7px 8px' }} />
              </label>
              <label style={{ fontSize: 11, color: 'var(--text-hint)', minWidth: 0 }}>Тип
                <select value={t.kind || 'mill'} onChange={e => upd(t.id, { kind: e.target.value })} style={{ marginTop: 2, padding: '7px 6px', fontSize: 13 }}>
                  {Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </label>
              <label style={{ fontSize: 11, color: 'var(--text-hint)', minWidth: 0 }}>{t.kind === 'saw' ? 'Толщина' : 'Ø, мм'}
                <input type="text" inputMode="decimal" key={t.id + t.d} defaultValue={t.d || ''} onBlur={e => { const v = num(e.target.value); if (v !== num(t.d)) upd(t.id, { d: v }) }} style={{ marginTop: 2, padding: '7px 8px', textAlign: 'center' }} />
              </label>
              <button type="button" aria-label="Удалить инструмент" onClick={() => { if (window.confirm(`Удалить инструмент ${t.name}?`)) setTools(tools.filter(x => x.id !== t.id)) }}
                style={{ border: 'none', background: 'transparent', color: 'var(--text-hint)', fontSize: 16, padding: '8px 0' }}>✕</button>
            </div>
          ))}
          <button type="button" onClick={() => setTools([...tools, { id: newId(), name: 'T' + (tools.length + 2), kind: 'mill', d: 6 }])}
            style={{ width: '100%', marginTop: 12, padding: 8, border: '0.5px dashed var(--border-md)', borderRadius: 'var(--radius)', background: 'transparent', fontSize: 12, color: 'var(--text-muted)' }}>+ Добавить инструмент</button>
        </div>
        <SaveSnapshotButton cnc={cnc} onChange={onChange} />
      </>
    )
  }

  const nameOf = id => tools.find(t => t.id === id)?.name
  // что получит слой, если своё не назначено
  const byRule = (cat, l) => { const r = resolveD6Tool({ ops: { ...ops, layers: {} }, tools }, cat, l.width, null); return r.tool ? r.tool.name : r.missing ? 'не назначен → авто' : 'авто' }

  const Mode = ({ cat, width }) => {
    const op = ops[cat]
    const opts = [['auto', 'Авто'], ['tool', 'Один инструмент'], ...(width ? [['width', 'По ширине']] : [])]
    const rules = op.rules || []
    const setRule = (i, patch) => setOp(cat, { rules: rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) })
    return (
      <>
        <Seg value={op.mode} options={opts} onChange={v => setOp(cat, { mode: v })} />
        {op.mode === 'auto' && <Hint>Инструмент в программу не пишется — его подбирает система управления станка.</Hint>}
        {op.mode === 'tool' && <div style={{ marginTop: 8 }}><ToolSel tools={tools} value={op.tool} onChange={v => setOp(cat, { tool: v })} /></div>}
        {op.mode === 'width' && (
          <div style={{ marginTop: 8 }}>
            {rules.map((r, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '30px 64px 26px minmax(0,1fr) 26px', gap: 4, alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>до</span>
                <input type="text" inputMode="decimal" key={i + ':' + r.upTo} defaultValue={r.upTo || ''} placeholder="мм" onBlur={e => { const v = num(e.target.value); if (v !== num(r.upTo)) setRule(i, { upTo: v }) }} style={{ padding: '7px 6px', textAlign: 'center' }} />
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>мм</span>
                <ToolSel tools={tools} value={r.tool} onChange={v => setRule(i, { tool: v })} />
                <button type="button" aria-label="Удалить правило" onClick={() => setOp(cat, { rules: rules.filter((_, j) => j !== i) })} style={{ border: 'none', background: 'transparent', color: 'var(--text-hint)', fontSize: 15, padding: 0 }}>✕</button>
              </div>
            ))}
            <button type="button" onClick={() => setOp(cat, { rules: [...rules, { upTo: (Math.max(0, ...rules.map(r => num(r.upTo))) || 0) + 5, tool: '' }] })}
              style={{ width: '100%', padding: 7, border: '0.5px dashed var(--border-md)', borderRadius: 'var(--radius)', background: 'transparent', fontSize: 12, color: 'var(--text-muted)' }}>+ Правило по ширине</button>
            <Hint>Ширина паза до указанной (включительно) — этим инструментом; правила проверяются от узкого к широкому. Паз шире последнего правила уходит на «авто» с предупреждением.</Hint>
          </div>
        )}
        {op.mode !== 'auto' && !tools.length && <p style={{ fontSize: 11, color: 'var(--amber)', marginTop: 4 }}>Сначала добавьте инструменты станка на вкладке «Инструменты».</p>}
      </>
    )
  }
  const Layers = ({ cat, list, label }) => (list || []).map(l => (
    <div key={l.key} style={{ marginTop: 10, paddingTop: 10, borderTop: '0.5px solid var(--border)' }}>
      <label className="label">{label(l)} <span style={{ color: 'var(--text-hint)' }}>· {l.count} шт.</span></label>
      <ToolSel tools={tools} value={ops.layers?.[l.key] || ''} onChange={v => setLayer(l.key, v)} first={`Как в общем правиле (${byRule(cat, l)})`} />
      {(() => { const t = tools.find(x => x.id === ops.layers?.[l.key]); return t && t.kind !== 'saw' && l.width && num(t.d) > l.width + 0.05 ? <p style={{ fontSize: 11, color: 'var(--amber)', marginTop: 3 }}>Фреза Ø{r1(t.d)} шире паза.</p> : null })()}
    </div>
  ))
  const Dir = ({ cat }) => (
    <>
      <label className="label" style={{ marginTop: 10 }}>Направление обхода</label>
      <Seg value={ops[cat].dir} options={[['ccw', '↺ Против часовой'], ['cw', '↻ По часовой']]} onChange={v => setOp(cat, { dir: v })} />
    </>
  )
  const MmField = ({ cat, k, label, def }) => (
    <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginTop: 10, maxWidth: 260 }}>{label}
      <input type="text" inputMode="decimal" key={cat + k + (ops[cat][k] ?? def)} defaultValue={ops[cat][k] ?? def}
        onBlur={e => { const v = Math.max(0, num(e.target.value)); if (v !== num(ops[cat][k] ?? def)) setOp(cat, { [k]: v }) }}
        style={{ marginTop: 3, padding: '8px 10px', width: 90, textAlign: 'center' }} />
    </label>
  )
  const inOrder = n => (layers ? <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text-hint)' }}> · в заказе {n} шт.</span> : null)
  const sum = l => (l || []).reduce((n, x) => n + x.count, 0)
  return (
    <>
      <div className="card" style={{ marginBottom: 10 }}>
        <Title>1. Пазы в пласти{inOrder(sum(layers?.groove))}</Title>
        {Mode({ cat: 'groove', width: true })}
        {Layers({ cat: 'groove', list: layers?.groove, label: l => `Паз ${l.width} × ${l.depth} мм (ширина × глубина)` })}
        {!layers && <Hint>Пазы по слоям (ширина × глубина) видны в заказе — там можно назначить свой инструмент каждому.</Hint>}
      </div>
      <div className="card" style={{ marginBottom: 10 }}>
        <Title>2. Пазы в торце{inOrder(sum(layers?.edgeGroove))}</Title>
        {Mode({ cat: 'edgeGroove', width: true })}
        <Hint>Паз в торце делает торцевой фрезерный узел или диск — у станков по-разному: выберите инструмент нужного типа (тип задаётся на вкладке «Инструменты»).</Hint>
        {Layers({ cat: 'edgeGroove', list: layers?.edgeGroove, label: l => `Паз в торце ${l.width} × ${l.depth} мм` })}
      </div>
      <div className="card" style={{ marginBottom: 10 }}>
        <Title>3. Выемки по пласти{inOrder(sum(layers?.pocket))}</Title>
        {Mode({ cat: 'pocket' })}
        {MmField({ cat: 'pocket', k: 'step', label: 'Шаг между проходами, % от Ø фрезы', def: 50 })}
        <Hint>«Авто» — выборка по контуру выемки, проходы строит станок. Свой инструмент — путь фрезы строит программа: от центра выемки кольцами по её форме, каждое по часовой, последнее — по контуру со смещением на радиус фрезы (скругление выемки повторяется, если радиус фрезы не больше него).</Hint>
        {Layers({ cat: 'pocket', list: layers?.pocket, label: l => `Выемка ${l.size || ''} глубиной ${l.depth} мм` })}
        {!layers && <Hint>Выемки по слоям (размер и глубина) видны в заказе — там можно назначить свой инструмент каждой.</Hint>}
      </div>
      <div className="card" style={{ marginBottom: 10 }}>
        <Title>4. Выемки в торце{inOrder(sum(layers?.edgePocket))}</Title>
        {Mode({ cat: 'edgePocket' })}
        {MmField({ cat: 'edgePocket', k: 'step', label: 'Шаг между проходами, % от Ø фрезы', def: 50 })}
        <Hint>Фрезеровка на торце (торцевой фрезерный узел) по форме выемки со скруглениями. Как у выемок по пласти: «авто» — выборку строит станок; свой инструмент — от центра, кольцами, по часовой (если смотреть на торец), последнее — по контуру.</Hint>
        {Layers({ cat: 'edgePocket', list: layers?.edgePocket, label: l => `Выемка в торце ${l.size || ''} глубиной ${l.depth} мм` })}
      </div>
      <div className="card" style={{ marginBottom: 10 }}>
        <Title>5. Вырезы внутри детали{layers ? inOrder(layers.cutout) : null}</Title>
        {Mode({ cat: 'cutout' })}
        {Dir({ cat: 'cutout' })}
        {MmField({ cat: 'cutout', k: 'lead', label: 'Вход с отступа от контура, мм', def: 20 })}
        <Hint>Фреза внутри выреза, насквозь. По умолчанию — по часовой (встречное фрезерование). Вход — изнутри выреза, по нормали к контуру; в узком вырезе отступ уменьшается сам. 0 — без отступа.</Hint>
      </div>
      <div className="card" style={{ marginBottom: 10 }}>
        <Title>6. Вырезы на краю детали{layers ? inOrder(layers.edge) : null}</Title>
        {Mode({ cat: 'edge' })}
        {Dir({ cat: 'edge' })}
        {MmField({ cat: 'edge', k: 'lead', label: 'Заход и выход за краем детали, мм', def: 10 })}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 10, cursor: 'pointer' }}>
          <input type="checkbox" checked={ops.edge.notch !== false} onChange={e => setOp('edge', { notch: e.target.checked })} style={{ width: 18, height: 18 }} />
          Надсечка на выходе
        </label>
        <Hint>U-образный вырез, угловая вырубка, радиус угла: фреза снаружи контура детали, по умолчанию против часовой. Заход и выход — за краем детали по касательной (станок может предупредить, что траектория за деталью). Надсечка: перед резом фреза снаружи врезается в край в точке выхода, потом режет вырез и выходит в надсечку — кромку на выходе не рвёт. Прямые края по габариту не фрезеруются.</Hint>
      </div>
      {nameOf('legacy') && <Hint>Инструмент {nameOf('legacy')} перенесён из прежней настройки.</Hint>}
      <SaveSnapshotButton cnc={cnc} onChange={onChange} />
    </>
  )
}
