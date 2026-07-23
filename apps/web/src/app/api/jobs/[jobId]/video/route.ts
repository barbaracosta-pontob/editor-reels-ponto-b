/**
 * GET /api/jobs/[jobId]/video
 * Serve o vídeo original do job para o Remotion via HTTP.
 * O Remotion não acessa file:// — precisa de URL http://.
 */

import { NextRequest } from "next/server";
import { createReadStream, statSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(process.cwd(), "../..");
const JOBS_DIR = process.env.JOBS_DIR
  ? path.resolve(REPO_ROOT, process.env.JOBS_DIR)
  : path.join(REPO_ROOT, "jobs");

export async function GET(
  req: NextRequest,
  { params }: { params: { jobId: string } }
) {
  const { jobId } = params;
  const jobDir = path.join(JOBS_DIR, jobId);

  if (!existsSync(jobDir)) {
    return new Response(JSON.stringify({ error: "Job não encontrado" }), { status: 404 });
  }

  const files = readdirSync(jobDir);
  const VIDEO_EXTS = [".mp4", ".mov", ".avi", ".mkv", ".webm"];
  const videoFile = files.find((f) => VIDEO_EXTS.includes(path.extname(f).toLowerCase()));

  if (!videoFile) {
    return new Response(JSON.stringify({ error: "Vídeo não encontrado" }), { status: 404 });
  }

  const videoPath = path.join(jobDir, videoFile);
  if (!existsSync(videoPath)) {
    return new Response(JSON.stringify({ error: "Arquivo não encontrado" }), { status: 404 });
  }

  const stat = statSync(videoPath);
  const fileSize = stat.size;
  const rangeHeader = req.headers.get("range");

  const startByte = (() => {
    if (!rangeHeader) return 0;
    const m = rangeHeader.match(/bytes=(\d+)-/);
    return m ? parseInt(m[1], 10) : 0;
  })();

  const endByte = (() => {
    if (!rangeHeader) return fileSize - 1;
    const m = rangeHeader.match(/bytes=\d+-(\d*)/);
    if (!m) return fileSize - 1;
    const e = m[1] !== "" ? parseInt(m[1], 10) : NaN;
    return !isNaN(e) && e < fileSize ? e : fileSize - 1;
  })();

  if (startByte >= fileSize) {
    return new Response("Range Not Satisfiable", {
      status: 416,
      headers: { "Content-Range": `bytes */${fileSize}` },
    });
  }

  const chunkSize = endByte - startByte + 1;
  const nodeStream = createReadStream(videoPath, { start: startByte, end: endByte });

  // Converte para Web ReadableStream tratando erro de cliente desconectado.
  // Respeita backpressure: pausa a leitura do arquivo quando o controller
  // ja tem chunk suficiente enfileirado, e retoma no pull(). Sem isso, 2+
  // videos grandes sendo servidos ao mesmo tempo (2 instancias, por ex.)
  // enchem a fila mais rapido do que o navegador consegue consumir, o
  // stream quebra no meio e o <video> reporta MEDIA_ELEMENT_ERROR (Code 4)
  // como se o arquivo estivesse corrompido.
  const webStream = new ReadableStream({
    start(controller) {
      nodeStream.on("data", (chunk) => {
        try {
          controller.enqueue(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
        } catch {
          // Cliente fechou a conexão — destrói o stream Node silenciosamente
          nodeStream.destroy();
          return;
        }
        if (controller.desiredSize !== null && controller.desiredSize <= 0) {
          nodeStream.pause();
        }
      });
      nodeStream.on("end", () => {
        try { controller.close(); } catch { /* já fechado */ }
      });
      nodeStream.on("error", (err) => {
        try { controller.error(err); } catch { /* já fechado */ }
      });
    },
    pull() {
      nodeStream.resume();
    },
    cancel() {
      nodeStream.destroy();
    },
  });

  return new Response(webStream, {
    status: rangeHeader ? 206 : 200,
    headers: {
      ...(rangeHeader
        ? { "Content-Range": `bytes ${startByte}-${endByte}/${fileSize}` }
        : {}),
      "Accept-Ranges": "bytes",
      "Content-Length": String(chunkSize),
      "Content-Type": "video/mp4",
      "Cache-Control": "no-store",
    },
  });
}
