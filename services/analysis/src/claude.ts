import Anthropic from "@anthropic-ai/sdk";
import { ZodError } from "zod";

import { ReelPropsSchema, type ReelProps, PlanoInsertsSchema, type InsertPlanoItem } from "@pontob/schema";
import { SYSTEM_PROMPT, REFINE_SYSTEM_PROMPT, buildUserPrompt, buildRefinePrompt, PROMPT_VERSION, SYSTEM_PROMPT_INSERTS, buildInsertPrompt } from "./prompt";

const DEFAULT_MODEL = process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6";
// O prompt pede um bloco <analise>/<diagnostico> extenso (chain-of-thought) ANTES do JSON.
// Esse raciocinio sozinho consome ~2.5-3k tokens; somado ao JSON de 9-15 cenas, 4096 estoura
// e o JSON e truncado no meio (stop_reason "max_tokens") -> JSON.parse falha -> "JSON invalido".
// Orcamento generoso + escalonamento por tentativa evitam o corte.
const MAX_TOKENS = 16000;
// Refine escreve um bloco <diagnostico> LONGO (chain-of-thought) antes do JSON.
// Em vídeos longos isso truncava a resposta (stop_reason=max_tokens) nas 1as
// tentativas, gastando-as à toa. Orçamento inicial maior evita o corte e deixa
// o retry-com-feedback corrigir erros de schema de verdade. Escalona +8k/tentativa.
const MAX_TOKENS_REFINE = 32000;

export type AnalyzeParams = {
  transcript: object;
  videoOriginalPath: string;
  /**
   * Duracao real do arquivo de video em segundos (obtida via ffprobe).
   * Quando informada, e usada como teto duro: nenhuma cena pode estender
   * o reel alem desse limite. Sem esse valor, o limite fisico nao e aplicado
   * — o agente pode gerar timeline alem do conteudo do video.
   */
  videoDuration?: number;
  especialista: {
    nome: string;
    cargo: string;
    area_atuacao?: string;
    publico_alvo?: string;
    tom_de_voz?: string;
    vocabulario_prioritario?: Array<{ termo: string; tipo: "bandeira" | "jargao" }>;
    palavras_a_evitar?: string[];
    cta_padrao?: {
      formato: string;
      palavra_ou_evento?: string;
      texto_secundario?: string;
    };
    identidade_visual?: {
      cor_destaque_primaria?: string;
      cor_destaque_secundaria?: string;
    };
    metricas_referencia?: Array<{ nome: string; unidade: string; contexto?: string }>;
    observacoes?: string;
  };
  brief?: string;
  /**
   * Quando true, a edicao sera em "modo legenda": o prompt orienta o agente a
   * usar VideoSimples como base (para a legenda continua aparecer por cima) e
   * cenas graficas apenas nos picos. Ver buildUserPrompt.
   */
  legenda?: boolean;
};

export type AnalyzeResult = {
  scenes: ReelProps;
  metadata: {
    promptVersion: string;
    model: string;
    tentativas: number;
    tokens: {
      input: number;
      output: number;
      cacheRead: number;
      cacheCreation: number;
    };
  };
};

