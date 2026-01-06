FROM mcr.microsoft.com/playwright:v1.57.0-jammy

WORKDIR /app

# copia apenas package.json
COPY package*.json ./

# usa npm install (não npm ci)
RUN npm install --omit=dev

# copia o resto do código
COPY . .

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "start"]
