# Deploying to a Hostinger Ubuntu VPS (nginx + systemd)

This app is a single persistent Node process. State lives in three places:

- **Database** — remote Supabase Postgres (`DATABASE_URL`). Not on the VPS.
- **Signing key** — `keys/server_ed25519.pem`, generated once on the server.
- **Candidate photos** — `uploads/`.

Only `keys/` and `uploads/` are local, so the VPS just needs the app directory on
disk. Run **one** instance (photos are local to it, and it keeps the ballot chain
simple).

## How many domains?

**One** domain or subdomain is enough — e.g. `vote.yourdomain.com`. Voters use
`/` (the Vote page) and officials use `/admin.html` on the **same** host; they are
separate pages, not separate sites. Point one DNS **A record** (and an **AAAA**
record if you have IPv6) at the VPS IP.

Optional: a second subdomain like `admin.yourdomain.com` pointing at the same
server if you want a tidy admin URL — not required. You can also lock `/admin.html`
to office IPs in the nginx config instead.

---

## 1. DNS
In your DNS (Hostinger hPanel → Domains → DNS):
```
A    vote    <your-VPS-IPv4>
AAAA vote    <your-VPS-IPv6>      # only if your VPS has IPv6
```
Wait for it to resolve (`ping vote.yourdomain.com`).

## 2. Server prerequisites (as root or sudo)
```bash
apt update && apt upgrade -y
# Node 20 LTS (required: the app uses node --env-file)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs nginx certbot python3-certbot-nginx git
# Firewall
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
```

## 3. App user + code
```bash
adduser --system --group --home /opt/voting voting
cd /opt/voting
# Copy the project here (git clone, or scp the folder). Then:
sudo -u voting git clone <your-repo-url> .     # or scp the files in
sudo -u voting npm ci --omit=dev               # installs express, pg, nodemailer, sharp
```

## 4. Configure `.env`
Create `/opt/voting/.env` (owned by the `voting` user, `chmod 600`). Use the
values from this project's `.env` — the important ones:
```
PORT=3000
ADMIN_USER=PollAdmin
ADMIN_PASS=9Rs7Ez8lsl43Sswh         # change after first login
DATABASE_URL=postgresql://postgres.bssasrcnwljtfghbltqa:...@aws-0-eu-west-1.pooler.supabase.com:5432/postgres
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=electionuwl@gmail.com
SMTP_PASS=<gmail app password>
SMTP_FROM=electionuwl@gmail.com
```
> Use the **pooler** `DATABASE_URL` (IPv4). The direct `db.<ref>.supabase.co`
> host is IPv6-only and fails on IPv4-only VPSes.

## 5. Generate the signing key (once)
```bash
cd /opt/voting
sudo -u voting npm run keygen
```
This writes `keys/server_ed25519.pem` and stores the public key in the database.
**Back up `keys/` offline** — losing it makes past ballots unverifiable. Do NOT
re-run keygen after the election starts.

(The `PollAdmin` account is created automatically on first boot from
`ADMIN_USER`/`ADMIN_PASS`; or run `sudo -u voting npm run create-admin <user> <pass>`.)

## 6. systemd service
```bash
sudo cp deploy/voting.service /etc/systemd/system/voting.service
sudo systemctl daemon-reload
sudo systemctl enable --now voting
sudo systemctl status voting          # should be active (running)
journalctl -u voting -f               # logs; expect "Voting server on http://localhost:3000"
```

## 7. nginx + HTTPS
```bash
sudo cp deploy/nginx-voting.conf /etc/nginx/sites-available/voting
sudo sed -i 's/vote.YOURDOMAIN.com/vote.yourdomain.com/' /etc/nginx/sites-available/voting
sudo ln -s /etc/nginx/sites-available/voting /etc/nginx/sites-enabled/voting
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d vote.yourdomain.com     # issues + installs TLS, adds :443
```
Certbot auto-renews via a systemd timer.

## 8. Go live
- Visit `https://vote.yourdomain.com/admin.html`, sign in as **PollAdmin**, and
  change the password (Admin accounts → add a new admin, remove the seed one, or
  rotate with `create-admin`).
- Build the election: **Positions → Candidates → Roster** (each voter row needs an
  email: `student_id,name,email`).
- Voters go to `https://vote.yourdomain.com/`, enter their email, get a 6-digit
  code, and vote.
- Close + approve from the admin console when done. Download a backup
  (Admin → Backup & reset) regularly.

## Keep in mind
- **One instance only.** Photos live on the VPS disk; a second instance wouldn't
  see them.
- **Protect `.env` and `keys/`.** `.env` holds the DB password and SMTP secret;
  `keys/` holds the signing key.
- The database is Supabase — back it up there too (Supabase dashboard), plus the
  app's own Admin → Backup for a portable JSON copy.
