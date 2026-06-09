# Fireblocks NCW → Dynamic WaaS Migration POC — Build Spec

A from-scratch reconstruction blueprint for this project — enough to rebuild the
system without reading the original source. The two halves (`frontend/` and
`backend/`) are forks of Fireblocks' official NCW demo with a key-migration
feature added, and connect at runtime over HTTP / WebSocket.

```
┌─────────────────┐   JWT + REST/Socket.IO    ┌──────────────────┐   Fireblocks SDK   ┌────────────┐
│    frontend     │ ────────────────────────► │     backend      │ ─────────────────► │ Fireblocks │
│ React+Vite+TS   │ ◄──────────────────────── │ Express+TS+      │ ◄───webhooks────── │  platform  │
│ (browser, MPC)  │   webhooks + tx updates   │ TypeORM + MySQL  │                    └────────────┘
└────────┬────────┘                           └──────────────────┘
         │ importPrivateKey (key never hits the backend)
         ▼
   ┌──────────────┐
   │ Dynamic WaaS │
   └──────────────┘
```

---

## REPO HALF 1: `backend/`

### Stack
- Node 20, Express 4, TypeScript (ts-node + nodemon dev; `tsc` → `dist/` prod)
- TypeORM 0.3 + MySQL (SQLite under `NODE_ENV=test`)
- `fireblocks-sdk` v5, `jose` (JWT/JWKS), `openid-client`, Socket.IO, `agentkeepalive`, `coinmarketcap-js`

### Bootstrapping (`src/server.ts`)
1. `dotenv.config()`.
2. Build a shared `HttpsAgent` keepalive (maxSockets 100, 60s timeout).
3. Construct **two `FireblocksSDK` instances**, same API secret, different API keys:
   - `signer` (`FIREBLOCKS_API_KEY_NCW_SIGNER`) — signing, RPC, takeover, backup, fee estimate
   - `admin` (`FIREBLOCKS_API_KEY_NCW_ADMIN`) — wallet/account/asset/NFT management
4. Resolve JWT auth: if `ISSUER_BASE_URL` set → OIDC `Issuer.discover` → `createRemoteJWKSet`; else use `ISSUER` + `JWKS_URI`; verify `audience`. Throws if neither.
5. `AppDataSource.initialize()` → `createApp(...)` → `app.listen(PORT)`.
6. Attach Socket.IO to the server with CORS. Start an hourly `staleMessageCleanup` interval.
7. CORS origin from `ORIGIN_WEB_SDK` (comma-split) or default `["http://localhost:5173","https://fireblocks.github.io"]`.

### App wiring (`src/app.ts`)
Middleware order: morgan → CORS → `body-parser` JSON (50MB) → `checkJwt()` on protected routes → routes → `errorHandler` (last).

Routes mounted:
```
GET  /                  health → "OK"
POST /api/login         UserController.login (JWT)
/api/passphrase         passphrase routes (JWT)
/api/devices            device routes (JWT) — nests transactions/accounts/assets/nfts/messages/web3
/api/wallets            wallet routes (JWT)
/api/migration          migration routes (JWT)
/api/webhook            webhook route (NO JWT; RSA signature verified instead)
```

Socket.IO: authenticate the handshake JWT (`socket.handshake.auth.token`) with the same options as HTTP; abort on failure. Handle `socket.on("rpc", (deviceId, message, cb))` → `deviceService.rpc(walletId, deviceId, message)` → `signer.NCW.invokeWalletRpc(...)` → `cb({ response })` or `cb({ error })`.

### Data model (TypeORM entities, `src/model/`)
```
User(id PK, sub UNIQUE)               1─M Device, 1─M Passphrase
Wallet(id PK string/uuid)             1─M Device, M─M Transaction
Device(id PK uuid, userId, walletId)  M─1 User, M─1 Wallet, 1─M Message  [idx createdAt/updatedAt]
Transaction(id PK, status, ...)       M─M Wallet  [idx status, createdAt, lastUpdated]
Message(id PK auto, deviceId,         M─1 Device  [idx deviceId, createdAt]
        physicalDeviceId, message, lastSeen)
Passphrase(id PK uuid, userId, location)  M─1 User
```
`synchronize:false` — migrations only (`src/migrations/*`, compiled to `dist/migrations/*.js`). Two subscribers: `MessageSubscriber`, `TransactionSubscriber`.

