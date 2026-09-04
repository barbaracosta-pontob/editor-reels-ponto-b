/**
 * GET /api/jobs/[jobId]
 * Retorna os dados de um job processado, incluindo duracao real do video.
 */

import { NextRequest, NextResponse } from "next/server";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { getVideoDuration } from "../../../../lib/video-duration";

import { acharJobDir, jobDirOuLocal, REPO_ROOT } from "@/lib/jobsDir";

export async function GET(
  _req: NextRequest,
  { params }: { params: { jobId: string } }
) {
  const { jobId } = params;
  const jobDir = jobDirOuLocal(jobId);
  const scenesPath = path.join(jobDir, "scenes.json");

  if (!existsSync(scenesPath)) {
    return NextResponse.json({ error: "Job nao encontrado" }, { status: 404 });
  }

  try {
    const scenes = JSON.parse(readFileSync(scenesPath, "utf-8"));

    let fileName = "";
    let createdAt = "";

    try {
      const files = readdirSync(jobDir);
      const mp4 = files.find((f) => f.endsWith(".mp4"));
      if (mp4) fileName = mp4;
    } catch {}

    try {
      createdAt = statSync(scenesPath).mtime.toISOString();
    } catch {}

    const videoPath = path.join(jobDir, fileName);
    const transcriptPath = path.join(jobDir, "transcript.json");
    const outputPath = path.join(jobDir, "out", "reel.mp4");

    const videoDuration = await getVideoDuration(videoPath);

    return NextResponse.json({
      id: jobId,
      fileName,
      videoPath,
      transcriptPath,
      scenesPath,
      status: "ready",
      scenes,
      outputPath: existsSync(outputPath) ? outputPath : null,
      error: null,
      createdAt,
      especialista_slug: scenes.especialista_slug ?? "generico",
      videoDuration,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
