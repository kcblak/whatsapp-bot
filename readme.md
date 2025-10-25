# WhatsApp Bot + Admin Dashboard (Baileys)

A Node.js WhatsApp bot powered by Baileys with a secure, session-based admin dashboard and modern web UI. It lets you pair via QR, monitor status, manage bot responses, and send messages through a protected API.

## Features
- WhatsApp Web client via Baileys (QR pairing)
- Modern UI pages: `/login`, `/dashboard`, `/qr`, `/status`
- Admin authentication with sessions (bcrypt) and first-time admin setup
- Secure maintenance endpoints protected by `RESET_TOKEN`
- Bot command system with sensible defaults (`!help`, `!ping`, `!echo`, `!time`, `!info`)
- REST APIs to send messages and manage bot responses
- Health and status endpoints
- Optional Postgres backup/restore of WhatsApp auth data

## Quick Start
1. Prerequisites: Node.js 18+
2. Install dependencies: `npm install`
3. Configure env vars (copy `.env.example` → `.env`):
   - `OWNER_NUMBER` – your WhatsApp number (no `+`)
   - `PORT` – default `3000`
   - `SESSION_SECRET` – any strong string
   - `RESET_TOKEN` – required for protected maintenance routes
   - Optional Postgres: `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGSSL`
4. Start the app: `npm start`
5. Visit `http://localhost:3000/login` to create the admin account (first run) and sign in.
6. Open `http://localhost:3000/qr` from the dashboard to scan and connect WhatsApp.

## UI Pages
- `/login` – Admin login and initial setup
- `/dashboard` – Admin-only controls (includes Reset QR)
- `/qr` – Shows QR for pairing (styled)
- `/status` – Admin-only status (auto-refresh, HTML or JSON based on `Accept`)

## API & Routes
- `POST /auth/login` – Login or complete first-time admin setup
- `POST /auth/logout` – Destroy session
- `GET /auth/setup-status` – Check if admin setup is required
- `GET /qr` – HTML page with QR code to pair
- `GET /status` – Admin-only; health, uptime, memory, connection state
- `GET /health` – Basic health
- `POST /send-message` – Admin-only; JSON `{ number, message }`
- `GET /bot-responses` – Admin-only; returns effective responses
- `POST /bot-responses` – Admin-only; updates responses from JSON `{ responses: { cmd: reply } }`
- `ALL /reset-session` – Protected by `RESET_TOKEN`; forces new QR by clearing WhatsApp auth
- `ALL /reset-setup` – Protected by `RESET_TOKEN`; clears config and flags first-run setup
- `GET /debug` – Protected by `RESET_TOKEN` via `?token=` or header `x-reset-token`
- `GET /pairing-code` – Generates pairing code (when supported)

## Default Bot Commands
- `!help` – List commands
- `!ping` – Connectivity check
- `!echo <message>` – Echo back
- `!time` – Current time
- `!info` – Bot info

## Security Notes
- Admin pages and admin APIs require a valid session
- Set a strong `SESSION_SECRET` and `RESET_TOKEN`
- Keep `.env` and `admin-credentials.json` private

## Optional Postgres
If configured, the app attempts to backup/restore WhatsApp auth data to Postgres. If not available, it runs normally using local files.

## Troubleshooting
- No QR shown: ensure you’re not already connected; use `/reset-session?token=YOUR_SECRET`
- Forbidden on admin pages: log in at `/login`
- Debug/Reset forbidden: include `?token=RESET_TOKEN` or header `x-reset-token: RESET_TOKEN`

## License
MIT – use and modify as needed.