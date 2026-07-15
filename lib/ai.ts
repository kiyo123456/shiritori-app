/**
 * Anthropic Claude Haiku 4.5 呼び出し層。
 *
 * ここが担うのは「ゆらぎのある判断」のみ:
 *   - judgeWord: 単語のよみ・実在性・カテゴリを構造化出力で得る
 *   - suggestHintWord: 次の一手のヒント素材（連想なぞなぞ＋語）を得る
 * 勝敗ルールは lib/shiritori.ts（決定論）が担うため、ここには置かない。
 *
 * APIキーは Deno.env（サーバー環境変数）からのみ取得し、クライアントには晒さない。
 */

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";

/** 幼児向けのカテゴリ分類 */
export const CATEGORIES = [
  "どうぶつ",
  "たべもの",
  "のりもの",
  "しぜん",
  "からだ",
  "せいかつ",
  "その他",
] as const;
export type Category = (typeof CATEGORIES)[number];

export class AiError extends Error {}
export class NoApiKeyError extends AiError {}

function apiKey(): string {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new NoApiKeyError("ANTHROPIC_API_KEY is not set");
  return key;
}

/** Anthropic Messages API を tool 強制で呼び、tool_use の input を返す */
async function callTool(
  systemPrompt: string,
  userText: string,
  tool: Record<string, unknown>,
  toolName: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey(),
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 300,
      temperature: 0,
      system: systemPrompt,
      tools: [tool],
      tool_choice: { type: "tool", name: toolName },
      messages: [{ role: "user", content: userText }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new AiError(`Anthropic API error ${res.status}: ${body}`);
  }
  const data = await res.json();
  const toolUse = (data.content ?? []).find(
    (c: { type: string }) => c.type === "tool_use",
  );
  if (!toolUse) throw new AiError("no tool_use in response");
  return toolUse.input as Record<string, unknown>;
}

export interface JudgeResult {
  /** 現代仮名遣いのひらがなよみ */
  reading: string;
  /** 実在する日本語の言葉か */
  isReal: boolean;
  /** カテゴリ（幼児向け分類） */
  category: Category;
}

/**
 * 入力語のよみ・実在性・カテゴリを判定する。
 * 漢字・カタカナ・ひらがな、いずれの表記でも受け付ける。
 */
export async function judgeWord(word: string): Promise<JudgeResult> {
  const system =
    "あなたは幼児向けしりとりゲームの言葉判定係です。入力された日本語の言葉について、" +
    "現代仮名遣いのひらがなの「よみ」、実在する一般的な言葉かどうか、そして幼児向けカテゴリを判定します。" +
    "よみは送り仮名や記号を含めず、その語の読みだけをひらがなで返してください。" +
    "固有名詞やスラング、造語は isReal=false としてください。";
  const input = await callTool(
    system,
    `つぎの言葉を判定してください: 「${word}」`,
    {
      name: "report_word",
      description: "言葉のよみ・実在性・カテゴリを報告する",
      input_schema: {
        type: "object",
        properties: {
          reading: {
            type: "string",
            description: "現代仮名遣いのひらがなよみ（記号なし）",
          },
          isReal: {
            type: "boolean",
            description: "実在する一般的な日本語の言葉なら true",
          },
          category: {
            type: "string",
            enum: CATEGORIES,
            description: "幼児向けカテゴリ",
          },
        },
        required: ["reading", "isReal", "category"],
      },
    },
    "report_word",
  );
  return {
    reading: String(input.reading ?? ""),
    isReal: Boolean(input.isReal),
    category: (CATEGORIES as readonly string[]).includes(
        String(input.category),
      )
      ? (input.category as Category)
      : "その他",
  };
}

export interface HintWord {
  /** ヒント対象の語（表記） */
  word: string;
  /** その語のひらがなよみ */
  reading: string;
  /** 答えを言わない連想なぞなぞ（例: 白くてふわふわ、"こ"からはじまる…） */
  riddle: string;
}

