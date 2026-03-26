import express from "express";
import multer from "multer";
import axios from "axios";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const {
  GITLAB_TOKEN,
  GITLAB_PROJECT_ID,
  GITLAB_BRANCH = "main",
  GITLAB_BASE_URL = "https://gitlab.com",
  CDN_FOLDER = "cdn-files",
  PORT = 3000,
} = process.env;

if (!GITLAB_TOKEN || !GITLAB_PROJECT_ID) {
  console.error("❌  Missing GITLAB_TOKEN or GITLAB_PROJECT_ID env vars");
  process.exit(1);
}

const gitlabApi = axios.create({
  baseURL: `${GITLAB_BASE_URL}/api/v4/projects/${encodeURIComponent(GITLAB_PROJECT_ID)}`,
  headers: { "PRIVATE-TOKEN": GITLAB_TOKEN },
});

// ── helpers ──────────────────────────────────────────────────────────────────

async function getFile(filePath) {
  try {
    const res = await gitlabApi.get(`/repository/files/${encodeURIComponent(filePath)}`, {
      params: { ref: GITLAB_BRANCH },
    });
    return res.data;
  } catch (e) {
    if (e.response?.status === 404) return null;
    throw e;
  }
}

async function putFile(filePath, content, message, isNew) {
  const method = isNew ? "post" : "put";
  await gitlabApi[method](`/repository/files/${encodeURIComponent(filePath)}`, {
    branch: GITLAB_BRANCH,
    content,
    encoding: "base64",
    commit_message: message,
  });
}

// ── serve CDN files ───────────────────────────────────────────────────────────

app.get("/files/*", async (req, res) => {
  const filePath = `${CDN_FOLDER}/${req.params[0]}`;
  try {
    const data = await getFile(filePath);
    if (!data) return res.status(404).send("File not found");
    const buf = Buffer.from(data.content, "base64");
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap = {
      ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
      ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
      ".pdf": "application/pdf", ".mp4": "video/mp4", ".webm": "video/webm",
      ".mp3": "audio/mpeg", ".txt": "text/plain", ".json": "application/json",
      ".css": "text/css", ".js": "application/javascript",
    };
    res.setHeader("Content-Type", mimeMap[ext] || "application/octet-stream");
    res.setHeader("Cache-Control", "public, max-age=31536000");
    res.send(buf);
  } catch (e) {
    console.error(e.message);
    res.status(500).send("Error fetching file");
  }
});

// ── upload endpoint ───────────────────────────────────────────────────────────

app.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file provided" });

  const customName = req.body.filename?.trim();
  const ext = path.extname(req.file.originalname);
  const baseName = customName
    ? (path.extname(customName) ? customName : customName + ext)
    : req.file.originalname;

  const subFolder = req.body.folder?.trim().replace(/^\/|\/$/g, "") || "";
  const relativePath = subFolder ? `${subFolder}/${baseName}` : baseName;
  const filePath = `${CDN_FOLDER}/${relativePath}`;

  try {
    const existing = await getFile(filePath);
    const content = req.file.buffer.toString("base64");
    const action = existing ? "Updated" : "Uploaded";
    await putFile(filePath, content, `${action} ${relativePath} via CDN`, !existing);

    const host = `${req.protocol}://${req.get("host")}`;
    const link = `${host}/files/${relativePath}`;
    res.json({ success: true, link, path: relativePath, size: req.file.size, action });
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).json({ error: "Upload failed", detail: e.response?.data?.message || e.message });
  }
});

// ── list files ────────────────────────────────────────────────────────────────

app.get("/api/files", async (req, res) => {
  try {
    const folder = req.query.folder
      ? `${CDN_FOLDER}/${req.query.folder}`
      : CDN_FOLDER;
    const response = await gitlabApi.get("/repository/tree", {
      params: { path: folder, ref: GITLAB_BRANCH, recursive: true, per_page: 100 },
    });
    const files = response.data
      .filter((f) => f.type === "blob")
      .map((f) => ({
        name: f.name,
        path: f.path.replace(`${CDN_FOLDER}/`, ""),
        link: `${req.protocol}://${req.get("host")}/files/${f.path.replace(`${CDN_FOLDER}/`, "")}`,
      }));
    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: "Could not list files" });
  }
});

// ── delete file ───────────────────────────────────────────────────────────────

app.delete("/api/files/*", async (req, res) => {
  const filePath = `${CDN_FOLDER}/${req.params[0]}`;
  try {
    await gitlabApi.delete(`/repository/files/${encodeURIComponent(filePath)}`, {
      data: { branch: GITLAB_BRANCH, commit_message: `Delete ${req.params[0]} via CDN` },
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Delete failed" });
  }
});

// ── UI ────────────────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, "../public")));
app.get("/", (_, res) => res.sendFile(path.join(__dirname, "../public/index.html")));

app.listen(PORT, () => console.log(`🚀 CDN running on http://localhost:${PORT}`));
