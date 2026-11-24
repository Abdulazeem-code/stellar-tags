# syntax=docker/dockerfile:1
FROM node:22-alpine

WORKDIR /app

# Install dependencies first for better caching
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source
COPY src ./src

# Create non-root user for security
USER node

# Healthcheck or default command
ENV NODE_ENV=production
CMD ["node", "src/index.js"]
