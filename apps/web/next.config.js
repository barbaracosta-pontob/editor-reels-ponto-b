/** @type {import('next').NextConfig} */
// Suprime o detector de lockfile do Next.js que falha em monorepos npm workspaces
process.env.NEXT_IGNORE_INCORRECT_LOCKFILE = "1";

const path = require("path");

// Carrega o .env da raiz do monorepo (dois níveis acima de apps/web)
// O Next.js por padrão só lê .env dentro do seu próprio diretório;
// em monorepos o .env fica na raiz, então precisamos carregá-lo explicitamente.
require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: false });

const nextConfig = {
  transpilePackages: ["@pontob/schema", "@remotion/player", "remotion"],
  distDir: process.env.NEXT_DIST_DIR || ".next",

  webpack(config, { dev }) {
    // Garante que @pontob/schema resolve para o pacote do monorepo,
    // mesmo quando importado de arquivos fora de apps/web (ex: services/analysis)
    config.resolve.alias = {
      ...config.resolve.alias,
      "@pontob/schema": path.resolve(__dirname, "../../packages/schema"),
    };

    if (dev) {
      // O watcher do webpack observa o repo inteiro, e o pipeline escreve MUITO
      // dentro dele durante um render: jobs/<id>/render-status.json e reescrito
      // a cada ~400ms (mais de 2000 vezes num render de 15 min), mais o
      // render-<fmt>.log, os mp4 de saida e os inserts baixados.
      //
      // Cada uma dessas escritas acorda o watcher. O resultado era recompilacao
      // continua durante o render e, quando o Fast Refresh nao conseguia aplicar
      // a quente, um RELOAD COMPLETO do navegador - que jogava o usuario de volta
      // para a home no meio da exportacao, porque o job aberto vive so na memoria
      // do React. O aviso "Fast Refresh had to perform a full reload" no console
      // e o sintoma.
      //
      // Nada aqui e codigo-fonte: sao dados de trabalho. Ignorar e seguro e tira
      // o render do caminho do watcher.
      const ignorados = [
        "**/.git/**",
        "**/node_modules/**",
        path.resolve(__dirname, "../../jobs/**"),
        path.resolve(__dirname, "../../jobs-instance*/**"),
        path.resolve(__dirname, "../../.transcript-cache/**"),
        path.resolve(__dirname, "../../exports/**"),
        path.resolve(__dirname, "../../_to_delete/**"),
      ];
      config.watchOptions = {
        ...config.watchOptions,
        ignored: ignorados,
        // Junta rajadas de eventos numa recompilacao so, em vez de uma por
        // arquivo tocado.
        aggregateTimeout: 400,
      };
    }

    return config;
  },

  async headers() {
    return [
      {
        source: "/icon.png",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400" }],
      },
      {
        source: "/favicon.ico",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400" }],
      },
    ];
  },

  async rewrites() {
    return [
      {
        source: "/icon.png",
        destination: "/api/static/icon",
      },
      {
        source: "/favicon.ico",
        destination: "/api/static/favicon",
      },
    ];
  },
};

module.exports = nextConfig;
