import { fetch } from "@tauri-apps/plugin-http";

const API = "https://api.anthropic.com/v1";
const VERSION = "2023-06-01";

export type Severity = "critical" | "major" | "minor" | "nit";

export interface ModelComment {
  path: string;
  line: number;
  severity: Severity;
  body: string;
}

export interface ResolvedThread {
  /** Short id from the prompt (T1, T2, ...). */
  id: string;
  reason: string;
}

export interface ModelReview {
  summary: string;
  comments: ModelComment[];
  resolved: ResolvedThread[];
}

export interface ModelInfo {
  id: string;
  display_name: string;
}

const REVIEW_TOOL = {
  name: "submit_review",
  description: "PR 리뷰 결과를 제출한다.",
  input_schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "PR 전체에 대한 리뷰 요약 (markdown, 한국어). 주요 위험과 전반적 평가.",
      },
      comments: {
        type: "array",
        description: "특정 라인에 다는 코멘트. 지적할 것이 없으면 빈 배열.",
        items: {
          type: "object",
          properties: {
            path: { type: "string", description: "diff에 나온 파일 경로 그대로" },
            line: { type: "integer", description: "diff에서 번호가 붙은 새 파일 라인 번호" },
            severity: { type: "string", enum: ["critical", "major", "minor", "nit"] },
            body: { type: "string", description: "문제와 구체적 수정 제안 (markdown, 한국어)" },
          },
          required: ["path", "line", "severity", "body"],
        },
      },
      resolved_threads: {
        type: "array",
        description:
          "'열린 이전 지적' 중 현재 코드에서 문제가 확실히 고쳐진 것. 고쳐졌는지 diff로 확인할 수 없거나 애매하면 넣지 않는다.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "프롬프트에 주어진 스레드 id (예: T3)" },
            reason: { type: "string", description: "어떻게 고쳐졌는지 한 문장 (한국어)" },
          },
          required: ["id", "reason"],
        },
      },
    },
    required: ["summary", "comments", "resolved_threads"],
  },
};

export class AnthropicError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const AUTO_ONLY_MODELS = new Set<string>();

export class Claude {
  constructor(private apiKey: string) {}

  private headers() {
    return {
      "x-api-key": this.apiKey,
      "anthropic-version": VERSION,
      // Tauri http 플러그인이 웹뷰 Origin 헤더를 붙여 Anthropic이 브라우저 CORS 요청으로 판단함.
      // 실제 요청은 로컬 앱의 Rust 쪽에서 나가고 키가 공개 웹페이지에 노출되지 않으므로 허용.
      "anthropic-dangerous-direct-browser-access": "true",
      "content-type": "application/json",
    };
  }

  private async check(res: Response) {
    if (res.ok) return;
    const text = await res.text();
    let msg = text;
    try {
      msg = JSON.parse(text).error?.message ?? text;
    } catch {
      /* not json */
    }
    throw new AnthropicError(res.status, `Claude ${res.status}: ${msg}`);
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await fetch(`${API}/models?limit=100`, { headers: this.headers() });
    await this.check(res);
    const json = (await res.json()) as { data: ModelInfo[] };
    return json.data;
  }

  // 모델마다 강제 tool_choice({type:"tool"})를 지원하지 않는 경우가 있어,
  // 거절되면 이 모델은 auto 모드로 기억하고 다시 호출한다. Claude 인스턴스는 리뷰마다
  // 새로 만들어지므로 모듈 단위로 기억한다.
  private autoOnly = AUTO_ONLY_MODELS;

  private async callMessages(model: string, system: string, user: string, forced: boolean) {
    const res = await fetch(`${API}/messages`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        system: forced
          ? system
          : `${system}\n\n반드시 ${REVIEW_TOOL.name} 도구를 정확히 한 번 호출해서 결과를 제출하라. 도구 호출 외의 텍스트 답변은 하지 마라.`,
        messages: [{ role: "user", content: user }],
        tools: [REVIEW_TOOL],
        tool_choice: forced ? { type: "tool", name: REVIEW_TOOL.name } : { type: "auto" },
      }),
    });
    await this.check(res);
    return (await res.json()) as {
      content: Block[];
      stop_reason: string;
    };
  }

  async review(model: string, system: string, user: string): Promise<ModelReview> {
    let json;
    const forced = !this.autoOnly.has(model);
    try {
      json = await this.callMessages(model, system, user, forced);
    } catch (e) {
      if (forced && e instanceof AnthropicError && e.status === 400 && /tool_choice/.test(e.message)) {
        this.autoOnly.add(model);
        json = await this.callMessages(model, system, user, false);
      } else {
        throw e;
      }
    }
    const input = extractReview(json.content);
    if (!input) {
      const blocks = json.content
        .map((c) => (c.type === "tool_use" ? `tool_use:${c.name}(${describeInput(c.input)})` : c.type))
        .join(", ");
      throw new Error(`Claude 응답에 리뷰 결과가 없습니다 (stop_reason=${json.stop_reason}, blocks=[${blocks}])`);
    }
    return {
      summary: String(input.summary ?? ""),
      comments: Array.isArray(input.comments) ? input.comments : [],
      resolved: Array.isArray(input.resolved_threads)
        ? input.resolved_threads.filter((r) => r && typeof r.id === "string")
        : [],
    };
  }
}

/** Tool input exactly as the model sends it (snake_case, every field optional). */
interface RawReview {
  summary?: string;
  comments?: ModelComment[];
  resolved_threads?: ResolvedThread[];
}

type Block = { type: string; name?: string; input?: unknown; text?: string };

/** Accepts an object or a JSON string; returns it only if it looks like a review. */
function asReview(v: unknown): RawReview | undefined {
  let o = v;
  if (typeof o === "string") {
    try {
      o = JSON.parse(o);
    } catch {
      return undefined;
    }
  }
  if (!o || typeof o !== "object") return undefined;
  const r = o as Record<string, unknown>;
  // Some models wrap the arguments one level deeper ({"input": {...}} / {"review": {...}}).
  for (const k of ["input", "review", "arguments"]) {
    if (r[k] && typeof r[k] === "object" && !("summary" in r) && !("comments" in r)) return asReview(r[k]);
  }
  for (const k of ["comments", "resolved_threads"]) {
    if (typeof r[k] === "string") {
      try {
        r[k] = JSON.parse(r[k] as string);
      } catch {
        /* leave as is */
      }
    }
  }
  return typeof r.summary === "string" || Array.isArray(r.comments) ? (r as RawReview) : undefined;
}

/** Finds the review in a response: the named tool call, any other tool call, then JSON in text. */
export function extractReview(content: Block[]): RawReview | undefined {
  const tools = content.filter((c) => c.type === "tool_use");
  const named = tools.filter((c) => c.name === REVIEW_TOOL.name);
  for (const c of [...named, ...tools.filter((c) => c.name !== REVIEW_TOOL.name)]) {
    const r = asReview(c.input);
    if (r) return r;
  }
  const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  const m = text.match(/\{[\s\S]*\}/);
  return m ? asReview(m[0]) : undefined;
}

function describeInput(v: unknown): string {
  if (v === null || v === undefined) return "없음";
  if (typeof v === "string") return `문자열 ${v.length}자`;
  if (typeof v === "object") return `keys=${Object.keys(v as object).join("|") || "비어 있음"}`;
  return typeof v;
}
