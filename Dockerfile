# XenMCP Docker agent: a read-only MCP server for the containers on this host.
# Runs as a non-root user that may read the Docker socket (group of the socket,
# set with --group-add), with a read-only root and no capabilities.
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE}
WORKDIR /srv
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts && npm cache clean --force
COPY lib.mjs server.mjs LICENSE ./
ENV NODE_ENV=production
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/health >/dev/null || exit 1
CMD ["node", "server.mjs"]
