FROM node:20-alpine AS base
WORKDIR /app
ENV NPM_CONFIG_AUDIT=false \
	NPM_CONFIG_FUND=false \
	NPM_CONFIG_FETCH_RETRIES=5 \
	NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
	NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 \
	NPM_CONFIG_FETCH_TIMEOUT=600000

# --- Backend ---
FROM base AS backend
COPY stellar-payment-platform/package*.json ./
COPY stellar-payment-platform/prisma ./prisma
RUN npm ci --no-audit --no-fund
COPY stellar-payment-platform/ .
RUN npx prisma generate
EXPOSE 5000
CMD ["node", "server.js"]

# --- Frontend build ---
FROM base AS frontend-build
COPY payment-dashboard/package*.json ./
RUN apk add --no-cache python3 make g++ linux-headers libusb-dev eudev-dev
RUN npm install --registry=https://registry.yarnpkg.com/ --no-audit --no-fund --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000 --fetch-timeout=600000
COPY payment-dashboard/ .
ARG VITE_API_BASE=http://localhost:5000
ENV VITE_API_BASE=$VITE_API_BASE
RUN npm run build

# --- Frontend serve ---
FROM nginx:alpine AS frontend
COPY --from=frontend-build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