### Middleware (`src/middleware/`)
- **`jwt.ts`** — extract bearer from `Authorization` header or `?token`; verify via `jose` against remote JWKS; attach `req.auth = { token, payload }`.
- **`webhook.ts`** — if `WEBHOOK_SKIP_VERIFY==="true"` skip (demo only, logs a warning + security comment); else verify `fireblocks-signature` header with `crypto.createVerify("RSA-SHA512")` against the Fireblocks public key.
- **`device.ts` / `wallet.ts`** — load entity, assert ownership via `JWT.sub → User`, attach `req.device` / `req.wallet`.
- **`errorHandler.ts`** — **must log only safe fields.** For Axios errors log `METHOD url -> status message` — NEVER the whole error object (it embeds `X-API-Key` + bearer token in the request headers). Return `{ error, message, code }` with the upstream status.

### Routes → controllers → services (request flow)
`client → route → ownership middleware → controller (HTTP I/O + validation) → service (Fireblocks calls / DB) → response`

Key endpoint groups:
- **device**: `POST :id/assign` (admin.NCW.createWallet + createWalletAccount), `POST :id/join`, `GET /`, `POST :id/rpc`
- **transaction**: `GET/POST :deviceId/transactions/`, `GET :txId`, `POST :txId/cancel` — uses `signer.createTransaction(args, { ncw: { walletId } })`, `estimateFeeForTransaction`, `cancelTransactionById`. Supports `?poll=true` long-poll (see real-time below).
- **asset**: list/summary/`supported_assets` (24h cache), `POST :assetId` → `signer.NCW.activateWalletAsset`, balance/address via `admin.NCW.*`
- **wallet**: `GET /`, `GET :walletId/backup/latest` → `signer.NCW.getLatestBackup` (returns metadata only)
- **web3 / nft / message / passphrase**: standard CRUD over the NCW SDK
- **webhook**: dispatch by event type (V1 + V2), see below

### Real-time / event loop
1. Client `POST` tx → `signer.createTransaction`.
2. Fireblocks → webhook `TRANSACTION_CREATED` / `TRANSACTION_STATUS_UPDATED` → `/api/webhook`.
3. Handler writes/updates `Transaction` → **`TransactionSubscriber`** (`afterInsert`/`afterUpdate`) emits on a Node `EventEmitter`: `wallet:{walletId}` and `wallet:{walletId}:{status}`.
4. Client long-poll `GET .../transactions?poll=true` parks up to ~10s on that event, returns immediately when it fires.

> ⚠️ In-process EventEmitter = single-instance only; production needs Redis / a shared bus.

Webhook events handled: `NCW_DEVICE_MESSAGE` / `embedded_wallet.device.message` → store Message; `TRANSACTION_CREATED` → create + link + fetch USD rate; `TRANSACTION_STATUS_UPDATED` → update status; NCW lifecycle events → logged; others → 200 ack.

### ⭐ Migration feature (the differentiator)
**`src/services/migration.service.ts`** — `MigrationService`, in-memory `Map<migrationId, StartRecord>` (active) + `CompleteRecord[]` (completed). *Comment notes: demo-only storage; production needs a durable, tamper-evident store.* Never accepts/returns key material.
- `start(sub, walletId, assetId)` → `{ migrationId: randomUUID(), sub, walletId, assetId, startedAt }`
- `complete(sub, migrationId, fireblocksAddress, dynamicAddress)` → validates ownership (`sub` match), computes `addressesMatch` (case-insensitive compare), stores `CompleteRecord`, deletes the active record.

**`src/controllers/migration.controller.ts`** — `POST /api/migration/start` (`{walletId, assetId}`) and `POST /api/migration/complete` (`{migrationId, fireblocksAddress, dynamicAddress}`). **Must reject any body containing `privateKey` or `key`** with HTTP 400. Sets `Cache-Control: no-store`.

