import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { SCREENS } from './demoScreens'
import { DEMOS } from './demoScripts'
import { demoLang, dt, speechText, UI, VOICE_LOCALE } from './demoLang'
import { useBackClose } from '../../lib/backStack'

// Обучающее «видео»: плеер сам проигрывает сценарий на копиях экранов приложения — палец со стрелкой
// идёт к кнопке, нажимает, вводит размеры, экран меняется; снизу субтитры и (по желанию) голос.
// Пауза, шаг назад/вперёд, перемотка по полосе и по главам. Ничего не создаётся в настоящих заказах.

const W0 = 360, H0 = 700                    // холст экрана, px
const MOVE = 650                            // палец едет к цели
const TYPE_MS = 85                          // на символ при «печати»
const EASE = 'cubic-bezier(.45,.05,.25,1)'

// состояние экрана перед кадром n: все изменения предыдущих кадров + экран и прокрутка самого кадра
function stateAt(beats, n) {
  let st = { screen: beats[0].s, y: 0 }
  for (let j = 0; j < n; j++) st = applyBeat(st, beats[j], Infinity)
  const b = beats[n]
  return { ...st, focus: null, screen: b.s, y: b.y ?? (b.s === st.screen ? st.y : 0) }
}
// результат кадра: что напечатано (typed символов) и что поменялось на экране
function applyBeat(st, b, typed) {
  const n = { ...st, ...(b.set || {}), screen: b.s, y: b.y ?? (b.s === st.screen ? st.y : 0), focus: null }
  if (b.key) {
    const full = b.type || ''
    n[b.key] = full.slice(0, Math.min(full.length, typed))
    if (typed < full.length) n.focus = b.key
  }
  return n
}
const typeTime = b => (b.type ? b.type.length * TYPE_MS : 0)
const readTime = text => Math.max(2200, (text || '').length * 62)

// Голоса телефона для языка ролика. Лучшие — нейросетевые и «онлайн» (Google, Microsoft Natural/Online, Siri
// Enhanced/Premium): они ставят ударения и интонацию заметно естественнее встроенных «роботов».
const voicesFor = l => {
  const p = (VOICE_LOCALE[l] || l).slice(0, 2).toLowerCase()
  return (window.speechSynthesis?.getVoices() || []).filter(v => String(v.lang).toLowerCase().replace('_', '-').startsWith(p))
}
const voiceScore = v => (/natural|neural|online|premium|enhanced|wavenet|studio/i.test(v.name) ? 4 : 0) + (/google/i.test(v.name) ? 3 : 0) + (v.localService === false ? 1 : 0) + (/compact|espeak/i.test(v.name) ? -3 : 0)
const bestVoice = list => [...list].sort((a, b) => voiceScore(b) - voiceScore(a))[0] || null
function useVoices(l) {
  const [list, setList] = useState(() => voicesFor(l))
  useEffect(() => {
    const ss = window.speechSynthesis
    if (!ss) return
    const on = () => setList(voicesFor(l))
    ss.addEventListener?.('voiceschanged', on)
    const t = setTimeout(on, 700)                    // на части телефонов голоса приходят без события
    return () => { ss.removeEventListener?.('voiceschanged', on); clearTimeout(t) }
  }, [l])
  return list
}

function speak(text, voice, l, onEnd) {
  const ss = window.speechSynthesis
  if (!ss || !text) { onEnd(); return () => {} }
  ss.cancel()
  const u = new SpeechSynthesisUtterance(speechText(text, l))
  u.lang = voice?.lang || VOICE_LOCALE[l] || 'ru-RU'
  u.rate = 0.95; u.pitch = 1
  if (voice) u.voice = voice
  let done = false
  const fin = () => { if (!done) { done = true; onEnd() } }
  u.onend = fin; u.onerror = fin
  const guard = setTimeout(fin, text.length * 95 + 2500)   // onend на некоторых телефонах не приходит
  ss.speak(u)
  return () => { clearTimeout(guard); done = true; ss.cancel() }
}

