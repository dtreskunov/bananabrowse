FROM node:22.22.2-bookworm-slim AS build
WORKDIR /app/bananabrowse-mcp
COPY bananabrowse-mcp/package.json bananabrowse-mcp/package-lock.json ./
RUN npm ci --ignore-scripts
COPY bananabrowse-mcp/tsconfig.json bananabrowse-mcp/*.ts ./
COPY shared/ /app/shared/
RUN npm run build:service

FROM node:22.22.2-bookworm-slim
WORKDIR /app/bananabrowse-mcp
COPY bananabrowse-mcp/package.json bananabrowse-mcp/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/bananabrowse-mcp/dist ./dist
COPY package.json /app/package.json
RUN mkdir -p /var/lib/bananabrowse && chown node:node /var/lib/bananabrowse
USER node
ENV BANANABROWSE_DB=/var/lib/bananabrowse/bananabrowse.db
ENV BANANABROWSE_BIND=0.0.0.0
EXPOSE 18792
CMD ["node", "dist/bananabrowse-mcp/index.js"]
