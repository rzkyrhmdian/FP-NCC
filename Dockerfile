FROM denoland/deno:2.3.1

WORKDIR /app

COPY deno.json deno.lock ./
COPY main.ts ChatServer.ts ChatStorage.ts ./
RUN deno cache main.ts

COPY public ./public

RUN mkdir -p /app/data && chown -R deno:deno /app

USER deno

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD deno eval "const r = await fetch('http://127.0.0.1:8080/health'); if (!r.ok) Deno.exit(1);"

CMD ["deno", "task", "start"]
