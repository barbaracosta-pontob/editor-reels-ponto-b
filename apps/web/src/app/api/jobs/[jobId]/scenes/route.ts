/**
 * PUT /api/jobs/[jobId]/scenes
 * Salva as cenas editadas de volta no scenes.json do job.
 *
 * Antes de gravar, garante que video_end_segundos nao ultrapassa a duracao
 * real do arquivo de video. Esse teto fisico evita timeline alem do conteudo
 * (que geraria tela preta/congelada no final do reel renderizado).
 */

import { NextRequest, NextResponse } from "next/server";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { getVideoDuration } from "../../../../../lib/video-duration";

import { acharJobDir, jobDirOuLocal, REPO_ROOT } from "@/lib/jobsDir";

export async function PUT(
  req: NextRequest,
  { params }: { params: { jobId: string } }
) {
  const { jobId } = params;
  const jobDir = jobDirOuLocal(jobId);
  const scenesPath = path.join(jobDir, "scenes.json");

  if (!existsSync(scenesPath)) {
    return NextResponse.json({ error: "Job não encontrado" }, { status: 404 });
  }

  try {
    const body = await req.json();

    // Clamp video_end_segundos pela duracao real do arquivo de video.
    const videoFile = (() => {
      try {
        return readdirSync(jobDir).find((f) => f.toLowerCase().endsWith(".mp4")) ?? null;
      } catch {
        return null;
      }
    })();
    if (videoFile) {
      const videoDuration = await getVideoDuration(path.join(jobDir, videoFile));
      if (videoDuration != null && typeof body?.video_end_segundos === "number" && body.video_end_segundos > videoDuration) {
        console.warn(
          `[PUT scenes] video_end_segundos=${body.video_end_segundos}s ultrapassa duracao real ` +
          `${videoDuration}s. Ajustando para ${videoDuration}s.`,
        );
        body.video_end_segundos = videoDuration;
      }
    }

    writeFileSync(scenesPath, JSON.stringify(body, null, 2), "utf-8");
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
