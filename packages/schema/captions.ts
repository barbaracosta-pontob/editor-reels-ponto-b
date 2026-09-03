import { z } from "zod";

/**
 * Legenda contínua — dados e configuração.
 *
 * A legenda NÃO é gerada pelo Claude: ela vem direto dos timestamps
 * palavra-a-palavra que o Whisper já grava em `transcript.json`. Aqui ficam
 * o schema desses dados, a configuração escolhida pelo usuário e as funções
 * puras que (a) convertem o transcript em palavras de legenda, (b) agrupam
 * palavras em frases e (c) definem quais tipos de cena "escondem" a legenda.
 *
 * Módulo puro (sem React / sem Remotion) — usado tanto no pipeline (Node,
 * na rota /api/jobs) quanto no componente de render (Remotion).
 */

// ── Dados ─────────────────────────────────────────────────────────────────────

export const LegendaPalavraSchema = z.object({
  texto: z.string().min(1),
  inicio: z.number().min(0), // segundos, na linha do tempo do vídeo bruto
  fim: z.number().min(0),
});
export type LegendaPalavra = z.infer<typeof LegendaPalavraSchema>;

// ── Configuração ───────────────────────────────────────────────────────────────

export const LEGENDA_ESTILOS = ["palavra_unica", "frase_limpa", "dinamica"] as const;
export type LegendaEstilo = (typeof LEGENDA_ESTILOS)[number];

export const LEGENDA_POSICOES = ["auto", "alto", "centro", "rodape"] as const;
export type LegendaPosicao = (typeof LEGENDA_POSICOES)[number];

export const LegendaConfigSchema = z.object({
  ativa: z.boolean().default(false),
  estilo: z.enum(LEGENDA_ESTILOS).default("frase_limpa"),
  // "auto" = usa a posição padrão de cada estilo (palavra_unica: alto,
  // frase_limpa: rodapé, dinamica: centro). Sempre dentro da safe area.
  posicao: z.enum(LEGENDA_POSICOES).default("auto"),
  // Fundo semitransparente atrás do texto (caixa). Default: sem caixa.
  caixa: z.boolean().default(false),
  // Cor de destaque da palavra ativa (preset dinâmica). Aceita alias
  // "primaria"/"secundaria"/"branco" ou hex. Default resolve pra primária.
  cor_destaque: z.string().default("primaria"),
  // Agrupamento em frases (presets frase_limpa e dinamica).
  palavras_por_frase: z.number().int().min(1).max(8).default(3),
  // Ajuste fino de posição vertical, em % da altura. Negativo sobe, positivo
  // desce. Aplicado por cima da posição base (para tirar a legenda do rosto).
  deslocamento_y: z.number().min(-45).max(45).default(0),
});
export type LegendaConfig = z.infer<typeof LegendaConfigSchema>;

// Posição efetiva de cada estilo quando a config está em "auto".
export function posicaoEfetiva(config: Pick<LegendaConfig, "estilo" | "posicao">): Exclude<LegendaPosicao, "auto"> {
  if (config.posicao && config.posicao !== "auto") return config.posicao;
  switch (config.estilo) {
    case "palavra_unica": return "alto";
    case "dinamica":      return "centro";
    case "frase_limpa":
    default:              return "rodape";
  }
}

// ── Conversão do transcript ─────────────────────────────────────────────────────

// Shape mínimo do transcript.json (faster-whisper). Campos extras são ignorados.
type TranscriptWord = { word?: string; start?: number; end?: number };
type TranscriptSegment = { words?: TranscriptWord[]; text?: string; start?: number; end?: number };
export type TranscriptLike = { segments?: TranscriptSegment[] };

/**
 * Achata o transcript em uma lista de palavras de legenda, na ordem falada.
 * Usa os timestamps palavra-a-palavra do Whisper (em segundos).
 * Ignora entradas sem texto ou sem timestamps válidos.
 */
export function transcriptToLegendaPalavras(transcript: TranscriptLike): LegendaPalavra[] {
  const out: LegendaPalavra[] = [];
  const segs = transcript?.segments ?? [];
  for (const seg of segs) {
    const words = seg?.words;
    if (Array.isArray(words) && words.length) {
      for (const w of words) {
        const texto = (w?.word ?? "").trim();
        const inicio = typeof w?.start === "number" ? w.start : NaN;
        const fim = typeof w?.end === "number" ? w.end : NaN;
        if (!texto || !Number.isFinite(inicio) || !Number.isFinite(fim)) continue;
        out.push({ texto, inicio, fim: Math.max(fim, inicio) });
      }
    } else if (seg?.text && typeof seg.start === "number" && typeof seg.end === "number") {
      // Fallback: segmento sem word-timestamps vira uma "palavra" única.
      const texto = seg.text.trim();
      if (texto) out.push({ texto, inicio: seg.start, fim: Math.max(seg.end, seg.start) });
    }
  }
  return out;
}

// ── Agrupamento em frases ───────────────────────────────────────────────────────

export type LegendaFrase = {
  palavras: LegendaPalavra[];
  inicio: number; // = palavras[0].inicio
  fim: number;    // = último.fim
};

const FIM_DE_FRASE = /[.!?…]$/;
const PAUSA_QUEBRA_S = 0.6; // silêncio que força quebra de frase
const EXTRA_MAX = 2;        // palavras extras toleradas p/ não quebrar em palavra funcional