### Env (`backend/.env.example`)
`PORT`, `WEBHOOK_SKIP_VERIFY` (demo only), `ORIGIN_WEB_SDK`, `CMC_PRO_API_KEY`, `ISSUER_BASE_URL` **or** `ISSUER` + `JWKS_URI`, `AUDIENCE`, `FIREBLOCKS_API_SECRET` (PEM, escaped `\n`), `FIREBLOCKS_API_KEY_NCW_SIGNER`, `FIREBLOCKS_API_KEY_NCW_ADMIN`, `FIREBLOCKS_API_BASE_URL`, `FIREBLOCKS_WEBHOOK_PUBLIC_KEY` (PEM), `DB_HOST/PORT/USERNAME/PASSWORD/NAME`. `.env` gitignored; placeholders must not contain literal `BEGIN ... KEY` PEM markers (trips secret scanners).

---

## REPO HALF 2: `frontend/`

### Stack
- React 18 + Vite 4 + TypeScript, **Zustand** state, daisyUI / Tailwind
- `@fireblocks/ncw-js-sdk` (browser MPC), `@dynamic-labs/sdk-react-core` + `@dynamic-labs/ethereum` + waas, Firebase auth, Socket.IO client, axios
- Dev server: `vite --host` on `:5173` (matches backend CORS). `.nvmrc` = 20.

### Bootstrap & providers
`src/index.tsx` → wrap `<App/>` in `DynamicContextProvider` configured from `src/dynamic/config.ts`:
```ts
dynamicSettings = {
  environmentId: import.meta.env.VITE_DYNAMIC_ENVIRONMENT_ID,
  walletConnectors: [EthereumWalletConnectors],
  walletsFilter: (wallets) => wallets.filter(w => w.walletConnector.isEmbeddedWallet),
}
```
`App.tsx` → NavBar + (`loggedUser ? <AppContent/> : <Login/>`), centered max-width flex column.

`AppContent.tsx` gates progressively: login → `ModeSelector` → `AssignDevice` → `FireblocksNCWInitializer` → (when `fireblocksNCWStatus === "sdk_available"`) `FireblocksNCWExampleActions`.

### State (`src/AppStore.ts`, Zustand single store)
Holds: `loggedUser/userId`, `walletId/deviceId`, `fireblocksNCWStatus`, `keysStatus`, `accounts` (nested `accounts[accountId][assetId] = {asset, address, balance}`), `txs`, `web3Connections`.
NCW init (`initFireblocksNCW`): build SDK via `FireblocksNCWFactory` with a **messagesHandler** that pipes RPC over `apiService.sendMessage()` (Socket.IO → backend → Fireblocks), an **eventsHandler** (key/backup/recovery/join status), `PasswordEncryptedLocalStorage` secure storage, IndexedDB logger. Migration-relevant methods: `takeover()` → `IFullKey[]`, `deriveAssetKey(xprv, coinType, account, change, index)`, `startKeyMigration`, `completeKeyMigration`, `addAsset`, `refreshBalance`, `createTransaction`, `signTransaction`.

### API client (`src/services/ApiService.ts`)
- REST `_get/_post/_delete` attach `Authorization: Bearer <Firebase ID token>`.
- Socket.IO: token in handshake auth; `sendMessage` uses `emitWithAck` for RPC; tx subscription for live updates.
- `startKeyMigration` / `completeKeyMigration` → the backend `/api/migration/*` endpoints.
- Base URL from `VITE_BACKEND_BASE_URL`.

### Auth (`src/auth/FirebaseAuthManager.ts`)
Firebase (Google/Apple OAuth). `getAccessToken()` → Firebase ID token (JWT) used as the bearer for all backend calls. The backend's JWKS/issuer/audience must name this same Firebase project.

### Action cards (`FireblocksNCWExampleActions.tsx`)
Render order (post-cleanup): `GenerateMPCKeys` / `JoinExistingWallet`, `BackupAndRecover`, then when a key is READY: `Assets`, `Transactions`, **`KeyMigrationFlow` (lead/primary card)**, then a collapsible **`AdvancedSection`** (default collapsed) containing `MigrationFlow` (sweep), raw `Takeover`, `Web3`, `Logs`. `AdvancedSection` is a local component with a toggle button; nothing is deleted, just hidden.

