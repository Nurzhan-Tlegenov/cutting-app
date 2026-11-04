import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { MenuButton } from '../components/NavDrawer'
import BottomNav from '../components/BottomNav'
import CncLoader from '../components/CncLoader'
import { UserName } from '../components/UserCard'
import { useIsSupport, useSupportStaff, setSupport, supportTeam } from '../lib/support'

const date = v => (v ? new Date(v).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '')

// «Поддержка» — раздел для мастер-аккаунта и сотрудников поддержки (claude/support-spec.md).
// Этап 2: команда поддержки (мастер выдаёт и снимает роль). Доска обращений — следующий этап.
export default function SupportPage() {
  const { user, isMaster } = useAuth()
  const navigate = useNavigate()
  const ok = useIsSupport(user?.id)
  const staff = useSupportStaff(!!isMaster)
  const [team, setTeam] = useState(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    if (!ok) return
    let alive = true
    supportTeam().then(r => { if (!alive) return; if (r.error) setErr(r.error); else setTeam(r.data || []) })
    return () => { alive = false }
  }, [ok, staff])

  const head = <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 12, paddingTop: 4 }}><MenuButton /><h1 style={{ fontSize: 18, fontWeight: 500 }}>Поддержка</h1></div>
  if (ok === undefined) return <div className="page"><CncLoader label="Открываем…" /></div>
  if (!ok) return (
    <div className="page" style={{ paddingBottom: 100 }}>{head}
      <div className="card"><p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 10 }}>Этот раздел — для сотрудников поддержки RaskroyPro. Вопрос или проблема? Напишите нам — ответ придёт в «Сообщения».</p>
        <button type="button" className="btn-primary" onClick={() => navigate('/messages?write=1')}>Написать в поддержку</button></div>
      <BottomNav />
    </div>
  )

  const rows = staff?.data || []
  const off = async id => {
    if (!window.confirm('Снять роль «Поддержка»? Раздел «Поддержка» у него пропадёт.')) return
    const r = await setSupport(id, false)
    if (r.error) setErr(r.error)
  }
  return (
    <div className="page" style={{ paddingBottom: 100 }}>
      {head}
      <div className="card" style={{ marginBottom: 12, border: '1px dashed var(--border)' }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Доска обращений</div>
        <p style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
          Скоро здесь: обращения пользователей карточками — «Новые → В работе → Нужны подробности → Нужен разработчик → Сделано / Не берём»,
          кнопка «Беру», ответ пользователю прямо из карточки.
          {isMaster ? ' Пока обращения — в «Сообщениях».' : ''}
        </p>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Команда поддержки</div>
        {!team ? <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>{err || 'Загружаем…'}</p> : team.map(t => (
          <div key={t.user_id} style={{ fontSize: 13, padding: '5px 0', borderTop: '0.5px solid var(--border)' }}>
            {t.master ? '👑 ' : '🎧 '}{t.full_name}{t.user_id === user?.id ? <span style={{ color: 'var(--text-hint)' }}> · это вы</span> : ''}
          </div>
        ))}
      </div>

      {isMaster && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 2 }}>Сотрудники поддержки</div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
            Добавить — галочкой «🎧 Сотрудник поддержки» в карточке пользователя («Пользователи и регистрация» или нажатие на имя в обращении).
            Сотрудник видит только этот раздел: обращения, переписку, файлы и краткую карточку автора без телефона.
          </p>
          {staff === undefined ? <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>Загружаем…</p>
            : staff.error ? <p className="error-text" style={{ fontSize: 12 }}>{staff.error}</p>
              : !rows.length ? <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>Пока никого.</p>
                : rows.map(s => (
                  <div key={s.user_id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '0.5px solid var(--border)', opacity: s.active ? 1 : 0.55 }}>
                    <div style={{ flex: 1, minWidth: 0, fontSize: 13 }}>
                      <UserName id={s.user_id} name={s.full_name || 'Пользователь'} />
                      <div style={{ fontSize: 11.5, color: 'var(--text-hint)' }}>{[s.country, s.city].filter(Boolean).join(', ')}{s.active ? ` · с ${date(s.added_at)}` : ' · роль снята'}</div>
                    </div>
                    {s.active
                      ? <button type="button" className="btn-secondary" style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => off(s.user_id)}>Снять</button>
                      : <button type="button" className="btn-secondary" style={{ padding: '5px 10px', fontSize: 12 }} onClick={async () => { const r = await setSupport(s.user_id, true); if (r.error) setErr(r.error) }}>Вернуть</button>}
                  </div>
                ))}
        </div>
      )}
      {err && team && <p className="error-text" style={{ fontSize: 12 }}>{err}</p>}
      <BottomNav />
    </div>
  )
}
