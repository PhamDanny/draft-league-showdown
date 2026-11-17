# Hosting on a VPS

How to run the league site on a small Linux server, reachable at your own domain over HTTPS. After the first setup, a deploy is one command.

What you end up with:

```
friends ──HTTPS──► Caddy (ports 80/443, automatic certificates)
                     └─► league site (127.0.0.1:8000, systemd service "draft-league")
                           └─► Showdown server (127.0.0.1:8001, started by the site)
```

Placeholders used below. Replace them everywhere:

- `league.example.com`: your domain or subdomain
- `SERVER_IP`: the VPS's public IPv4 address

## 1. Buy the server and the domain

- **VPS:** pick the smallest plan with **2 vCPU and 4 GB RAM** from Hetzner, DigitalOcean, Vultr, Linode or a similar provider. Choose **Ubuntu 24.04 LTS**, and add your SSH public key when creating it (see the next step if you don't have one). Turn on the provider's automatic backups if they offer them; it's usually about 20% of the server price, and it's the easiest safety net.
- **Domain:** any registrar works (Cloudflare Registrar and Porkbun sell at near cost). In its DNS settings, add an `A` record for `league.example.com` pointing to `SERVER_IP`. If the domain is on Cloudflare, set that record to **DNS only** (grey cloud) so Caddy can get its certificate directly.

## 2. SSH key on your PC

In PowerShell on your Windows PC:

```powershell
ssh-keygen -t ed25519
```

Press Enter through the prompts. Paste the contents of `~\.ssh\id_ed25519.pub` into the VPS provider when creating the server.

Then add a shortcut so `ssh league` works. Create or edit `~\.ssh\config`:

```
Host league
    HostName SERVER_IP
    User league
```

## 3. First login: user, firewall, swap

Log in as root once (`ssh root@SERVER_IP`) and run:

```bash
# Updates. Ubuntu installs security updates automatically after this.
apt update && apt upgrade -y

# A normal user to run the site, with your SSH key
adduser --disabled-password --gecos "" league
mkdir -p /home/league/.ssh
cp ~/.ssh/authorized_keys /home/league/.ssh/
chown -R league:league /home/league/.ssh
chmod 700 /home/league/.ssh && chmod 600 /home/league/.ssh/authorized_keys

# Firewall: only SSH and web. This also keeps port 8000 (plain HTTP) off the internet.
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw --force enable

# 2 GB of swap so the Showdown build doesn't run out of memory
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

If your provider also has its own firewall in the web console, allow the same three ports there (22, 80, 443).

## 4. Install Node, Git, Caddy and sqlite3

Still as root:

```bash
# Node 24 from NodeSource (Ubuntu's own package is too old; the site needs 22.18+)
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs git sqlite3

# Caddy, from its official repository
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy

node -v   # should print v24.x
```

## 5. Get the code and build it

Switch to the `league` user:

```bash
su - league
git clone https://github.com/PhamDanny/draft-league-showdown.git
cd draft-league-showdown
npm run setup
```

Setup takes several minutes. It creates `.env` and new keys in `data/keys/`.

## 6. Fill in .env

Still as `league`, edit `.env` (`nano .env`). Set these **before the first start**:

```
PORT=8000
PUBLIC_URL=https://league.example.com
DISCORD_CLIENT_ID=...            # already filled in
DISCORD_CLIENT_SECRET=...        # from the Discord developer portal, OAuth2 page
ADMIN_DISCORD_IDS=...            # your Discord user id
DEV_LOGIN=0
DISCORD_BOT_TOKEN=...            # optional, see "Discord bot" in README.md
DISCORD_PUBLIC_KEY=...           # optional, same
```

`ADMIN_DISCORD_IDS` matters here: if it's empty, the first person to sign in becomes admin, and on a public server that could be anyone. `DEV_LOGIN` must stay `0`, or anyone can sign in as anyone.

Then `exit` back to root.

## 7. Run the site as a service

As root, create `/etc/systemd/system/draft-league.service`:

```ini
[Unit]
Description=Draft League Showdown
After=network-online.target
Wants=network-online.target

[Service]
User=league
WorkingDirectory=/home/league/draft-league-showdown
ExecStart=/usr/bin/node app/main.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

The service runs `node` directly rather than `npm start`, so a stop or restart reaches the site's shutdown handler, which also stops the Showdown server. `.env` is read by the site itself.

Let the `league` user start, stop and restart the service without a password, so deploys work without root. Run `visudo -f /etc/sudoers.d/draft-league` and add:

```
league ALL=(root) NOPASSWD: /usr/bin/systemctl start draft-league, /usr/bin/systemctl stop draft-league, /usr/bin/systemctl restart draft-league
```

And let it read the site's logs: `usermod -aG systemd-journal league`.

Start it:

```bash
systemctl daemon-reload
systemctl enable --now draft-league
systemctl status draft-league        # should say "active (running)"
journalctl -u draft-league -f        # live logs; Ctrl+C to stop watching
```

## 8. HTTPS with Caddy

Replace `/etc/caddy/Caddyfile` with:

```
league.example.com {
	reverse_proxy 127.0.0.1:8000
}
```

```bash
systemctl reload caddy
```

Caddy gets and renews the certificate on its own, and passes the Showdown websocket through without extra settings. Open `https://league.example.com`. If it doesn't load within a minute or two, check that the DNS record points at `SERVER_IP` (`journalctl -u caddy` shows certificate errors).

## 9. Point Discord at the new address

Do this once the HTTPS address loads.

1. Discord developer portal → your application → **OAuth2** → **Redirects**: add `https://league.example.com/auth/discord/callback`. You can keep the localhost one for local testing.
2. If you use the bot: **General Information** → **Interactions Endpoint URL**: `https://league.example.com/discord/interactions`. Discord checks the URL when you save, so the site must be running.

Sign in with Discord and check that you're admin.

## 10. Backups

The database and the keys are the only things that can't be rebuilt. **If `data/keys/seal.key` is lost, every sealed team and battle log is unreadable for good.**

- **Keys, once:** copy `data/keys/` off the server and keep it somewhere safe (a password manager or an encrypted folder). The keys don't change after setup. From PowerShell on your PC:

  ```powershell
  scp -r league:draft-league-showdown/data/keys .\league-keys
  ```

- **Database, nightly:** as `league`, run `crontab -e` and add:

  ```
  0 4 * * * mkdir -p ~/backups && sqlite3 ~/draft-league-showdown/data/league.db ".backup '$HOME/backups/league-$(date +\%F).db'" && find ~/backups -name 'league-*.db' -mtime +14 -delete
  ```

  This keeps two weeks of daily copies. Don't copy `league.db` with a plain `cp` while the site is running; the database is in WAL mode, and `.backup` is what makes a consistent copy. To pull a copy to your PC now and then: `scp league:backups/league-2026-11-16.db .`

The provider's automatic backups cover the whole server on top of this.

## Moving existing data from your PC (optional)

Skip this to start fresh. If you want your current leagues on the server, copy the database **and** the keys together; the sealed logs in the database can only be opened with the keys that sealed them.

1. Stop the site on your PC, so the database is fully written out.
2. From PowerShell in the repo folder on your PC, stop the server's site and clear its fresh database:

   ```powershell
   ssh league "sudo systemctl stop draft-league && rm -f draft-league-showdown/data/league.db*"
   ```

3. Copy your database and keys over:

   ```powershell
   scp data\league.db league:draft-league-showdown/data/
   scp -r data\keys league:draft-league-showdown/data/
   ```

   If `data\league.db-wal` or `data\league.db-shm` still exist on your PC after stopping, copy them the same way. They hold the latest writes.

4. Start it again: `ssh league "sudo systemctl start draft-league"`.

Any test players you made with `DEV_LOGIN` come along too.

## Deploying changes

From your PC, after changes are pushed to GitHub:

```powershell
ssh league "bash draft-league-showdown/scripts/deploy.sh"
```

`scripts/deploy.sh` pulls the latest `main`, reinstalls packages if `package-lock.json` changed, re-runs `npm run setup` if anything under `showdown/` or the setup script changed, restarts the site and shows its status.

**A restart ends any battles in progress.** Deploy when nobody is mid-game. A deploy that re-runs setup takes several minutes, and the battle screen may misbehave during the rebuild.

### Automatic deploys

`.github/workflows/deploy.yml` runs the deploy script on every push to `main`, except pushes that only touch Markdown, `docs/`, `test/` or `.github/`. It can also be run by hand from the repo's **Actions** tab (**Deploy** → **Run workflow**). To push without deploying, put `[skip ci]` in the commit message.

It logs in with its own SSH key, which can do nothing but run `scripts/deploy.sh`. Setup, once:

1. On your PC, make a key with no passphrase: `ssh-keygen -t ed25519 -N "" -f deploy_key`.
2. Add `deploy_key.pub` to `/home/league/.ssh/authorized_keys` on the server, prefixed so it can only deploy:

   ```
   command="bash /home/league/draft-league-showdown/scripts/deploy.sh",restrict ssh-ed25519 AAAA... 
   ```

3. In the GitHub repo, set:
   - variable `DEPLOY_HOST`: `league.example.com`
   - variable `DEPLOY_KNOWN_HOSTS`: the output of `ssh-keyscan -t ed25519 league.example.com` (check its fingerprint matches the one you accepted on first login)
   - secret `DEPLOY_SSH_KEY`: the contents of `deploy_key` (`gh secret set DEPLOY_SSH_KEY < deploy_key`)
4. Delete `deploy_key` from your PC. To revoke it later, remove its line from `authorized_keys`.

To look at logs from your PC: `ssh league "journalctl -u draft-league -n 200"`.
