# insat API. Build from the repo ROOT so the bootstrap can read the
# SQL it applies on boot (db/schema.sql, db/migrate.sql):
#   docker build -f server/Dockerfile -t satify-api .
FROM node:20-slim
WORKDIR /app

# Install API dependencies first (layer-cached unless package files change).
COPY server/package.json server/package-lock.json* server/
RUN cd server && npm install --omit=dev && npm cache clean --force

# App code + the SQL the API applies on boot.
COPY server ./server
COPY db ./db

ENV NODE_ENV=production
WORKDIR /app/server
# The platform injects PORT (config.js falls back to 3001). No .env file in prod —
# env vars come from Render/Railway/etc.
EXPOSE 3001
CMD ["node", "index.js"]
