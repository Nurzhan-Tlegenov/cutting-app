// Резервная копия настроек производства — один файл .json: сохранить у себя, перенести на другой аккаунт, восстановить.
// В файле — разделы (что восстанавливать, выбирают при загрузке):
//   cnc     — постпроцессоры (свои, не общие), инструменты, обработка, «Мои постпроцессоры», имена файлов и папок;
//   labels  — шаблон бирки, сохранённые шаблоны, бирка деловых остатков;
//   reports — отчёты PDF: конструктор листа, страница статистики, смета;
//   machine — параметры станка производства (рез, отступы, ХДФ, авто-обрезки) и настройки пильного центра;
//   prices  — прайс-лист;
//   other   — прочее за аккаунтом: свои форматы листа, обозначения кромки, виды кромки, фрезы фасадов, пресеты импорта.
// Заказы, клиенты, сотрудники и посты в файл не входят.
import { getUserSettings, saveUserSettings, fetchUserSettings } from './userSettings'
import { supabase } from './supabase'
import { loadPrices, savePrices } from './pricing'
import { syncProductionReports } from './productionReports'
import { saveProductionCnc } from './productionApi'
import { normalizeCnc } from './cncSettings'
import { loadLabelImages, saveLabelImage } from './materialTextures'

export const BACKUP_KIND = 'raskroypro-settings'
export const SECTIONS = [
  ['cnc', 'Постпроцессоры и программы ЧПУ', 'станки, инструменты, обработка, «Мои постпроцессоры», имена файлов'],
  ['labels', 'Бирки', 'шаблон бирки, сохранённые шаблоны, бирка деловых остатков'],
  ['reports', 'Отчёты (PDF)', 'конструктор листа, страница статистики, смета'],
  ['machine', 'Параметры станка', 'рез, отступы, ХДФ, авто-обрезки, пильный центр'],
  ['prices', 'Прайс-лист', 'цены на работы'],
  ['other', 'Прочее', 'свои форматы листа, обозначения кромки, виды кромки, фрезы фасадов, пресеты импорта'],
]
// какие настройки аккаунта в каком разделе
const KEYS = {
  cnc: ['cnc', 'fileNames', 'cncWithLabels', 'cncWithMaps', 'drillKind'],
  labels: ['labelTpl', 'labelRemTpl', 'labelRemSaved', 'labelSaved', 'labelSavedCur'],
  reports: ['pdfTpl', 'pdfStatsPage', 'pdfSummary', 'pdfEstimate'],
  other: ['sheetFormats', 'edgeAliasMem', 'edgeTypes', 'facadeMills', 'offcutMargin', 'importPresets', 'basisFaceOrder', 'dxfSnap'],
}
const PROD_COLS = ['kerf_width', 'margin_left', 'margin_right', 'margin_top', 'margin_bottom',
  'hdf_kerf_width', 'hdf_margin_left', 'hdf_margin_right', 'hdf_margin_top', 'hdf_margin_bottom', 'offcut_min_length', 'offcut_min_width', 'beam_saw_settings']

const has = v => v !== undefined && v !== null && !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)

/** Собрать файл настроек. prod — своё производство (или null). -> { data, fileName } */
export async function makeBackup(user, prod) {
  const st = await fetchUserSettings(user)
  const sections = {}
  for (const [sec, keys] of Object.entries(KEYS)) {
    const part = {}
    for (const k of keys) if (has(st[k])) part[k] = st[k]
    if (sec === 'cnc' && part.cnc) part.cnc = { ...part.cnc, posts: (part.cnc.posts || []).filter(p => !p.shared) }   // общие постпроцессоры — у всех и так есть
    // картинки, вставленные в бирки (логотип и т. п.), хранятся отдельно — кладём в файл те, что используются в шаблонах
    if (sec === 'labels' && Object.keys(part).length) {
      try {
        const used = new Set((JSON.stringify(part).match(/"ref:[^"]+"/g) || []).map(x => x.slice(5, -1)))
        const all = await loadLabelImages(user)
        const imgs = Object.fromEntries(Object.entries(all || {}).filter(([id]) => used.has(id)))
        if (Object.keys(imgs).length) part.__images = imgs
      } catch { /* без картинок */ }
    }
    if (Object.keys(part).length) sections[sec] = part
  }
  if (prod?.id) {
    const { data: row } = await supabase.from('productions').select('*').eq('id', prod.id).maybeSingle()
    const m = {}
    for (const c of PROD_COLS) if (row && has(row[c])) m[c] = row[c]
    if (Object.keys(m).length) sections.machine = m
    const pr = await loadPrices(prod.id)
    if (!pr.error && has(pr.data)) sections.prices = pr.data
  }
  const data = { kind: BACKUP_KIND, version: 1, at: new Date().toISOString(), from: prod?.name || '', sections }
  const day = new Date().toISOString().slice(0, 10)
  const name = String(prod?.name || 'nastroyki').replace(/[^\wа-яё.-]+/gi, '_').slice(0, 40)
  return { data, fileName: `RaskroyPro_${name}_${day}.json` }
}

export function downloadJson(data, fileName) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url; a.download = fileName
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30000)
}

