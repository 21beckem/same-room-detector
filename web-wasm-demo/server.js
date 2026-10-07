#!/usr/bin/env node

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const DEMO_ROOT = __dirname;
const PROJECT_ROOT = path.resolve(DEMO_ROOT, "..");
const DATASET_ROOT = path.join(PROJECT_ROOT, "data-exploration", "room-audio-recordings");
const MODEL_PATH = path.join(PROJECT_ROOT, "model_output", "model.json");
const WASM_PATH = path.join(PROJECT_ROOT, "web-calibration", "wasm_parity", "wasm", "same_room.wasm");
const LOADER_PATH = path.join(PROJECT_ROOT, "web-calibration", "wasm_parity", "node_modules", "@assemblyscript", "loader", "index.js");
const PORT = Number(process.env.PORT || 3000);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wav": "audio/wav",
  ".wasm": "application/wasm",
};

function send(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-store" });
  res.end(body);
}

function sendFile(res, filePath, contentType) {
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
    res.end(data);
  } catch (error) {
    if (error.code === "ENOENT") send(res, 404, "Not found\n");
    else send(res, 500, `Could not read file: ${error.message}\n`);
  }
}

function recordingUrl(relativePath) {
  return "/audio/" + relativePath.split(path.sep).map(encodeURIComponent).join("/");
}

function discoverAudioFiles() {
  const result = [];
  const categories = fs.readdirSync(DATASET_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const categoryEntry of categories) {
    const category = categoryEntry.name;
    const categoryPath = path.join(DATASET_ROOT, category);
    const groups = fs.readdirSync(categoryPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^group-\d+$/.test(entry.name))
      .sort((a, b) => Number(a.name.slice(6)) - Number(b.name.slice(6)));

    for (const groupEntry of groups) {
      const groupId = Number(groupEntry.name.slice(6));
      const groupPath = path.join(categoryPath, groupEntry.name);
      const wavs = fs.readdirSync(groupPath).filter((name) => name.toLowerCase().endsWith(".wav"));
      const byDevice = {};
      for (const name of wavs) {
        const match = name.match(/_([AB])\.wav$/i);
        if (match) (byDevice[match[1].toUpperCase()] ||= []).push(name);
      }
      if (!byDevice.A || !byDevice.B || byDevice.A.length !== 1 || byDevice.B.length !== 1) continue;

      for (const device of ["A", "B"]) {
        const relativePath = path.join(category, groupEntry.name, byDevice[device][0]);
        result.push({
          id: `${category}/g${groupId}/${device}`,
          cat: category,
          gid: groupId,
          dev: device,
          label: `${category}/g${groupId}/${device}`,
          path: relativePath.split(path.sep).join("/"),
          url: recordingUrl(relativePath),
        });
      }
    }
  }
  return result;
}

function serveAudio(res, pathname) {
  let relative;
  try {
    relative = pathname.slice("/audio/".length).split("/").map(decodeURIComponent).join(path.sep);
  } catch {
    send(res, 400, "Invalid audio path\n");
    return;
  }
  const filePath = path.resolve(DATASET_ROOT, relative);
  const datasetPrefix = DATASET_ROOT.endsWith(path.sep) ? DATASET_ROOT : `${DATASET_ROOT}${path.sep}`;
  if (!filePath.startsWith(datasetPrefix) || !filePath.toLowerCase().endsWith(".wav")) {
    send(res, 403, "Forbidden\n");
    return;
  }
  sendFile(res, filePath, "audio/wav");
}

const staticFiles = new Map([
  ["/", [path.join(DEMO_ROOT, "index.html"), MIME_TYPES[".html"]]],
  ["/app.js", [path.join(DEMO_ROOT, "app.js"), MIME_TYPES[".js"]]],
  ["/same-room-analyzer.js", [path.join(DEMO_ROOT, "same-room-analyzer.js"), MIME_TYPES[".js"]]],
  ["/analysis-worker.js", [path.join(DEMO_ROOT, "analysis-worker.js"), MIME_TYPES[".js"]]],
  ["/audio.js", [path.join(DEMO_ROOT, "audio.js"), MIME_TYPES[".js"]]],
  ["/wasm-model.js", [path.join(DEMO_ROOT, "wasm-model.js"), MIME_TYPES[".js"]]],
  ["/styles.css", [path.join(DEMO_ROOT, "styles.css"), MIME_TYPES[".css"]]],
  ["/model.json", [MODEL_PATH, MIME_TYPES[".json"]]],
  ["/same_room.wasm", [WASM_PATH, MIME_TYPES[".wasm"]]],
  ["/vendor/assemblyscript-loader.js", [LOADER_PATH, MIME_TYPES[".js"]]],
]);

const server = http.createServer((req, res) => {
  let requestUrl;
  try {
    requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    send(res, 400, "Invalid URL\n");
    return;
  }

  if (requestUrl.pathname === "/api/audio-files") {
    try {
      send(res, 200, JSON.stringify(discoverAudioFiles()), "application/json; charset=utf-8");
    } catch (error) {
      send(res, 500, `Could not discover audio files: ${error.message}\n`);
    }
    return;
  }
  if (requestUrl.pathname.startsWith("/audio/")) {
    serveAudio(res, requestUrl.pathname);
    return;
  }
  const file = staticFiles.get(requestUrl.pathname);
  if (file) {
    sendFile(res, file[0], file[1]);
    return;
  }
  send(res, 404, "Not found\n");
});

server.listen(PORT, () => {
  console.log(`Same-room WASM demo running at http://localhost:${PORT}`);
});
