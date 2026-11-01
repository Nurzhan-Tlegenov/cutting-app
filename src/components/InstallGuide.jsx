// «Как установить приложение на телефон» — в «Обучении». Вкладки iPhone / Android / Компьютер, своя выбрана сама.
// iPhone — пошагово через «Поделиться» (окна установки у Safari нет); Android и компьютер — кнопка «Установить»,
// если браузер её предлагает, и шаги для Chrome, Яндекс Браузера, Samsung Internet.
import { useEffect, useState } from 'react'
import { canPromptInstall, onInstallChange, promptInstall, isInstalled, platform } from '../lib/install'

// значки, как на экране телефона — чтобы человек узнал кнопку
const ShareIco = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="var(--blue)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: '-3px' }}>
    <path d="M12 15V3M8 7l4-4 4 4" /><path d="M7 10H5v11h14V10h-2" />
  </svg>
)
const PlusIco = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" style={{ verticalAlign: '-3px' }}>
    <rect x="3" y="3" width="18" height="18" rx="4" /><path d="M12 8v8M8 12h8" />
  </svg>
)
const Dots = ({ v }) => <b style={{ display: 'inline-block', padding: '0 5px', borderRadius: 6, background: 'var(--bg2)', letterSpacing: v ? 0 : 1 }}>{v ? '⋮' : '•••'}</b>
const InstallIco = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: '-3px' }}>
    <rect x="2" y="4" width="20" height="13" rx="2" /><path d="M12 7v6M9 10.5l3 3 3-3M8 21h8" />
  </svg>
)

const STEPS = {
  ios: [
    <>Откройте сайт <b>в Safari</b> (синий компас). Если ссылку открыли из Telegram, WhatsApp или другого приложения — нажмите там «Открыть в Safari» или скопируйте ссылку ниже и вставьте в Safari.</>,
    <>Нажмите кнопку <b>«Поделиться»</b> <ShareIco /> — квадрат со стрелкой вверх. На iPhone она внизу экрана, на iPad — вверху справа. Если её не видно — нажмите <Dots /> рядом с адресной строкой, затем «Поделиться».</>,
    <>В открывшемся списке прокрутите вниз и выберите <b>«На экран „Домой“»</b> <PlusIco />. Если пункта нет — нажмите «Ещё» / «Редактировать действия» и добавьте его.</>,
    <>Проверьте, что включено <b>«Открыть как веб-приложение»</b> (если такой переключатель есть), и нажмите <b>«Добавить»</b> справа вверху.</>,
    <>На рабочем столе появится значок <b>RaskroyPro</b>. Дальше открывайте приложение с него — оно на весь экран, без адресной строки, и само обновляется.</>,
  ],
  iosChrome: <>В Chrome на iPhone: нажмите <ShareIco /> в адресной строке (или <Dots /> → «Поделиться») → <b>«На экран „Домой“»</b> → «Добавить». Если пункта нет — откройте сайт в Safari.</>,
  android: [
    <>Откройте сайт в <b>Chrome</b> (или в Яндекс Браузере, Samsung Internet). Если ссылку открыли из Telegram или WhatsApp — нажмите <Dots v /> → «Открыть в браузере».</>,
    <>Нажмите <Dots v /> (три точки справа вверху).</>,
    <>Выберите <b>«Установить приложение»</b>. Если такого пункта нет — <b>«Добавить на главный экран»</b> → <b>«Установить»</b>.</>,
    <>Подтвердите «Установить». Значок <b>RaskroyPro</b> появится на рабочем столе и в списке приложений.</>,
  ],
  androidOther: <>Яндекс Браузер: <Dots v /> или ☰ → «Добавить ярлык» / «Установить приложение». Samsung Internet: ☰ → «Добавить страницу на» → «Главный экран».</>,
  desktop: [
    <>Откройте сайт в <b>Chrome</b>, <b>Edge</b> или Яндекс Браузере.</>,
    <>В адресной строке справа нажмите значок установки <InstallIco /> (монитор со стрелкой) → «Установить».</>,
    <>Если значка нет: <Dots v /> → «Сохранить и поделиться» (или «Трансляция, сохранение и отправка») → <b>«Установить страницу как приложение…»</b>. В Edge: <Dots /> → «Приложения» → «Установить этот сайт как приложение».</>,
    <>Приложение откроется в своём окне, ярлык появится на рабочем столе и в меню «Пуск».</>,
  ],
}
const TABS = [['ios', '📱 iPhone'], ['android', '🤖 Android'], ['desktop', '💻 Компьютер']]

