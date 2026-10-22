#!/bin/bash
# Зеркало RaskroyPro для России (ru.raskroypro.com) — версия «вставить при создании сервера».
# Вставляется в поле Initialization script / Cloud-init / User data при создании сервера (Oracle Cloud и др.).
# На сервер заходить не нужно: всё ставится само, а сертификат https получается сам,
# как только в DNS появится запись A: ru -> IP сервера (скрипт ждёт её до 2 суток).
# Данных на сервере нет: сайт пересылается с Vercel, база — с Supabase.
DOMAIN=ru.raskroypro.com
SITE=cutting-app-nine.vercel.app
DB=bmcmyrdsxievaglpspcn.supabase.co
EMAIL=nurzhyk.kz1@gmail.com
exec > /var/log/raskroy-mirror.log 2>&1
set -x

export DEBIAN_FRONTEND=noninteractive
for i in 1 2 3 4 5; do apt-get update -y && apt-get install -y nginx certbot python3-certbot-nginx dnsutils && break; sleep 30; done

# Oracle Cloud: в образе Ubuntu встроенный файрвол закрывает всё, кроме SSH — открываем 80 и 443
if command -v iptables >/dev/null; then
  iptables -I INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT
  command -v netfilter-persistent >/dev/null && netfilter-persistent save
fi
command -v ufw >/dev/null && ufw status | grep -q active && { ufw allow 80/tcp; ufw allow 443/tcp; }

cat > /etc/nginx/sites-available/raskroy <<NGINX
map \$http_upgrade \$conn_upgrade { default upgrade; '' close; }
server {
  listen 80;
  server_name $DOMAIN;
  client_max_body_size 60m;

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
nginx -t && systemctl enable nginx && systemctl restart nginx

# Сертификат: ждём, пока ru.raskroypro.com начнёт указывать на этот сервер, и получаем его (продлевается сам)
cat > /usr/local/bin/raskroy-cert.sh <<CERT
#!/bin/bash
MYIP=\$(curl -s -4 https://ifconfig.me || curl -s -4 https://api.ipify.org)
for i in \$(seq 1 576); do
  if [ "\$(dig +short $DOMAIN A @1.1.1.1 | tail -1)" = "\$MYIP" ]; then
    certbot --nginx -d $DOMAIN --non-interactive --agree-tos -m $EMAIL --redirect && { echo "сертификат получен"; exit 0; }
  fi
  sleep 300
done
CERT
chmod +x /usr/local/bin/raskroy-cert.sh
cat > /etc/systemd/system/raskroy-cert.service <<UNIT
[Unit]
Description=RaskroyPro mirror certificate
After=network-online.target nginx.service
[Service]
Type=simple
ExecStart=/usr/local/bin/raskroy-cert.sh
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now raskroy-cert.service
echo "готово, ждём DNS"
