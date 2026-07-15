/**
 * Groq 呼び出し層（OpenAI互換 Chat Completions API）。
 *
 * ここが担うのは「ゆらぎのある判断」のみ:
 *   - judgeWord: 単語のよみ・実在性・カテゴリを構造化出力で得る
 *   - suggestHintWord: 次の一手のヒント素材（連想なぞなぞ＋語）を得る
 *   - generateOpponentWord: AI対戦の一手を得る
 * 勝敗ルールは public/shiritori.js（決定論）が担うため、ここには置かない。
 *
 * APIキーは Deno.env（サーバー環境変数）からのみ取得し、クライアントには晒さない。
 * 構造化出力は Groq の response_format: json_object（JSON強制）＋プロンプト指定で担保する。
 */

const GROQ_API = "https://api.groq.com/openai/v1/chat/completions";
// 日本語が使えるモデル。GROQ_MODEL 環境変数で差し替え可能。
const MODEL = Deno.env.get("GROQ_MODEL") ?? "llama-3.3-70b-versatile";

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

const CATEGORY_LIST = CATEGORIES.join(" / ");

export class AiError extends Error {}
export class NoApiKeyError extends AiError {}

function apiKey(): string {
  const key = Deno.env.get("GROQ_API_KEY");
  if (!key) throw new NoApiKeyError("GROQ_API_KEY is not set");
  return key;
}

/**
 * Groq に JSON モードで問い合わせ、message.content を JSON パースして返す。
 * system プロンプトに出力すべきJSONの形を明記しておくこと。
 */
async function callJson(
  systemPrompt: string,
  userText: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(GROQ_API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${apiKey()}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new AiError(`Groq API error ${res.status}: ${body}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new AiError("no content in Groq response");
  }
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    throw new AiError(`invalid JSON from Groq: ${content}`);
  }
}

function toCategory(v: unknown): Category {
  return (CATEGORIES as readonly string[]).includes(String(v))
    ? (v as Category)
    : "その他";
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
    "あなたは幼児向けしりとりゲームの言葉判定係です。入力された日本語の言葉を判定し、" +
    "次のJSON形式だけを出力してください（前後に説明文を付けない）:\n" +
    `{"reading": "現代仮名遣いのひらがなよみ（記号なし）", "isReal": true か false, "category": "${CATEGORY_LIST} のいずれか"}\n` +
    "reading はその語の読みだけをひらがなで。固有名詞やスラング、造語は isReal を false にしてください。";
  const input = await callJson(system, `判定する言葉: 「${word}」`);
  return {
    reading: String(input.reading ?? ""),
    isReal: Boolean(input.isReal),
    category: toCategory(input.category),
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
    "幼児（4〜6歳）が知っていそうな身近な言葉を1つ選び、" +
    "答えの言葉そのものは言わずに特徴で連想させる短いなぞなぞ（ひらがな中心・20文字程度）を作ります。" +
    "次のJSON形式だけを出力してください（前後に説明文を付けない）:\n" +
    `{"word": "ヒント対象の語（表記）", "reading": "その語のひらがなよみ", "riddle": "答えを言わない短い連想なぞなぞ"}`;
  const used = usedWords.length > 0
    ? `すでに使った言葉: ${usedWords.join("、")}。これらは選ばないでください。`
    : "";
  const cat = category
    ? `できれば「${category}」のカテゴリから選んでください。`
    : "";
  const input = await callJson(
    system,
    `「${nextChar}」からはじまる言葉のヒントを作ってください。${cat}${used}`,
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
    "ぜったいに「ん」で終わる言葉を選ばないでください。よみは現代仮名遣いのひらがなで記号なし。" +
    "次のJSON形式だけを出力してください（前後に説明文を付けない）:\n" +
    `{"word": "打つ語（表記）", "reading": "ひらがなよみ", "category": "${CATEGORY_LIST} のいずれか"}`;
  const avoidList = [...usedWords, ...avoid];
  const used = avoidList.length > 0
    ? `つぎの言葉は使わないでください: ${avoidList.join("、")}。`
    : "";
  const input = await callJson(
    system,
    `「${nextChar}」からはじまる言葉を1つ選んでください。${used}`,
  );
  return {
    word: String(input.word ?? ""),
    reading: String(input.reading ?? ""),
    category: toCategory(input.category),
  };
}
