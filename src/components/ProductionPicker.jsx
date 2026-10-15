import { useMemo, useState } from 'react'
import ProductionForm from './ProductionForm'
import RefShare from './RefShare'
import { countryCode, productionLabel } from '../lib/productionLabel'
import { serviceBadges, missingServices } from '../lib/productionServices'

// «Где будете резать?» — выбор производства ДО раскроя. Рез и отступы листа сразу берутся у производства,
// поэтому раскрой не приходится переделывать при отправке заказа.
//   • производства своей страны и города — сверху; страну и город можно сменить;
//   • «Я сам производство» — регистрация своего (пока ждёт подтверждения, им можно раскраивать для себя);
//   • «Моего производства нет» — приглашение цеху в WhatsApp / Telegram; до его регистрации можно раскроить
//     со своими параметрами (с пометкой, что производство может пересчитать).
const APP_URL = 'https://raskroypro.com'

export default function ProductionPicker({ productions, mine, lastId, profile, kerfOf, sheet, needs = {}, onPick, onSkip, onClose, onRegistered }) {
  const approved = useMemo(() => productions.filter(pr => (pr.status ?? 'approved') === 'approved' && pr.id !== mine?.id), [productions, mine])
  const myLand = countryCode(profile?.country)
  // все страны, где есть производства, — и своя первой, даже если в ней пока ни одного (тогда сразу видно «пригласите»)
  const lands = useMemo(() => [...new Set([...(myLand ? [myLand] : []), ...approved.map(pr => countryCode(pr.country) || '—')])]
    .sort((a, b) => (b === myLand) - (a === myLand) || a.localeCompare(b)), [approved, myLand])
  const [land, setLand] = useState(() => lands[0] || '')
  const inLand = approved.filter(pr => (countryCode(pr.country) || '—') === land)
  const towns = [...new Set(inLand.map(pr => String(pr.city || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'))
  const myTown = String(profile?.city || '').trim()
  const [town, setTown] = useState(() => {
    const t = approved.filter(pr => (countryCode(pr.country) || '—') === lands[0]).map(pr => String(pr.city || '').trim())
    return t.some(x => x.toLowerCase() === myTown.toLowerCase()) ? t.find(x => x.toLowerCase() === myTown.toLowerCase()) : ''
  })
  const sameTown = pr => !!myTown && String(pr.city || '').trim().toLowerCase() === myTown.toLowerCase()
  const shown = inLand.filter(pr => !town || String(pr.city || '').trim() === town)
    .sort((a, b) => (b.id === lastId) - (a.id === lastId) || sameTown(b) - sameTown(a)
      || String(a.city || '').localeCompare(String(b.city || ''), 'ru') || String(a.name || '').localeCompare(String(b.name || ''), 'ru'))
  const nearby = approved.some(sameTown)   // есть ли производство в городе клиента
  const [view, setView] = useState('list')   // list | register | invite
  const mineReady = mine && (mine.status ?? 'approved') === 'approved'

  const card = (pr, note) => (
    <button key={pr.id} type="button" onClick={() => onPick(pr)}
      style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '10px 12px', marginBottom: 6, cursor: 'pointer',
        border: pr.id === lastId ? '1.5px solid var(--blue)' : '0.5px solid var(--border-md)', borderRadius: 'var(--radius)', background: 'var(--bg)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{note ? pr.name : productionLabel(pr)}</div>
        <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 1 }}>
          {note && <span style={{ color: 'var(--teal)' }}>{note} · </span>}
          {kerfOf(pr) != null && `рез ${kerfOf(pr)} мм`}{pr.id === lastId && !note ? ' · выбирали в прошлый раз' : ''}
          {!note && myTown && !sameTown(pr) && <span style={{ color: 'var(--amber)' }}> · не в вашем городе</span>}
        </div>
        {(() => {   // услуги производства значками; чего нет из нужного заказу — предупреждение
          const b = serviceBadges(pr.services), miss = missingServices(pr.services, needs)
          return <>
            {b.length > 0 && <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
              {b.map(x => <span key={x} style={{ fontSize: 10.5, padding: '1px 7px', borderRadius: 9, background: 'var(--blue-light, var(--bg2))', color: 'var(--blue)' }}>{x}</span>)}
            </div>}
            {miss.length > 0 && <div style={{ fontSize: 11, color: 'var(--amber)', marginTop: 3 }}>⚠ В заказе есть {miss.join(', ')} — это производство такого не делает</div>}
          </>
        })()}
      </div>
      <span style={{ color: 'var(--blue)', fontSize: 18 }}>›</span>
    </button>
  )
  const link = { width: '100%', marginTop: 8, padding: 10, border: '0.5px solid var(--blue-mid, var(--border-md))', borderRadius: 'var(--radius)', background: 'transparent', color: 'var(--blue)', fontSize: 14, cursor: 'pointer' }
  const chip = on => ({ padding: '4px 10px', borderRadius: 14, fontSize: 12, cursor: 'pointer', border: on ? 'none' : '0.5px solid var(--border-md)', background: on ? 'var(--blue)' : 'transparent', color: on ? 'white' : 'var(--text-muted)' })
  // личная ссылка-приглашение: производство регистрируется по ней без ожидания подтверждения (до миграции — общий адрес)
  const shareRow = <RefShare kind="production" name={String(profile?.full_name || '').trim()} compact fallback={APP_URL} />
  // приглашение цеха — на виду: сверху, если в городе клиента производств нет, иначе под списком
  const inviteCard = (
    <div style={{ background: 'var(--bg)', border: '1px dashed var(--blue)', borderRadius: 'var(--radius)', padding: '10px 12px', margin: '4px 0 10px' }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 2 }}>{nearby ? 'Режете в другом месте?' : 'Пригласите своё производство'}</div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>Отправьте цеху, где вы режете, свою ссылку. По ней он зарегистрируется без ожидания подтверждения и сразу появится в этом списке.</div>
      {shareRow}
    </div>
  )

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 955, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 520, maxHeight: '88vh', overflowY: 'auto', background: 'var(--bg2)', borderRadius: '16px 16px 0 0', padding: '16px 16px calc(16px + env(safe-area-inset-bottom))' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          {view !== 'list' && <button type="button" onClick={() => setView('list')} style={{ background: 'none', border: 'none', fontSize: 20, color: 'var(--blue)', padding: '0 8px 0 0' }}>‹</button>}
          <div style={{ flex: 1, fontSize: 17, fontWeight: 600 }}>{view === 'register' ? 'Моё производство' : view === 'invite' ? 'Пригласить производство' : 'Где будете резать?'}</div>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, color: 'var(--text-hint)' }}>✕</button>
        </div>

        {view === 'list' && <>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>Рез и отступы листа возьмём у производства — раскрой сразу будет правильным, переделывать при отправке не придётся. Отправлять заказ сейчас не обязательно.</p>
          {mine && card(mine, mineReady ? 'моё производство' : 'моё · ждёт подтверждения')}
          {!mine && myTown && !nearby && (
            <div style={{ fontSize: 12, background: 'var(--amber-light, var(--bg))', border: '0.5px solid var(--amber)', borderRadius: 'var(--radius)', padding: '8px 10px', marginBottom: 10 }}>
              В вашем городе ({myTown}) производств пока нет. Можно выбрать любое другое — чтобы попробовать раскрой, — или, если вы сами режете, зарегистрировать своё производство.
              <button type="button" className="btn-primary" style={{ width: '100%', marginTop: 8 }} onClick={() => setView('register')}>Зарегистрировать своё производство</button>
            </div>
          )}
          {!nearby && !mineReady && inviteCard}
          {lands.length > 1 && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '4px 0 8px' }}>
            {lands.map(l => <button key={l} type="button" style={chip(l === land)} onClick={() => { setLand(l); setTown('') }}>{l}</button>)}
          </div>}
          {towns.length > 1 && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            <button type="button" style={chip(!town)} onClick={() => setTown('')}>Все города</button>
            {towns.map(t => <button key={t} type="button" style={chip(t === town)} onClick={() => setTown(t)}>{t}</button>)}
          </div>}
          {shown.map(pr => card(pr))}
          {!approved.length && <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '6px 0' }}>Подтверждённых производств пока нет.</p>}
          {approved.length > 0 && !shown.length && <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '6px 0' }}>{inLand.length ? 'В этом городе производств пока нет — посмотрите «Все города».' : 'В этой стране производств пока нет — выберите другую страну, чтобы попробовать раскрой, или пригласите свой цех.'}</p>}
          {shown.length > 0 && land !== myLand && <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: '2px 0 6px' }}>Производство в другой стране подойдёт, чтобы попробовать раскрой: карты посмотреть можно, отправлять заказ не обязательно.</p>}
          {(nearby || mineReady) && inviteCard}
          {!mine && (nearby || !myTown) && <button type="button" style={link} onClick={() => setView('register')}>Я сам производство — зарегистрировать</button>}
          <button type="button" style={{ ...link, color: 'var(--text-muted)', borderColor: 'var(--border-md)' }} onClick={onSkip}>Пока раскроить со своими параметрами</button>
        </>}

        {view === 'register' && <>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>Заказы клиентов будут приходить вам в раздел «Производство». Пока производство ждёт подтверждения администратора, вы уже можете раскраивать свои заказы с его резом и отступами.</p>
          <ProductionForm submitLabel="Зарегистрировать" sheet={sheet}
            initial={{ country: profile?.country || '', city: profile?.city || '', phone: profile?.phone || '' }}
            onCancel={() => setView('list')} onDone={pid => onRegistered(pid)} />
        </>}

        {view === 'invite' && <>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>Отправьте приглашение цеху, где вы режете. По вашей ссылке он зарегистрируется без ожидания подтверждения и сразу появится в этом списке.</p>
          <RefShare kind="production" name={String(profile?.full_name || '').trim()} fallback={APP_URL} />
          <button type="button" style={{ ...link, color: 'var(--text-muted)', borderColor: 'var(--border-md)', marginTop: 14 }} onClick={onSkip}>Пока раскроить со своими параметрами</button>
          <p style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 4 }}>Рез и отступы — как в заказе сейчас. Когда выберете производство, раскрой, возможно, придётся пересчитать под его рез.</p>
        </>}
      </div>
    </div>
  )
}
