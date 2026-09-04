/**
 * POST /api/jobs/[jobId]/logo  — recebe a logo do CTA (multipart) e salva no job.
 * GET  /api/jobs/[jobId]/logo  — serve a logo salva.
 */
import { NextRequest } from "next/server";
import { writeFile, readFile } from "node:fs/promises";
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";

import { acharJobDir, jobDirOuLocal, REPO_ROOT } from "@/lib/jobsDir";

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".gif": "image/gif",
};

export async function POST(req: NextRequest, { params }: { params: { jobId: string } }) {
  const { jobId } = params;
  const jobDir = jobDirOuLocal(jobId);
  if (!existsSync(jobDir)) return new Response(JSON.stringify({ error: "Job nao encontrado" }), { status: 404 });

  const form = await req.formData();
  const file = form.get("logo") as File | null;
  if (!file) return new Response(JSON.stringify({ error: "Logo nao enviada" }), { status: 400 });

  const ext = path.extname(file.name || "").toLowerCase();
  const safeExt = MIME[ext] ? ext : ".png";
  for (const f of readdirSync(jobDir)) {
    if (/^logo\./i.test(f)) { try { unlinkSync(path.join(jobDir, f)); } catch { /* ignore */ } }
  }
  const buf = Buffer.from(await file.arrayBuffer());
  await writeFile(path.join(jobDir, "logo" + safeExt), buf);
  return Response.json({ logo_url: `/api/jobs/${jobId}/logo` });
}

export async function GET(_req: NextRequest, { params }: { params: { jobId: string } }) {
  const { jobId } = params;
  const jobDir = jobDirOuLocal(jobId);
  const f = existsSync(jobDir) ? readdirSync(jobDir).find((n) => /^logo\./i.test(n)) : null;
  if (!f) return new Response(JSON.stringify({ error: "Logo nao encontrada" }), { status: 404 });
  const buf = await readFile(path.join(jobDir, f));
  const ext = path.extname(f).toLowerCase();
  return new Response(new Uint8Array(buf), { status: 200, headers: { "Content-Type": MIME[ext] ?? "image/png", "Cache-Control": "no-store" } });
}
