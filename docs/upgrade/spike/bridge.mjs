// Inside the sandbox: 127.0.0.1:3128 (the sandbox's own loopback) -> host proxy Unix socket.
import net from "node:net";
net.createServer((c) => { const u = net.connect(process.env.SOCK); c.pipe(u); u.pipe(c); u.on("error", () => c.destroy()); c.on("error", () => u.destroy()); }).listen(3128, "127.0.0.1");
