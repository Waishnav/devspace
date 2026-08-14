import { createServer } from "node:http";

const rawPort = process.env.DEVSPACE_CHROME_ACCEPTANCE_PORT ?? "17890";
const port = Number.parseInt(rawPort, 10);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid DEVSPACE_CHROME_ACCEPTANCE_PORT: ${rawPort}`);
}

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DevSpace Chrome Acceptance</title>
</head>
<body>
  <h1>DevSpace Chrome Acceptance</h1>
  <label for="value">Acceptance input</label>
  <input id="value" aria-label="Acceptance input">
  <button id="apply" type="button">Apply</button>
  <div id="result" data-testid="result">Waiting</div>
  <script>
    document.querySelector("#apply").addEventListener("click", () => {
      document.querySelector("#result").textContent =
        "Accepted: " + document.querySelector("#value").value;
    });
  </script>
</body>
</html>`;

const server = createServer((request, response) => {
  if (request.url === "/healthz") {
    const payload = JSON.stringify({ ok: true, name: "devspace-chrome-acceptance" });
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
      connection: "close",
    });
    response.end(payload);
    return;
  }

  if (request.url === "/favicon.ico") {
    response.writeHead(204, { connection: "close" });
    response.end();
    return;
  }

  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    connection: "close",
  });
  response.end(html);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`${JSON.stringify({
    event: "ready",
    url: `http://127.0.0.1:${port}/`,
    healthUrl: `http://127.0.0.1:${port}/healthz`,
  })}\n`);
});

let closing = false;
function close(signal) {
  if (closing) return;
  closing = true;
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
    process.stdout.write(`${JSON.stringify({ event: "closed", signal })}\n`);
  });
  server.closeAllConnections();
}

process.once("SIGINT", () => close("SIGINT"));
process.once("SIGTERM", () => close("SIGTERM"));
