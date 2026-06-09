# Fireblocks → Dynamic WaaS — Key Migration Demo

## 1. What This Is

A proof of concept demonstrating **private-key migration from Fireblocks Embedded Wallets (NCW) to Dynamic WaaS**. It uses **Fireblocks Full Key Takeover** to reconstruct the wallet's private key client-side (in the browser, via MPC), then **Dynamic's `importPrivateKey`** to import it into a Dynamic WaaS wallet. The **same on-chain address is preserved** — no asset transfer required.

> ⚠️ Proof of concept — not production-hardened. The private key is reconstructed in browser memory during migration. See [Scope / Limitations](#8-scope--limitations).

## 2. Architecture

```
┌─────────────────┐   JWT + REST/Socket.IO    ┌──────────────────┐   Fireblocks SDK   ┌────────────┐
│    frontend     │ ────────────────────────► │     backend      │ ─────────────────► │ Fireblocks │
│ React+Vite+TS   │ ◄──────────────────────── │ Express+TS+      │ ◄───webhooks────── │  platform  │
│ (browser, MPC)  │   webhooks + tx updates   │ TypeORM + MySQL  │                    └────────────┘
└────────┬────────┘                           └──────────────────┘
         │ importPrivateKey
         │ (private key NEVER leaves the browser / never hits the backend)
         ▼
   ┌──────────────┐
   │ Dynamic WaaS │
   └──────────────┘
```

The backend is an **audit witness only** — it records migration intent and outcome (wallet/asset IDs, addresses, match result) and **rejects any request containing key material**. See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for the full build spec.

## 3. Prerequisites

| System | What you need |
|--------|---------------|
| **Fireblocks** | A workspace with **NCW and Full Key Takeover enabled**, plus two NCW API users (Signer + Admin) |
| **Dynamic** | A dev environment with **WaaS enabled** and **`automaticEmbeddedWalletCreation` disabled** |
| **Firebase** | A project with **Google sign-in enabled** (issues the JWT both halves trust) |
| **MySQL** | A database for backend persistence (Docker is fine) |

- **Fireblocks workspace must have NCW and Full Key Takeover enabled** (contact your Fireblocks representative — Full Key Takeover is gated).
- **Dynamic dashboard: enable WaaS and disable `automaticEmbeddedWalletCreation`** — otherwise Dynamic auto-creates a different wallet and `importPrivateKey` won't be the source of the wallet you verify.

## 4. Credentials

### Backend credentials (secrets) — `backend/.env`
| Variable | What it is |
|----------|-----------|
| `FIREBLOCKS_API_SECRET` | API user **private key PEM** (single line, newlines escaped as `\n`) — the crown-jewel secret |
| `FIREBLOCKS_API_KEY_NCW_SIGNER` | UUID of the **NCW Signer** API user |
| `FIREBLOCKS_API_KEY_NCW_ADMIN` | UUID of the **NCW Admin** API user |
| `FIREBLOCKS_WEBHOOK_PUBLIC_KEY` | Fireblocks webhook **public key** PEM (differs sandbox vs prod) |
| `FIREBLOCKS_API_BASE_URL` | `https://sandbox-api.fireblocks.io/` or `https://api.fireblocks.io/` |
| `JWKS_URI` / `ISSUER` / `AUDIENCE` | Firebase JWT verification config (see [§5](#5-the-firebase-wiring-gotcha)) |
| `DB_HOST` / `DB_PORT` / `DB_USERNAME` / `DB_PASSWORD` / `DB_NAME` | MySQL connection |

### Frontend config (NOT secrets) — `frontend/.env`
All `VITE_`-prefixed vars are compiled into the browser bundle and are **publicly visible**.

| Variable | What it is |
|----------|-----------|
| `VITE_DYNAMIC_ENVIRONMENT_ID` | Dynamic environment ID (Dashboard → Developers) |
| `VITE_BACKEND_BASE_URL` | `http://localhost:3000` |
| `VITE_NCW_SDK_ENV` | `sandbox` or `production` (must match the backend's Fireblocks workspace) |

- **Firebase client config** is currently **hardcoded in `frontend/src/auth/FirebaseAuthManager.ts`**. Replace it with your own Firebase project's web config. (Firebase web config is public by design — not a secret.)

## 5. The Firebase Wiring Gotcha

The Firebase **project ID** used by the frontend's `FirebaseAuthManager.ts` **MUST match** the backend's `AUDIENCE` and `ISSUER` env vars:

```
ISSUER   = https://securetoken.google.com/<firebase-project-id>
AUDIENCE = <firebase-project-id>
```

If they don't match, **every backend request returns 401** (you'll see a tight poll loop of 401s). Set them from one Firebase project.

## 6. Setup

```bash
# 1. Clone
git clone https://github.com/muhammmad-al/fireblocks-dynamic-migration-demo.git
cd fireblocks-dynamic-migration-demo

# 2. Start MySQL
docker run -d --name ncw-mysql \
  -e MYSQL_ROOT_PASSWORD=yourpassword \
  -e MYSQL_DATABASE=ncw \
  -p 3306:3306 mysql:8

# 3. Backend
cd backend
cp .env.example .env        # then fill in your credentials
npm install
npm run dev                 # http://localhost:3000

# 4. Frontend (new terminal)
cd frontend
cp .env.example .env        # then fill in your config
npm install
npm run dev                 # http://localhost:5173
```

Then open **http://localhost:5173**.

> Requires **Node 20** (both projects ship an `.nvmrc`; run `nvm use`). `jose` needs the global `fetch`/`Headers` from Node 18+.

## 7. Running the Migration

- **Log in** with Google (Firebase Auth).
- **Generate MPC keys** (ECDSA SECP256K1).
- **Enable the `ETH_TEST5` asset** in the Assets card and note the Fireblocks address.
- In the **"Key Migration"** card: click **Export Key** → **Import to Dynamic** (triggers Dynamic OTP login) → **Verify Ownership**.
- **Confirm the Source (Fireblocks) and Target (Dynamic) addresses match.**

## 8. Scope / Limitations

- **Single-chain** (Sepolia `ETH_TEST5`), **ECDSA / EVM only**.
- **Single device.**
- **Not production-hardened**: no iframe isolation, no multi-chain, no TAP, no gas sponsorship.
- **Iframe security isolation** (to protect the in-browser key from malicious JS) is being developed separately by the Dynamic team.
- **EdDSA / Solana** migration requires a separate `takeover()` call — same pattern, different BIP44 coin type.

## 9. Links

- Fireblocks Full Key Takeover: https://ncw-developers.fireblocks.com/docs/full-key-takeover
- Fireblocks NCW JS SDK: https://www.npmjs.com/package/@fireblocks/ncw-js-sdk
- Fireblocks NCW Setup Guide: https://ncw-developers.fireblocks.com/v4.0/docs/setup-5
- Dynamic `importPrivateKey`: https://docs.dynamic.xyz/wallets/embedded-wallets/dynamic-waas
