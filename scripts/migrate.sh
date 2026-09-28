#!/usr/bin/env bash
#
# RUN PENDING MIGRATIONS (AND BACKFILLS) AGAINST THE DEPLOYED STACK.
#
#   ./scripts/migrate.sh                                   # apply migrations
#   ./scripts/migrate.sh status                            # what is outstanding
#   ./scripts/migrate.sh run prisma/backfill-purpose.ts    # one backfill
#
# ── Why this file exists ──────────────────────────────────────────────────
#
# The README said "run `npx prisma migrate deploy` on release". That command
# cannot work here, and quietly: the runtime image installs with
# `npm ci --omit=dev`, and `prisma` is a devDependency, so the CLI is not in
# the running container at all. `docker exec salon-api npx prisma …` either
# fails or silently downloads a different CLI version from the registry.
#
# The cost of that was not a failed release. It was that migrations simply
# never ran, for weeks, while the app looked completely healthy — reads only
# touch old columns, so the only thing that broke was customers pressing Send
# on the feedback form, and a rating that fails to save leaves no trace.
#
# The build stage has the CLI, the migrations and the schema. So that is what
# runs them: same Dockerfile, same lockfile, same Prisma version as the code
# being deployed. No CLI downloaded at release time.
set -euo pipefail

API_CONTAINER="${API_CONTAINER:-salon-api}"
MIGRATE_IMAGE="${MIGRATE_IMAGE:-api:migrate}"
ENV_FILE="${ENV_FILE:-.env}"

cd "$(dirname "$0")/.."

if [ ! -f "$ENV_FILE" ]; then
  echo "No $ENV_FILE here. Run this from backend/, or set ENV_FILE." >&2
  exit 1
fi

# The database is reachable only on the API container's own network, by
# container name. Read it off the running container rather than hardcoding it:
# compose names networks after the project directory, so it differs per host.
NETWORK="$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}' "$API_CONTAINER" 2>/dev/null || true)"
if [ -z "$NETWORK" ]; then
  echo "Could not find the network for container '$API_CONTAINER'." >&2
  echo "Is it running? docker ps" >&2
  exit 1
fi

echo "→ building the migrate image (build stage of the same Dockerfile)"
docker build --quiet --target build -t "$MIGRATE_IMAGE" . >/dev/null

run() {
  docker run --rm --network "$NETWORK" --env-file "$ENV_FILE" "$MIGRATE_IMAGE" "$@"
}

case "${1:-deploy}" in
  status)
    run npx prisma migrate status
    ;;
  run)
    # A backfill. Separate from migrations on purpose: a migration changes the
    # shape of the database and must run on every release, a backfill fills the
    # new shape once and is usually slow enough to want watching.
    [ -n "${2:-}" ] || { echo "Usage: $0 run prisma/backfill-<name>.ts" >&2; exit 1; }
    echo "→ $2"
    run npx tsx "$2"
    ;;
  deploy)
    echo "→ before:"
    run npx prisma migrate status || true
    echo
    run npx prisma migrate deploy
    echo
    echo "→ restart the API so it picks up the new schema:"
    echo "   docker restart $API_CONTAINER"
    echo "→ then confirm pendingMigrations is 0:"
    echo "   curl -s localhost:4000/health"
    ;;
  *)
    echo "Usage: $0 [deploy|status|run <script>]" >&2
    exit 1
    ;;
esac
