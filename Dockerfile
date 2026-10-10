FROM node:22.22.2-bookworm-slim
WORKDIR /app/domagent-mcp
COPY domagent-mcp/package.json domagent-mcp/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY domagent-mcp/*.js ./
COPY shared/ /app/shared/
COPY package.json /app/package.json
RUN mkdir -p /var/lib/domagent && chown node:node /var/lib/domagent
USER node
ENV DOMAGENT_DB=/var/lib/domagent/domagent.db
ENV DOMAGENT_BIND=0.0.0.0
EXPOSE 18792
CMD ["node", "index.js"]
