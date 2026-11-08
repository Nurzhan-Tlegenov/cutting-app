// Задания линейного раскроя — в настройках пользователя (linearJobs), видны на всех его устройствах.
import { getUserSettings, saveUserSettings } from './userSettings'

export const LINEAR_FEATURE = 'linear_cut'
export const nid = () => Math.random().toString(36).slice(2, 9)
export function newLinearJob(extra = {}) {
  return { id: nid(), name: 'Новый раскрой', material: '', stocks: [{ len: 6000, qty: '' }], kerf: 3, trim: 0, pieces: [{ id: nid(), name: '', len: '', qty: 1 }], ...extra }
}
export const readJobs = user => { try { return getUserSettings(user)?.linearJobs || [] } catch { return [] } }
export const writeJobs = (jobs, user) => saveUserSettings({ linearJobs: jobs }, user)
