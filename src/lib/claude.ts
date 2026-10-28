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

export interface ModelReview {
  summary: string;
  comments: ModelComment[];
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
    },
    required: ["summary", "comments"],
  },
};

export class AnthropicError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

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
  // 거절되면 이 모델은 auto 모드로 기억하고 다시 호출한다.
  private autoOnly = new Set<string>();

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
      content: Array<{ type: string; name?: string; input?: ModelReview; text?: string }>;
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
    const tool = json.content.find((c) => c.type === "tool_use" && c.name === REVIEW_TOOL.name);
    let input: Partial<ModelReview> | undefined = tool?.input;
    if (!input) {
      // auto 모드에서 도구 대신 텍스트로 JSON을 준 경우 대비
      const text = json.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          input = JSON.parse(m[0]);
        } catch {
          /* not json */
        }
      }
    }
    if (!input) throw new Error(`Claude 응답에 리뷰 결과가 없습니다 (stop_reason=${json.stop_reason})`);
    return {
      summary: String(input.summary ?? ""),
      comments: Array.isArray(input.comments) ? input.comments : [],
    };
  }
}
