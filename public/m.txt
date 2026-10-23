#!/bin/bash
# Зеркало RaskroyPro для России: ru.raskroypro.com.
# Из России заблокированы адреса Vercel (сайт) и Supabase (база). Этот сервер стоит там, откуда они доступны
# (например, в Казахстане), а пользователи из России открывают его: сайт и запросы к базе он пересылает сам.
# Данных на сервере нет — база одна и та же, всё хранится в Supabase.
#
# Как запустить (один раз): сервер Ubuntu 22.04/24.04, в DNS домена запись A: ru → IP этого сервера.
# Войти на сервер (консоль в панели хостинга), вставить этот файл целиком и нажать Enter.
set -e
DOMAIN=ru.raskroypro.com
SITE=cutting-app-nine.vercel.app
DB=bmcmyrdsxievaglpspcn.supabase.co
EMAIL=nurzhyk.kz1@gmail.com

apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get install -y nginx certbot python3-certbot-nginx

cat > /etc/nginx/sites-available/raskroy <<NGINX
map \$http_upgrade \$conn_upgrade { default upgrade; '' close; }
server {
  listen 80;
  server_name $DOMAIN;
  client_max_body_size 60m;
  large_client_header_buffers 8 64k;   # после входа браузер шлёт длинный токен — со стандартными 8k nginx отвечал 400

  # база: /sb/... -> Supabase (вход, данные, файлы, функции, обновления в реальном времени)
  location /sb/ {
    proxy_pass https://$DB/;
    proxy_set_header Host $DB;
    proxy_ssl_server_name on;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$conn_upgrade;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_read_timeout 3600s;
    proxy_buffering off;
  }

  # сайт: всё остальное -> Vercel (метка x-raskroy-mirror отключает там переадресацию на raskroypro.com)
  location / {
    proxy_pass https://$SITE;
    proxy_set_header Host $SITE;
    proxy_set_header x-raskroy-mirror 1;
    proxy_ssl_server_name on;
    proxy_http_version 1.1;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
  }
}
NGINX
ln -sf /etc/nginx/sites-available/raskroy /etc/nginx/sites-enabled/raskroy
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# сертификат https (бесплатный, продлевается сам)
certbot --nginx -d $DOMAIN --non-interactive --agree-tos -m $EMAIL --redirect

echo
echo "Готово: https://$DOMAIN"
curl -s -o /dev/null -w "сайт: %{http_code}\n" https://$DOMAIN/
curl -s -w "\nбаза: %{http_code}\n" https://$DOMAIN/sb/auth/v1/health
