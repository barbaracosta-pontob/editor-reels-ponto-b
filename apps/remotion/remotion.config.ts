import { Config } from "@remotion/cli/config";
import os from "os";
import path from "path";

/**
 * Concorrencia do render: quantas abas do Chromium renderizam frames em
 * paralelo.
 *
 * POR QUE MUDOU (2026-09-03)
 * --------------------------
 * Estava fixo em 1 - ou seja, o render usava UM nucleo, independente do
 * tamanho da maquina. Num processador de 8 nucleos isso e 1/4 da capacidade
 * disponivel (o default do Remotion e cerca de metade dos nucleos).
 *
 * Agora e derivado da maquina, com dois limites de seguranca:
 * - piso 1, para nao quebrar em maquina de 1-2 nucleos;
 * - teto 4, porque cada aba carrega o video decodificado em memoria e as
 *   composicoes deste projeto usam OffthreadVideo com varios inserts; subir
 *   demais troca CPU por swap e fica mais lento, nao mais rapido.
 *
 * REMOTION_CONCURRENCY sobrescreve para calibrar sem mexer no codigo. Se um
 * render comecar a estourar memoria, baixe por ali antes de mexer aqui.
 */
const nucleos = os.cpus().length || 2;
const concorrenciaEnv = parseInt(process.env.REMOTION_CONCURRENCY ?? "", 10);
const concorrencia = Number.isFinite(concorrenciaEnv) && concorrenciaEnv > 0
  ? concorrenciaEnv
  : Math.max(1, Math.min(4, Math.floor(nucleos / 2)));

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
Config.setConcurrency(concorrencia);
Config.setCodec("h264");

// Serve arquivos estáticos (vídeos dos jobs) durante o render
// Vídeos copiados para apps/remotion/public/jobs/<jobId>/ ficam acessíveis
// como URLs relativas: /jobs/<jobId>/video.mp4
Config.setPublicDir(path.join(__dirname, "public"));

// Resolve @pontob/schema diretamente para o arquivo fonte TypeScript.
// __dirname pode ser instável dependendo de como o bundler carrega o config,
// então ancoramos pelo cwd (raiz do monorepo quando rodado via npm workspace).
Config.overrideWebpackConfig((config) => {
  // cwd = apps/remotion quando chamado pelo CLI do Remotion
  const schemaPath = path.resolve(process.cwd(), "../../packages/schema/scenes.ts");
  return {
    ...config,
    resolve: {
      ...config.resolve,
      alias: {
        ...((config.resolve?.alias as Record<string, string>) ?? {}),
        "@pontob/schema": schemaPath,
      },
    },
  };
});
