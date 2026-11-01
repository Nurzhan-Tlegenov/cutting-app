// Ссылка-установка …/install — открывается без входа. Её отправляют клиенту: он нажимает — и
//   Android / компьютер: одна кнопка «Установить» (окно установки браузера);
//   iPhone: ставить приложение по ссылке Apple не разрешает никому — только «Поделиться» → «На экран „Домой“»,
//   поэтому крупно 3 шага и стрелка к кнопке «Поделиться» внизу экрана.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import InstallGuide from '../components/InstallGuide'
import { canPromptInstall, onInstallChange, promptInstall, isInstalled, platform } from '../lib/install'

const big = { width: '100%', padding: '14px 16px', borderRadius: 14, border: 'none', fontSize: 17, fontWeight: 600, cursor: 'pointer' }
const ShareIco = ({ size = 22 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="var(--blue)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: '-4px' }}>
    <path d="M12 15V3M8 7l4-4 4 4" /><path d="M7 10H5v11h14V10h-2" />
  </svg>
)

export default function InstallPage() {
  const navigate = useNavigate()
  const pf = platform()
  const [, setTick] = useState(0)
  const [done, setDone] = useState(false)
  const [waited, setWaited] = useState(false)          // окно установки браузер так и не прислал — показываем шаги
  useEffect(() => onInstallChange(() => setTick(t => t + 1)), [])
  useEffect(() => { const t = setTimeout(() => setWaited(true), 2500); return () => clearTimeout(t) }, [])
  const installed = isInstalled()
  const iosSafari = pf.os === 'ios' && pf.browser !== 'inapp'
  const install = async () => { const r = await promptInstall(); if (r === 'accepted') setDone(true); else setTick(t => t + 1) }
  return (
    <div className="page page-read" style={{ paddingBottom: iosSafari ? 140 : 40, maxWidth: 520, margin: '0 auto' }}>
      <div style={{ textAlign: 'center', padding: '22px 0 14px' }}>
        <img src="/icon-192.png" alt="" width="84" height="84" style={{ borderRadius: 20, boxShadow: '0 4px 16px rgba(0,0,0,.15)' }} />
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: '12px 0 4px' }}>Установить RaskroyPro</h1>
        <div style={{ fontSize: 14, color: 'var(--text-muted)' }}>Значок на рабочем столе — открывается сразу, на весь экран</div>
      </div>

      {installed || done ? (
        <div className="card" style={{ textAlign: 'center', padding: 16 }}>
          <div style={{ fontSize: 34 }}>✅</div>
          <div style={{ fontSize: 16, fontWeight: 600, margin: '6px 0 10px' }}>{done ? 'Готово — значок RaskroyPro на рабочем столе' : 'Приложение уже установлено'}</div>
          <button type="button" className="btn-primary" style={big} onClick={() => navigate('/')}>Открыть приложение</button>
        </div>
      ) : pf.browser === 'inapp' ? (
        <div className="card" style={{ padding: 16, fontSize: 15, lineHeight: 1.5 }}>
          <b>Откройте эту ссылку в браузере</b> — из мессенджера установить нельзя.
          <div style={{ marginTop: 6 }}>Нажмите {pf.os === 'ios' ? <>«•••» или <ShareIco size={18} /> → <b>«Открыть в Safari»</b></> : <>⋮ → <b>«Открыть в браузере»</b> (Chrome)</>}, и здесь появится установка.</div>
        </div>
      ) : pf.os !== 'ios' && canPromptInstall() ? (
        <button type="button" className="btn-primary" style={{ ...big, fontSize: 19, padding: '18px 16px' }} onClick={install}>📲 Установить</button>
      ) : pf.os !== 'ios' && !waited ? (
        <div style={{ textAlign: 'center', color: 'var(--text-hint)', fontSize: 14, padding: 14 }}>Готовим установку…</div>
      ) : iosSafari ? (
        <div className="card" style={{ padding: '14px 16px' }}>
          <div style={{ fontSize: 13, color: 'var(--text-hint)', marginBottom: 8 }}>На iPhone приложение ставится так (Apple не даёт ставить по ссылке):</div>
          {[
            <>Нажмите <b>«Поделиться»</b> <ShareIco /> — внизу экрана{pf.browser === 'chrome' ? ' (в Chrome — в адресной строке)' : ''}. Не видно — нажмите <b>«•••»</b>, затем «Поделиться».</>,
            <>Прокрутите вниз и выберите <b>«На экран „Домой“»</b>.</>,
            <>Нажмите <b>«Добавить»</b> — значок появится на рабочем столе.</>,
          ].map((s, i) => (
            <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '9px 0', borderTop: i ? '0.5px solid var(--border)' : 'none' }}>
              <span style={{ flex: '0 0 30px', height: 30, borderRadius: 15, background: 'var(--blue)', color: '#fff', fontWeight: 700, fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{i + 1}</span>
              <span style={{ fontSize: 16, lineHeight: 1.45 }}>{s}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div style={{ marginTop: 14 }}><InstallGuide defaultOpen={false} title="Подробно: iPhone, Android, компьютер" /></div>
      <button type="button" onClick={() => navigate('/')} style={{ display: 'block', margin: '6px auto 0', border: 'none', background: 'none', color: 'var(--blue)', fontSize: 14, cursor: 'pointer' }}>Открыть в браузере, без установки ›</button>

      {/* iPhone Safari: стрелка вниз — к кнопке «Поделиться» на панели браузера */}
      {iosSafari && !installed && (
        <div style={{ position: 'fixed', left: 0, right: 0, bottom: 'calc(8px + env(safe-area-inset-bottom))', display: 'flex', flexDirection: 'column', alignItems: 'center', pointerEvents: 'none', zIndex: 50 }}>
          <div style={{ background: 'var(--blue)', color: '#fff', fontSize: 14, fontWeight: 600, padding: '7px 14px', borderRadius: 18, boxShadow: '0 4px 14px rgba(0,0,0,.2)' }}>Нажмите «Поделиться» внизу</div>
          <div className="install-arrow" style={{ fontSize: 34, lineHeight: 1, color: 'var(--blue)', marginTop: 2 }}>↓</div>
          <style>{'@keyframes installBounce{0%,100%{transform:translateY(0)}50%{transform:translateY(8px)}} .install-arrow{animation:installBounce 1.1s ease-in-out infinite}'}</style>
        </div>
      )}
    </div>
  )
}
