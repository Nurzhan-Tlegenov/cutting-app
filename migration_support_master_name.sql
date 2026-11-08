-- Имя мастер-аккаунта не показывается в поддержке: вместо имени — «Поддержка РаскройPro».
-- Сотрудники поддержки (не мастер) по-прежнему видны по имени.
-- support_name() используется в доске, карточке, истории, пушах и подписи ответов — поэтому меняется везде сразу,
-- в том числе в старых сообщениях (имя в карточке считается при показе).

create or replace function public.support_name(p_user uuid) returns text
language sql security definer set search_path = public stable as $$
  select case
    when exists (select 1 from profiles where id = p_user and role = 'admin') then 'Поддержка РаскройPro'
    else coalesce((select nullif(trim(full_name), '') from profiles where id = p_user), 'Пользователь')
  end
$$;

-- уже отправленные ответы из карточки: убрать имя мастер-аккаунта из подписи отправителя
update app_messages m
   set from_name = 'Поддержка RaskroyPro · Поддержка РаскройPro' || substr(m.from_name, strpos(m.from_name, ' → '))
  where m.kind = 'reply'
    and m.from_name like 'Поддержка RaskroyPro · %'
    and strpos(m.from_name, ' → ') > 0
    and exists (select 1 from profiles p where p.id = m.from_id and p.role = 'admin');

-- проверка: должно вернуть «Поддержка РаскройPro»
select support_name(id) from profiles where role = 'admin' limit 1;
