# Fireblocks NCW demo backend + migration audit endpoints

Express/TypeScript backend for the Fireblocks Non-Custodial Wallet (NCW) demo,
extended with **migration audit endpoints** for the NCW → [Dynamic](https://www.dynamic.xyz/)
WaaS key-migration POC. It is the server half of [`ncw-web-demo`](../ncw-web-demo).

> ⚠️ **Proof of concept — not production-hardened.** Migration audit records are
> kept in memory, and a demo-only flag can bypass webhook signature verification
> (see below). Review the Security notes before adapting for production.

## What it does

- Brokers between the browser-side NCW SDK and the Fireblocks platform: wallet /
  account creation, asset & balance queries, transaction submission, and an
  RPC relay (Socket.IO) for the client-side MPC signing.
- Receives Fireblocks **webhooks** (V1 + V2) and pushes transaction status updates
  to clients via a long-poll backed by TypeORM entity subscribers.
- Records **migration intent and outcome** for the key-migration flow — without
  ever touching key material.

## Prerequisites

- **Node 20**
- **MySQL** (a SQLite test DB is used under `NODE_ENV=test`)
- A **Fireblocks workspace** with NCW enabled, plus two API users:
  an **NCW Signer** key and an **NCW Admin** key
- JWT issuer (OpenID Connect / JWKS) matching the tokens the frontend sends

## Environment variables

Copy `.env.example` to `.env` and fill in. `.env` is gitignored — keep real
secrets out of source control (use a secrets manager outside local dev). PEM
values must have newlines escaped as `\n`.

| Variable | Purpose |
|----------|---------|
| `PORT` | API listen port (e.g. `3000`) |
| `WEBHOOK_SKIP_VERIFY` | **Demo only.** `true` bypasses webhook signature checks. Leave unset/`false` in prod |
| `ORIGIN_WEB_SDK` | (optional) CORS allow-list, comma-separated. Defaults to `localhost:5173` + GitHub Pages |
| `CMC_PRO_API_KEY` | CoinMarketCap key for USD quotes |
| `ISSUER_BASE_URL` **or** `ISSUER` + `JWKS_URI` | JWT issuer (OIDC discovery, or explicit issuer + JWKS) |
| `AUDIENCE` | Expected JWT `aud` claim |
| `FIREBLOCKS_API_SECRET` | API user private key PEM |
| `FIREBLOCKS_API_KEY_NCW_SIGNER` | API key (UUID) for the signer role |
| `FIREBLOCKS_API_KEY_NCW_ADMIN` | API key (UUID) for the admin role |
| `FIREBLOCKS_API_BASE_URL` | `https://sandbox-api.fireblocks.io/` or `https://api.fireblocks.io/` |
| `FIREBLOCKS_WEBHOOK_PUBLIC_KEY` | Fireblocks webhook public key PEM (sandbox ≠ prod) |
| `DB_HOST` / `DB_PORT` / `DB_USERNAME` / `DB_PASSWORD` / `DB_NAME` | MySQL connection |

## Run

```bash
npm install
npm run dev          # nodemon + ts-node, hot reload

# production-style:
npm run build        # tsc -> dist/
npm run migrate      # run TypeORM migrations
npm run serve        # node dist/server.js
```

> The composite `npm start` and `migrate` scripts shell out to `yarn` internally.
> Use the explicit `build` / `migrate` / `serve` steps above if you don't have
> yarn installed.

## Migration endpoints

Both require a valid JWT, and both **refuse any request body containing a
`privateKey` or `key` field** (`src/controllers/migration.controller.ts`).

### `POST /api/migration/start`
Records migration intent.
```jsonc
// request
{ "walletId": "<ncw-wallet-id>", "assetId": "ETH_TEST5" }
// response
{ "migrationId": "…", "sub": "…", "walletId": "…", "assetId": "…", "startedAt": "…" }
```

### `POST /api/migration/complete`
Records the outcome and whether the source/destination addresses match.
```jsonc
// request
{ "migrationId": "…", "fireblocksAddress": "0x…", "dynamicAddress": "0x…" }
// response
{ "migrationId": "…", "completedAt": "…", "fireblocksAddress": "0x…",
  "dynamicAddress": "0x…", "addressesMatch": true }
```

> Records are stored **in memory** (demo only) and lost on restart. Production
> would persist them to a durable, tamper-evident audit store.

## Architecture

- **Two Fireblocks SDK instances** sharing one API secret but different API keys:
  `signer` (transaction signing, RPC, takeover, backup) and `admin` (wallet /
  account / asset management) — privilege separation by key.
- **Auth:** stateless JWT verified against a remote JWKS (`jose`); ownership
  middleware resolves `JWT.sub → User → Device/Wallet` before each handler.
- **Real-time:** Socket.IO `rpc` channel relays MPC messages to
  `NCW.invokeWalletRpc`. Transaction updates flow webhook → DB write → TypeORM
  subscriber → client long-poll (single-instance; production needs a shared bus).
- **Data:** TypeORM + MySQL. Entities: `User`, `Device`, `Wallet`, `Transaction`,
  `Message`, `Passphrase`.

### Module layout

- `src/routes` — Express route mapping
- `src/controllers` — request handlers
- `src/services` — business logic & Fireblocks calls
- `src/middleware` — `jwt`, `webhook` (signature verify), `device`/`wallet` ownership, error handler
- `src/model` — TypeORM entities · `src/migrations` — schema migrations

## Security

- `WEBHOOK_SKIP_VERIFY=true` disables webhook signature verification and must
  never be set outside local demos — it lets any caller POST forged events.
- The backend never receives private-key material; the migration controller
  rejects `privateKey`/`key` fields outright.
- Use dedicated, least-privilege Fireblocks API users for the demo; never reuse
  production signing keys.
