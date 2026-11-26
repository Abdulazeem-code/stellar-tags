# syntax=docker/dockerfile:1
FROM node:22-alpine

WORKDIR /app

# Copy package files and install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source and scripts
COPY src ./src
COPY scripts ./scripts

# Run as non-root user
USER node

ENV NODE_ENV=production
CMD ["node", "src/index.js"]
