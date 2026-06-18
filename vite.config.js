import { defineConfig } from "vite";

export default defineConfig({
  plugins: [selectionApiPlugin()],
  build: {
    target: "es2020"
  },
  server: {
    watch: {
      ignored: ["**/public/datasets/**"]
    }
  }
});

function selectionApiPlugin() {
  let selection = null;
  const middleware = (request, response, next) => {
    if (!request.url?.startsWith("/api/selection")) {
      next();
      return;
    }
    setJsonHeaders(response);
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }
    if (request.method === "GET") {
      response.end(JSON.stringify({ selection }));
      return;
    }
    if (request.method === "DELETE") {
      selection = null;
      response.end(JSON.stringify({ selection }));
      return;
    }
    if (request.method === "POST") {
      readJsonBody(request)
        .then((body) => {
          selection = {
            ...body,
            receivedAt: new Date().toISOString()
          };
          response.end(JSON.stringify({ selection }));
        })
        .catch((error) => {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: error.message }));
        });
      return;
    }
    response.statusCode = 405;
    response.end(JSON.stringify({ error: "Method not allowed" }));
  };
  return {
    name: "hpx-selection-api",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    }
  };
}

function setJsonHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let data = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new Error("Selection payload is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : null);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}
