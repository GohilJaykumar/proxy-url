FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY manager_server.js rpc_proxy.js ws_proxy.js db_proxy.js \
     mcp_server.js mcp_tools.js mcp_resources.js mcp_prompts.js ./
COPY public ./public

ENV NODE_ENV=production
ENV MANAGER_PORT=9090

EXPOSE 9090

CMD ["npm", "run", "start"]