export default function DemoVideo({ id, onClose }) {
  const demo = DEMOS[id]
  const beats = demo.beats
  const [i, setI] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [phase, setPhase] = useState({ i: -1, typed: 0 })          // кадр i уже «нажат»; сколько символов напечатано
  const [finger, setFinger] = useState({ x: W0 * 0.6, y: H0 * 0.85, show: false })
  const [tap, setTap] = useState({ n: 0, dbl: false })
  const [voice, setVoice] = useState(() => { try { return localStorage.getItem('demoVoice') !== '0' } catch { return true } })
  const [ended, setEnded] = useState(false)
  const [scale, setScale] = useState(1)
  const L = demoLang(), ui = UI[L] || UI.ru
  const voices = useVoices(L)
  const vKey = 'demoVoiceName:' + L
  const [voiceName, setVoiceName] = useState(() => { try { return localStorage.getItem(vKey) || '' } catch { return '' } })
  const [voiceMenu, setVoiceMenu] = useState(false)
  const theVoice = voices.find(v => v.name === voiceName) || bestVoice(voices)
  const canSpeak = !!window.speechSynthesis && voices.length > 0
  const sayText = dt(beats[i].say, L)
  const frame = useRef(null)
  useBackClose(true, onClose)

  const b = beats[i]
  const base = useMemo(() => stateAt(beats, i), [beats, i])
  const st = phase.i === i ? applyBeat(base, b, phase.typed) : base
  const Screen = SCREENS[st.screen]

  // масштаб холста под экран
  useEffect(() => {
    const fit = () => setScale(Math.min((window.innerWidth - 20) / W0, (window.innerHeight - 190) / H0, 1.25))
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])

  // палец — к элементу кадра (и после перемотки, на паузе)
  const aim = () => {
    const el = b.at && frame.current?.querySelector(`[data-demo="${b.at}"]`)
    if (!el) { setFinger(f => ({ ...f, show: false })); return }
    const fr = frame.current.getBoundingClientRect(), r = el.getBoundingClientRect(), k = fr.width / W0
    setFinger({ x: (r.left + r.width / 2 - fr.left) / k, y: (r.top + Math.min(r.height / 2, 40) - fr.top) / k, show: true })
  }
  useEffect(() => {
    if (playing) return
    const t = setTimeout(aim, 60)
    return () => clearTimeout(t)
  }, [i, playing, phase.i])   // eslint-disable-line react-hooks/exhaustive-deps

  // проигрывание кадра: палец к цели → нажатие → печать / изменение экрана → субтитр дочитан (голос договорил) → дальше
  useEffect(() => {
    if (!playing) return
    let alive = true
    const T = []
    const later = (ms, f) => T.push(setTimeout(() => { if (alive) f() }, ms))
    const talk = voice && canSpeak
    let spoke = !talk, minDone = false
    const next = () => {
      if (!spoke || !minDone) return
      if (i + 1 < beats.length) setI(i + 1)
      else { setPlaying(false); setEnded(true) }
    }
    later(i > 0 && beats[i - 1].s !== b.s ? 380 : 40, aim)   // новый экран въезжает — палец целится, когда он встал
    const actAt = b.at ? MOVE + 150 : 300
    if (b.act || b.key || b.set) {
      later(actAt, () => {
        if (b.act) setTap(t => ({ n: t.n + 1, dbl: b.act === 'tap2' }))
        setPhase({ i, typed: 0 })
      })
      if (b.type) for (let c = 1; c <= b.type.length; c++) later(actAt + 200 + c * TYPE_MS, () => setPhase({ i, typed: c }))
    }
    later(actAt + typeTime(b) + Math.max(700, readTime(sayText) - actAt), () => { minDone = true; next() })
    let stop = () => {}
    if (talk) later(120, () => { stop = speak(sayText, theVoice, L, () => later(350, () => { spoke = true; next() })) })
    return () => { alive = false; T.forEach(clearTimeout); stop() }
  }, [i, playing, voice, canSpeak, theVoice?.name])   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => window.speechSynthesis?.cancel(), [])

  const goTo = n => { setEnded(false); setPhase({ i: -1, typed: 0 }); setI(Math.max(0, Math.min(beats.length - 1, n))) }
  const togglePlay = () => { if (ended) { setEnded(false); goTo(0); setPlaying(true) } else setPlaying(p => !p) }
  const toggleVoice = () => { const v = !voice; setVoice(v); if (!v) window.speechSynthesis?.cancel(); try { localStorage.setItem('demoVoice', v ? '1' : '0') } catch { /* без памяти */ } }
  const chapters = beats.map((x, n) => [x.ch, n]).filter(([c]) => c)
  const curCh = chapters.filter(([, n]) => n <= i).pop()?.[0]
  const pickVoice = name => { setVoiceName(name); setVoiceMenu(false); try { localStorage.setItem(vKey, name) } catch { /* без памяти */ } }
  const seek = e => { const r = e.currentTarget.getBoundingClientRect(); goTo(Math.floor(((e.clientX - r.left) / r.width) * beats.length)) }
  const ctl = { width: 44, height: 44, borderRadius: 22, border: 'none', background: 'rgba(255,255,255,.12)', color: '#fff', fontSize: 18, padding: 0, cursor: 'pointer' }

  return createPortal(
    <div dir="ltr" data-no-i18n={L === 'ru' ? '' : undefined} style={{ position: 'fixed', inset: 0, zIndex: 1300, background: '#0f1218', color: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <style>{CSS}</style>
      {/* шапка */}
      <div style={{ width: '100%', maxWidth: 480, display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px 8px', boxSizing: 'border-box' }}>
        <div data-no-i18n="" dir={L === 'ar' ? 'rtl' : 'ltr'} style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dt(demo.title, L)}</div>
          <div style={{ fontSize: 11.5, opacity: 0.6 }}>{dt(curCh, L)} · {i + 1} {ui.of} {beats.length}</div>
        </div>
        <button type="button" aria-label="Закрыть" onClick={onClose} style={{ ...ctl, width: 36, height: 36, fontSize: 20 }}>×</button>
      </div>

      {/* экран-«телефон» */}
      <div style={{ width: W0 * scale, height: H0 * scale, flexShrink: 0, position: 'relative' }}>
        <div ref={frame} onClick={togglePlay}
          style={{ width: W0, height: H0, transform: `scale(${scale})`, transformOrigin: '0 0', position: 'absolute', left: 0, top: 0, background: 'var(--bg)', color: 'var(--text)', borderRadius: 22, overflow: 'hidden', boxShadow: '0 0 0 6px #262b35, 0 12px 40px rgba(0,0,0,.5)' }}>
          <div style={{ position: 'absolute', inset: 0, transform: `translateY(${-st.y}px)`, transition: `transform .45s ${EASE}` }}>
            <div key={st.screen} className="demo-screen" style={{ position: 'absolute', inset: 0 }}><Screen st={st} /></div>
          </div>
          {/* палец со стрелкой */}
          <div style={{ position: 'absolute', left: finger.x, top: finger.y, opacity: finger.show ? 1 : 0, transition: `left ${MOVE}ms ${EASE}, top ${MOVE}ms ${EASE}, opacity .3s`, pointerEvents: 'none', zIndex: 5 }}>
            <span key={tap.n} className={tap.n ? (tap.dbl ? 'demo-ripple demo-ripple2' : 'demo-ripple') : undefined} />
            <svg key={'f' + tap.n} className={tap.n ? 'demo-press' : undefined} width="40" height="46" viewBox="0 0 40 46" style={{ position: 'absolute', left: -6, top: -3, filter: 'drop-shadow(0 3px 4px rgba(0,0,0,.35))' }}>
              <path d="M6 3 L6 33 L13.5 26 L19 39 L24.5 36.5 L19 24 L29 24 Z" fill="#fff" stroke="#1b1f27" strokeWidth="2.2" strokeLinejoin="round" />
            </svg>
          </div>
          {/* субтитры: внизу; если палец показывает в нижнюю часть экрана — сверху, чтобы не закрывать кнопку */}
          <div style={{ position: 'absolute', left: 12, right: 12, ...(finger.show && finger.y > H0 * 0.55 ? { top: 58 } : { bottom: 64 }), zIndex: 6, pointerEvents: 'none', display: 'flex', justifyContent: 'center' }}>
            <div key={i} className="demo-sub" data-no-i18n="" dir={L === 'ar' ? 'rtl' : 'ltr'} style={{ background: 'rgba(15,18,24,.88)', color: '#fff', fontSize: 15, lineHeight: 1.4, padding: '8px 12px', borderRadius: 10, textAlign: 'center', maxWidth: 320 }}>{sayText}</div>
          </div>
          {(!playing || ended) && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: ended ? 'rgba(15,18,24,.55)' : 'transparent', zIndex: 7 }}>
              <span style={{ width: 76, height: 76, borderRadius: 38, background: 'rgba(15,18,24,.7)', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 30 }}>{ended ? '↻' : '▶'}</span>
            </div>
          )}
        </div>
      </div>

      {/* управление */}
      <div style={{ width: W0 * scale, maxWidth: '100%', marginTop: 14 }}>
        <div onClick={seek} style={{ height: 22, display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
          <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'rgba(255,255,255,.18)', position: 'relative' }}>
            {chapters.map(([c, n]) => <span key={c} style={{ position: 'absolute', left: `${(n / beats.length) * 100}%`, top: -2, width: 2, height: 8, background: 'rgba(255,255,255,.45)' }} />)}
            <div style={{ height: '100%', borderRadius: 2, background: '#4fa3ff', width: `${((i + (phase.i === i ? 0.5 : 0.1)) / beats.length) * 100}%`, transition: 'width .4s' }} />
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, marginTop: 6 }}>
          <button type="button" aria-label="Звук" onClick={toggleVoice} disabled={!canSpeak} style={{ ...ctl, width: 38, height: 38, fontSize: 16, opacity: voice && canSpeak ? 1 : 0.45 }}>{voice && canSpeak ? '🔊' : '🔇'}</button>
          <button type="button" aria-label="Назад" onClick={() => goTo(i - 1)} style={ctl}>⏮</button>
          <button type="button" aria-label={playing ? 'Пауза' : 'Играть'} onClick={togglePlay} style={{ ...ctl, width: 56, height: 56, fontSize: 22, background: '#4fa3ff' }}>{playing ? '❚❚' : ended ? '↻' : '▶'}</button>
          <button type="button" aria-label="Вперёд" onClick={() => goTo(i + 1)} style={ctl}>⏭</button>
          {/* выбор голоса: какой из голосов телефона звучит естественнее — решает сам человек, выбор запоминается */}
          <button type="button" aria-label={ui.voice} onClick={() => setVoiceMenu(v => !v)} disabled={!canSpeak} style={{ ...ctl, width: 38, height: 38, fontSize: 15, opacity: canSpeak ? 1 : 0.35 }}>🗣</button>
        </div>
        {!canSpeak && <div data-no-i18n="" style={{ textAlign: 'center', fontSize: 11.5, opacity: 0.6, marginTop: 6 }}>{ui.noVoice}</div>}
        {voiceMenu && canSpeak && (
          <div data-no-i18n="" style={{ marginTop: 10, background: 'rgba(255,255,255,.08)', borderRadius: 12, padding: 6, maxHeight: 170, overflowY: 'auto' }}>
            <div style={{ fontSize: 11.5, opacity: 0.6, padding: '2px 8px 4px' }}>{ui.voice}</div>
            {[{ name: '', label: `${ui.auto} — ${bestVoice(voices)?.name || ''}` }, ...voices.map(v => ({ name: v.name, label: v.name }))].map(o => (
              <button key={o.name || '_'} type="button" onClick={() => pickVoice(o.name)}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 8px', borderRadius: 8, border: 'none', fontSize: 13, cursor: 'pointer', color: '#fff',
                  background: voiceName === o.name ? 'rgba(79,163,255,.35)' : 'transparent', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.label}</button>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center', marginTop: 10 }}>
          {chapters.map(([c, n]) => (
            <button key={c} type="button" onClick={() => goTo(n)}
              data-no-i18n="" style={{ padding: '4px 10px', borderRadius: 14, border: 'none', fontSize: 12, cursor: 'pointer', background: c === curCh ? '#4fa3ff' : 'rgba(255,255,255,.1)', color: '#fff' }}>{dt(c, L)}</button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  )
}

const CSS = `
.demo-screen { animation: demo-in .35s ease both }
@keyframes demo-in { from { opacity: 0; transform: translateX(14px) } to { opacity: 1; transform: none } }
.demo-sub { animation: demo-sub .3s ease both }
@keyframes demo-sub { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } }
.demo-caret { display: inline-block; width: 1.5px; height: 14px; margin-left: 1px; vertical-align: -2px; background: var(--blue); animation: demo-blink .9s steps(1) infinite }
@keyframes demo-blink { 50% { opacity: 0 } }
.demo-ripple { position: absolute; left: -22px; top: -22px; width: 44px; height: 44px; border-radius: 50%; background: rgba(79,163,255,.45); animation: demo-rip .6s ease-out both }
.demo-ripple2 { animation: demo-rip .45s ease-out 2 both }
@keyframes demo-rip { from { transform: scale(.2); opacity: 1 } to { transform: scale(1.5); opacity: 0 } }
.demo-press { animation: demo-press .32s ease both }
@keyframes demo-press { 50% { transform: scale(.82) translate(2px, 3px) } }
.demo-part { animation: demo-part 2.6s ease-in-out infinite both }
@keyframes demo-part { 0% { opacity: 0; transform: translate(6px, -8px) } 25%, 80% { opacity: 1; transform: none } 100% { opacity: .35 } }
.demo-pop { animation: demo-pop .35s ease both }
@keyframes demo-pop { from { opacity: 0; transform: scale(.92) } to { opacity: 1; transform: none } }
.demo-spin { width: 11px; height: 11px; border-radius: 50%; border: 2px solid var(--blue-mid); border-top-color: var(--blue); animation: demo-spin .8s linear infinite }
@keyframes demo-spin { to { transform: rotate(360deg) } }
.demo-draw { stroke-dasharray: 1; stroke-dashoffset: 1; animation: demo-draw 9s linear forwards }
@keyframes demo-draw { to { stroke-dashoffset: 0 } }
`