/**
 * 次の一手のヒント素材を得る。
 * nextChar から始まり、usedWords に含まれず、幼児が知っていそうな語を1つ選び、
 * その語を直接言わない「連想なぞなぞ」も一緒に生成する。
 */
export async function suggestHintWord(
  nextChar: string,
  usedWords: string[],
  category?: string,
): Promise<HintWord> {
  const system =
    "あなたは幼児向けしりとりのやさしいヒント係です。指定された文字から始まる、" +
    "幼児（4〜6歳）が知っていそうな身近な言葉を1つ選びます。" +
    "そのうえで、答えの言葉そのものは言わずに、特徴で連想させる短いなぞなぞを作ります。" +
    "なぞなぞはひらがな中心のやさしい言葉で、20文字程度にしてください。";
  const used = usedWords.length > 0
    ? `すでに使った言葉: ${usedWords.join("、")}。これらは選ばないでください。`
    : "";
  const cat = category
    ? `できれば「${category}」のカテゴリから選んでください。`
    : "";
  const input = await callTool(
    system,
    `「${nextChar}」からはじまる言葉のヒントを作ってください。${cat}${used}`,
    {
      name: "report_hint",
      description: "ヒント対象の語となぞなぞを報告する",
      input_schema: {
        type: "object",
        properties: {
          word: { type: "string", description: "ヒント対象の語（表記）" },
          reading: { type: "string", description: "その語のひらがなよみ" },
          riddle: {
            type: "string",
            description: "答えを言わない短い連想なぞなぞ",
          },
        },
        required: ["word", "reading", "riddle"],
      },
    },
    "report_hint",
  );
  return {
    word: String(input.word ?? ""),
    reading: String(input.reading ?? ""),
    riddle: String(input.riddle ?? ""),
  };
}

export type Difficulty = "easy" | "normal";

export interface OpponentWord {
  /** AIが打つ語（表記） */
  word: string;
  /** その語のひらがなよみ */
  reading: string;
  /** カテゴリ（幼児向け分類） */
  category: Category;
}

/**
 * AI対戦の「次の一手」を生成する。
 * nextChar から始まり、usedWords に含まれず、「ん」で終わらない実在語を選ぶ。
 * 勝敗の最終判定はサーバー側の決定論コードで再検証する前提（ここは候補生成のみ）。
 * @param avoid リトライ時に避けたい語（前回の不正な候補）
 */
export async function generateOpponentWord(
  nextChar: string,
  usedWords: string[],
  difficulty: Difficulty = "easy",
  avoid: string[] = [],
): Promise<OpponentWord> {
  const level = difficulty === "easy"
    ? "幼児（4〜6歳）が知っている、とてもやさしい身近な言葉を選んでください。"
    : "小学生でも分かる、少し幅広い言葉を選んでください。";
  const system = "あなたは幼児向けしりとりゲームの対戦あいてです。" +
    "指定された文字からはじまる実在する日本語の一般名詞を1つ選びます。" +
    level +
    "ぜったいに「ん」で終わる言葉を選ばないでください。" +
    "よみは現代仮名遣いのひらがなで、記号を含めないでください。";
  const avoidList = [...usedWords, ...avoid];
  const used = avoidList.length > 0
    ? `つぎの言葉は使わないでください: ${avoidList.join("、")}。`
    : "";
  const input = await callTool(
    system,
    `「${nextChar}」からはじまる言葉を1つ選んでください。${used}`,
    {
      name: "report_move",
      description: "しりとりの次の一手を報告する",
      input_schema: {
        type: "object",
        properties: {
          word: { type: "string", description: "打つ語（表記）" },
          reading: {
            type: "string",
            description: "その語の現代仮名遣いのひらがなよみ（記号なし）",
          },
          category: {
            type: "string",
            enum: CATEGORIES,
            description: "幼児向けカテゴリ",
          },
        },
        required: ["word", "reading", "category"],
      },
    },
    "report_move",
  );
  return {
    word: String(input.word ?? ""),
    reading: String(input.reading ?? ""),
    category: (CATEGORIES as readonly string[]).includes(String(input.category))
      ? (input.category as Category)
      : "その他",
  };
}
