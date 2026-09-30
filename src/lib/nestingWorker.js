// Web Worker для раскроя: один воркер — один расчёт. Так несколько конфигураций
// раскроя считаются одновременно (у каждого воркера своё состояние модулей) и
// не подвешивают интерфейс.
//
// Протокол:
//   → { type: 'start', params, live, island, islands } — запуск (live — до «Стоп»; island — номер потока, от него роль у фигурных деталей)
//   → { type: 'stop' }                  — «Стоп»: поиск заканчивается, лучший вариант доводится до финала
//   → { type: 'migrant', genome, sheets } — лучший вариант соседнего потока: порядок + раскладка
//   ← { type: 'progress', res }         — промежуточное улучшение (для показа на экране)
//   ← { type: 'stats', stats }          — «пульс» поиска раз в ~1 с (для хронологии раскроя)
//   ← { type: 'done', res }             — итог
//   ← { type: 'error', error }
import { runLiveNesting } from './liveNesting'

let stopRequested = false
let migrant = null

self.onmessage = async e => {
  const msg = e.data || {}
  if (msg.type === 'stop') { stopRequested = true; return }
  // лучший вариант соседа: порядок деталей (genome) + сама раскладка (sheets)
  if (msg.type === 'migrant') { migrant = msg.sheets && msg.genome ? { ...msg.genome, sheets: msg.sheets } : msg.genome; return }
  // совместимость со старым форматом { params }
  const params = msg.params
  if (!params) return
  stopRequested = false
  try {
    const res = await runLiveNesting(params, {
      live: !!msg.live,
      island: msg.island || 0, islands: msg.islands || 1,
      shouldStop: () => stopRequested,
      takeMigrant: () => { const m = migrant; migrant = null; return m },
      onProgress: res => self.postMessage({ type: 'progress', res }),
      onStats: stats => self.postMessage({ type: 'stats', stats }),
    })
    self.postMessage({ type: 'done', res })
  } catch (err) {
    self.postMessage({ type: 'error', error: err?.message || String(err) })
  }
}
