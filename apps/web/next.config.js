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
      // a cada ~800ms, mais o render-<fmt>.log, os mp4 de saida e os inserts.
      //
      // Cada escrita acorda o watcher. O resultado era recompilacao continua
      // durante o render e, quando o Fast Refresh nao conseguia aplicar a
      // quente, um RELOAD COMPLETO do navegador - que jogava o usuario de volta
      // para a home no meio da exportacao. Nada aqui e codigo-fonte: e tudo dado
      // de trabalho, entao ignorar e seguro.
      //
      // ATENCAO AO FORMATO DOS PADROES (bug de 2026-09-04):
      // o watchpack converte cada string de `ignored` em RegExp tratando-a como
      // glob POSIX. Um caminho do Windows vindo de path.resolve() chega com
      // barras invertidas, que viram escapes na regex:
      //   C:\Repos\...\jobs\**  ->  /^C:\Repos\...\jobs\([^/]*)$/
      // O `\(` deixa de abrir grupo e a expressao estoura com "Unmatched ')'",
      // em TODA chamada de watch: uncaughtException em rajada, e o ignore nunca
      // chega a valer. Por isso a normalizacao para barras normais abaixo -
      // ela nao e cosmetica.
      const raizPosix = path.resolve(__dirname, "../..").replace(/\\/g, "/");
      const pastasDeTrabalho = [
        `${raizPosix}/jobs/**`,
        `${raizPosix}/jobs-instance*/**`,
        `${raizPosix}/.transcript-cache/**`,
        `${raizPosix}/exports/**`,
        `${raizPosix}/_to_delete/**`,
      ];

      // Preserva o que o Next ja ignorava (.git, node_modules, .next) em vez de
      // substituir. So acrescenta quando o valor existente e uma lista de
      // strings; se for funcao ou RegExp, mistura-los num array seria invalido,
      // entao nesse caso deixamos o do Next em paz e nao aplicamos o nosso.
      const anterior = config.watchOptions?.ignored;
      const base = typeof anterior === "string"
        ? [anterior]
        : Array.isArray(anterior) && anterior.every((x) => typeof x === "string")
          ? anterior
          : null;

      config.watchOptions = {
        ...config.watchOptions,
        ...(base ? { ignored: [...base, ...pastasDeTrabalho] } : {}),
        // Junta rajadas de eventos numa recompilacao so.
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
