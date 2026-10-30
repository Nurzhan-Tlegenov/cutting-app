import { useEffect, useMemo, useRef, useState } from 'react'
import { parseNestingFile } from '../lib/nestingFile'

// Мастер-аккаунт: просмотр файла раскроя, присланного пользователем («Результат раскроя», «История раскроя»,
// «Замечание по пильному центру»), — прямо в «Сообщениях», без скачивания. Карты листов, хронология по времени
// с откатом назад (ползунок, шаги, проигрывание), список улучшений и детали заказа.

const r1 = v => Math.round(v * 10) / 10
const pct = v => (v == null ? '—' : Math.round(v * 1000) / 10 + '%')
const secs = ms => (ms == null ? '' : ms < 60000 ? r1(ms / 1000) + ' с' : Math.floor(ms / 60000) + ' мин ' + Math.round((ms % 60000) / 1000) + ' с')
const COLORS = ['#cfe3ff', '#d6f5e3', '#ffe2c6', '#eadcff', '#ffd6dd', '#d9f2f7', '#f6efc4', '#e3e8ee']
const VIA = { lattice: 'решётка «ёлочкой»', seed: 'черновик', rough: 'черновик', hybrid: 'пары → прямоугольники', exact: 'точно по контурам', rect: 'прямоугольники' }

function polyArea(P) { let a = 0; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += p[0] * q[1] - q[0] * p[1] } return Math.abs(a) / 2 }

