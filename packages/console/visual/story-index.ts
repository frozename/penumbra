import { createServer, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

export interface StoryEntry {
  id: string;
  title: string;
  name: string;
}

interface StoryIndexItem {
  id?: unknown;
  title?: unknown;
  name?: unknown;
  type?: unknown;
}

export function loadStoryIndex(staticDir: string): StoryEntry[] {
  const indexPath = join(staticDir, "index.json");
  const raw = JSON.parse(readFileSync(indexPath, "utf-8")) as {
    entries?: Record<string, StoryIndexItem>;
    stories?: Record<string, StoryIndexItem>;
  };
  const entries = raw.entries ?? raw.stories;
  if (!entries) {
    throw new Error("Storybook index.json is missing entries/stories field");
  }

  return Object.values(entries)
    .filter((entry) => entry.type === "story" || entry.type === undefined)
    .map((entry) => ({
      id: String(entry.id ?? ""),
      title: String(entry.title ?? ""),
      name: String(entry.name ?? ""),
    }));
}

export async function serveStorybookStatic(
  staticDir: string,
  port: number,
): Promise<{ stop: () => Promise<void> }> {
  const root = resolve(staticDir);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const pathname = decodeURIComponent(url.pathname);
      const requestedPath = pathname === "/" ? "/index.html" : pathname;
      const targetPath = resolve(root, `.${requestedPath}`);
      if (!targetPath.startsWith(root)) {
        res.writeHead(403).end("forbidden");
        return;
      }

      if (!existsSync(targetPath)) {
        res.writeHead(404).end("not found");
        return;
      }

      const contentType = mimeTypeFor(targetPath);
      const body = await readFile(targetPath);
      res.writeHead(200, { "content-type": contentType }).end(body);
    } catch {
      res.writeHead(500).end("internal server error");
    }
  });

  await new Promise<void>((resolveReady, rejectReady) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      rejectReady(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveReady();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });

  return {
    stop: async () => {
      await closeServer(server);
    },
  };
}

function mimeTypeFor(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".map":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((err) => {
      if (err) {
        rejectClose(err);
        return;
      }
      resolveClose();
    });
  });
}
