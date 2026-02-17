# Webex VIP Dashboard

Dashboard de supervision Webex Devices orienté temps réel:
- statut Online/Offline + depuis quand
- défauts/pannes devices
- métriques QoS en appel (packet loss, jitter, latency, MOS)
- i18n (détection langue navigateur + override utilisateur persistant)

## Stack
- Backend: Node.js, TypeScript, Express, WebSocket (`ws`), JWT, logs `pino`
- Frontend: HTML/CSS/JS vanilla, responsive
- i18n: JSON par langue + fallback anglais

## Démarrage
1. Copier l’exemple d’env:
```bash
cp .env.example .env
```
2. Installer:
```bash
npm install
```
3. Lancer en dev:
```bash
npm run dev
```
4. Ouvrir:
- [http://localhost:8080](http://localhost:8080)

## Variables importantes
- `USE_MOCK_DATA=true`: mode mock pour développement local
- `WEBEX_BOT_TOKEN`: token API Webex
- `WEBEX_WEBHOOK_SECRET`: secret de signature webhook
- `POLL_INTERVAL_MS`: polling statut device
- `CALL_METRICS_POLL_MS`: polling QoS fallback
- `ADMIN_USERS`, `READONLY_USERS`: RBAC simple basé email

## API
- `POST /api/login` (public): retourne JWT
- `POST /api/webhooks/webex` (public): endpoint webhooks Webex (idempotence + signature)
- `GET /api/devices` (auth)
- `GET /api/events` (auth)
- `GET /api/audit` (auth admin)
- `GET /api/health` (public)

## Temps réel
- WebSocket: `/ws`
- Push snapshot + deltas toutes les 2 secondes
- Objectif latence UI < 2-5 secondes (webhook prioritaire, polling fallback)

## Résilience implémentée
- Déduplication webhook par `event.id` (TTL)
- Tolérance erreurs polling/Webex
- Journalisation structurée
- Ring buffers en mémoire (events/audit)

## Limites de cette V1
- Stockage en mémoire (prévoir Redis/PostgreSQL pour 10k devices)
- QoS Webex partiellement dépendant des endpoints disponibles selon tenant/permissions
- OAuth Webex à industrialiser (token rotation, refresh)

## Roadmap recommandée pour prod
1. Remplacer store mémoire par Redis + Postgres
2. Ajouter queue (BullMQ/Kafka) pour ingestion webhook et replays
3. Ajouter OpenTelemetry (traces) + métriques Prometheus
4. Mettre en place OAuth complet + gestion secrets (Vault/SM)
5. Ajouter tests e2e et tests de charge (100 -> 10 000 devices)
