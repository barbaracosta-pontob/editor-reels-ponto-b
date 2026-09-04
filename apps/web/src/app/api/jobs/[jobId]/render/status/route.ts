/**
 * GET /api/jobs/[jobId]/render/status
 *
 * Fonte da verdade do progresso de render. A UI faz polling aqui em vez de
 * segurar um stream aberto - assim fechar a aba, dar F5, minimizar ou dormir
 * a maquina nao perde o acompanhamento nem o resultado.
 *
 * Alem de devolver o render-status.json, esta rota RECUPERA renders orfaos:
 * se o status diz "running" mas o processo morreu (ex.: o dev server foi
 * reiniciado no meio), ela olha o disco e decide entre done e error, em vez
 * de deixar a UI girando pra sempre.
 */

import { NextRequest } from "next/server";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { readStatus, writeStatus, processoVivo } from "@/lib/renderStatus";

import { acharJobDir, jobDirOuLocal, REPO_ROOT } from "@/lib/jobsDir";

// Quanto tempo sem nenhum flush antes de suspeitar de orfao. O render escreve
// no maximo a cada 400ms enquanto vivo, mas o bundling inicial pode ficar
// calado por um tempo - 90s da folga suficiente pra nao dar falso positivo.
const STALE_MS = 90_000;

export async function GET(
  _req: NextRequest,
  { params }: { params: { jobId: string } },
) {
  const { jobId } = params;
  const jobDir = acharJobDir(jobId);

  if (!jobDir) {
    return Response.json({ error: "Job nao encontrado" }, { status: 404 });
  }

  const status = await readStatus(jobDir);

  if (!status) {
    // Nunca renderizou (ou o arquivo esta sendo reescrito neste instante).
    // Se ja existe mp4 em out/, informa - assim um job antigo, renderizado
    // antes desta mudanca, ainda aparece como pronto.
    const outputs = detectarSaidas(jobDir);
    return Response.json({
      status: Object.keys(outputs).length > 0 ? "done" : "idle",
      phase: "bundling",
      frames: 0,
      total: 0,
      eta: "",
      outputs,
    });
  }

  if (status.status === "running") {
    const parado = Date.now() - status.updatedAt > STALE_MS;
    const vivo = processoVivo(status.pid);

    if (parado && !vivo) {
      // Orfao. O processo sumiu sem fechar o status - tipicamente o dev server
      // reiniciou. Decide pelo que existe em disco.
      const outputs = detectarSaidas(jobDir);
      const completos = status.formatos.every((f) => outputs[f]);
      const recuperado = {
        ...status,
        status: (completos ? "done" : "error") as "done" | "error",
        outputs,
        pid: undefined,
        error: completos
          ? undefined
          : "O processo de render foi interrompido (o servidor provavelmente reiniciou). Exporte de novo.",
        updatedAt: Date.now(),
      };
      try { await writeStatus(jobDir, recuperado); } catch { /* best effort */ }
      return Response.json(recuperado);
    }
  }

  return Response.json(status);
}

/** Varre jobs/<id>/out/ atras dos mp4 ja gerados, por formato. */
function detectarSaidas(jobDir: string): Record<string, string> {
  const outDir = path.join(jobDir, "out");
  const encontrados: Record<string, string> = {};
  for (const fmt of ["reels", "wide", "square"]) {
    const p = path.join(outDir, `reel_${fmt}.mp4`);
    // size > 0 evita reportar como pronto um arquivo que o FFmpeg apenas criou.
    if (existsSync(p) && statSync(p).size > 0) encontrados[fmt] = p;
  }
  return encontrados;
}
