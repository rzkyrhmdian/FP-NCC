import { Application, Context, isHttpError, Router, Status } from "@oak/oak";
import ChatServer from "./ChatServer.ts";
import { JsonFileStorage } from "./ChatStorage.ts";

function readEnv(key: string, fallback: string): string {
  try {
    return Deno.env.get(key) ?? fallback;
  } catch {
    return fallback;
  }
}

const port = Number(readEnv("PORT", "8080")) || 8080;
const dataPath = readEnv("DATA_PATH", `${Deno.cwd()}/data/chat-state.json`);
const startedAt = Date.now();

const app = new Application();
const router = new Router();
const server = new ChatServer({
  storage: new JsonFileStorage(dataPath),
});

await server.init();

app.use(async (ctx, next) => {
  ctx.response.headers.set("X-Content-Type-Options", "nosniff");
  ctx.response.headers.set("X-Frame-Options", "DENY");
  ctx.response.headers.set("Referrer-Policy", "no-referrer");
  ctx.response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  await next();
});

router.get("/health", (ctx: Context) => {
  ctx.response.status = Status.OK;
  ctx.response.body = {
    status: "ok",
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    ...server.getStats(),
  };
});

router.get("/start_web_socket", (ctx: Context) => server.handleConnection(ctx));

app.use(router.routes());
app.use(router.allowedMethods());
app.use(async (context) => {
  try {
    await context.send({
      root: `${Deno.cwd()}/public`,
      index: "index.html",
    });
  } catch (err) {
    if (isHttpError(err) && err.status === Status.NotFound) {
      context.response.status = Status.NotFound;
      context.response.body = "Not Found";
      return;
    }
    throw err;
  }
});

const abortController = new AbortController();
const shutdown = async () => {
  console.log("Shutting down server and flushing chat state...");
  await server.dispose();
  abortController.abort();
};

try {
  Deno.addSignalListener("SIGINT", () => {
    shutdown();
  });
  if (Deno.build.os !== "windows") {
    Deno.addSignalListener("SIGTERM", () => {
      shutdown();
    });
  }
} catch {
  // Ignore if signal listeners are unavailable.
}

console.log(`Listening at http://localhost:${port}`);
await app.listen({
  hostname: "0.0.0.0",
  port,
  signal: abortController.signal,
});