/** Прочитать файл настроек -> { data, sections: [ключи разделов] } | { error } */
export async function readBackup(file) {
  try {
    const data = JSON.parse(await file.text())
    if (data?.kind !== BACKUP_KIND || !data.sections || typeof data.sections !== 'object') return { error: 'Это не файл настроек РаскройPro.' }
    return { data, sections: SECTIONS.map(([k]) => k).filter(k => data.sections[k]) }
  } catch { return { error: 'Не удалось прочитать файл — он повреждён или это не файл настроек.' } }
}

/**
 * Восстановить выбранные разделы. Текущие настройки этих разделов заменяются (перед этим можно сохранить копию).
 * -> { done: [названия], errors: [тексты] }
 */
export async function applyBackup(user, prod, data, picked) {
  const done = [], errors = []
  const S = data.sections || {}
  const title = k => SECTIONS.find(s => s[0] === k)?.[1] || k
  const patch = {}
  for (const sec of ['cnc', 'labels', 'reports', 'other']) {
    if (!picked.includes(sec) || !S[sec]) continue
    for (const k of KEYS[sec]) if (k in S[sec]) patch[k] = S[sec][k]
    // общие постпроцессоры из чужого аккаунта не переносим; выбранный станок — один из своих
    if (sec === 'cnc' && patch.cnc) {
      const cur = getUserSettings(user).cnc
      const curShared = (cur?.posts || []).filter(p => p.shared)
      patch.cnc = { ...patch.cnc, posts: [...(patch.cnc.posts || []).filter(p => !p.shared), ...curShared] }
    }
    if (sec === 'labels' && S.labels.__images) {
      for (const [id, img] of Object.entries(S.labels.__images)) { try { await saveLabelImage(user, id, img) } catch { /* картинку можно вставить заново */ } }
    }
    done.push(title(sec))
  }
  if (Object.keys(patch).length) {
    saveUserSettings(patch, user)
    if (patch.cnc && prod?.id) saveProductionCnc(prod.id, { ...normalizeCnc(patch.cnc, [], { beam: true }), posts: (patch.cnc.posts || []).filter(p => !p.shared) })
    if (picked.includes('reports')) syncProductionReports(user)        // копия для клиентов производства
  }
  if (prod?.id && picked.includes('machine') && S.machine) {
    const m = {}
    for (const c of PROD_COLS) if (c in S.machine) m[c] = S.machine[c]
    const { error } = await supabase.from('productions').update(m).eq('id', prod.id)
    if (error) {
      // колонок может не быть (старая база) — пробуем по одной, что получится
      let ok = 0
      for (const [c, v] of Object.entries(m)) { const r = await supabase.from('productions').update({ [c]: v }).eq('id', prod.id); if (!r.error) ok++ }
      if (ok) done.push(title('machine') + (ok < Object.keys(m).length ? ' (частично)' : '')); else errors.push(`${title('machine')}: ${error.message}`)
    } else done.push(title('machine'))
  } else if (picked.includes('machine') && S.machine && !prod?.id) errors.push('Параметры станка: у аккаунта нет своего производства')
  if (prod?.id && picked.includes('prices') && S.prices) {
    const r = await savePrices(prod.id, S.prices)
    if (r.error) errors.push(`${title('prices')}: ${r.error}`); else done.push(title('prices'))
  } else if (picked.includes('prices') && S.prices && !prod?.id) errors.push('Прайс-лист: у аккаунта нет своего производства')
  return { done, errors }
}
