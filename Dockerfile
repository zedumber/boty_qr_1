# Usa una imagen ligera de Node.js
FROM node:20-alpine

# Establece directorio de trabajo dentro del contenedor
WORKDIR /app

# Copia package.json y package-lock.json primero (para aprovechar cache de Docker)
COPY package*.json ./

# Instala dependencias
RUN npm install --production


# RUN npm install bull ioredis

# Copia el resto del código
COPY . .

# Crea carpetas necesarias dentro del contenedor
RUN mkdir -p /app/auth /app/audios

# Expone el puerto en el que corre tu app
EXPOSE 4000

# Comando por defecto para correr el servidor
CMD ["node", "index.js"]