// Palavras funcionais (artigos, preposições, conjunções) em que uma frase NÃO
// deve terminar — ficam "penduradas" e prejudicam a leitura. Ex.: evitar
// "preparando a" e juntar como "preparando a aula".
const PALAVRAS_FUNCIONAIS: ReadonlySet<string> = new Set([
  "o", "a", "os", "as", "um", "uma", "uns", "umas",
  "de", "do", "da", "dos", "das", "dum", "duma",
  "em", "no", "na", "nos", "nas", "num", "numa",
  "ao", "aos", "à", "às",
  "por", "pelo", "pela", "pelos", "pelas", "pra", "pro", "para",
  "com", "sem", "sob", "sobre", "entre", "até", "após", "ante", "perante",
  "e", "ou", "mas", "que", "se", "nem", "como", "quando",
  "meu", "minha", "seu", "sua", "teu", "tua", "nosso", "nossa",
]);

function ehFuncional(texto: string): boolean {
  const limpo = texto.toLowerCase().replace(/[.,!?;:…"'()]/g, "").trim();
  return PALAVRAS_FUNCIONAIS.has(limpo);
}

/**
 * Agrupa palavras em frases curtas para os presets `frase_limpa` e `dinamica`.
 * Quebra por: (1) limite de palavras, (2) pontuação de fim de frase,
 * (3) pausa natural na fala (silêncio > PAUSA_QUEBRA_S).
 * Evita terminar a frase numa palavra funcional (artigo/preposição/conjunção):
 * nesse caso estende até EXTRA_MAX palavras além do limite para "puxar" a
 * próxima palavra de conteúdo. Pontuação e pausa sempre têm prioridade.
 */
export function agruparEmFrases(
  palavras: LegendaPalavra[],
  maxPalavras = 3,
): LegendaFrase[] {
  const max = Math.max(1, Math.floor(maxPalavras));
  const frases: LegendaFrase[] = [];
  let atual: LegendaPalavra[] = [];

  const fechar = () => {
    if (!atual.length) return;
    frases.push({
      palavras: atual,
      inicio: atual[0].inicio,
      fim: atual[atual.length - 1].fim,
    });
    atual = [];
  };

  for (let i = 0; i < palavras.length; i++) {
    const p = palavras[i];
    const anterior = atual[atual.length - 1];
    const pausa = anterior ? p.inicio - anterior.fim : 0;
    // Quebra ANTES de adicionar se houve pausa longa e já temos conteúdo.
    if (anterior && pausa >= PAUSA_QUEBRA_S) fechar();

    atual.push(p);

    // Pontuação de fim de frase sempre fecha (é uma quebra natural).
    if (FIM_DE_FRASE.test(p.texto)) { fechar(); continue; }

    if (atual.length >= max) {
      // Se a última palavra é funcional e ainda cabe folga, adia a quebra
      // para não deixar artigo/preposição pendurado no fim da frase.
      const podeEstender = atual.length < max + EXTRA_MAX;
      if (ehFuncional(p.texto) && podeEstender) continue;
      fechar();
    }
  }
  fechar();
  return frases;
}

/**
 * Reescreve o texto de uma frase preservando a sincronia:
 * - Se o número de palavras não mudou, mantém os tempos originais (caso típico:
 *   correção de digitação do Whisper).
 * - Se mudou (juntou/dividiu/adicionou palavra), redistribui a janela de tempo
 *   da frase [início, fim] proporcionalmente ao tamanho de cada palavra nova.
 * Retorna as novas palavras da frase (vazio se o texto ficou vazio).
 */
export function reescreverFrase(
  palavrasAntigas: LegendaPalavra[],
  textoNovo: string,
): LegendaPalavra[] {
  const tokens = textoNovo.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || !palavrasAntigas.length) return [];
  if (tokens.length === palavrasAntigas.length) {
    return tokens.map((tk, i) => ({ ...palavrasAntigas[i], texto: tk }));
  }
  const inicio = palavrasAntigas[0].inicio;
  const fim = Math.max(palavrasAntigas[palavrasAntigas.length - 1].fim, inicio);
  const dur = Math.max(0, fim - inicio);
  const totalChars = tokens.reduce((a, t) => a + Math.max(1, t.length), 0);
  let acc = inicio;
  return tokens.map((tk, i) => {
    const ini = acc;
    const f = i === tokens.length - 1 ? fim : ini + (dur * Math.max(1, tk.length)) / totalChars;
    acc = f;
    return { texto: tk, inicio: ini, fim: f };
  });
}

// ── Supressão por cena ──────────────────────────────────────────────────────────

/**
 * Tipos de cena que têm texto próprio e, portanto, ESCONDEM a legenda contínua
 * enquanto estão na tela (regra definida pela Ponto B). A legenda reaparece nas
 * janelas de vídeo puro (VideoSimples) e nos formatos sem texto sobreposto.
 */
export const CENAS_QUE_SUPRIMEM_LEGENDA: ReadonlySet<string> = new Set([
  "Hook",
  "FraseImpacto",
  "ComparativoNumerico",
  "VideoCitacao",
  "ListaPontos",
  "MiniCaso",
  "TransicaoTexto",
  "CTA",
  "CtaFullNavy",
  "ConviteEvento",
  "GraficoLinha",
  "GraficoBarra",
]);

export function cenaSuprimeLegenda(tipo: string): boolean {
  return CENAS_QUE_SUPRIMEM_LEGENDA.has(tipo);
}
