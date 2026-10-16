FROM node:20-slim
WORKDIR /app
COPY . .
ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data
EXPOSE 8080
CMD ["node", "server.js"]
