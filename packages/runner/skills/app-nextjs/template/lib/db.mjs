import postgres from "postgres";

/**
 * Workforce OS sets DATABASE_URL to postgresql://user:pw@localhost:<port>/db?host=<socket dir>: the database is only
 * reachable through its unix socket, so the socket folder from ?host= is passed to the driver explicitly.
 */
export function connect() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is not set");
  const url = new URL(raw);
  const socketDir = url.searchParams.get("host");
  return postgres({
    host: socketDir ?? url.hostname,
    port: Number(url.port || 5432),
    database: decodeURIComponent(url.pathname.slice(1)),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    max: 5,
    idle_timeout: 30,
  });
}
