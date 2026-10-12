import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { DEFAULT_POST, DEFAULT_DRILL6, isDrill6, activePost, routerPost, pickPost, toggleUse6, applySnapshot, removeSnapshot, renameSnapshot } from '../lib/cncSettings'

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
  const post = activePost(cnc), router = routerPost(cnc)
  const used = id => id === router?.id || (cnc.use6 || []).includes(id)

  // общий (виден всем пользователям): мастер-аккаунт отметил «Для всех»
  const isPub = p => !!(p.forAll || p.shared)
  const pubTag = p => isPub(p) ? <span style={{ fontSize: 10.5, padding: '1px 7px', borderRadius: 9, background: 'var(--teal-light)', color: 'var(--teal)', whiteSpace: 'nowrap', fontWeight: 600 }}>🌐 {isMaster ? 'для всех' : 'общий'}</span> : null
  const togglePub = p => {
    const on = !p.forAll
    if (!window.confirm(on ? `Сделать «${p.name}» общим?\nЕго увидят все пользователи приложения.` : `Убрать «${p.name}» из общих?\nДругие пользователи его больше не увидят.`)) return
    onChange({ ...cnc, posts: cnc.posts.map(q => (q.id === p.id ? { ...q, forAll: on, shared: false } : q)) })
  }
  const openPost = id => { onChange(pickPost(cnc, id)); close() }
  const add = kind => {
    const p = kind === 'drill6' ? { ...DEFAULT_DRILL6(), name: `Шестисторонний ${cnc.posts.filter(isDrill6).length + 1}` } : { ...DEFAULT_POST(), name: `Постпроцессор ${cnc.posts.filter(q => !isDrill6(q)).length + 1}` }
    onChange({ ...(kind === 'drill6' ? toggleUse6(cnc, p.id, true) : cnc), posts: [...cnc.posts, p], post: p.id })
    close()
  }
  const del = p => {
    if (p.shared) { window.alert('Это общий постпроцессор (от мастер-аккаунта) — его не удалить.'); return }
    if (!isDrill6(p) && !cnc.posts.some(q => q.id !== p.id && !isDrill6(q))) { window.alert('Это единственный раскроечный станок — его удалить нельзя.'); return }
    if (!window.confirm(`Удалить постпроцессор «${p.name}»?\nЕго настройки пропадут (сохранённые в «Мои постпроцессоры» останутся).`)) return
    const posts = cnc.posts.filter(q => q.id !== p.id)
    onChange({ ...toggleUse6(cnc, p.id, false), posts, post: cnc.post === p.id ? posts[0].id : cnc.post, router: cnc.router === p.id ? '' : cnc.router })
  }
  const rename = p => {
    const n = window.prompt('Название постпроцессора', p.name)
    if (n && n.trim() && n.trim() !== p.name) onChange({ ...cnc, posts: cnc.posts.map(q => (q.id === p.id ? { ...q, name: n.trim() } : q)) })
  }
  // сохранённый: к открытому станку того же типа — заменить его настройки; другого типа — добавить новым
  const applySaved = s => {
    const same = (isDrill6(post) ? 'drill6' : 'router') === s.kind && !post.shared
    if (same) {
      if (!window.confirm(`Применить «${s.name}» к «${post.name}»?\nТекущие настройки «${post.name}» заменятся.`)) return
      onChange(applySnapshot(cnc, s.id, false))
    } else onChange(applySnapshot(cnc, s.id, true))
    close()
  }
  const saved = [...(cnc.saved || [])].sort((a, b) => (b.at || 0) - (a.at || 0))

  const kindTag = p => <span style={{ fontSize: 10.5, padding: '1px 7px', borderRadius: 9, background: isDrill6(p) || p.kind === 'drill6' ? 'var(--amber-light)' : 'var(--blue-light)', color: isDrill6(p) || p.kind === 'drill6' ? 'var(--amber)' : 'var(--blue-dark)', whiteSpace: 'nowrap' }}>{isDrill6(p) || p.kind === 'drill6' ? 'присадка 6-стор.' : 'раскрой'}</span>
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
              {isMaster && <div style={{ fontSize: 11, color: 'var(--text-hint)', margin: '-2px 4px 6px' }}>🌐 — общий: виден всем пользователям{cnc.posts.some(isPub) ? ` (сейчас ${cnc.posts.filter(isPub).length})` : ''}. Кнопка 🌐 у станка — сделать общим или убрать.</div>}
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
                    {isMaster && !p.shared && <button type="button" title={p.forAll ? 'Общий для всех — убрать из общих' : 'Сделать общим для всех'} onClick={() => togglePub(p)}
                      style={{ ...icon, background: p.forAll || p.shared ? 'var(--teal)' : 'var(--bg)', color: p.forAll || p.shared ? 'white' : 'var(--text-hint)', border: '0.5px solid var(--border-md)' }}>🌐</button>}
                    {!p.shared && <button type="button" title="Переименовать" onClick={() => rename(p)} style={icon}>✎</button>}
                    {!p.shared && <button type="button" title="Удалить" onClick={() => del(p)} style={{ ...icon, color: 'var(--danger)' }}>🗑</button>}
                  </div>
                )
              })}
              <div style={{ display: 'flex', gap: 6, margin: '6px 0 14px' }}>
                <button type="button" onClick={() => add('router')} style={{ flex: 1, padding: '9px 8px', borderRadius: 12, border: '1px dashed var(--blue)', background: 'transparent', color: 'var(--blue)', fontSize: 13 }}>+ Раскроечный станок</button>
                <button type="button" onClick={() => add('drill6')} style={{ flex: 1, padding: '9px 8px', borderRadius: 12, border: '1px dashed var(--amber)', background: 'transparent', color: 'var(--amber)', fontSize: 13 }}>+ Присадочный 6-стор.</button>
              </div>

              <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.04em', margin: '4px 4px 2px' }}>Мои сохранённые</div>
              <div style={{ fontSize: 11, color: 'var(--text-hint)', margin: '0 4px 6px' }}>
                {saved.length ? `Тап — применить: к открытому «${post.name}», если тот же тип станка; другой тип — добавится отдельным станком.` : 'Пока пусто. Настройте станок и нажмите «💾 Сохранить настройки» — вариант появится здесь.'}
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
    </>
  )
}
