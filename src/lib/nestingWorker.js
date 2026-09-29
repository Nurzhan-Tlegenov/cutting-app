// Web Worker для раскроя: один воркер — один расчёт. Так несколько конфигураций
// раскроя считаются одновременно (у каждого воркера своё состояние модулей) и
// не подвешивают интерфейс.
//
// Протокол:
//   → { type: 'start', params, live }  — запуск (live — до «Стоп»)
//   → { type: 'stop' }                  — «Стоп»: поиск заканчивается, лучший вариант доводится до финала
//   ← { type: 'progress', res }         — промежуточное улучшение (для показа на экране)
//   ← { type: 'done', res }             — итог
//   ← { type: 'error', error }
import { runLiveNesting } from './liveNesting'

let stopRequested = false

self.onmessage = async e => {
  const msg = e.data || {}
  if (msg.type === 'stop') { stopRequested = true; return }
  // совместимость со старым форматом { params }
  const params = msg.params
  if (!params) return
  stopRequested = false
  try {
    const res = await runLiveNesting(params, {
      live: !!msg.live,
      shouldStop: () => stopRequested,
      onProgress: res => self.postMessage({ type: 'progress', res }),
    })
    self.postMessage({ type: 'done', res })
  } catch (err) {
    self.postMessage({ type: 'error', error: err?.message || String(err) })
  }
}
