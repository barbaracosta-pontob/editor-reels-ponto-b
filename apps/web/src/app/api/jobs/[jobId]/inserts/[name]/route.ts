/**
 * GET /api/jobs/[jobId]/inserts/[name]
 * Serve um asset de insert baixado (jobs/<id>/inserts/<name>) via HTTP, para o
 * preview no navegador e para o Remotion durante o render.
 *
 * Aceita os nomes gerados pelo motor v2:
 *   - insert_<bloco>.mp4        (b-roll de video)
 *   - insert_<bloco>_<fatia>.jpg (foto, blocos longos fatiados)
 *   - insert_<bloco>.jpg         (foto, compat. com nome antigo)
 * Video responde a Range (206) para tocar/seekar bem no player.
 *
 * PERFORMANCE (corrigido em 2026-09-03)
 * -------------------------------------
 * A versao anterior fazia `readFile(file)` - o arquivo INTEIRO na memoria - a
 * cada range request, e so depois fatiava o pedaco pedido. O OffthreadVideo do
 * Remotion dispara muitas ranges por insert durante o render; com 17 inserts
 * isso viravam centenas de leituras completas de arquivos de 1-3MB, tudo no
 * mesmo processo Next que estava conduzindo o render. Agora usa
 * createReadStream({ start, end }): le so os bytes pedidos e respeita
 * backpressure.
 */

import { NextRequest } from "next/server";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";

import { acharJobDir, jobDirOuLocal, REPO_ROOT } from "@/lib/jobsDir";

/**
 * Node stream -> Web stream, respeitando backpressure: pausa a leitura do
 * arquivo quando a fila do controller enche e retoma no pull(). Sem isso,
 * varios assets grandes servidos ao mesmo tempo enchem a fila mais rapido do
 * que o consumidor le e o stream quebra no meio.
 */
function paraWebStream(nodeStream: ReturnType<typeof createReadStream>): ReadableStream {
  return new ReadableStream({
    start(controller) {
      nodeStream.on("data", (chunk) => {
        try {
          controller.enqueue(chunk instanceof Buffer ? new Uint8Array(chunk) : chunk);
        } catch {
          nodeStream.destroy();
          return;
        }
        if (controller.desiredSize !== null && controller.desiredSize <= 0) {
          nodeStream.pause();
        }
      });
      nodeStream.on("end", () => {
        try { controller.close(); } catch { /* ja fechado */ }
      });
      nodeStream.on("error", (err) => {
        try { controller.error(err); } catch { /* ja fechado */ }
      });
    },
    pull() {
      nodeStream.resume();
    },
    cancel() {
      nodeStream.destroy();
    },
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: { jobId: string; name: string } },
) {
  const { jobId, name } = params;

  // Sanitizacao: so arquivos gerados pelo motor (imagem, video, ou fundo do CTA).
  if (!/^(insert_\d+(_\d+)?|cta_fundo)\.(jpg|mp4)$/.test(name)) {
    return Response.json({ error: "Nome invalido" }, { status: 400 });
  }

  const jobDir = acharJobDir(jobId);
  if (!jobDir) {
    return Response.json({ error: "Job nao encontrado" }, { status: 404 });
  }

  const file = path.join(jobDir, "inserts", name);
  if (!existsSync(file)) {
    return Response.json({ error: "Insert nao encontrado" }, { status: 404 });
  }

  const isVideo = name.endsWith(".mp4");
  const contentType = isVideo ? "video/mp4" : "image/jpeg";
  const size = statSync(file).size;

  if (isVideo) {
    const range = req.headers.get("range");
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = m ? parseInt(m[1], 10) : 0;
      const end = m && m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;

      if (start >= size || start > end) {
        return new Response("Range Not Satisfiable", {
          status: 416,
          headers: { "Content-Range": `bytes */${size}` },
        });
      }

      return new Response(paraWebStream(createReadStream(file, { start, end })), {
        status: 206,
        headers: {
          "Content-Type": contentType,
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Accept-Ranges": "bytes",
          "Content-Length": String(end - start + 1),
          "Cache-Control": "no-store",
        },
      });
    }

    return new Response(paraWebStream(createReadStream(file)), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
        "Content-Length": String(size),
        "Cache-Control": "no-store",
      },
    });
  }

  return new Response(paraWebStream(createReadStream(file)), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(size),
      "Cache-Control": "no-store",
    },
  });
}
