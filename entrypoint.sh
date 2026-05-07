#!/bin/sh
# Container entrypoint: run DB migrations, then exec the main process.
# CMD ("node dist/index.js" by default) is passed in as $@.
set -e

echo "[entrypoint] applying database migrations..."
node dist/db/migrate.js

echo "[entrypoint] migrations complete; starting main process: $*"
exec "$@"
