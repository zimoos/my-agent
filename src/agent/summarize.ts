import type { ProviderRuntime } from '../provider/runtime.js';

export interface ContextSummaryInput {
  i: number;
  role: string;
  content: string;
}

export interface ContextSummaryOutput {
  i: number;
  summary: string;
}

export async function summarizeContextItems(
  providerRuntime: ProviderRuntime,
  model: string,
  items: ContextSummaryInput[],
  signal?: AbortSignal
): Promise<ContextSummaryOutput[]> {
  if (items.length === 0) return [];

  const payload = items.map((item) => ({
    i: item.i,
    role: item.role,
    content: item.content.slice(0, 6000),
  }));
  const resp = await providerRuntime.createChatCompletion(
    {
      model,
      messages: [
        {
          role: 'system',
          content:
            '你是上下文压缩器。按输入数组逐项压缩，必须返回严格 JSON：{"items":[{"i":数字,"summary":"压缩后的完整语义"}]}。不要丢失路径、结论、错误、工具结果。不要输出解释。',
        },
        { role: 'user', content: JSON.stringify({ items: payload }) },
      ],
      temperature: 0.2,
      stream: false,
    },
    { signal }
  );

  const raw = (resp as any)?.choices?.[0]?.message?.content;
  if (typeof raw !== 'string') return [];
  const jsonText = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed?.items)) return [];
    return parsed.items
      .map((item: any) => ({
        i: Number(item?.i),
        summary: typeof item?.summary === 'string' ? item.summary.trim() : '',
      }))
      .filter((item: ContextSummaryOutput) =>
        Number.isInteger(item.i) && item.summary.length > 0
      );
  } catch {
    return [];
  }
}
