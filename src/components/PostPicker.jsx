import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import SendToMaster from './SendToMaster'
import PostRequest from './PostRequest'
import { postCatalog } from '../lib/postAccess'
import { useNavigate } from 'react-router-dom'
import { fileToPayload, REPORT_MAX_MB } from '../lib/messages'
import { DEFAULT_POST, DEFAULT_DRILL6, DEFAULT_BEAMSAW, isBeamSaw, isRouterPost, newId, isDrill6, activePost, routerPost, pickPost, toggleUse6, applySnapshot, removeSnapshot, renameSnapshot, sameName } from '../lib/cncSettings'

// Выбор постпроцессора — строка сверху настроек ЧПУ: «Постпроцессор: <имя> ▾». Тап — окно снизу:
//   • станки текущей настройки — открыть, переименовать, удалить (лишний, добавленный случайно);
//   • мои сохранённые постпроцессоры — тап, и настройки применяются (без отдельной вкладки);
//   • добавить раскроечный или присадочный станок.

const EASE = 'cubic-bezier(.32,.72,0,1)'

export default function PostPicker({ cnc, onChange, isMaster = false }) {
  const [open, setOpen] = useState(false)
  const [shown, setShown] = useState(false)          // для анимации: окно выезжает и уезжает
  useEffect(() => {
    if (open) { const t = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(t) }
  }, [open])
  const close = () => { setShown(false); setTimeout(() => setOpen(false), 280) }
  // «Нет постпроцессора для моего станка» — УП с этого станка уходит разработчику (мастер-аккаунту) с описанием станка;
  // по ней добавляется постпроцессор. Файл на телефон не скачивается.
  const upFile = useRef(null)
  const [ask, setAsk] = useState(null)
  // каталог постпроцессоров (по запросу) и запрос
  const navigate = useNavigate()
  const [catalog, setCatalog] = useState(null)
  const [reqFor, setReqFor] = useState(undefined)     // undefined — окно закрыто; null — свой станок; item — из каталога
  const loadCatalog = () => postCatalog().then(r => setCatalog(r.missing ? false : (r.data || [])))
  useEffect(() => { if (open && !isMaster) loadCatalog() }, [open])   // eslint-disable-line react-hooks/exhaustive-deps
  const pickUp = e => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    if (f.size > REPORT_MAX_MB * 1048576) { window.alert(`Файл слишком большой (${(f.size / 1048576).toFixed(1)} МБ, можно до ${REPORT_MAX_MB} МБ). Хватит программы одного листа — или отправьте её разработчику в WhatsApp / Telegram.`); return }
    close()
    setAsk({
      title: `Запрос постпроцессора · УП: ${f.name}`,
      fileName: f.name,
      getPayload: () => fileToPayload(f),
      label: 'Какой у вас станок? Производитель, модель, система ЧПУ',
      need: 'Напишите, какой у вас станок — хотя бы производитель и модель.',
      placeholder: 'Например: Woodtec H 2040, стойка Syntec, есть присадочная голова, датчик длины инструмента',
    })
  }
  const post = activePost(cnc), router = routerPost(cnc)
  const used = id => id === router?.id || (cnc.use6 || []).includes(id)

  // общий (виден всем пользователям): мастер-аккаунт отметил «Для всех»
  const isPub = p => !!(p.forAll || p.shared)
  const pubTag = p => isMaster && isPub(p) ? <span style={{ fontSize: 10.5, padding: '1px 7px', borderRadius: 9, background: 'var(--teal-light)', color: 'var(--teal)', whiteSpace: 'nowrap', fontWeight: 600 }}>🔑 в каталоге</span> : null
  const togglePub = p => {
    const on = !p.forAll
    if (!window.confirm(on ? `Опубликовать «${p.name}» в каталоге?\nВсе увидят только его название и смогут запросить. Пользоваться им будут те, кому вы его выдадите (Мастер-аккаунт → «Постпроцессоры: выдача и запросы»).` : `Убрать «${p.name}» из каталога?\nУ всех, кому он выдан, он пропадёт.`)) return
    onChange({ ...cnc, posts: cnc.posts.map(q => (q.id === p.id ? { ...q, forAll: on, shared: false } : q)) })
  }
  const openPost = id => { onChange(pickPost(cnc, id)); close() }
  const add = kind => {
    const p = kind === 'drill6' ? { ...DEFAULT_DRILL6(), name: `Шестисторонний ${cnc.posts.filter(isDrill6).length + 1}` }
      : kind === 'beamsaw' ? { ...DEFAULT_BEAMSAW(), id: newId(), name: `Пильный центр ${cnc.posts.filter(isBeamSaw).length + 1}` }
        // новый станок — с пустыми командами: чужие команды (начало, смена инструмента, конец) не подставляются,
        // чтобы их случайно не отправили на свой станок. Взять за основу готовый — выбрать существующий постпроцессор
        : { ...DEFAULT_POST(), name: `Постпроцессор ${cnc.posts.filter(isRouterPost).length + 1}`, cmdStart: '', cmdToolStart: '', cmdToolEnd: '', cmdEnd: '', cmdHeadStart: '', cmdHeadEnd: '' }
    onChange({ ...(kind === 'drill6' ? toggleUse6(cnc, p.id, true) : cnc), posts: [...cnc.posts, p], post: p.id })
    close()
  }
  const del = p => {
    if (p.shared) { window.alert('Этот постпроцессор удалить нельзя.'); return }
    if (isRouterPost(p) && !cnc.posts.some(q => q.id !== p.id && isRouterPost(q))) { window.alert('Это единственный раскроечный станок — его удалить нельзя.'); return }
    if (isBeamSaw(p) && !cnc.posts.some(q => q.id !== p.id && isBeamSaw(q))) { window.alert('Это единственный пильный центр — его удалить нельзя (можно переименовать и настроить).'); return }
    if (!window.confirm(`Удалить постпроцессор «${p.name}»?\nЕго настройки пропадут (сохранённые в «Мои постпроцессоры» останутся).`)) return
    const posts = cnc.posts.filter(q => q.id !== p.id)
    // свои инструменты постпроцессора (срисованные с программы) уходят вместе с ним — другим станкам они не видны
    onChange({ ...toggleUse6(cnc, p.id, false), posts, tools: (cnc.tools || []).filter(t => t.postId !== p.id), post: cnc.post === p.id ? posts[0].id : cnc.post, router: cnc.router === p.id ? '' : cnc.router })
  }
  const rename = p => {
    const n = window.prompt('Название постпроцессора', p.name)
    if (n && n.trim() && n.trim() !== p.name) onChange({ ...cnc, posts: cnc.posts.map(q => (q.id === p.id ? { ...q, name: n.trim() } : q)) })
  }
  // сохранённый: к открытому станку того же типа — заменить его настройки; другого типа — добавить новым
  const applySaved = s => {
    const same = (post.kind || 'router') === (s.kind || 'router') && !post.shared
    if (same) {
      if (!window.confirm(`Применить «${s.name}» к «${post.name}»?\nТекущие настройки «${post.name}» заменятся.`)) return
      onChange(applySnapshot(cnc, s.id, false))
    } else onChange(applySnapshot(cnc, s.id, true))
    close()
  }
  // сохранённый вариант с именем станка — это «точка сохранения» самого станка: показывается у станка кнопкой ↺,
  // отдельной строкой — только варианты, для которых станка с таким именем нет
  const kindOf = p => p.kind || 'router'
  const snapOf = p => (cnc.saved || []).find(x => sameName(x.name, p.name) && x.kind === kindOf(p))
  const restore = (p, sn) => {
    if (!window.confirm(`Вернуть «${p.name}» к сохранённым настройкам от ${new Date(sn.at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}?\nТекущие настройки этого станка заменятся.`)) return
    onChange(applySnapshot(pickPost(cnc, p.id), sn.id, false)); close()
  }
  const saved = [...(cnc.saved || [])].filter(x => !cnc.posts.some(p => sameName(p.name, x.name) && kindOf(p) === x.kind)).sort((a, b) => (b.at || 0) - (a.at || 0))

  const kindTag = p => {
    const k = p.kind || 'router'
    const [bg, fg, txt] = k === 'drill6' ? ['var(--amber-light)', 'var(--amber)', 'присадка 6-стор.'] : k === 'beamsaw' ? ['var(--teal-light)', 'var(--teal)', 'пильный центр'] : ['var(--blue-light)', 'var(--blue-dark)', 'раскрой']
    return <span style={{ fontSize: 10.5, padding: '1px 7px', borderRadius: 9, background: bg, color: fg, whiteSpace: 'nowrap' }}>{txt}</span>
  }
  const icon = { width: 34, height: 34, borderRadius: 17, border: 'none', background: 'var(--bg2)', color: 'var(--text-muted)', fontSize: 15, cursor: 'pointer', flex: '0 0 auto' }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="card"
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', marginBottom: 10, textAlign: 'left', cursor: 'pointer', border: '1px solid var(--blue)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>Постпроцессор (открыт в настройках)</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{post.name}</div>
        </div>
        {pubTag(post)}
        {kindTag(post)}
        <span style={{ color: 'var(--blue)', fontSize: 13, fontWeight: 500 }}>Выбрать ▾</span>
      </button>

      {open && createPortal(
        <div style={{ position: 'fixed', inset: 0, zIndex: 1150 }}>
          <div onClick={close} style={{ position: 'absolute', inset: 0, background: '#000', opacity: shown ? 0.38 : 0, transition: `opacity .3s ${EASE}` }} />
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, maxWidth: 560, margin: '0 auto', maxHeight: '86dvh', display: 'flex', flexDirection: 'column',
            background: 'var(--bg)', borderRadius: '18px 18px 0 0', boxShadow: '0 -8px 30px rgba(0,0,0,.18)', transform: shown ? 'translateY(0)' : 'translateY(100%)', transition: `transform .36s ${EASE}`,
            paddingBottom: 'env(safe-area-inset-bottom)' }}>
            <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0 2px' }}><span style={{ width: 38, height: 4, borderRadius: 2, background: 'var(--border-md)' }} /></div>
            <div style={{ display: 'flex', alignItems: 'center', padding: '4px 16px 8px' }}>
              <div style={{ flex: 1, fontSize: 16, fontWeight: 600 }}>Постпроцессоры</div>
              <button type="button" onClick={close} style={icon}>×</button>
            </div>
            <div style={{ overflowY: 'auto', padding: '0 12px 14px', overscrollBehavior: 'contain' }}>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.04em', margin: '4px 4px 6px' }}>Станки в настройке</div>
              {isMaster && (
                <div style={{ fontSize: 11, color: 'var(--text-hint)', margin: '-2px 4px 6px' }}>
                  🔑 — в каталоге: все видят название и могут запросить, пользуются те, кому вы выдали{cnc.posts.some(isPub) ? ` (в каталоге ${cnc.posts.filter(isPub).length})` : ''}. Кнопка 🔑 у станка — добавить в каталог или убрать.
                  <button type="button" onClick={() => { close(); navigate('/post-access') }} style={{ display: 'block', marginTop: 4, padding: '7px 10px', borderRadius: 10, border: '1px solid var(--teal)', background: 'transparent', color: 'var(--teal)', fontSize: 12.5, cursor: 'pointer' }}>🔑 Выдача, запросы и кто чем пользуется ›</button>
                </div>
              )}
              {cnc.posts.map(p => {
                const on = p.id === post.id
                return (
                  <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 8px', marginBottom: 4, borderRadius: 12, background: on ? 'var(--blue-light)' : 'var(--bg2)', border: on ? '1px solid var(--blue)' : '1px solid transparent' }}>
                    <div onClick={() => openPost(p.id)} style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}>
                      <div style={{ fontSize: 14, fontWeight: on ? 600 : 500, color: on ? 'var(--blue-dark)' : 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 2, flexWrap: 'wrap' }}>
                        {kindTag(p)}
                        {used(p.id) && <span style={{ fontSize: 10.5, color: 'var(--teal)' }}>✓ выпускает программы</span>}
                        {pubTag(p)}
                        {on && <span style={{ fontSize: 10.5, color: 'var(--blue)' }}>открыт</span>}
                      </div>
                    </div>
                    {isMaster && !p.shared && <button type="button" title={p.forAll ? 'В каталоге — убрать' : 'Добавить в каталог (выдача по запросу)'} onClick={() => togglePub(p)}
                      style={{ ...icon, background: p.forAll || p.shared ? 'var(--teal)' : 'var(--bg)', color: p.forAll || p.shared ? 'white' : 'var(--text-hint)', border: '0.5px solid var(--border-md)' }}>🔑</button>}
                    {!p.shared && snapOf(p) && <button type="button" title={`Вернуть сохранённые настройки (${new Date(snapOf(p).at).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })})`} onClick={() => restore(p, snapOf(p))} style={{ ...icon, color: 'var(--blue)' }}>↺</button>}
                    {!p.shared && <button type="button" title="Переименовать" onClick={() => rename(p)} style={icon}>✎</button>}
                    {!p.shared && <button type="button" title="Удалить" onClick={() => del(p)} style={{ ...icon, color: 'var(--danger)' }}>🗑</button>}
                  </div>
                )
              })}
              <div style={{ display: 'flex', gap: 6, margin: '6px 0 14px' }}>
                <button type="button" onClick={() => add('router')} style={{ flex: 1, padding: '9px 8px', borderRadius: 12, border: '1px dashed var(--blue)', background: 'transparent', color: 'var(--blue)', fontSize: 13 }}>+ Раскроечный станок</button>
                <button type="button" onClick={() => add('drill6')} style={{ flex: 1, padding: '9px 8px', borderRadius: 12, border: '1px dashed var(--amber)', background: 'transparent', color: 'var(--amber)', fontSize: 13 }}>+ Присадочный 6-стор.</button>
                {cnc.posts.some(isBeamSaw) && <button type="button" onClick={() => add('beamsaw')} style={{ flex: 1, padding: '9px 8px', borderRadius: 12, border: '1px dashed var(--teal)', background: 'transparent', color: 'var(--teal)', fontSize: 13 }}>+ Пильный центр</button>}
              </div>

              {!isMaster && (
                <div style={{ padding: '10px 12px', borderRadius: 12, border: '1px dashed var(--teal)', background: 'var(--bg2)', margin: '0 0 14px' }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>Готовые постпроцессоры — по запросу</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '2px 0 8px' }}>
                    Постпроцессор настраивается под ваш станок и выдаётся вашему производству. Выберите свой станок из списка или опишите его — с примером рабочей программы.
                  </div>
                  {catalog === null && <div style={{ fontSize: 12, color: 'var(--text-hint)' }}>Загружаем каталог…</div>}
                  {catalog && catalog.filter(c => !c.mine).map(c => (
                    <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', borderTop: '0.5px solid var(--border)' }}>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                      {kindTag(c)}
                      {c.asked
                        ? <span style={{ fontSize: 11.5, color: 'var(--teal)', whiteSpace: 'nowrap' }}>запрос отправлен</span>
                        : <button type="button" onClick={() => setReqFor(c)} style={{ padding: '5px 10px', borderRadius: 14, border: '1px solid var(--teal)', background: 'transparent', color: 'var(--teal)', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' }}>Запросить</button>}
                    </div>
                  ))}
                  {catalog === false ? (
                    <>
                      <input ref={upFile} type="file" style={{ display: 'none' }} onChange={pickUp} />
                      <button type="button" onClick={() => upFile.current?.click()} style={{ width: '100%', padding: '9px 8px', borderRadius: 12, border: 'none', background: 'var(--teal)', color: 'white', fontSize: 13, cursor: 'pointer' }}>📂 Выбрать УП и попросить добавить</button>
                    </>
                  ) : (
                    <button type="button" onClick={() => setReqFor(null)} style={{ width: '100%', marginTop: 8, padding: '9px 8px', borderRadius: 12, border: 'none', background: 'var(--teal)', color: 'white', fontSize: 13, cursor: 'pointer' }}>🔑 Запросить постпроцессор под свой станок</button>
                  )}
                </div>
              )}

              <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.04em', margin: '4px 4px 2px' }}>Сохранённые варианты</div>
              <div style={{ fontSize: 11, color: 'var(--text-hint)', margin: '0 4px 6px' }}>
                {saved.length ? `Варианты под другими именами. Тап — применить к открытому «${post.name}» (если тот же тип станка), «+» — отдельным станком.` : 'Сохранённые настройки станка — у самого станка, кнопка ↺. Под другим именем вариант появится здесь.'}
              </div>
              {saved.map(s => (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 8px', marginBottom: 4, borderRadius: 12, background: 'var(--bg2)' }}>
                  <div onClick={() => applySaved(s)} style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}>
                    <div style={{ fontSize: 14, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 2, flexWrap: 'wrap' }}>
                      {kindTag(s)}
                      {s.kind === 'router' && s.post?.fieldX ? <span style={{ fontSize: 10.5, color: 'var(--text-hint)' }}>поле {s.post.fieldX}×{s.post.fieldY}</span> : null}
                      {s.at ? <span style={{ fontSize: 10.5, color: 'var(--text-hint)' }}>{new Date(s.at).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' })}</span> : null}
                    </div>
                  </div>
                  <button type="button" title="Добавить отдельным станком" onClick={() => { onChange(applySnapshot(cnc, s.id, true)); close() }} style={{ ...icon, color: 'var(--blue)' }}>+</button>
                  <button type="button" title="Переименовать" onClick={() => { const n = window.prompt('Название', s.name); if (n && n.trim()) onChange(renameSnapshot(cnc, s.id, n.trim())) }} style={icon}>✎</button>
                  <button type="button" title="Удалить" onClick={() => { if (window.confirm(`Удалить сохранённый вариант «${s.name}»?`)) onChange(removeSnapshot(cnc, s.id)) }} style={{ ...icon, color: 'var(--danger)' }}>🗑</button>
                </div>
              ))}
            </div>
          </div>
        </div>,
        document.body,
      )}
      <SendToMaster job={ask} onClose={() => setAsk(null)} />
      {reqFor !== undefined && <PostRequest catalogItem={reqFor} onClose={() => setReqFor(undefined)} onSent={loadCatalog} />}
    </>
  )
}