/** Remove markdown fence caso Claude envolva o JSON em ```json ... ``` */
function stripMarkdownFence(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

/**
 * Remove blocos de analise/diagnostico (<analise> ou <diagnostico>) que o Claude
 * escreve antes do JSON quando instruido a pensar em voz alta.
 * Retorna apenas o JSON.
 */
function stripAnalysisBlock(text: string): string {
  const stripped = text
    .replace(/<analise>[\s\S]*?<\/analise>/gi, "")
    .replace(/<diagnostico>[\s\S]*?<\/diagnostico>/gi, "")
    .trim();
  const jsonStart = stripped.indexOf("{");
  if (jsonStart === -1) return stripped;
  return stripped.slice(jsonStart);
}

// ── Cobertura do CTA até o fim da última fala ────────────────────────────────
// Garante que o reel nunca encerre antes do mentor parar de falar.
// Usa o end do último segmento do transcript como referência — não a duração
// total do arquivo, que pode ter silêncio/respiro após a fala.
//
// Lógica: calcula a posição de início do CTA (soma das durações anteriores
// + start_segundos da cena com vídeo que inicia o "relógio"), depois verifica
// se startCTA + duracaoCTA cobre fimUltimaFala + buffer.

type SegLike = { start: number; end: number };

function corrigirCoberturaCta(scenes: ReelProps, transcript: object): ReelProps {
  const t = transcript as Record<string, unknown>;
  const segs = Array.isArray(t.segments) ? (t.segments as SegLike[]) : [];
  if (!segs.length) return scenes;

  const fimUltimaFala = segs[segs.length - 1].end;
  const buffer = 0.5;

  const scenesRaw = scenes as Record<string, unknown>;
  const videoStart: number = typeof scenesRaw.video_start_segundos === "number"
    ? scenesRaw.video_start_segundos as number
    : 0;

  const cenas = [...scenes.cenas];
  const ultimaIdx = cenas.length - 1;
  const ultima = cenas[ultimaIdx];
  if (ultima.tipo !== "CTA") return scenes;

  // Detecta início da fala do CTA: último segmento de fala que NÃO é encerramento puro
  // ("Eu te vejo lá", "Até lá") — queremos o start do bloco do CTA completo
  const falaCtaIdx = (() => {
    // Procura o segmento mais cedo que contém palavras típicas de CTA
    const ctaKeywords = ["clique", "coment", "garanta", "acesse", "inscreva", "aperte", "arrasta", "link"];
    for (let i = 0; i < segs.length; i++) {
      const text = segs[i].text.toLowerCase();
      if (ctaKeywords.some(k => text.includes(k))) return i;
    }
    // fallback: dois últimos segmentos
    return Math.max(0, segs.length - 2);
  })();

  const startFalaCta = segs[falaCtaIdx].start;
  const fimNecessario = fimUltimaFala + buffer;

  // pos_CTA atual = videoStart + soma das durações antes do CTA
  const somaAnteCTA = cenas.slice(0, ultimaIdx).reduce((acc, c) => acc + c.duracao_segundos, 0);
  const posCTAAtual = videoStart + somaAnteCTA;

  // Gap entre onde o CTA começa e onde deveria começar
  const gap = startFalaCta - posCTAAtual; // positivo = CTA começa cedo demais

  const duracaoCtaCorreta = Math.max(4, Math.round((fimNecessario - startFalaCta) * 10) / 10);

  if (Math.abs(gap) < 1 && Math.abs(ultima.duracao_segundos - duracaoCtaCorreta) < 1) {
    return scenes; // tudo ok
  }

  console.log(`[corrigirCoberturaCta] startFalaCta=${startFalaCta.toFixed(2)}s posCTA=${posCTAAtual.toFixed(2)}s gap=${gap.toFixed(2)}s | CTA: ${ultima.duracao_segundos}s -> ${duracaoCtaCorreta}s`);

  // Ajusta a última cena ANTES do CTA para preencher o gap
  // (tipicamente ConviteEvento ou último overlay)
  if (Math.abs(gap) >= 1 && ultimaIdx > 0) {
    const penultimaIdx = ultimaIdx - 1;
    const penultima = cenas[penultimaIdx];
    const novaDuracaoPenultima = Math.max(1, Math.round((penultima.duracao_segundos + gap) * 10) / 10);
    console.log(`[corrigirCoberturaCta] expandindo cena ${penultimaIdx + 1} (${penultima.tipo}): ${penultima.duracao_segundos}s -> ${novaDuracaoPenultima}s`);
    cenas[penultimaIdx] = { ...penultima, duracao_segundos: novaDuracaoPenultima };
  }

  // Corrige duração do CTA
  cenas[ultimaIdx] = { ...ultima, duracao_segundos: duracaoCtaCorreta };

  const novaSoma = cenas.reduce((acc, c) => acc + c.duracao_segundos, 0);
  return {
    ...scenes,
    cenas,
    duracao_total_estimada: Math.round(novaSoma * 10) / 10,
  };
}

// ── Clamp duro: timeline nunca passa do fim do arquivo de video ──────────────
// Mesmo com o prompt corrigido, mantemos esta rede de seguranca para qualquer
// regressao futura ou tentativa em que o agente erre.
//
// Regras:
//   1. video_end_segundos <= videoDuration.
//   2. video_start_segundos + soma(duracao_segundos) <= videoDuration.
// Se (2) for violada, encolhemos cenas a partir do fim, preservando o CTA
// quando possivel (CTA cobre a fala de chamada — se cortar, perde a mensagem
// central do reel). So mexemos no CTA se nao houver mais nada para encolher.

function clampReelToVideoDuration(scenes: ReelProps, videoDuration?: number): ReelProps {
  if (!videoDuration || videoDuration <= 0) return scenes;

  const scenesRaw = scenes as Record<string, unknown>;
  const videoStart: number = typeof scenesRaw.video_start_segundos === "number"
    ? scenesRaw.video_start_segundos as number
    : 0;

  const availableWindow = Math.max(0, videoDuration - videoStart);
  const somaCenas = scenes.cenas.reduce((acc, c) => acc + c.duracao_segundos, 0);

  // Tolerancia de arredondamento: 0.1s.
  const excesso = somaCenas - availableWindow;
  if (excesso <= 0.1) {
    // Soma ja cabe — apenas garante que video_end_segundos respeita o teto.
    const endAtual = typeof scenesRaw.video_end_segundos === "number"
      ? scenesRaw.video_end_segundos as number
      : videoStart + somaCenas;
    const endClampado = Math.min(endAtual, videoDuration);
    if (Math.abs(endClampado - endAtual) < 0.05) return scenes;
    return {
      ...scenes,
      video_end_segundos: Math.round(endClampado * 10) / 10,
      duracao_total_estimada: Math.round(somaCenas * 10) / 10,
    } as ReelProps;
  }

  console.warn(
    `[clampReelToVideoDuration] sequencia excede o video em ${excesso.toFixed(2)}s ` +
    `(soma=${somaCenas.toFixed(2)}s, janela disponivel=${availableWindow.toFixed(2)}s, ` +
    `videoDuration=${videoDuration}s, video_start=${videoStart}s). Encolhendo cenas a partir do fim.`,
  );

  const cenas = [...scenes.cenas];
  let restante = excesso;

  // Indice da ultima cena nao-CTA — tentamos encolher essas primeiro.
  const ultimaNaoCtaIdx = (() => {
    for (let i = cenas.length - 1; i >= 0; i--) {
      if (cenas[i].tipo !== "CTA") return i;
    }
    return -1;
  })();

  // Estrategia: percorre do fim pro inicio, encolhendo cenas (exceto CTA) ate
  // zerar o excesso. Cada cena tem uma duracao minima de 1s para nao virar nada.
  const MIN_DURACAO = 1.0;
  for (let i = cenas.length - 1; i >= 0 && restante > 0.05; i--) {
    const cena = cenas[i];
    if (cena.tipo === "CTA" && ultimaNaoCtaIdx !== -1) continue; // pula CTA enquanto houver outras cenas
    const podeReduzir = Math.max(0, cena.duracao_segundos - MIN_DURACAO);
    const reduzir = Math.min(podeReduzir, restante);
    if (reduzir <= 0) continue;
    const novaDur = Math.round((cena.duracao_segundos - reduzir) * 10) / 10;
    cenas[i] = { ...cena, duracao_segundos: novaDur };
    restante = Math.round((restante - reduzir) * 10) / 10;
    console.warn(
      `[clampReelToVideoDuration] cena #${i + 1} (${cena.tipo}): ${cena.duracao_segundos}s -> ${novaDur}s ` +
      `(reduziu ${reduzir.toFixed(2)}s, restante ${restante.toFixed(2)}s)`,
    );
  }

  // Se ainda sobrou excesso, encolhe o CTA tambem (ultimo recurso).
  if (restante > 0.05) {
    const ctaIdx = cenas.findIndex((c) => c.tipo === "CTA");
    if (ctaIdx !== -1) {
      const cta = cenas[ctaIdx];
      const podeReduzir = Math.max(0, cta.duracao_segundos - MIN_DURACAO);
      const reduzir = Math.min(podeReduzir, restante);
      const novaDur = Math.round((cta.duracao_segundos - reduzir) * 10) / 10;
      cenas[ctaIdx] = { ...cta, duracao_segundos: novaDur };
      restante = Math.round((restante - reduzir) * 10) / 10;
      console.warn(
        `[clampReelToVideoDuration] CTA encolhido em ultimo recurso: ${cta.duracao_segundos}s -> ${novaDur}s`,
      );
    }
  }

  if (restante > 0.05) {
    console.warn(
      `[clampReelToVideoDuration] AINDA sobram ${restante.toFixed(2)}s mesmo apos encolher tudo. ` +
      `Reel pode ter trecho preto/congelado no final.`,
    );
  }

  const novaSoma = cenas.reduce((acc, c) => acc + c.duracao_segundos, 0);
  const novoEnd = Math.min(videoDuration, Math.round((videoStart + novaSoma) * 10) / 10);

  return {
    ...scenes,
    cenas,
    duracao_total_estimada: Math.round(novaSoma * 10) / 10,
    video_end_segundos: novoEnd,
  } as ReelProps;
}

// ── Defaults de SFX por tipo de cena ─────────────────────────────────────────
// Aplicados programaticamente após validação Zod — não dependem do Claude decidir.

const SFX_DEFAULT: Record<string, string> = {
  Hook:               "sfx/whoosh.mp3",
  FraseImpacto:       "sfx/transition.mp3",
  ComparativoNumerico:"sfx/ding.mp3",
  GraficoBarra:       "sfx/slide.mp3",
  GraficoLinha:       "sfx/slide.mp3",
  VideoCitacao:       "sfx/slide.mp3",
  ListaPontos:        "sfx/pop.mp3",
  MiniCaso:           "sfx/ding.mp3",
  TransicaoTexto:     "sfx/transition.mp3",
  ConviteEvento:      "sfx/slide.mp3",
  CTA:                "sfx/transition.mp3",
};

function aplicarSfxDefaults(scenes: ReelProps): ReelProps {
  return {
    ...scenes,
    cenas: scenes.cenas.map((cena) => {
      if (cena.sfx) return cena; // já tem sfx — respeita a escolha
      const path = SFX_DEFAULT[cena.tipo];
      if (!path) return cena;
      return { ...cena, sfx: { path, volume: 2 } } as typeof cena;
    }),
  };
}

export class AnalysisError extends Error {
  constructor(
    message: string,
    public readonly tentativas: number,
    public readonly ultimaResposta?: string,
    public readonly zodError?: ZodError,
  ) {
    super(message);
    this.name = "AnalysisError";
  }
}

/**
 * Roda analise da transcricao com Claude e retorna JSON validado.
 * 3 tentativas, temperatura caindo (0.4 -> 0.2 -> 0.0).
 */
export async function analyze(
  params: AnalyzeParams,
  options: { model?: string; apiKey?: string } = {},
): Promise<AnalyzeResult> {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY nao definido. Passe via env ou options.apiKey");
  }

  const client = new Anthropic({ apiKey });
  const model = options.model ?? DEFAULT_MODEL;
  const userPrompt = buildUserPrompt({
    transcript: params.transcript,
    videoOriginalPath: params.videoOriginalPath,
    especialista: params.especialista,
    brief: params.brief,
    legenda: params.legenda,
  });

  const tokensAcumulados = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
  };

  const temperaturas = [0.4, 0.2, 0.0];
  let ultimaResposta = "";
  let ultimoErroZod: ZodError | undefined;

  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    const temperature = temperaturas[tentativa - 1];

    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: userPrompt,
      },
    ];

    if (tentativa > 1 && ultimoErroZod) {
      messages.push({
        role: "assistant",
        content: ultimaResposta,
      });
      messages.push({
        role: "user",
        content: `O JSON anterior falhou na validacao Zod com este erro:\n\n${ultimoErroZod.errors
          .map((e) => `- ${e.path.join(".")}: ${e.message}`)
          .join("\n")}\n\nCorrija e retorne apenas o JSON valido.`,
      });
    }

    // Escalona o orcamento a cada tentativa: se a anterior truncou, a proxima tem mais folga.
    const maxTokens = MAX_TOKENS + (tentativa - 1) * 8000;

    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages,
    });

    tokensAcumulados.input += response.usage.input_tokens;
    tokensAcumulados.output += response.usage.output_tokens;
    tokensAcumulados.cacheRead += response.usage.cache_read_input_tokens ?? 0;
    tokensAcumulados.cacheCreation += response.usage.cache_creation_input_tokens ?? 0;

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new AnalysisError(
        "Resposta do Claude nao tem bloco de texto",
        tentativa,
      );
    }
    ultimaResposta = textBlock.text;

    // Truncamento por limite de tokens: o JSON foi cortado no meio. Retentar com o mesmo
    // orcamento so repetiria o corte — a proxima iteracao ja escalona max_tokens.
    if (response.stop_reason === "max_tokens") {
      console.error(
        `[analyze] tentativa ${tentativa}: resposta TRUNCADA (stop_reason=max_tokens, ` +
        `max_tokens=${maxTokens}, output=${response.usage.output_tokens}). ` +
        `O bloco <analise> consumiu o orcamento antes de fechar o JSON. Escalando na proxima tentativa...`,
      );
      ultimoErroZod = undefined;
      continue;
    }

    // Remove bloco <analise> (chain-of-thought) e markdown, extrai JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripMarkdownFence(stripAnalysisBlock(ultimaResposta)));
    } catch (err) {
      console.error(
        `[analyze] tentativa ${tentativa}: JSON invalido, retentando...`,
      );
      continue;
    }

    const validation = ReelPropsSchema.safeParse(parsed);
    if (validation.success) {
      const somaReal = validation.data.cenas.reduce(
        (acc, cena) => acc + cena.duracao_segundos,
        0,
      );
      const scenesComSfx = aplicarSfxDefaults({
        ...validation.data,
        duracao_total_estimada: Math.round(somaReal * 10) / 10,
      });
      const scenesNormalizados = corrigirCoberturaCta(scenesComSfx, params.transcript);
      // Rede de seguranca: garante que o reel nunca extrapola a duracao real do arquivo.
      const scenesClampados = clampReelToVideoDuration(scenesNormalizados, params.videoDuration);

      return {
        scenes: scenesClampados,
        metadata: {
          promptVersion: PROMPT_VERSION,
          model,
          tentativas: tentativa,
          tokens: tokensAcumulados,
        },
      };
    }

    console.error(
      `[analyze] tentativa ${tentativa}: schema invalido (${validation.error.errors.length} erros): ` +
      validation.error.errors.slice(0, 10).map((e) => `${e.path.join(".") || "(raiz)"}: ${e.message}`).join(" | "),
    );
    ultimoErroZod = validation.error;
  }

  throw new AnalysisError(
    `Falha apos 3 tentativas. Ultimo erro Zod: ${
      ultimoErroZod?.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ") ?? "desconhecido"
    }`,
    3,
    ultimaResposta,
    ultimoErroZod,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Plano de inserts — formato "Tela dividida"
// ─────────────────────────────────────────────────────────────────────────────

export type PlanejarInsertsParams = {
  transcript: object;
  videoDuration?: number;
  /** Direcionamento de imagem do editor (brief). Orientação, não obrigação. */
  brief?: string;
};

/**
 * Pede ao Claude o plano de inserts (blocos de assunto + termo de busca) para
 * o formato tela dividida. Não gera cenas. Valida com PlanoInsertsSchema e
 * clampa os tempos pela duração real do vídeo.
 */
export async function planejarInserts(
  params: PlanejarInsertsParams,
  options: { model?: string; apiKey?: string } = {},
): Promise<{ inserts: InsertPlanoItem[] }> {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY nao definido. Passe via env ou options.apiKey");
  }

  const client = new Anthropic({ apiKey });
  const model = options.model ?? DEFAULT_MODEL;
  // Busca de dado recente (overlay de texto): opcional, ligada por env, pois exige
  // a ferramenta web_search habilitada na conta Anthropic e adiciona custo/latencia.
  let usarBuscaDados = process.env.INSERTS_DADOS_RECENTES === "1";
  const userPrompt = buildInsertPrompt({ transcript: params.transcript, brief: params.brief, permitirBuscaDados: usarBuscaDados });

  // Ferramenta de busca web nativa (server tool). Tipo derivado do SDK p/ nao
  // depender da versao exata. Traz dado/fato recente e verificavel (nao imagem).
  const webSearchTool = { type: "web_search_20250305", name: "web_search", max_uses: 2 };

  const temperaturas = [0.4, 0.2, 0.0];
  let ultimaResposta = "";
  let ultimoErroZod: ZodError | undefined;

  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: userPrompt }];
    if (tentativa > 1 && ultimoErroZod) {
      messages.push({ role: "assistant", content: ultimaResposta });
      messages.push({
        role: "user",
        content: `O JSON anterior falhou na validacao Zod com este erro:\n\n${ultimoErroZod.errors
          .map((e) => `- ${e.path.join(".")}: ${e.message}`)
          .join("\n")}\n\nCorrija e retorne apenas o JSON valido.`,
      });
    }

    const baseParams = {
      model,
      max_tokens: 8000,
      temperature: temperaturas[tentativa - 1],
      system: [{ type: "text" as const, text: SYSTEM_PROMPT_INSERTS, cache_control: { type: "ephemeral" as const } }],
      messages,
    };

    let response;
    try {
      response = await client.messages.create(
        usarBuscaDados
          ? { ...baseParams, tools: [webSearchTool] as unknown as Anthropic.MessageCreateParamsNonStreaming["tools"] }
          : baseParams,
      );
    } catch (err) {
      // web_search pode nao estar habilitada na conta: segue sem a ferramenta.
      if (usarBuscaDados) {
        console.warn("[planejarInserts] busca web indisponivel, seguindo sem dado recente:", err);
        usarBuscaDados = false;
        response = await client.messages.create(baseParams);
      } else {
        throw err;
      }
    }

    // Com a ferramenta de busca, a resposta pode ter blocos de tool antes do texto
    // final — pega o ULTIMO bloco de texto (o JSON), nao o primeiro.
    const textos = response.content.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text");
    const textBlock = textos[textos.length - 1];
    if (!textBlock) {
      throw new AnalysisError("Resposta do Claude nao tem bloco de texto", tentativa);
    }
    ultimaResposta = textBlock.text;

    if (response.stop_reason === "max_tokens") {
      ultimoErroZod = undefined;
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripMarkdownFence(stripAnalysisBlock(ultimaResposta)));
    } catch {
      continue;
    }

    const validation = PlanoInsertsSchema.safeParse(parsed);
    if (validation.success) {
      let inserts = validation.data.inserts;
      const dur = params.videoDuration;
      if (dur && dur > 0) {
        inserts = inserts
          .map((i) => ({ ...i, inicio: Math.min(i.inicio, dur), fim: Math.min(i.fim, dur) }))
          .filter((i) => i.fim > i.inicio);
      }
      return { inserts };
    }

    ultimoErroZod = validation.error;
  }

  throw new AnalysisError(
    `Falha ao planejar inserts apos 3 tentativas. Ultimo erro: ${
      ultimoErroZod?.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ") ?? "desconhecido"
    }`,
    3,
    ultimaResposta,
    ultimoErroZod,
  );
}

