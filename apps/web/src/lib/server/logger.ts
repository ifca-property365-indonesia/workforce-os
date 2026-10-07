import "server-only";

type Level = "info" | "warn" | "error";
function emit(level: Level, obj: Record<string, unknown>, msg: string) {
  const line = JSON.stringify({ level, time: new Date().toISOString(), svc: "web", msg, ...obj });
  if (level === "error") console.error(line);
  else console.log(line);
}
export const logger = {
  info: (o: Record<string, unknown>, m: string) => emit("info", o, m),
  warn: (o: Record<string, unknown>, m: string) => emit("warn", o, m),
  error: (o: Record<string, unknown>, m: string) => emit("error", o, m),
};
