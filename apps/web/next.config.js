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

  webpack(config) {
    // Garante que @pontob/schema resolve para o pacote do monorepo,
    // mesmo quando importado de arquivos fora de apps/web (ex: services/analysis)
    config.resolve.alias = {
      ...config.resolve.alias,
      "@pontob/schema": path.resolve(__dirname, "../../packages/schema"),
    };
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
