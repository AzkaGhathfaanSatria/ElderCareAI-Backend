FROM node:22-slim
# python3 + OpenCV dipakai worker kamera (scripts/camera_bridge.py) yang dijalankan server
RUN apt-get update && apt-get install -y --no-install-recommends openssl python3 python3-opencv python3-requests \
    && rm -rf /var/lib/apt/lists/*
ENV PYTHON_BIN=python3
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 4000
CMD ["npm", "start"]
