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

  async review(model: string, system: string, user: string): Promise<ModelReview> {
    const res = await fetch(`${API}/messages`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        system,
        messages: [{ role: "user", content: user }],
        tools: [REVIEW_TOOL],
        tool_choice: { type: "tool", name: REVIEW_TOOL.name },
      }),
    });
    await this.check(res);
    const json = (await res.json()) as {
      content: Array<{ type: string; name?: string; input?: ModelReview }>;
      stop_reason: string;
    };
    const tool = json.content.find((c) => c.type === "tool_use" && c.name === REVIEW_TOOL.name);
    if (!tool?.input) throw new Error(`Claude 응답에 리뷰 결과가 없습니다 (stop_reason=${json.stop_reason})`);
    return {
      summary: String(tool.input.summary ?? ""),
      comments: Array.isArray(tool.input.comments) ? tool.input.comments : [],
    };
  }
}