// Refinamento

export type RefineParams = {
  transcript: object;
  videoOriginalPath: string;
  /**
   * Duracao real do arquivo de video em segundos (obtida via ffprobe).
   * Mesma semantica de AnalyzeParams.videoDuration: teto duro para o reel.
   */
  videoDuration?: number;
  cenasAtuais: object;
  brief?: string;
  especialista: {
    nome: string;
    cargo: string;
    area_atuacao?: string;
    identidade_visual?: {
      cor_destaque_primaria?: string;
      cor_destaque_secundaria?: string;
    };
    observacoes?: string;
  };
};

/**
 * Avalia a sequencia de cenas atual + transcricao e devolve uma versao melhorada.
 */
export async function refine(
  params: RefineParams,
  options: { model?: string; apiKey?: string } = {},
): Promise<AnalyzeResult> {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY nao definido.");

  const client = new Anthropic({ apiKey });
  const model = options.model ?? DEFAULT_MODEL;

  const userPrompt = buildRefinePrompt({
    transcript: params.transcript,
    videoOriginalPath: params.videoOriginalPath,
    cenatAtual: params.cenasAtuais,
    especialista: params.especialista,
    brief: params.brief,
  });

  const tokensAcumulados = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  const temperaturas = [0.3, 0.1, 0.0];
  let ultimaResposta = "";
  let ultimoErroZod: ZodError | undefined;

  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: userPrompt }];

    if (tentativa > 1 && ultimoErroZod) {
      messages.push({ role: "assistant", content: ultimaResposta });
      messages.push({
        role: "user",
        content: `O JSON anterior falhou na validacao:\n\n${ultimoErroZod.errors
          .map((e) => `- ${e.path.join(".")}: ${e.message}`)
          .join("\n")}\n\nCorrija e retorne apenas o JSON valido.`,
      });
    }

    const maxTokens = MAX_TOKENS_REFINE + (tentativa - 1) * 8000;

    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      temperature: temperaturas[tentativa - 1],
      system: [{ type: "text", text: REFINE_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages,
    });

    tokensAcumulados.input += response.usage.input_tokens;
    tokensAcumulados.output += response.usage.output_tokens;
    tokensAcumulados.cacheRead += response.usage.cache_read_input_tokens ?? 0;
    tokensAcumulados.cacheCreation += response.usage.cache_creation_input_tokens ?? 0;

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") throw new AnalysisError("Resposta sem texto", tentativa);
    ultimaResposta = textBlock.text;

    if (response.stop_reason === "max_tokens") {
      console.error(
        `[refine] tentativa ${tentativa}: resposta TRUNCADA (stop_reason=max_tokens, ` +
        `max_tokens=${maxTokens}, output=${response.usage.output_tokens}). Escalando na proxima tentativa...`,
      );
      ultimoErroZod = undefined;
      continue;
    }

    // Remove bloco <diagnostico> (chain-of-thought) e extrai JSON
    const jsonText = stripAnalysisBlock(ultimaResposta);

    let parsed: unknown;
    try { parsed = JSON.parse(stripMarkdownFence(jsonText)); }
    catch { console.error(`[refine] tentativa ${tentativa}: JSON invalido`); continue; }

    // A entrada (scenes.json) tem "especialista_slug" no root; o modelo costuma
    // devolvê-lo, e a schema é estrita → erro "Unrecognized key especialista_slug"
    // TODA vez (causa da instabilidade antiga do refine). A rota re-adiciona esse
    // campo depois, então é seguro remover aqui antes de validar.
    if (parsed && typeof parsed === "object") {
      delete (parsed as Record<string, unknown>).especialista_slug;
    }

    const validation = ReelPropsSchema.safeParse(parsed);
    if (validation.success) {
      // Duração do player = janela de trim (end - start), não soma dos overlays.
      // Se o agente preservou video_start/end do JSON de entrada, usamos esses valores.
      // Caso contrário, cai na soma dos overlays como fallback.
      const data = validation.data;
      const trimStart = typeof (data as Record<string, unknown>).video_start_segundos === "number"
        ? (data as Record<string, unknown>).video_start_segundos as number
        : 0;
      const trimEnd = typeof (data as Record<string, unknown>).video_end_segundos === "number"
        ? (data as Record<string, unknown>).video_end_segundos as number
        : null;
      const somaReal = data.cenas.reduce((acc, c) => acc + c.duracao_segundos, 0);
      const duracaoTotal = trimEnd !== null && trimEnd > trimStart
        ? Math.round((trimEnd - trimStart) * 10) / 10
        : Math.round(somaReal * 10) / 10;
      const scenesComSfxR = aplicarSfxDefaults({ ...data, duracao_total_estimada: duracaoTotal });
      const scenesComCta = corrigirCoberturaCta(scenesComSfxR, params.transcript);
      // Rede de seguranca: clamp ao fim real do arquivo (mesma logica do analyze).
      const scenesClampadosR = clampReelToVideoDuration(scenesComCta, params.videoDuration);
      return {
        scenes: scenesClampadosR,
        metadata: { promptVersion: PROMPT_VERSION, model, tentativas: tentativa, tokens: tokensAcumulados },
      };
    }

    console.error(
      `[refine] tentativa ${tentativa}: schema invalido (${validation.error.errors.length} erros): ` +
      validation.error.errors.slice(0, 10).map((e) => `${e.path.join(".") || "(raiz)"}: ${e.message}`).join(" | "),
    );
    ultimoErroZod = validation.error;
  }

  throw new AnalysisError(
    `Refine falhou apos 3 tentativas: ${ultimoErroZod?.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ") ?? "desconhecido"}`,
    3, ultimaResposta, ultimoErroZod,
  );
}
