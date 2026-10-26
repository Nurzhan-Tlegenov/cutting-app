import { Suspense, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { lazyRetry } from '../lib/lazyRetry'
import { learnFromProgram, readProgramFile } from '../lib/gcodeLearn'
import { useBackClose } from '../lib/backStack'
import CncLoader from './CncLoader'

const GcodeSimulator = lazyRetry(() => import('./GcodeSimulator'))

// Симуляция G-кода из файла — любой управляющей программы, в том числе сделанной другими программами (как просмотр XML
// присадки). Нужна, чтобы посмотреть, что делает чужая программа, прежде чем настраивать по ней постпроцессор.
// Диаметры инструментов берутся из комментариев программы, свёрла присадочной головы — по виду смены инструмента
// (см. gcodeLearn.js): голова рисуется слева от шпинделя. Отверстия и контуры раскрашиваются по типу инструмента.
export default function GcodeFileSim({ onClose }) {
  useBackClose(true, onClose)
  const file = useRef(null)
  const [sim, setSim] = useState(null)        // { name, text, kinds, dia, head, thickness }
  const [err, setErr] = useState('')
  const pick = async e => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    setErr('')
    if (f.size > 40 * 1024 * 1024) { setErr('Файл больше 40 МБ — возьмите программу одного листа.'); return }
    try {
      const { text } = await readProgramFile(f)
      const r = learnFromProgram(text)
      const tools = r.learned?.tools || []
      const dia = Object.fromEntries(tools.filter(t => t.d > 0).map(t => [t.t, t.d]))
      const type = Object.fromEntries(tools.map(t => [t.t, t.type]))
      // вид операции по строкам: после смены на сверло — отверстия, на фрезу — контуры
      let cur = null
      const kinds = text.split(/\r?\n/).map(l => {
        const s = l.replace(/\([^)]*\)/g, '').replace(/;.*$/, '')
        const m = /T\s*0*(\d+)/i.exec(s)
        if (m && /M0?6(?=\D|$)|^\s*(N\d+\s*)?T/i.test(s)) cur = Number(m[1])
        return cur == null ? null : type[cur] === 'drill' ? 'hole' : 'outer'
      })
      const th = /x\s*(\d+(?:[.,]\d+)?)\s*[;)]/i.exec((/Sheet[^)]*\)/i.exec(text) || [])[0] || '')
      setSim({ name: f.name, text, kinds, dia, head: tools.filter(t => t.head).map(t => t.t), thickness: th ? Number(th[1].replace(',', '.')) : 16 })
    } catch (x) { setErr(`Файл не прочитался: ${x?.message || x}`) }
  }
  const box = { position: 'fixed', inset: 0, background: 'var(--bg)', zIndex: 1100, height: '100dvh', overscrollBehavior: 'contain' }
  return createPortal(
    sim ? (
      <div style={{ ...box, padding: 10, boxSizing: 'border-box' }}>
        <div style={{ maxWidth: window.innerWidth >= 1100 ? 'none' : 1100, margin: '0 auto', height: '100%' }}>
          <Suspense fallback={<CncLoader label="Запускаем симулятор…" />}>
            <GcodeSimulator key={sim.name} text={sim.text} kinds={sim.kinds} title={sim.name} thickness={sim.thickness}
              toolDia={t => sim.dia[t] || 0} headTools={sim.head} onClose={() => setSim(null)} />
          </Suspense>
        </div>
      </div>
    ) : (
      <div style={{ ...box, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderBottom: '0.5px solid var(--border)' }}>
          <div style={{ flex: 1, fontSize: 16, fontWeight: 500 }}>Симуляция G-кода</div>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 26, lineHeight: 1, color: 'var(--text-muted)', padding: '0 4px' }}>×</button>
        </div>
        <div style={{ padding: 14 }}>
          <input ref={file} type="file" style={{ display: 'none' }} onChange={pick} />
          <button type="button" className="btn-primary" onClick={() => file.current?.click()}>📂 Открыть управляющую программу</button>
          <p style={{ fontSize: 12, color: 'var(--text-hint)', marginTop: 8 }}>
            Любой G-код — из этого приложения или из других программ (.nc, .tap, .cnc, .txt…). Видно траектории, порядок обработки,
            смены инструмента и строки программы. Если в программе есть присадочная голова, она рисуется слева от шпинделя.
          </p>
          {err && <p className="error-text" style={{ marginTop: 8 }}>{err}</p>}
        </div>
      </div>
    ),
    document.body,
  )
}
