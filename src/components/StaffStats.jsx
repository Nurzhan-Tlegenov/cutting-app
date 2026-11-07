// «Итоги» производства у сотрудника — по праву «Итоги производства» (perms.stats); суммы — только с правом «Цены».
// Те же итоги, что у владельца (OrderStats → Results), только без кнопок «убрать из итогов».
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { Results, usePeriod } from './OrderStats'
import { productionStatsOf } from '../lib/productionApi'
import { getUserSettings, saveUserSettings } from '../lib/userSettings'
import CncLoader from './CncLoader'

export default function StaffStats({ prodId, canOpen = false, money = false }) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const per = usePeriod('wStats_')
  const [list, setList] = useState(null)
  const [err, setErr] = useState('')
  const [show, setShow] = useState(() => getUserSettings(user).resultsShow || null)
  useEffect(() => {
    let alive = true
    productionStatsOf(prodId).then(r => {
      if (!alive) return
      if (r.error) { setErr(/not allowed/.test(r.error) ? 'Нет права «Итоги производства» — его включает владелец производства.' : r.error); setList([]) } else setList(r.data || [])
    })
    return () => { alive = false }
  }, [prodId])
  if (list === null) return <CncLoader compact label="Считаем итоги…" />
  return (
    <div className="card" style={{ padding: '8px 12px' }}>
      {err ? <p style={{ fontSize: 12.5, color: 'var(--amber)' }}>{err}</p> : (
        <>
          <Results list={list} per={per} show={show} onShow={v => { setShow(v); saveUserSettings({ resultsShow: v }, user) }}
            onOpen={canOpen ? o => navigate(`/orders/${o.id}`) : undefined} />
          {!money && <p style={{ fontSize: 11.5, color: 'var(--text-hint)', marginTop: 6 }}>Суммы не показываются — нет права «Цены».</p>}
        </>
      )}
    </div>
  )
}