### ⭐ Key Migration flow (`src/components/KeyMigrationFlow.tsx`) — the showcased path
Constants: `SEPOLIA_ASSET_ID="ETH_TEST5"`, `ACCOUNT_ID=0`, `SEPOLIA_COIN_TYPE=1` (BIP44 testnet).
Clean UI: title "Key Migration: Fireblocks → Dynamic", rows for **Source (Fireblocks)** address, **Target (Dynamic)** ("Not yet imported" until done), single-line **Status** (`Ready → Exporting… → Exported ✓ → Importing… → Imported ✓ → Verified ✓`, or `Address mismatch`). Three buttons: **Export Key / Import to Dynamic / Verify Ownership**. No paragraphs, no key fragment shown; errors verbose.

Sequence:
1. **Export** (`handleExport`): require `walletId` + `fireblocksAddress` (fetched in Assets). `startKeyMigration(walletId, assetId)` → `migrationId`. `takeover()` → find `MPC_CMP_ECDSA_SECP256K1` key → `deriveAssetKey(ecdsa.privateKey, 1, 0, 0, 0)` → hold derived key in React state only.
2. **Import** (`handleImport` / `runImport`): if `!isLoggedIn` pop Dynamic OTP (`setShowAuthFlow`), resume via effect on auth. Strip `0x`, call `importPrivateKey({ chainName: ChainEnum.Evm, privateKey, addressType: "Ethereum" })` (returns `void`). **Wipe key from state.** Set `pendingMatch`.
3. **Match** (effect): the imported wallet appears in **`useUserWallets()`** (fast/primary path — re-runs the effect when it updates) and/or **`getWaasWallets()`** (fallback, re-polled by a ~1.5s ticker). On match → `setImportedAddress` → `completeKeyMigration(migrationId, fireblocksAddress, dynamicAddress)` → store `addressesMatch`. 60s timeout fallback.
   - *Critical lesson learned: `useUserWallets()` is the list that surfaces imported keys quickly; `getWaasWallets()` lags for imports. Use both, prefer the reactive list.*
4. **Stale-session recovery**: if import throws `/authoriz|unauthorized|cookie/i`, `handleLogOut()` → re-auth → re-queue `runImport`.
5. **Verify** (`handleVerify`): find wallet (WaaS list then userWallets) → `wallet.signMessage(VERIFY_MESSAGE)`.
6. Best-effort key wipe on unmount.

**Security invariants:** the private key lives only in component state, is wiped after import, is never sent to the backend, and the backend rejects key fields.

### Sweep flow (`src/components/MigrationFlow.tsx`) — alternative, behind Advanced
Dynamic OTP login → `createWalletAccount([ChainEnum.Evm])` → enable `ETH_TEST5` + `refreshBalance` → optional `signMessage` ownership proof → `createTransaction({ assetId:"ETH_TEST5", destAddress: dynamicWallet.address, amount, feeLevel:"LOW" })` → poll status, auto-`signTransaction` on `PENDING_SIGNATURE`, show Etherscan link on `COMPLETED`. Uses the generic tx endpoints (no `/migration/*` calls). Addresses change (on-chain transfer); keeps the MPC model.

### Env (`frontend/.env.example`, all `VITE_`-prefixed = browser-exposed, no secrets)
`VITE_AUTOMATE_INITIALIZATION`, `VITE_BACKEND_BASE_URL`, `VITE_NCW_SDK_ENV` (sandbox|production), `VITE_DYNAMIC_ENVIRONMENT_ID`. Firebase client config is in `FirebaseAuthManager.ts` (public by design).

---

## Cross-cutting reconstruction notes
- **Key custody:** the entire point — MPC reconstruction and `importPrivateKey` happen **in the browser**; the backend is an audit witness only.
- **Two-key privilege separation** on the backend (signer vs admin) is a deliberate security pattern.
- **Dynamic dashboard prerequisite:** disable `automaticEmbeddedWalletCreation` so `importPrivateKey` creates the wallet (else a different auto-created wallet shows up and confuses the match).
- **Fireblocks prerequisite:** a workspace with NCW + Full Key Takeover enabled.
- **Node 20 required** — `jose` needs the global `Headers` / `fetch` (Node 18+); Node 16 fails JWT verification.
- **Firebase ties the halves together:** the frontend's Firebase project ID must equal the backend's `AUDIENCE`/`ISSUER`, or every request 401s.
- **Scope of POC:** single-chain (Sepolia ETH_TEST5), ECDSA/EVM only, single device. Production: multi-chain, EdDSA (separate `takeover()`), multi-device, persisted audit log, distributed event bus, webhook signature always on.
