import { Hono } from "hono";

const app = new Hono();

app.get("/api/health", (c) => {
  return c.json({
    status: "ok",
    service: "hermes-van",
    version: "0.1.0",
    time: new Date().toISOString(),
  });
});

export default app;
