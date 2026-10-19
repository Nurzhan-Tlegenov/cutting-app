import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { BEAM_DEFAULTS, beamSettings, maxPartIn } from '../lib/beamSaw'

// β Пильный центр — настройки производства. Все значения меняются в любую сторону, без потолков:
// станки и системы управления у всех разные. В полях — сами значения (по умолчанию — типовые для пильного центра),
// их правят как обычные числа; «Вернуть значения по умолчанию» — сбросить всё.
export const BEAM_SQL_HINT = 'Настройки пильного центра ещё не включены в базе: выполните migration_beam_saw.sql в Supabase (SQL Editor) — один раз.'

const str = v => (v == null ? '' : String(v))
const clean = v => v.replace(/[^0-9.,]/g, '')

export default function BeamSawSettings({ prod, onSaved }) {
  const raw = prod?.beam_saw_settings && typeof prod.beam_saw_settings === 'object' ? prod.beam_saw_settings : {}
  // в полях — настоящие значения (сохранённые или по умолчанию), а не серые подсказки: их можно просто исправить
  const filled = r => { const f = beamSettings(r); return { ...f, rotations: f.rotations == null ? '' : f.rotations, levelTrims: f.levelTrims.map(str) } }
  const [v, setV] = useState(() => filled(raw))
  const [msg, setMsg] = useState('')
  const s = beamSettings(v)

  const save = async next => {
    const val = next || v
    const out = {}
    for (const [k, x] of Object.entries(val)) {
      if (k === 'levelTrims') { const a = (x || []).map(t => (str(t).trim() === '' ? null : Number(str(t).replace(',', '.')))); if (a.some(t => t != null)) out[k] = a; continue }
      if (typeof x === 'boolean') { out[k] = x; continue }
      if (str(x).trim() === '') continue
      out[k] = ['direction', 'stripOrder', 'lastDir'].includes(k) ? x : Number(str(x).replace(',', '.'))
    }
    if (JSON.stringify(out) === JSON.stringify(prod?.beam_saw_settings || {})) return
    const { error } = await supabase.from('productions').update({ beam_saw_settings: out }).eq('id', prod.id)
    if (error) { setMsg(/beam_saw_settings/.test(String(error.message)) ? BEAM_SQL_HINT : error.message); return }
    setMsg('Сохранено'); setTimeout(() => setMsg(''), 1500)
    onSaved?.(out)
  }
  const set = (k, x) => setV(o => ({ ...o, [k]: x }))
  // поле стёрли и ушли — в нём снова значение по умолчанию (кроме «поворотов»: пусто — без ограничения)
  const blur = k => {
    let next = v
    if (k !== 'rotations' && str(v[k]).trim() === '' && BEAM_DEFAULTS[k] != null) { next = { ...v, [k]: BEAM_DEFAULTS[k] }; setV(next) }
    save(next)
  }
  const reset = () => {
    if (!window.confirm('Вернуть все настройки пильного центра к значениям по умолчанию?')) return
    const next = filled({}); setV(next); save(next)
  }
  const pick = (k, x) => { const next = { ...v, [k]: x }; setV(next); save(next) }

  const field = (k, label, hint, intOnly) => (
    <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 5 }}>
      <span style={{ flex: 1, minWidth: 0 }}>{label}{hint && <span style={{ display: 'block', fontSize: 10.5, color: 'var(--text-hint)' }}>{hint}</span>}</span>
      <input type="text" inputMode={intOnly ? 'numeric' : 'decimal'} value={str(v[k])} placeholder={k === 'rotations' ? 'без огр.' : ''}
        onFocus={e => e.target.select?.()}
        onChange={e => set(k, intOnly ? e.target.value.replace(/[^0-9]/g, '') : clean(e.target.value))} onBlur={() => blur(k)}
        style={{ width: 84, padding: '5px 8px', fontSize: 13, textAlign: 'center' }} />
    </label>
  )
  const seg = (k, opts) => (
    <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
      {opts.map(([val, label]) => (
        <button key={val} type="button" onClick={() => pick(k, val)}
          style={{ flex: 1, padding: '6px 4px', borderRadius: 'var(--radius)', border: 'none', fontSize: 12, cursor: 'pointer',
            background: s[k] === val ? 'var(--blue)' : 'var(--bg2)', color: s[k] === val ? 'white' : 'var(--text-muted)' }}>{label}</button>
      ))}
    </div>
  )
  const check = (k, label) => (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 6, cursor: 'pointer' }}>
      <input type="checkbox" checked={s[k]} onChange={e => pick(k, e.target.checked)} style={{ width: 17, height: 17 }} />{label}
    </label>
  )
  const head = t => <div style={{ fontSize: 12.5, fontWeight: 600, margin: '10px 0 5px' }}>{t}</div>
  const ex = Math.round(maxPartIn(600, s) * 10) / 10

  return (
    <div>
      <p style={{ fontSize: 11.5, color: 'var(--blue)', margin: '0 0 6px', lineHeight: 1.4 }}>
        β Бета-тест. Эти настройки подставляются в раскрой «Пильный центр β» у заказчиков, выбравших ваше производство. Все значения можно увеличить или уменьшить под ваш станок: нажмите на число и впишите своё. Сохраняется само.
      </p>
      {msg && <p style={{ fontSize: 12, color: msg === 'Сохранено' ? 'var(--teal)' : 'var(--amber)', margin: '0 0 6px' }}>{msg}</p>}

      {head('Пила и лист')}
      <div style={{ fontSize: 10.5, color: 'var(--text-hint)', margin: '-2px 0 6px' }}>Свои для пильного центра — не зависят от «Параметров станка» пилы и фрезера.</div>
      {field('kerf', 'Пропил (ширина реза), мм')}
      <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 3 }}>Обрезка кромки листа (отступы), мм</div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        {[['trimLeft', '←'], ['trimRight', '→'], ['trimTop', '↑'], ['trimBottom', '↓']].map(([k, l]) => (
          <label key={k} style={{ flex: 1, minWidth: 0, fontSize: 10.5, color: 'var(--text-hint)', textAlign: 'center' }}>{l}
            <input type="text" inputMode="decimal" value={str(v[k])} onFocus={e => e.target.select?.()} onChange={e => set(k, clean(e.target.value))} onBlur={() => blur(k)} style={{ padding: '4px 6px', fontSize: 13, textAlign: 'center' }} />
          </label>
        ))}
      </div>

      {head('Уровни резов и повороты')}
      {field('levels', 'Уровней резов, не больше', 'Лист → полосы → поперёк → … Каждый следующий уровень — поворот заготовки на 90°', true)}
      {field('rotations', 'Поворотов заготовки, не больше', 'Пусто — сколько позволяют уровни', true)}
      <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 3 }}>Торцовка в начале заготовки по уровням, мм<span style={{ display: 'block', fontSize: 10.5, color: 'var(--text-hint)' }}>1-й и 2-й уровни режут от краёв листа — там торцовка = обрезка листа (выше). Уровней больше — новые поля берут значение предыдущего</span></div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
        {s.levelTrims.map((def, i) => (
          <label key={i} style={{ width: 62, fontSize: 10.5, color: 'var(--text-hint)', textAlign: 'center' }}>{i + 3}-й
            <input type="text" inputMode="decimal" value={str(v.levelTrims?.[i] ?? def)} onFocus={e => e.target.select?.()}
              onChange={e => { const a = s.levelTrims.map((d, j) => str(v.levelTrims?.[j] ?? d)); a[i] = clean(e.target.value); set('levelTrims', a) }}
              onBlur={() => {
                // стёрли — как на предыдущем уровне (на первом из них — по умолчанию)
                const a = s.levelTrims.map((d, j) => str(v.levelTrims?.[j] ?? d))
                if (a[i].trim() === '') a[i] = i ? a[i - 1] : str(BEAM_DEFAULTS.levelTrims[0])
                const next = { ...v, levelTrims: a }; setV(next); save(next)
              }} style={{ padding: '4px 6px', fontSize: 13, textAlign: 'center' }} />
          </label>
        ))}
      </div>

      {head('Захват и узкие детали')}
      {field('grip', 'Мин. остаток для захвата, мм', `Деталь уже полосы — остаток не меньше этого. Сейчас: в полосу 600 — деталь не больше ${ex} (или ровно 600)`)}
      {check('gripWithKerf', 'Остаток считается вместе с пропилом')}
      {field('narrowMin', 'Узкая деталь — до, мм (включительно)', 'Такие детали пилятся с запасом. 0 — выключено')}
      {field('narrowCut', 'Пилить узкую деталь шириной, мм', 'Потом подрезается до своего размера — на карте и бирке будет «подрезать до …»')}

      {head('Полосы')}
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 3 }}>Направление полос</div>
      {seg('direction', [['y', 'Вдоль длинной (Y)'], ['x', 'Вдоль короткой (X)'], ['auto', 'Авто']])}
      <div style={{ fontSize: 10.5, color: 'var(--text-hint)', margin: '-2px 0 6px' }}>Авто: есть детали с текстурой — вдоль волокон (Y), нет — пробуются оба направления. Детали с текстурой не поворачиваются при любом направлении.</div>
      {s.direction === 'auto' && <>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 3 }}>Последний лист — обрезок вдоль</div>
        {seg('lastDir', [['y', 'Длинной (Y)'], ['x', 'Короткой (X)'], ['any', 'Как выгоднее']])}
        <div style={{ fontSize: 10.5, color: 'var(--text-hint)', margin: '-2px 0 6px' }}>Только для последнего листа: его полосы идут вдоль выбранной стороны, чтобы цельный остаток был вдоль неё. Остальные листы — как выгоднее.</div>
      </>}
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 3 }}>Порядок полос</div>
      {seg('stripOrder', [['desc', 'От большой к малой'], ['wnw', 'Б → М → Б']])}

      {head('Обрезки и карты')}
      <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 3 }}>Деловой обрезок — не меньше, мм</div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        {[['offcutMinL', 'длина'], ['offcutMinW', 'ширина']].map(([k, l]) => (
          <label key={k} style={{ flex: 1, minWidth: 0, fontSize: 10.5, color: 'var(--text-hint)', textAlign: 'center' }}>{l}
            <input type="text" inputMode="decimal" value={str(v[k])} onFocus={e => e.target.select?.()} onChange={e => set(k, clean(e.target.value))} onBlur={() => blur(k)} style={{ padding: '4px 6px', fontSize: 13, textAlign: 'center' }} />
          </label>
        ))}
      </div>
      {check('mergeSame', 'Одинаковые карты — одной картой «× N листов»')}
      <button type="button" onClick={reset} style={{ marginTop: 8, padding: '6px 12px', borderRadius: 16, fontSize: 12, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>
        Вернуть значения по умолчанию
      </button>
    </div>
  )
}
