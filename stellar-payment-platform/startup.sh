#!/bin/sh

# Ensure database schema is up-to-date
npx prisma migrate deploy

# Start the Express server
npm start
