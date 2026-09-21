// Web Worker для раскроя: один воркер — один расчёт. Так несколько конфигураций
// раскроя считаются одновременно (у каждого воркера своё состояние модулей) и
// не подвешивают интерфейс.
import { runNesting } from './nesting'

self.onmessage = async e => {
  try {
    const res = await runNesting(e.data.params)
    self.postMessage({ ok: true, res })
  } catch (err) {
    self.postMessage({ ok: false, error: err?.message || String(err) })
  }
}
