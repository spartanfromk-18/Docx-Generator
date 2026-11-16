FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# Schema is applied on boot when missing; keep it inside the image.
COPY ../scripts/init_db.sql /opt/specforge/init_db.sql
EXPOSE 8787
CMD ["node", "dist/index.js"]