export default function InstallGuide() {
  const pf = platform()
  const [tab, setTab] = useState(pf.os)
  const [open, setOpen] = useState(!isInstalled())
  const [, setTick] = useState(0)
  const [copied, setCopied] = useState(false)
  useEffect(() => onInstallChange(() => setTick(t => t + 1)), [])
  const installed = isInstalled()
  const site = typeof window !== 'undefined' ? window.location.origin : ''
  const copy = async () => {
    try { await navigator.clipboard.writeText(site); setCopied(true); setTimeout(() => setCopied(false), 2500) } catch { window.prompt('Скопируйте ссылку:', site) }
  }
  const install = async () => { const r = await promptInstall(); if (r === 'accepted') setTick(t => t + 1) }
  const steps = STEPS[tab]
  return (
    <div className="card" style={{ marginBottom: 10, padding: '12px 14px' }}>
      <div onClick={() => setOpen(v => !v)} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', cursor: 'pointer' }}>
        <span style={{ fontSize: 26, lineHeight: 1 }}>📲</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>Установить приложение на телефон</div>
          <div style={{ fontSize: 12, color: installed ? 'var(--teal)' : 'var(--text-hint)', marginTop: 2 }}>
            {installed ? '✓ Вы уже открыли приложение с рабочего стола' : 'Значок на рабочем столе — открывается сразу, на весь экран, без браузера'}
          </div>
        </div>
        <span style={{ color: 'var(--text-hint)', fontSize: 12, marginTop: 4 }}>{open ? '▴' : '▾'}</span>
      </div>
      {open && <>
        <div style={{ display: 'flex', gap: 4, marginTop: 10, background: 'var(--bg2)', borderRadius: 18, padding: 3 }}>
          {TABS.map(([k, l]) => (
            <button key={k} type="button" onClick={() => setTab(k)}
              style={{ flex: 1, padding: '6px 4px', borderRadius: 15, border: 'none', fontSize: 12.5, whiteSpace: 'nowrap', fontWeight: tab === k ? 600 : 400,
                background: tab === k ? 'var(--bg)' : 'transparent', color: tab === k ? 'var(--blue)' : 'var(--text-muted)', boxShadow: tab === k ? '0 1px 2px rgba(0,0,0,0.12)' : 'none' }}>
              {l}
            </button>
          ))}
        </div>
        {tab === pf.os && pf.browser === 'inapp' && (
          <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--amber)', background: 'var(--amber-light)', border: '0.5px solid var(--amber)', borderRadius: 'var(--radius)', padding: '6px 9px' }}>
            Сейчас сайт открыт внутри другого приложения (мессенджера) — оттуда установить нельзя. Откройте его в {pf.os === 'ios' ? 'Safari' : 'Chrome'}: кнопка «Открыть в браузере» или скопируйте ссылку ниже.
          </div>
        )}
        {tab !== 'ios' && tab === pf.os && canPromptInstall() && !installed && (
          <button type="button" className="btn-primary" onClick={install} style={{ width: '100%', marginTop: 10, padding: 10, fontSize: 14 }}>📲 Установить сейчас</button>
        )}
        <ol style={{ margin: '10px 0 0', paddingLeft: 22, fontSize: 13.5, color: 'var(--text)', lineHeight: 1.5 }}>
          {steps.map((s, i) => <li key={i} style={{ marginBottom: 7 }}>{s}</li>)}
        </ol>
        {tab === 'ios' && <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '2px 0 0', lineHeight: 1.45 }}>{STEPS.iosChrome}</p>}
        {tab === 'android' && <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '2px 0 0', lineHeight: 1.45 }}>{STEPS.androidOther}</p>}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{site.replace(/^https?:\/\//, '')}</span>
          <button type="button" className="btn-secondary" onClick={copy} style={{ flex: '0 0 auto', width: 'auto', padding: '7px 12px', fontSize: 13 }}>{copied ? '✓ Скопировано' : 'Скопировать ссылку'}</button>
        </div>
      </>}
    </div>
  )
}
