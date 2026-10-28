// Обязательные данные профиля (вход по почте / Google): имя и фамилия, телефон
/** Имя и фамилия — хотя бы два слова по 2+ буквы (не «М Х»): сообщество прозрачное, все знают, с кем работают */
export const nameOk = s => String(s || '').trim().split(/\s+/).filter(w => (w.match(/\p{L}/gu) || []).length >= 2).length >= 2
/** Телефон — не меньше 7 цифр */
export const phoneOk = s => String(s || '').replace(/\D/g, '').length >= 7
