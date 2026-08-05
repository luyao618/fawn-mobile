import { formatExactAge } from "../../domain/baby/age.ts";
import type { AlphaChatClientPort, AlphaProviderMessage } from "../../infrastructure/model/chatCompletionsClient.ts";
import type { RecentRecordsServicePort } from "../insights/recentRecordsService.ts";
import type { BabyProfileServicePort } from "../profile/babyProfileService.ts";
import type { ModelSettingsServicePort } from "../settings/modelSettingsService.ts";

const MAX_QUESTION_LENGTH = 2_000;

export type AlphaChatFailureCode = "not_configured" | "invalid_question" | "request_failed";

export class AlphaChatFailure extends Error {
  constructor(readonly code: AlphaChatFailureCode) {
    super(`Alpha chat failed (${code})`);
    this.name = "AlphaChatFailure";
  }
}

export type AlphaChatAnswer = Readonly<{
  content: string;
  modelId: string;
  contextRecordCount: number;
}>;

export interface AlphaChatServicePort {
  send(question: string): Promise<AlphaChatAnswer>;
}

function systemMessage(
  profile: Awaited<ReturnType<BabyProfileServicePort["load"]>>,
  records: Awaited<ReturnType<RecentRecordsServicePort["list"]>>,
): string {
  const age = formatExactAge(profile.exactAge) ?? "年龄未知";
  const name = profile.profile?.name?.trim() || "未命名宝宝";
  const recordLines = records.length === 0
    ? "- 暂无最近照护记录"
    : records.map((record) => `- ${record.domainLabel}: ${record.primary}; ${record.secondary || "已记录"}`).join("\n");
  return [
    "你是 For Mobile Alpha 的育儿问答助手。回答要简洁、谨慎，并明确区分记录事实与一般建议。",
    "不要诊断、开药或替代专业医疗人员；遇到紧急或危险症状，建议立即联系当地急救或专业医疗服务。",
    `宝宝: ${name}; 当前年龄: ${age}`,
    "最近照护记录:",
    recordLines,
  ].join("\n");
}

export class AlphaChatService implements AlphaChatServicePort {
  constructor(
    private readonly modelSettings: ModelSettingsServicePort,
    private readonly babyProfile: BabyProfileServicePort,
    private readonly recentRecords: RecentRecordsServicePort,
    private readonly client: AlphaChatClientPort,
  ) {}

  async send(question: string): Promise<AlphaChatAnswer> {
    const normalized = question.trim();
    if (!normalized || normalized.length > MAX_QUESTION_LENGTH) throw new AlphaChatFailure("invalid_question");
    const settings = await this.modelSettings.load();
    if (!settings) throw new AlphaChatFailure("not_configured");
    const [profile, records] = await Promise.all([
      this.babyProfile.load(),
      this.recentRecords.list(20),
    ]);
    const messages: readonly AlphaProviderMessage[] = Object.freeze([
      Object.freeze({ role: "system" as const, content: systemMessage(profile, records) }),
      Object.freeze({ role: "user" as const, content: normalized }),
    ]);
    try {
      const content = await this.client.complete(settings, messages);
      return Object.freeze({ content, modelId: settings.config.modelId, contextRecordCount: records.length });
    } catch {
      throw new AlphaChatFailure("request_failed");
    }
  }
}
