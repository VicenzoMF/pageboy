export interface Reranker {
  readonly model: string;
  rerank(query: string, passages: string[]): Promise<number[]>;
}

interface TransformersModule {
  AutoTokenizer: {
    from_pretrained(model: string): Promise<TokenizerLike>;
  };
  AutoModelForSequenceClassification: {
    from_pretrained(
      model: string,
      opts?: Record<string, unknown>,
    ): Promise<ModelLike>;
  };
}

interface TokenizerLike {
  (
    text: string[],
    opts: {
      text_pair?: string[];
      padding?: boolean;
      truncation?: boolean;
      max_length?: number;
    },
  ): unknown;
}

interface ModelLike {
  (inputs: unknown): Promise<{ logits: { data: Float32Array; dims: number[] } }>;
}

const DEFAULT_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";
const MAX_BATCH = 16;

class TransformersJsReranker implements Reranker {
  private tokenizer: TokenizerLike | null = null;
  private modelFn: ModelLike | null = null;
  private loadingPromise: Promise<void> | null = null;

  constructor(readonly model: string) {}

  private async load(): Promise<void> {
    if (this.tokenizer && this.modelFn) return;
    if (!this.loadingPromise) {
      this.loadingPromise = (async () => {
        const mod = (await tryDynamicImport([
          "@huggingface/transformers",
          "@xenova/transformers",
        ])) as TransformersModule | null;
        if (!mod) {
          throw new Error(
            "transformers.js is not installed. Run: npm install @huggingface/transformers",
          );
        }
        const tokenizer = await mod.AutoTokenizer.from_pretrained(this.model);
        const modelFn = await mod.AutoModelForSequenceClassification.from_pretrained(
          this.model,
          { quantized: true },
        );
        this.tokenizer = tokenizer;
        this.modelFn = modelFn;
      })();
    }
    await this.loadingPromise;
  }

  async rerank(query: string, passages: string[]): Promise<number[]> {
    if (passages.length === 0) return [];
    await this.load();
    if (!this.tokenizer || !this.modelFn) throw new Error("reranker not loaded");

    const scores: number[] = new Array(passages.length);
    for (let i = 0; i < passages.length; i += MAX_BATCH) {
      const batch = passages.slice(i, i + MAX_BATCH);
      const inputs = this.tokenizer(Array(batch.length).fill(query), {
        text_pair: batch,
        padding: true,
        truncation: true,
        max_length: 512,
      });
      const { logits } = await this.modelFn(inputs);
      const dim = logits.dims[logits.dims.length - 1];
      for (let j = 0; j < batch.length; j++) {
        scores[i + j] = dim > 1 ? logits.data[j * dim + 1] : logits.data[j];
      }
    }
    return scores;
  }
}

let cached: Reranker | null = null;
let cachedKey: string | null = null;

export async function getReranker(): Promise<Reranker | null> {
  const enabled =
    process.env.PAGEBOY_RERANK === "1" ||
    process.env.PAGEBOY_RERANK?.toLowerCase() === "true";
  if (!enabled && !process.env.PAGEBOY_RERANK_MODEL) return null;
  return loadReranker(process.env.PAGEBOY_RERANK_MODEL ?? DEFAULT_MODEL);
}

export async function loadReranker(model: string): Promise<Reranker | null> {
  if (cached && cachedKey === model) return cached;
  if (!(await transformersJsAvailable())) return null;
  const r = new TransformersJsReranker(model);
  cached = r;
  cachedKey = model;
  return r;
}

async function tryDynamicImport(specifiers: string[]): Promise<unknown | null> {
  for (const spec of specifiers) {
    try {
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

async function transformersJsAvailable(): Promise<boolean> {
  const mod = await tryDynamicImport([
    "@huggingface/transformers",
    "@xenova/transformers",
  ]);
  return mod !== null;
}