function SheetSvg({ sh, idx, width, hover, setHover }) {
  const ux = sh.usableX || 1, uy = sh.usableY || 1
  const sc = width / ux
  const parts = sh.placed
  const fill = parts.reduce((a, p) => a + (p.poly ? polyArea(p.poly) : p.w * p.h), 0) / (ux * uy)
  return (
    <div style={{ width, flex: '0 0 auto' }}>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 3 }}>
        Лист {idx + 1}{sh.stock === 'offcut' ? ' (обрезок)' : ''} · {parts.length} дет. · {Math.round(fill * 100)}%
      </div>
      <svg width={width} height={uy * sc} viewBox={`0 0 ${ux} ${uy}`} style={{ display: 'block', background: '#fff', border: '1px solid var(--border-md)' }}>
        {parts.map((p, i) => {
          // Y вверх от низа рабочей зоны -> SVG (Y вниз)
          const col = COLORS[(p.di ?? 0) % COLORS.length]
          const on = hover === p.di
          const cx = p.x + p.w / 2, cy = uy - (p.y + p.h / 2)
          const fs = Math.max(12, Math.min(p.w, p.h) / 7)
          return (
            <g key={i} onMouseEnter={() => setHover(p.di)} onMouseLeave={() => setHover(null)}>
              <rect x={p.x} y={uy - p.y - p.h} width={p.w} height={p.h} fill="none" stroke="#c9ced6" strokeWidth={1 / sc} strokeDasharray={`${4 / sc} ${3 / sc}`} />
              {p.poly
                ? <polygon points={p.poly.map(q => `${p.x + q[0]},${uy - (p.y + q[1])}`).join(' ')} fill={on ? '#ffd27a' : col} stroke="#3d4b5c" strokeWidth={1.2 / sc} />
                : <rect x={p.x} y={uy - p.y - p.h} width={p.w} height={p.h} fill={on ? '#ffd27a' : col} stroke="#3d4b5c" strokeWidth={1.2 / sc} />}
              <text x={cx} y={cy} fontSize={fs} textAnchor="middle" dominantBaseline="middle" fill="#1d2733" style={{ pointerEvents: 'none' }}>
                {p.label.length > 18 ? p.label.slice(0, 17) + '…' : p.label}
              </text>
              <text x={cx} y={cy + fs * 1.1} fontSize={fs * 0.8} textAnchor="middle" dominantBaseline="middle" fill="#55606e" style={{ pointerEvents: 'none' }}>
                {r1(p.x)};{r1(p.y)}{p.rot ? ` ↻${p.rot}°` : ''}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

export default function NestingFileViewer({ fileName, text, onClose }) {
  const tracks = useMemo(() => { try { return { list: parseNestingFile(text) } } catch (e) { return { error: e.message || String(e) } } }, [text])
  const list = tracks.list || []
  const [ti, setTi] = useState(0)
  const tr = list[ti] || null
  const n = tr?.frames.length || 0
  const [fi, setFi] = useState(Math.max(0, n - 1))
  const [play, setPlay] = useState(false)
  const [hover, setHover] = useState(null)
  const [zoom, setZoom] = useState(1)
  const timer = useRef(null)
  useEffect(() => {
    if (!play) return
    timer.current = setInterval(() => setFi(i => { if (i >= n - 1) { setPlay(false); return i } return i + 1 }), 700)
    return () => clearInterval(timer.current)
  }, [play, n])
  useEffect(() => {
    const on = e => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') setFi(i => Math.max(0, i - 1))
      else if (e.key === 'ArrowRight') setFi(i => Math.min(n - 1, i + 1))
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [n, onClose])

  const fr = tr?.frames[fi] || null
  const btn = { padding: '5px 10px', borderRadius: 8, border: '0.5px solid var(--border-md)', background: 'var(--bg)', color: 'var(--text)', fontSize: 13, cursor: 'pointer' }
  const sheetW = Math.round(260 * zoom)
  const best = tr && n > 1 ? tr.frames.reduce((b, f, i) => (f.count < tr.frames[b].count || (f.count === tr.frames[b].count && (f.last ?? 0) < (tr.frames[b].last ?? 0)) ? i : b), 0) : 0

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'var(--bg2)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '0.5px solid var(--border)', background: 'var(--bg)' }}>
        <button type="button" onClick={onClose} style={{ ...btn, border: 'none', fontSize: 20, color: 'var(--blue)', padding: 0 }}>←</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Раскрой из файла</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-hint)', fontFamily: 'monospace', wordBreak: 'break-all' }}>{fileName}</div>
        </div>
        <button type="button" style={btn} onClick={() => setZoom(z => Math.max(0.5, z / 1.25))}>−</button>
        <button type="button" style={btn} onClick={() => setZoom(z => Math.min(4, z * 1.25))}>+</button>
      </div>

      {tracks.error && <p className="error-text" style={{ padding: 14 }}>Не удалось прочитать файл: {tracks.error}</p>}
      {!tracks.error && !list.length && <p style={{ padding: 14, color: 'var(--text-muted)' }}>В файле нет раскроя (ни карт листов, ни хронологии).</p>}

      {tr && (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {list.length > 1 && (
            <div style={{ display: 'flex', gap: 6, padding: '8px 14px 0', flexWrap: 'wrap' }}>
              {list.map((t, i) => (
                <button key={i} type="button" onClick={() => { setTi(i); setPlay(false); setFi(Math.max(0, t.frames.length - 1)) }}
                  style={{ ...btn, borderRadius: 16, fontSize: 12, background: i === ti ? 'var(--blue)' : 'var(--bg)', color: i === ti ? '#fff' : 'var(--text-muted)' }}>{t.title}</button>
              ))}
            </div>
          )}
          {/* хронология: ползунок, шаги, проигрывание */}
          {n > 1 && (
            <div style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <button type="button" style={btn} onClick={() => setFi(0)} title="К началу">⏮</button>
              <button type="button" style={btn} onClick={() => setFi(i => Math.max(0, i - 1))} title="Шаг назад (←)">◀</button>
              <button type="button" style={{ ...btn, minWidth: 40 }} onClick={() => { if (fi >= n - 1) setFi(0); setPlay(p => !p) }}>{play ? '⏸' : '▶'}</button>
              <button type="button" style={btn} onClick={() => setFi(i => Math.min(n - 1, i + 1))} title="Шаг вперёд (→)">▶|</button>
              <button type="button" style={btn} onClick={() => setFi(n - 1)} title="Финиш">⏭</button>
              <input type="range" min={0} max={n - 1} value={fi} onChange={e => { setPlay(false); setFi(Number(e.target.value)) }} style={{ flex: 1, minWidth: 160 }} />
              <span style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{fi + 1} / {n}</span>
              {best !== fi && <button type="button" style={{ ...btn, fontSize: 12, color: 'var(--teal)', borderColor: 'var(--teal)' }} onClick={() => setFi(best)}>★ лучший</button>}
            </div>
          )}
          {fr && (
            <div style={{ padding: '0 14px 6px', fontSize: 12.5, color: 'var(--text-muted)', display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              <span>Листов: <b style={{ color: 'var(--text)' }}>{fr.sheets.length}</b></span>
              <span>Деталей: <b style={{ color: 'var(--text)' }}>{fr.sheets.reduce((a, s) => a + s.placed.length, 0)}</b></span>
              {fr.util != null && <span>Заполнение: <b style={{ color: 'var(--text)' }}>{pct(fr.util)}</b></span>}
              {fr.lastFill != null && <span>Последний лист: <b style={{ color: 'var(--text)' }}>{pct(fr.lastFill)}</b></span>}
              {fr.t != null && <span>Время: <b style={{ color: 'var(--text)' }}>{secs(fr.t)}</b></span>}
              {fr.via && <span>Чем найден: {VIA[fr.via] || fr.via}{fr.mode ? ` · ${fr.mode}` : ''}{fr.island != null ? ` · поток ${fr.island}` : ''}{fr.iter ? ` · шаг ${fr.iter}` : ''}</span>}
              {fr.kind && fr.kind !== 'result' && fr.kind !== 'best' && <span>({fr.kind})</span>}
            </div>
          )}
          <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 0 }}>
            <div style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: '6px 14px 20px' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-start' }}>
                {fr?.sheets.map((sh, i) => <SheetSvg key={i} sh={sh} idx={i} width={sheetW} hover={hover} setHover={setHover} />)}
              </div>
            </div>
            {/* справа: улучшения по времени (щёлкнуть — откатиться к ним) и детали */}
            {(tr.params || n > 1 || tr.details?.length > 0) && <div style={{ width: 'min(290px, 38vw)', flex: '0 0 auto', borderLeft: '0.5px solid var(--border)', overflow: 'auto', padding: '6px 10px', background: 'var(--bg)', fontSize: 12 }}>
              {tr.params && (
                <div style={{ marginBottom: 8, color: 'var(--text-muted)' }}>
                  Лист {tr.params.sheetL}×{tr.params.sheetW}, рез {tr.params.kerf}, отступы {tr.params.marginT}/{tr.params.marginR}/{tr.params.marginB}/{tr.params.marginL}
                  {tr.params.cuttingMethod ? ` · ${tr.params.cuttingMethod}` : ''}{tr.params.algo ? ` · ${tr.params.algo}` : ''}
                  {tr.meta?.algoVersion ? ` · алгоритм ${tr.meta.algoVersion}` : ''}{tr.meta?.islands ? ` · потоков ${tr.meta.islands}` : ''}
                  {tr.meta?.durationMs ? ` · шёл ${secs(tr.meta.durationMs)}` : ''}
                </div>
              )}
              {n > 1 && (
                <>
                  <div style={{ fontWeight: 600, margin: '4px 0' }}>Хронология</div>
                  {tr.frames.map((f, i) => (
                    <div key={i} onClick={() => { setPlay(false); setFi(i) }}
                      style={{ padding: '3px 6px', borderRadius: 6, cursor: 'pointer', background: i === fi ? 'var(--blue-light)' : 'transparent', display: 'flex', gap: 6 }}>
                      <span style={{ width: 52, color: 'var(--text-hint)' }}>{secs(f.t)}</span>
                      <span style={{ flex: 1 }}>{f.count} л. · {pct(f.util)}{f.lastFill != null ? ` · посл. ${pct(f.lastFill)}` : ''}</span>
                      {i === best && <span style={{ color: 'var(--teal)' }}>★</span>}
                    </div>
                  ))}
                </>
              )}
              {tr.details?.length > 0 && (
                <>
                  <div style={{ fontWeight: 600, margin: '10px 0 4px' }}>Детали</div>
                  {tr.details.map((d, i) => (
                    <div key={i} onMouseEnter={() => setHover(d.i ?? i)} onMouseLeave={() => setHover(null)}
                      style={{ padding: '2px 6px', borderRadius: 6, background: hover === (d.i ?? i) ? '#fff1d6' : 'transparent' }}>
                      <span style={{ display: 'inline-block', width: 10, height: 10, background: COLORS[(d.i ?? i) % COLORS.length], border: '1px solid #8a94a3', marginRight: 5 }} />
                      {d.prefix ? d.prefix + ' ' : ''}{d.name || d.display_name || `#${i}`} — {d.length}×{d.width} × {d.qty}{d.rotatable ? ' ↻' : ''}{d.contour ? ' · контур' : ''}
                    </div>
                  ))}
                </>
              )}
            </div>}
          </div>
        </div>
      )}
    </div>
  )
}
