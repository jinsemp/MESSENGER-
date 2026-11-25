# Stranger Chat MVP

A private, browser-based messaging MVP. Railway is used for account authentication, email lookup, temporary online presence, and WebRTC signaling. Chat messages travel over a WebRTC DataChannel and are saved only in each participant's browser using IndexedDB.

## Data boundaries

**Stored in PostgreSQL:** account UUID, email address, bcrypt password hash, account creation timestamp.

**Kept in Railway process memory only:** WebSocket presence connections and transient signaling delivery. This state disappears on restart.

**Not stored by the server:** message bodies, chat history, attachments, or message backups. The signaling server accepts only `offer`, `answer`, `ice`, and `hangup` events. Chat messages are sent over the peer-to-peer DataChannel, not the WebSocket.

**Stored in the browser:** chat messages in IndexedDB. They survive refresh and sign-out on that browser profile, but not necessarily clearing site data or using another device/browser.

## Run locally

1. Install Node.js 20+ and PostgreSQL 14+.
2. Create a PostgreSQL database.
3. Copy `.env.example` to `.env` and set `DATABASE_URL`, `JWT_SECRET`, and `COOKIE_SECURE=false` for local HTTP development.
4. Install and start:

   ```bash
   npm install
   npm start
   ```
5. Open `http://localhost:3000`.

The app creates the `users` table and email index on startup. PostgreSQL must have `gen_random_uuid()` available (standard on modern PostgreSQL).

## Deploy to Railway

1. Create a Railway project.
2. Add a PostgreSQL service.
3. Add this project as a Node service (deploy this directory or connect its GitHub repository).
4. Set these variables on the app service:
   - `DATABASE_URL`: reference the PostgreSQL service's `DATABASE_URL` variable.
   - `JWT_SECRET`: a long random secret (at least 32 characters).
   - `COOKIE_SECURE=true`
   - `NODE_ENV=production`
5. Deploy. Railway supplies `PORT` automatically.
6. Add a custom domain and use HTTPS.

## TURN configuration

STUN is configured by default. Some mobile networks, office Wi-Fi, and carrier-grade NATs block direct peer-to-peer connectivity. For reliable connections, configure a TURN provider and set:

- `TURN_URLS` (comma-separated `turn:` / `turns:` URLs)
- `TURN_USERNAME`
- `TURN_CREDENTIAL`

TURN relays encrypted WebRTC transport when required. It does not store message history. For production, use short-lived TURN credentials rather than a permanent shared credential.

## Important MVP limitations

- No email verification or password-reset flow yet.
- Email lookup is exact-match and currently reveals whether an account exists. Add email verification, anti-enumeration controls, and abuse protection before public launch.
- Presence is in-memory and designed for a single app instance. Multi-instance deployments need a shared presence adapter (for example Redis), still without message storage.
- Chat history is local to one browser profile. Clearing browser data or changing devices loses access to it. There is no cloud sync.
- WebRTC DataChannel is encrypted in transit by DTLS. This MVP does not implement a separate audited end-to-end identity/key-verification protocol; users should verify the peer's email out-of-band for sensitive conversations.
- Use a persistent PostgreSQL service with backups for account data. Backups contain account records, not messages.
- Add CSRF protection, email verification, password reset, stronger account recovery, monitoring, and security review before production use.

## Architecture

```text
Browser A --HTTPS/WSS--> Railway API
  |                       |-- PostgreSQL: accounts only
  |                       |-- WebSocket: presence + WebRTC signaling only
  |                       `-- no message endpoints / no message tables
  |
  `========== WebRTC DataChannel ========== Browser B
       chat text sent peer-to-peer; local IndexedDB on each side
```
