// Свой набор инструментов и обработки у постпроцессора.
// Обычно база инструментов и обработка контуров — общие для всех станков аккаунта. Но постпроцессор, настроенный по
// чужой управляющей программе (самонастройка), получает СВОИ инструменты (tool.postId = id постпроцессора) и свою
// обработку (post.ownOps): у чужого станка свои номера инструментов, и они не должны смешиваться с инструментами
// вашей линии. Пока открыт такой постпроцессор — видны и правятся только его инструменты и его обработка;
// у остальных постпроцессоров эти инструменты не видны.
// Общий («для всех») постпроцессор у других пользователей идёт с их собственными инструментами и обработкой:
// номера инструментов у каждого свои.

const activeOf = cnc => (cnc.posts || []).find(p => p.id === cnc.post) || (cnc.posts || [])[0] || null

/** У постпроцессора свой набор инструментов? */
export const hasOwnTools = (cnc, post = activeOf(cnc)) => !!post && !post.shared && (cnc.tools || []).some(t => t.postId === post.id)

/** Настройки так, как их видит открытый постпроцессор: его инструменты и его обработка. Повторный вызов ничего не меняет. */
export function postView(cnc) {
  const post = activeOf(cnc)
  if (!post) return cnc
  const all = cnc.tools || []
  const own = !post.shared && all.some(t => t.postId === post.id)
  const tools = own ? all.filter(t => t.postId === post.id) : all.filter(t => !t.postId)
  const ops = own && post.ownOps ? post.ownOps : cnc.ops
  if (tools.length === all.length && ops === cnc.ops) return cnc
  return { ...cnc, tools, ops }
}

/** Вернуть правку, сделанную в «виде» (postView), в полные настройки. */
export function postBack(cnc, view) {
  const post = activeOf(cnc)
  if (!post) return view
  const all = cnc.tools || []
  const own = !post.shared && all.some(t => t.postId === post.id)
  const shown = new Set((own ? all.filter(t => t.postId === post.id) : all.filter(t => !t.postId)).map(t => t.id))
  const rest = all.filter(t => !shown.has(t.id))
  const mine = (view.tools || []).map(t => (own ? { ...t, postId: post.id } : t))
  const next = { ...cnc, ...view, tools: [...rest, ...mine], posts: cnc.posts, post: cnc.post }
  if (own && post.ownOps) {
    next.ops = cnc.ops
    if (view.ops !== post.ownOps) next.posts = cnc.posts.map(p => (p.id === post.id ? { ...p, ownOps: view.ops } : p))
  }
  return next
}
