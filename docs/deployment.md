# Deploy at https://ypothesi.space

This guide runs one WatchParty process on an Ubuntu 24.04 x86-64 VPS, with Caddy providing public HTTPS. Create real parties at **https://ypothesi.space**: Invite then copies `https://ypothesi.space/?room=ID`. Localhost remains a separate development server with separate rooms; replacing a localhost link's hostname does not copy its room to production.

## 1. Provision the server and DNS

Obtain a VPS with a public IPv4 address, SSH access, and sudo privileges. A starting allocation for a small trial is 2 vCPUs, 4 GB RAM, and 20 GB disk; measure real playback before increasing audience size. CPU transcoding can require substantially more resources, and every viewer consumes server bandwidth. This is a sizing starting point, not a playback guarantee.

At the domain's DNS provider, set the apex `A` record for `ypothesi.space` to the VPS IPv4 address. Remove stale `AAAA` records unless this server also has working public IPv6. If the domain currently points to a tunnel or another site, replacing that record switches its traffic to this server. For the initial setup, use DNS-only mode if your provider offers an HTTP proxy.

Allow inbound TCP 80 and 443 in the provider firewall and on the server. Keep SSH available on your actual SSH port and restrict it to your administrative addresses where possible. Do not open port 3000. If using UFW with default port 22 SSH:

```sh
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

## 2. Install Node and Caddy

Run the following commands in a Bash SSH session on the VPS. Install Git, curl, xz-utils, and CA certificates:

```sh
sudo apt update
sudo apt install -y git curl xz-utils ca-certificates
```

Install a current **Node.js 24 LTS** Linux x64 binary from the [official Node downloads](https://nodejs.org/en/download). Verify its archive using the linked signed SHASUMS instructions, extract it, and install its `bin`, `lib`, `include`, and `share` directories under `/usr/local`. The supplied service expects `/usr/local/bin/node`; a shell-only version manager will not be available to systemd. Confirm:

```sh
/usr/local/bin/node --version
/usr/local/bin/npm --version
```

The Node version must report `v24.x`. Follow Caddy's [official Debian/Ubuntu installation instructions](https://caddyserver.com/docs/install#debian-ubuntu-raspbian) to install its stable package and `caddy` systemd service. Its package maintains Caddy separately from the application.

## 3. Install an application release

First commit and push the intended application changes so the server receives them. On the VPS, create a service account and clone the repository as your SSH deployment user:

```sh
sudo useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin watchparty
git clone https://github.com/andreilance06/watchparty.git "$HOME/watchparty-source"
sudo install -d -o "$USER" -g "$(id -gn)" -m 0755 /opt/watchparty/releases
cd "$HOME/watchparty-source"
git rev-parse HEAD
```

Review that commit, then create a release from its tracked files. Run each release block in the same Bash session so its variables remain available:

```sh
release_id="$(git rev-parse HEAD)-$(date -u +%Y%m%dT%H%M%SZ)"
release_dir="/opt/watchparty/releases/$release_id"
mkdir "$release_dir"
git archive HEAD | tar -x -C "$release_dir"
cd "$release_dir"
npm ci
npm run build
npm test
npm run test:ui
npm prune --omit=dev
chmod -R a+rX "$release_dir"
```

Do not disable npm install scripts: the FFmpeg and ffprobe dependencies download their platform executables. Their download hosts must be reachable. Review test output for failures and skipped media tests before proceeding. The repository tracks `package-lock.json`; use `npm ci` for reproducible releases. Build with development dependencies installed, run the checks, then prune development dependencies. Keep `dist`, the vendored assets, and installed production dependencies together for rollback.

## 4. Configure the services

Install the production environment outside the served project, then select this release:

```sh
sudo install -d -m 0750 /etc/watchparty
sudo install -m 0600 "$release_dir/deploy/watchparty.env.example" /etc/watchparty/watchparty.env
sudo install -m 0644 "$release_dir/deploy/watchparty.service" /etc/systemd/system/watchparty.service
sudo ln -s "$release_dir" /opt/watchparty/current
sudo systemd-analyze verify /etc/systemd/system/watchparty.service
sudo systemctl daemon-reload
sudo systemctl enable --now watchparty
sudo systemctl status watchparty --no-pager
sudo journalctl -u watchparty -n 50 --no-pager
curl --fail http://127.0.0.1:3000/
```

`ln -s` is for first installation only; see the update procedure for switching an existing release. Systemd reads the root-owned environment file before dropping privileges. The service runs as `watchparty`, reads the application without writing to it, and uses its private temporary directory for media processing. Startup logs must show usable FFmpeg and ffprobe selections. There is no GPU requirement; software transcoding is CPU limited.

Generate Caddy's system configuration from the supplied public template, replacing the environment placeholder explicitly so it also works under Caddy's systemd service:

```sh
sed 's/{$WATCHPARTY_DOMAIN}/ypothesi.space/g' "$release_dir/deploy/Caddyfile.public" | sudo tee /etc/caddy/Caddyfile > /dev/null
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
```

Caddy preserves the public Host, forwards HTTPS protocol information and WebSocket upgrades, and proxies to loopback port 3000. It [obtains and renews certificates automatically](https://caddyserver.com/docs/automatic-https) when public DNS and TCP ports 80/443 reach this server. Keep its certificate data under `/var/lib/caddy` persistent. The supplied public template disables the legacy default-room media and control endpoints: use **Create room**, then invite guests to that room.

## 5. Verify the public party

- Open `http://ypothesi.space` and confirm it redirects to trusted HTTPS. In browser DevTools, `isSecureContext` must be `true`.
- Create a private room. Invite must copy `https://ypothesi.space/?room=ID`, preserving that room's ID. Open it on another network/device; for a protected room, check both an incorrect and correct password.
- Confirm identity and room admission succeed, cookies are HttpOnly and Secure, and the room's control WebSocket upgrades with status 101 using `wss`. Selecting a video also connects the file source WebSocket.
- Send chat and reactions from both browsers. Test visible playback, audible sound, an uncached seek, captions, and compatibility conversion with a file requiring it. Original media range requests should return 206.
- Confirm an external connection to the VPS's port 3000 fails. Confirm a foreign Origin is rejected, for example:

  ```sh
  curl -i -X POST https://ypothesi.space/api/viewer-identity -H 'Origin: https://unrelated.example'
  ```

  Expect HTTP 403. Requests from the actual public page must succeed.
