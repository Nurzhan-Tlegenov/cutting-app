// «📦 Пакет для разработчика»: один zip по карточке обращения — мастер-аккаунт отправляет его разработчику (в сессию Claude).
//   obrashchenie.md — суть («Кратко»), карточка пользователя (без телефонов), вся переписка по порядку, заметки поддержки, история;
//   files/ — все файлы из переписки как пришли; orders/<номер>/ — заказ и детали (JSON), выпуски программ, модель заказа.
import { zipSync, strToU8 } from 'fflate'
import { payloadBlob } from './messages'
import { supportCard, supportFile, supportNotes, supportCardOrders, supportOrderData } from './support'

const dt = v => (v ? new Date(v).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '')
const safe = s => String(s || 'file').replace(/[\\/:*?"<>|\n\r\t]+/g, '_').slice(0, 120)
const ST = { new: 'Новые', work: 'В работе', details: 'Нужны подробности', dev: 'Нужен разработчик', done: 'Сделано', rejected: 'Не берём' }
const ACT = { created: 'обращение пришло', message: 'автор написал', take: 'взял', move: 'перенёс', assign: 'передал', reply: 'ответил', summary: '«Кратко»', note: 'заметка', dev_take: 'берём в разработку', dev_reject: 'не берём (разработка)', close: 'закрыл', reopen: 'вернул из архива', merge: 'объединил' }
const OST = { draft: 'черновик', new: 'новый', discussion: 'обсуждение', inwork: 'в работе', done: 'исполнен' }
const stamp = v => { const d = new Date(v), z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}-${z(d.getMinutes())}` }
const quote = t => String(t || '').split('\n').map(l => '> ' + l).join('\n')

/** Собрать пакет. onStep(текст) — что сейчас делается. -> { blob, name } | { error } */
export async function buildSupportPack(cardId, onStep = () => {}) {
  onStep('Карточка и переписка…')
  const r = await supportCard(cardId)
  if (r.error || !r.data) return { error: r.error || 'Карточка не найдена' }
  const { card: c, author: a = {}, messages = [], events = [] } = r.data
  const notes = (await supportNotes(cardId)).data || []
  const files = {}
  const used = new Set()
  const fname = (prefix, name) => {
    let n = `${prefix}_${safe(name)}`, k = 1
    while (used.has(n)) n = `${prefix}_${k++}_${safe(name)}`
    used.add(n); return n
  }

  // файлы из переписки
  const fileOf = {}
  const withFiles = messages.filter(m => m.file_name)
  for (const [i, m] of withFiles.entries()) {
    onStep(`Файлы ${i + 1} из ${withFiles.length}…`)
    const f = await supportFile(m.id)
    if (f.error || !f.data) { fileOf[m.id] = `(не удалось получить: ${f.error || 'нет файла'})`; continue }
    const name = fname(stamp(m.created_at), f.data.file_name || m.file_name)
    files['files/' + name] = new Uint8Array(await payloadBlob(f.data.payload || '').arrayBuffer())
    fileOf[m.id] = 'files/' + name
  }

  // заказы обращения
  onStep('Заказы…')
  const ord = await supportCardOrders(cardId)
  const orders = ord.data || []
  const orderLines = []
  for (const o of orders) {
    const d = await supportOrderData(cardId, o.id, true)
    const dir = `orders/${safe(o.order_number || o.id)}`
    if (d.error) { orderLines.push(`- ${o.order_number} — не удалось получить: ${d.error}`); continue }
    const { model, ...rest } = d.data || {}
    files[`${dir}/order.json`] = strToU8(JSON.stringify(rest, null, 2))
    let modelNote = ''
    if (model) {
      if (/^data:/.test(model)) { files[`${dir}/model.bin`] = new Uint8Array(await payloadBlob(model).arrayBuffer()); modelNote = ', модель: model.bin' }
      else { files[`${dir}/model.txt`] = strToU8(model); modelNote = ', модель: model.txt' }
    }
    orderLines.push(`- **${o.order_number}**${o.order_name ? ` «${o.order_name}»` : ''} — ${o.material_name || 'материал не указан'}, статус «${OST[o.status] || o.status}», деталей ${o.details}${o.own ? '' : ' (заказ клиента, пришёл на его производство)'} → \`${dir}/order.json\`${modelNote}`)
  }

  // obrashchenie.md
  onStep('Описание…')
  const who = [
    a.production ? `производство «${a.production.name}»${a.production.status && a.production.status !== 'approved' ? ' (ждёт подтверждения)' : ''}` : '',
    ...(a.works_at || []).map(w => `сотрудник производства «${w.name}»`),
    !a.production && !(a.works_at || []).length ? 'клиент' : '',
  ].filter(Boolean).join('; ')
  const posts = [...new Set([...(a.posts_granted || []), ...(a.posts_used || [])])]
  const md = [
    `# Обращение №${c.num} — ${c.author}`,
    '',
    `Статус: **${ST[c.status] || c.status}**${c.dev_ok ? ' (берём в разработку)' : ''} · создано ${dt(c.created_at)}${c.taken_name ? ` · занимается: ${c.taken_name}` : ''}`,
    '',
    '## Кратко',
    c.summary || '_не заполнено_',
    '',
    '## Пользователь',
    `- Имя: ${a.full_name || c.author}`,
    `- Страна, город: ${[a.country, a.city].filter(Boolean).join(', ') || '—'}`,
    `- Кто: ${who || '—'}`,
    `- В приложении с: ${a.since ? new Date(a.since).toLocaleDateString('ru-RU') : '—'}${a.orders != null ? ` · заказов: ${a.orders}` : ''}`,
    `- Постпроцессоры: ${posts.length ? posts.join(', ') : '—'}`,
    `- Станки (из запросов постпроцессоров): ${a.machines?.length ? a.machines.join('; ') : '—'}`,
    '',
    '## Заказы из обращения',
    orderLines.length ? orderLines.join('\n') : '_нет (ни приложенных, ни номеров вида 261104_001 в тексте)_',
    '',
    '## Переписка',
    ...messages.flatMap(m => [
      `### ${dt(m.created_at)} — ${m.staff ? (/^Поддержка/.test(m.staff_name || '') ? m.staff_name : `Поддержка (${m.staff_name})`) : c.author}${m.kind === 'debug' ? ' · файл для отладки' : ''}`,
      m.title ? `_${m.title}_` : '',
      m.body ? quote(m.body) : '',
      m.file_name ? `📎 ${m.file_name} → \`${fileOf[m.id] || '—'}\`` : '',
      '',
    ].filter((x, i, arr) => x !== '' || i === arr.length - 1)),
    '## Заметки поддержки (пользователь их не видел)',
    notes.length ? notes.map(n => `- ${dt(n.created_at)} · ${n.author_name}: ${String(n.body).replace(/\n/g, ' ')}`).join('\n') : '_нет_',
    '',
    '## История карточки',
    events.map(e => `- ${dt(e.at)} · ${e.actor_name} — ${ACT[e.action] || e.action}${e.to_status && e.from_status !== e.to_status ? ` → ${ST[e.to_status] || e.to_status}` : ''}${e.note ? `: ${String(e.note).replace(/\n/g, ' ').slice(0, 200)}` : ''}`).join('\n'),
    '',
    `_Пакет собран ${dt(new Date())}. Телефоны пользователя в пакет не входят._`,
  ].join('\n')
  files['obrashchenie.md'] = strToU8(md)

  onStep('Упаковываем…')
  const zip = zipSync(files, { level: 6 })
  return { blob: new Blob([zip], { type: 'application/zip' }), name: `obrashchenie_${c.num}_${safe(c.author).replace(/\s+/g, '_')}.zip` }
}
