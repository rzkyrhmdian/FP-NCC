FROM denoland/deno:latest

WORKDIR /app

COPY . .

EXPOSE 8080

CMD ["deno", "task", "dev"]
