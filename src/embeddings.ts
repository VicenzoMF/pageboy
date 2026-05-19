export interface EmbeddingProvider {
  readonly model: string;
  readonly dim: number;
  readonly name: string;
  embed(texts: string[]): Promise<Float32Array[]>;
}

// ---------- OpenAI ----------

const OPENAI_DIM_DEFAULTS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

class OpenAIEmbeddings implements EmbeddingProvider {
  readonly name = "openai";
  constructor(
    readonly apiKey: string,
    readonly model: string,
    readonly dim: number,
    readonly baseUrl: string,
  ) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        ...(this.model.startsWith("text-embedding-3") ? { dimensions: this.dim } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI embeddings ${res.status}: ${body.slice(0, 400)}`);
    }
    const data = (await res.json()) as {
      data: { embedding: number[]; index: number }[];
    };
    return data.data
      .sort((a, b) => a.index - b.index)
      .map((d) => new Float32Array(d.embedding));
  }
}

// ---------- Ollama ----------

class OllamaEmbeddings implements EmbeddingProvider {
  readonly name = "ollama";
  constructor(
    readonly host: string,
    readonly model: string,
    readonly dim: number,
  ) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const res = await fetch(`${this.host}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama embeddings ${res.status}: ${body.slice(0, 400)}`);
    }
    const data = (await res.json()) as { embeddings: number[][] };
    return data.embeddings.map((e) => new Float32Array(e));
  }
}

const OLLAMA_DIM_DEFAULTS: Record<string, number> = {
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
  "all-minilm": 384,
  "snowflake-arctic-embed": 1024,
  "bge-m3": 1024,
};

export async function probeOllama(host: string): Promise<boolean> {
  try {
    const res = await fetch(`${host}/api/tags`, {
      signal: AbortSignal.timeout(800),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function detectOllamaDim(
  host: string,
  model: string,
): Promise<number | null> {
  try {
    const res = await fetch(`${host}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: "x" }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { embeddings: number[][] };
    return data.embeddings[0]?.length ?? null;
  } catch {
    return null;
  }
}

// ---------- Transformers.js (optional) ----------

interface FeatureExtractor {
  (
    input: string | string[],
    opts: { pooling: "mean"; normalize: boolean },
  ): Promise<{ data: Float32Array; dims: number[] }>;
}

class TransformersJsEmbeddings implements EmbeddingProvider {
  readonly name = "transformers.js";
  private extractor: FeatureExtractor | null = null;
  private loadingPromise: Promise<FeatureExtractor> | null = null;

  constructor(readonly model: string, readonly dim: number) {}

  private async getExtractor(): Promise<FeatureExtractor> {
    if (this.extractor) return this.extractor;
    if (!this.loadingPromise) {
      this.loadingPromise = (async () => {
        const mod = (await tryDynamicImport([
          "@huggingface/transformers",
          "@xenova/transformers",
        ])) as { pipeline: (task: string, model: string) => Promise<FeatureExtractor> } | null;
        if (!mod) {
          throw new Error(
            "transformers.js is not installed. Run: npm install @huggingface/transformers",
          );
        }
        const ex = await mod.pipeline("feature-extraction", this.model);
        this.extractor = ex;
        return ex;
      })();
    }
    return this.loadingPromise;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const extractor = await this.getExtractor();
    const out = await extractor(texts, { pooling: "mean", normalize: true });
    const dim = out.dims[out.dims.length - 1];
    const result: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) {
      result.push(out.data.slice(i * dim, (i + 1) * dim) as Float32Array);
    }
    return result;
  }
}

const TRANSFORMERS_DIM_DEFAULTS: Record<string, number> = {
  "Xenova/all-MiniLM-L6-v2": 384,
  "Xenova/bge-small-en-v1.5": 384,
  "Xenova/bge-base-en-v1.5": 768,
  "mixedbread-ai/mxbai-embed-xsmall-v1": 384,
};

async function tryDynamicImport(specifiers: string[]): Promise<unknown | null> {
  for (const spec of specifiers) {
    try {
      // Indirect to keep TS from resolving the optional dep at compile time.
      const mod = await (Function("s", "return import(s)") as (
        s: string,
      ) => Promise<unknown>)(spec);
      return mod;
    } catch {
      // try next
    }
  }
  return null;
}

export async function transformersJsAvailable(): Promise<boolean> {
  const mod = await tryDynamicImport([
    "@huggingface/transformers",
    "@xenova/transformers",
  ]);
  return mod !== null;
}

// ---------- selection ----------

export async function getEmbeddingProvider(): Promise<EmbeddingProvider | null> {
  const explicit = (process.env.PAGEBOY_EMBED_PROVIDER ?? "").toLowerCase();

  if (explicit === "openai" || (!explicit && process.env.OPENAI_API_KEY)) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      if (explicit === "openai") {
        throw new Error("PAGEBOY_EMBED_PROVIDER=openai but OPENAI_API_KEY is not set");
      }
    } else {
      const model = process.env.PAGEBOY_EMBED_MODEL ?? "text-embedding-3-small";
      const defaultDim = OPENAI_DIM_DEFAULTS[model] ?? 1536;
      const dim = process.env.PAGEBOY_EMBED_DIM
        ? parseInt(process.env.PAGEBOY_EMBED_DIM, 10)
        : defaultDim;
      const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
      return new OpenAIEmbeddings(apiKey, model, dim, baseUrl);
    }
  }

  if (explicit === "ollama" || (!explicit && (process.env.OLLAMA_HOST || process.env.OLLAMA_URL))) {
    const host =
      process.env.OLLAMA_HOST ??
      process.env.OLLAMA_URL ??
      "http://127.0.0.1:11434";
    const reachable = await probeOllama(host);
    if (!reachable) {
      if (explicit === "ollama") {
        throw new Error(`Ollama not reachable at ${host}`);
      }
    } else {
      const model = process.env.PAGEBOY_EMBED_MODEL ?? "nomic-embed-text";
      let dim = process.env.PAGEBOY_EMBED_DIM
        ? parseInt(process.env.PAGEBOY_EMBED_DIM, 10)
        : OLLAMA_DIM_DEFAULTS[model] ?? 0;
      if (!dim) {
        const probed = await detectOllamaDim(host, model);
        if (!probed) {
          throw new Error(
            `Could not detect embedding dim for Ollama model "${model}". Set PAGEBOY_EMBED_DIM or pull the model: ollama pull ${model}`,
          );
        }
        dim = probed;
      }
      return new OllamaEmbeddings(host, model, dim);
    }
  }

  if (explicit === "transformers" || explicit === "transformersjs" || !explicit) {
    if (await transformersJsAvailable()) {
      const model =
        process.env.PAGEBOY_EMBED_MODEL ?? "Xenova/all-MiniLM-L6-v2";
      const dim = process.env.PAGEBOY_EMBED_DIM
        ? parseInt(process.env.PAGEBOY_EMBED_DIM, 10)
        : TRANSFORMERS_DIM_DEFAULTS[model] ?? 384;
      return new TransformersJsEmbeddings(model, dim);
    }
    if (explicit) {
      throw new Error(
        "transformers.js requested but not installed. Run: npm install @huggingface/transformers",
      );
    }
  }

  return null;
}

export async function embedInBatches(
  provider: EmbeddingProvider,
  texts: string[],
  batchSize = 64,
): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const vectors = await provider.embed(batch);
    out.push(...vectors);
  }
  return out;
}
