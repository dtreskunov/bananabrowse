FROM node:22.22.2-bookworm-slim AS build
WORKDIR /app/domagent-mcp
COPY domagent-mcp/package.json domagent-mcp/package-lock.json ./
RUN npm ci --ignore-scripts
COPY domagent-mcp/tsconfig.json domagent-mcp/*.ts ./
COPY shared/ /app/shared/
RUN npm run build:service

FROM node:22.22.2-bookworm-slim
WORKDIR /app/domagent-mcp
COPY domagent-mcp/package.json domagent-mcp/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/domagent-mcp/dist ./dist
COPY package.json /app/package.json
RUN mkdir -p /var/lib/domagent && chown node:node /var/lib/domagent
USER node
ENV DOMAGENT_DB=/var/lib/domagent/domagent.db
ENV DOMAGENT_BIND=0.0.0.0
EXPOSE 18792
CMD ["node", "dist/domagent-mcp/index.js"]
