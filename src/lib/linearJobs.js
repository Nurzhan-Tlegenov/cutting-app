// Задания линейного раскроя — в настройках пользователя (linearJobs), видны на всех его устройствах.
import { getUserSettings, saveUserSettings } from './userSettings'
import { linearCut } from './linearNest'

export const LINEAR_FEATURE = 'linear_cut'
export const nid = () => Math.random().toString(36).slice(2, 9)
export function newLinearJob(extra = {}) {
  return { id: nid(), name: 'Новый раскрой', material: '', stocks: [{ len: 6000, qty: '' }], kerf: 3, trim: 0, pieces: [{ id: nid(), name: '', len: '', qty: 1 }], ...extra }
}
export const readJobs = user => { try { return getUserSettings(user)?.linearJobs || [] } catch { return [] } }
export const writeJobs = (jobs, user) => saveUserSettings({ linearJobs: jobs }, user)

const num = v => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : null }
/** задание -> результат линейного раскроя */
export function computeJob(job) {
  return linearCut({
    pieces: (job.pieces || []).map(p => ({ len: num(p.len), qty: num(p.qty) ?? 1, name: p.name, angles: p.angles || '' })),
    stocks: (job.stocks || []).map(s => ({ len: num(s.len), qty: s.qty === '' || s.qty == null ? null : num(s.qty) })),
    kerf: num(job.kerf) ?? 0, trim: num(job.trim) ?? 0,
  })
}
export const LINEAR_SQL_HINT = 'Погонные материалы к заказу не прикрепились: в базе нет колонки. Выполните migration_order_linear.sql в Supabase (SQL Editor) — один раз.'
