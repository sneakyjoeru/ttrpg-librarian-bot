FROM node:18-alpine

RUN apk add --no-cache git

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

CMD [ "npm", "start" ]
