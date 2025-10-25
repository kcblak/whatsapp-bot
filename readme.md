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

## Deployment (Render)
- Create Web Service → connect repo.
- Runtime: `Node`.
- Build: `npm install`.
- Start: `npm start`.
- Environment:
  - `OWNER_NUMBER`, `SESSION_SECRET`, `RESET_TOKEN`, optional `PORT`.
  - Optional Postgres: `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGSSL`.
- After deploy: visit `/login` (create admin) → `/qr` (scan) → `/dashboard`.
- Notes:
  - Free tier lacks persistent disk; re-scan QR after restarts or use Postgres backup/restore.
  - Health endpoints: `/health`, `/status`.

## Deployment (Docker)
- Example `Dockerfile`:
  ```Dockerfile
  FROM node:20-alpine
  WORKDIR /app
  COPY package*.json ./
  RUN npm ci --only=production
  COPY . .
  ENV PORT=3000
  EXPOSE 3000
  CMD ["node", "index.js"]
  ```
- Build and run:
  - `docker build -t whatsapp-bot .`
  - `docker run -p 3000:3000 --env-file .env -v $(pwd)/auth_info_baileys:/app/auth_info_baileys whatsapp-bot`
- Provide `.env` (SESSION_SECRET, RESET_TOKEN, OWNER_NUMBER, optional Postgres).
- First-run: open `http://localhost:3000/login` → set admin → `/qr` to pair.

## Deployment (Namecheap cPanel Node.js)
- In cPanel → "Setup Node.js App" (Passenger):
  - Application Root: project folder.
  - Startup File: `index.js`.
  - Node version: 18+.
- Install deps: open cPanel Terminal → `npm install` in app root.
- Environment variables (in the app manager):
  - `OWNER_NUMBER`, `SESSION_SECRET`, `RESET_TOKEN`, optional `PORT`.
  - Optional Postgres: `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGSSL`.
- Restart app from cPanel.
- Visit `/login` to create admin, then `/qr` to pair, then `/dashboard`.
- Tips:
  - Ensure write permissions for `.env` and `auth_info_baileys/`.
  - Many managed DBs require `PGSSL=require`.
  - Use `/health` and `/status` for checks.

## License
MIT – use and modify as needed.