- Restart `watchparty` and verify the service recovers and new rooms work. A restart ends existing rooms: rooms, identities, and chat are in memory. Reboot once during setup to verify both services start automatically.
- Run `npm.cmd run build`, then `npm.cmd start` locally with production environment settings unset and confirm local development still works independently. Production origin settings intentionally reject localhost requests against the production process.

The browser supplying the selected video must stay open and connected even when the server is hosted remotely. Run exactly one Node process; multiple replicas do not share room state.

## Updates and rollback

Schedule updates between parties because restarting clears all active rooms. In the source checkout, fetch and check out the reviewed commit, then repeat the release creation and installation block from step 3. Do not edit the running release. Retain the previous directory, including its installed dependencies.

After tests pass, switch the symlink atomically on this filesystem and restart:

```sh
previous_release="$(readlink -f /opt/watchparty/current)"
printf 'Rollback release: %s\n' "$previous_release"
sudo ln -s "$release_dir" /opt/watchparty/current.next
sudo mv -Tf /opt/watchparty/current.next /opt/watchparty/current
sudo systemctl restart watchparty
sudo systemctl status watchparty --no-pager
curl --fail https://ypothesi.space/
```

Record the printed rollback path. If checks fail, select the previous installed release:

```sh
sudo ln -s "$previous_release" /opt/watchparty/current.rollback
sudo mv -Tf /opt/watchparty/current.rollback /opt/watchparty/current
sudo systemctl restart watchparty
```

If an update changes the unit or Caddy template, review and reinstall those files, validate them, and reload the relevant service. Back up the prior unit, Caddyfile, and environment settings before changing them; restore those too when rolling back such an update. Keep `/etc/watchparty/watchparty.env` on the server rather than overwriting it on routine releases.

## Logs and troubleshooting

```sh
sudo journalctl -u watchparty -u caddy -n 100 --no-pager
sudo journalctl -u watchparty -f
sudo ss -ltnp
```

Monitor process restarts, CPU, memory, free disk space, and outbound bandwidth during a real party. Keep the previous release until the new version passes playback checks.

| Symptom | Check |
| --- | --- |
| Certificate failure or unreachable site | Public A/AAAA records, provider firewall, UFW, Caddy logs, and listeners on 80/443. |
| HTTP 502 | WatchParty startup logs, executable permissions, `/usr/local/bin/node`, and loopback port 3000. |
| Identity or WebSocket gets 403 | Exact `PUBLIC_ORIGIN=https://ypothesi.space`, `TRUST_PROXY=loopback`, preserved Host, and Caddy on the same machine. |
| Invite contains localhost | The party was created on the development server. Open the public site and create a new party there. |
| Default room cannot play | The public template blocks legacy default-room connections. Create a private room. |
| FFmpeg download or startup failure | Dependency download connectivity, executable permissions, and FFmpeg/ffprobe paths in the journal. |
| Slow conversion or buffering | Host browser upload, server outbound bandwidth, CPU load, and encoder budget; test a native-compatible MP4 and lower quality. |

Do not configure shared caching for identity, admission, session, or authenticated media responses. For detailed protocol and playback checks, see [HTTPS requirements](https.md).
