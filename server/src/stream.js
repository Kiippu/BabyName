const HEARTBEAT_MS = 25000;

const clients = new Set();

/** GET /api/stream: push channel for match takeovers (spec §5/§7). */
function streamHandler(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders?.();
  res.write(":ok\n\n");
  clients.add(res);

  const heartbeat = setInterval(() => res.write(":heartbeat\n\n"), HEARTBEAT_MS);
  req.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}

module.exports = { streamHandler, broadcast };
