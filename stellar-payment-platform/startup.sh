#!/bin/sh
set -e

# Use the Prisma CLI bundled in node_modules. Bare `npx prisma` would silently
# download the latest CLI (v7+) when the local one is missing, and v7 rejects
# this schema (`url` in the datasource block, the "metrics" preview feature).
PRISMA="./node_modules/.bin/prisma"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set." >&2
  echo "Render must provide a PostgreSQL connection string to this service before startup." >&2
  echo "Link a Render PostgreSQL instance or set DATABASE_URL in the service environment." >&2
  exit 1
fi

if [ ! -x "$PRISMA" ]; then
  echo "ERROR: Prisma CLI not found at $PRISMA." >&2
  echo "It must be a production dependency so it survives 'npm prune --omit=dev'." >&2
  exit 1
fi

if [ ! -d "./node_modules/@prisma/client" ]; then
  echo "ERROR: @prisma/client is missing from the runtime image." >&2
  echo "Without it the app falls back to a mock client and serves fake data." >&2
  exit 1
fi

echo "Running database migrations..."
"$PRISMA" migrate deploy

echo "Starting the application..."
npm start
