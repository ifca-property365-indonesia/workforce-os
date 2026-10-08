// Local stand-in for the Anthropic API: records method, path and which auth headers arrive (values masked).
import http from "node:http";
const srv = http.createServer((req, res) => {
  const auth = Object.fromEntries(Object.entries(req.headers).filter(([k]) => /auth|api-key|anthropic-beta|anthropic-version/.test(k)).map(([k, v]) => [k, String(v).replace(/(dummy-[a-z]+)-\w+/, "$1-…")]));
  console.log(JSON.stringify({ method: req.method, path: req.url, auth }));
  res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "stub" } }));
});
srv.listen(0, "127.0.0.1", () => console.log("PORT " + srv.address().port));
