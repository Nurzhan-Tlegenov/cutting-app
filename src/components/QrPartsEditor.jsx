import { useRef } from 'react'
import { QR_TOKENS, QR_TOKEN_RE, qrTemplateOf } from '../lib/labelMaker'

// Конструктор кода детали — один и тот же для QR-кода бирки и для имени файла программы присадочного станка.
// Как названия папок: части в фигурных скобках добавляются кнопками «+» туда, где стоит курсор, в любом порядке и
// сколько угодно раз; между ними — свой текст и любые разделители. У каждой части можно ограничить число символов.
// value — { tpl, latin, sep, … } (прежний выбор галочками { parts, sep, text } превращается в шаблон сам),
// exclude — части, которые не предлагать ('link' — ссылка на 3D), props — свойства деталей заказа [[тип, название]].
const SEPS = /[\s_.\-;:,|/\\+#=*~]/
const nameOf = code => (code.startsWith('S:') ? `«${code.slice(2)}»` : (QR_TOKENS.find(([c]) => c === code) || [])[1] || code)

export default function QrPartsEditor({ value, onChange, exclude = [], preview, props = [] }) {
  const q = { parts: [], sep: '_', text: '', latin: false, ...value }
  const tpl = qrTemplateOf(q)
  const ref = useRef(null), caret = useRef(null)
  const remember = e => { caret.current = e.target.selectionStart }
  // пустой шаблон — пустой код (а не прежние галочки)
  const setTpl = t => onChange({ ...q, tpl: t, ...(t.trim() ? {} : { parts: [] }) })
  const sep = q.sep ?? '_'
  const add = code => {
    const el = ref.current, cur = el ? el.value : tpl
    const pos = document.activeElement === el ? el.selectionStart : caret.current
    const at = pos == null || pos < 0 || pos > cur.length ? cur.length : pos
    const before = cur.slice(0, at), after = cur.slice(at), tok = `{${code}}`
    const l = before && !SEPS.test(before.slice(-1)) ? sep : '', r = after && !SEPS.test(after.charAt(0)) ? sep : ''
    const next = before + l + tok + r + after
    if (el) el.value = next
    caret.current = at + l.length + tok.length + r.length
    setTpl(next)
  }
  // части шаблона — со своим ограничением символов
  const tokens = [...tpl.matchAll(QR_TOKEN_RE)].map(m => ({ code: m[1].trim(), n: m[2] != null ? Number(m[2]) : 0, at: m.index, len: m[0].length }))
  const replaceTok = (t, str) => setTpl(tpl.slice(0, t.at) + str + tpl.slice(t.at + t.len))
  const setLimit = (t, raw) => {
    const n = parseInt(String(raw).replace(/[^\d-]/g, ''), 10)
    replaceTok(t, n ? `{${t.code}:${n}}` : `{${t.code}}`)
  }
  const removeTok = t => {
    let a = t.at, b = t.at + t.len
    if (SEPS.test(tpl.charAt(b))) b++; else if (a > 0 && SEPS.test(tpl.charAt(a - 1))) a--   // и разделитель рядом
    setTpl(tpl.slice(0, a) + tpl.slice(b))
  }
  const chip = { padding: '4px 9px', borderRadius: 20, fontSize: 11.5, border: '0.5px solid var(--blue-mid)', background: 'transparent', color: 'var(--blue)', cursor: 'pointer' }
  const parts = QR_TOKENS.filter(([c]) => !(exclude.includes('link') && c === 'SSYLKA'))
  return (
    <>
      <input ref={ref} type="text" key={tpl} defaultValue={tpl} placeholder="Например: {ZAKAZ:10}-{POZ}_{OBOZ}"
        onBlur={e => { remember(e); if (e.target.value !== tpl) setTpl(e.target.value) }} onSelect={remember} onKeyUp={remember} onClick={remember}
        style={{ fontFamily: 'monospace', fontSize: 13, padding: '7px 9px' }} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 6 }}>
        {parts.map(([code, label]) => <button key={code} type="button" title={`Вставить {${code}}`} onClick={() => add(code)} style={chip}>+ {label}</button>)}
        {props.map(([k, label]) => <button key={k} type="button" title="Свойство детали из импорта" onClick={() => add('S:' + label)} style={{ ...chip, borderStyle: 'dashed' }}>+ {label}</button>)}
      </div>

      {tokens.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {tokens.map((t, i) => (
            <div key={i + t.code + t.at} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>{i + 1}. {nameOf(t.code)}</span>
              <span style={{ fontSize: 11, color: 'var(--text-hint)' }}>символов</span>
              <input type="text" inputMode="numeric" key={'n' + t.at + t.n} defaultValue={t.n || ''} placeholder="все"
                onBlur={e => { const v = parseInt(e.target.value, 10) || 0; if (v !== t.n) setLimit(t, e.target.value) }}
                title="Пусто — целиком; 8 — первые 8 символов; -4 — последние 4"
                style={{ width: 58, padding: '4px 6px', fontSize: 12, textAlign: 'center' }} />
              <button type="button" onClick={() => removeTok(t)} title="Убрать часть" style={{ border: 'none', background: 'none', color: 'var(--danger)', fontSize: 14, padding: '0 4px', cursor: 'pointer' }}>✕</button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>Разделитель при добавлении
          <input type="text" key={'s' + sep} defaultValue={sep} maxLength={3} onBlur={e => { if (e.target.value !== sep) onChange({ ...q, tpl, sep: e.target.value }) }}
            style={{ width: 52, padding: '4px 6px', textAlign: 'center' }} /></label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)', margin: 0 }}
          title="Если в части меньше символов, чем задано, — спереди дописывается этот знак: 12 при 4 символах -> 0012. Пусто — не дополнять">Дополнять до числа символов знаком
          <input type="text" key={'p' + (q.pad || '')} defaultValue={q.pad || ''} maxLength={1} placeholder="нет"
            onBlur={e => { const v = [...e.target.value][0] || ''; if (v !== (q.pad || '')) onChange({ ...q, tpl, pad: v }) }}
            style={{ width: 52, padding: '4px 6px', textAlign: 'center' }} /></label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, cursor: 'pointer', margin: 0 }}>
          <input type="checkbox" checked={!!q.latin} onChange={e => onChange({ ...q, tpl, latin: e.target.checked })} style={{ width: 17, height: 17 }} />
          Перевести в латиницу
        </label>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 4 }}>
        Части в фигурных скобках подставляются сами, всё остальное (прочерк, точка, свой текст) идёт в код как написано. Части можно повторять.
        Число символов: пусто — целиком, 8 — первые 8, −4 — последние 4; если символов меньше и задан знак дополнения — спереди дописывается он (заказ 12, 4 символа, знак 0 → 0012). Пустая часть убирается вместе с разделителем рядом. Пробелы в коде заменяются «_».
      </div>
      {preview != null && (
        <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 6, wordBreak: 'break-all' }}>
          Сейчас в коде: <span style={{ fontFamily: 'monospace', color: 'var(--text)' }}>{preview || '— пусто —'}</span>
        </div>
      )}
    </>
  )
}
