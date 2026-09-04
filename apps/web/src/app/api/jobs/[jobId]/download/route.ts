/**
 * GET /api/jobs/[jobId]/download?format=reels|wide|square
 * Serve o mp4 gerado para download no browser.
 * Se format nao for passado, tenta reel_reels.mp4, depois reel.mp4 (legado).
 */

import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { acharJobDir, jobDirOuLocal, REPO_ROOT } from "@/lib/jobsDir";

const VALID_FORMATS = ["reels", "wide", "square"] as const;
type FormatKey = typeof VALID_FORMATS[number];

export async function GET(
  req: NextRequest,
  { params }: { params: { jobId: string } }
) {
  const { jobId } = params;
  const jobDir = acharJobDir(jobId);
  if (!jobDir) {
    return NextResponse.json({ error: "Job nao encontrado" }, { status: 404 });
  }
  const outDir = path.join(jobDir, "out");

  const formatParam = req.nextUrl.searchParams.get("format") as FormatKey | null;

  // Candidatos em ordem de prioridade
  const candidates: { file: string; name: string }[] = [];

  if (formatParam && VALID_FORMATS.includes(formatParam)) {
    candidates.push({ file: `reel_${formatParam}.mp4`, name: `reel_${formatParam}.mp4` });
    // Compatibilidade com renders antigos onde a key "reels" gerava
    // `reel_reel.mp4` (suffix singular) em vez de `reel_reels.mp4`.
    if (formatParam === "reels") {
      candidates.push({ file: "reel_reel.mp4", name: "reel_reels.mp4" });
    }
  }

  // Fallbacks finais para compatibilidade com renders muito antigos
  candidates.push(
    { file: "reel_reels.mp4", name: "reel_reels.mp4" },
    { file: "reel_reel.mp4",  name: "reel_reels.mp4" },
    { file: "reel.mp4",       name: "reel.mp4" },
  );

  const found = candidates.find((c) => existsSync(path.join(outDir, c.file)));

  if (!found) {
    return NextResponse.json({ error: "Arquivo nao encontrado" }, { status: 404 });
  }

  const filePath = path.join(outDir, found.file);
  const buffer = await readFile(filePath);

  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Disposition": `attachment; filename="${found.name}"`,
      "Content-Length": String(buffer.length),
    },
  });
}
