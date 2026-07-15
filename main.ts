/**
 * Deno サーバー。
 * 役割:
 *   1. public/ の静的ファイル配信
 *   2. POST /api/judge  … 入力語のよみ・実在性・カテゴリを AI 判定（キーを隠す）
 *   3. POST /api/hint   … 段階スキャフォールドのヒントを生成
 *
 * APIキーはこのサーバーの環境変数からのみ読む。フロントには渡さない。
 * AI 障害時は degraded=true で縮退運転（ゲームは止めない）。
 */

import { serveDir } from "jsr:@std/http@1/file-server";
import {
  AiError,
  type Difficulty,
  generateOpponentWord,
  judgeWord,
  NoApiKeyError,
  suggestHintWord,
} from "./lib/ai.ts";
// AI の手も決定論で検証する（勝敗ロジックの単一の源）
import { connects, endsWithN, normalizeWord } from "./public/shiritori.js";

/** AI/キー由来の縮退はログに理由だけ残す（キーは出さない）。想定外は throw 元も残す */
function logDegraded(where: string, e: unknown): void {
  const known = e instanceof NoApiKeyError || e instanceof AiError;
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[${where}] degraded${known ? "" : " (unexpected)"}: ${msg}`);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function handleJudge(req: Request): Promise<Response> {
  let word = "";
  try {
    const body = await req.json();
    word = String(body.word ?? "").trim();
  } catch {
    return json({ error: "invalid body" }, 400);
  }
  if (!word) return json({ error: "empty word" }, 400);

  try {
    const result = await judgeWord(word);
    return json({ ...result, degraded: false });
  } catch (e) {
    // 縮退運転: AI 無しでも、かな入力ならそのまま読みとして続行できる。
    logDegraded("judge", e);
    return json({
      reading: word,
      isReal: true, // 実在チェックはスキップ
      category: null,
      degraded: true,
    });
  }
}

/** ヒントのレベル別文言を組み立てる */
function formatHint(
  level: number,
  nextChar: string,
  category: string | undefined,
  hintReading: string | undefined,
  hintWord: string | undefined,
  riddle: string | undefined,
): string {
  switch (level) {
    case 1:
      return `「${nextChar}」からはじまることば、${
        category ?? "なにか"
      }にいるかな？`;
    case 2:
      return riddle ?? `「${nextChar}」からはじまることばを かんがえてみよう！`;
    case 3:
      if (hintReading && hintReading.length >= 2) {
        return `「${hintReading.slice(0, 2)}…」ではじまるよ`;
      }
      return `「${nextChar}」からはじまるよ`;
    default:
      return hintWord
        ? `こたえのれい: 「${hintWord}」`
        : `「${nextChar}」からはじまることばだよ`;
  }
}

async function handleHint(req: Request): Promise<Response> {
  let nextChar = "";
  let level = 1;
  let usedWords: string[] = [];
  let category: string | undefined;
  try {
    const body = await req.json();
    nextChar = String(body.nextChar ?? "").trim();
    level = Math.max(1, Math.min(4, Number(body.level) || 1));
    usedWords = Array.isArray(body.usedWords) ? body.usedWords.map(String) : [];
    category = body.category ? String(body.category) : undefined;
  } catch {
    return json({ error: "invalid body" }, 400);
  }
  if (!nextChar) return json({ error: "empty nextChar" }, 400);

  // レベル1はAI不要（カテゴリ方向を示すだけ）
  if (level === 1) {
    return json({
      hint: formatHint(1, nextChar, category, undefined, undefined, undefined),
      level,
      degraded: false,
    });
  }

  try {
    const h = await suggestHintWord(nextChar, usedWords, category);
    return json({
      hint: formatHint(level, nextChar, category, h.reading, h.word, h.riddle),
      level,
      degraded: false,
    });
  } catch (e) {
    logDegraded("hint", e);
    // 縮退: 固定文言
    return json({
      hint: `「${nextChar}」からはじまることばを かんがえてみよう！`,
      level,
      degraded: true,
    });
  }
}

async function handleOpponent(req: Request): Promise<Response> {
  let nextChar = "";
  let usedWords: string[] = [];
  let difficulty: Difficulty = "easy";
  try {
    const body = await req.json();
    nextChar = String(body.nextChar ?? "").trim();
    usedWords = Array.isArray(body.usedWords) ? body.usedWords.map(String) : [];
    difficulty = body.difficulty === "normal" ? "normal" : "easy";
  } catch {
    return json({ error: "invalid body" }, 400);
  }
  if (!nextChar) return json({ error: "empty nextChar" }, 400);

  const used = new Set(usedWords.map(normalizeWord));
  const isValid = (reading: string): boolean =>
    connects(nextChar, reading) && !endsWithN(reading) &&
    !used.has(normalizeWord(reading));

  try {
    const avoid: string[] = [];
    // AI の候補を最大2回まで試し、決定論検証を通ったものだけ採用する
    for (let attempt = 0; attempt < 2; attempt++) {
      const move = await generateOpponentWord(
        nextChar,
        usedWords,
        difficulty,
        avoid,
      );
      if (isValid(move.reading)) {
        return json({ ...move, gaveUp: false, degraded: false });
      }
      avoid.push(move.word || move.reading);
    }
    // 有効な手を出せなかった → AI の降参（子のかち）
    return json({ gaveUp: true, degraded: false });
  } catch (e) {
    logDegraded("opponent", e);
    // AI が使えない → フロントはソロにフォールバック
    return json({ gaveUp: false, degraded: true });
  }
}

// Deno Deploy はリッスンすべきポートを PORT 環境変数で渡す。
// ローカルは未設定なので 8000 にフォールバックする。
const port = Number(Deno.env.get("PORT")) || 8000;

Deno.serve({ port }, async (req: Request) => {
  const url = new URL(req.url);

  if (req.method === "POST" && url.pathname === "/api/judge") {
    return await handleJudge(req);
  }
  if (req.method === "POST" && url.pathname === "/api/hint") {
    return await handleHint(req);
  }
  if (req.method === "POST" && url.pathname === "/api/opponent") {
    return await handleOpponent(req);
  }

  // 静的配信（public/ 配下）
  return await serveDir(req, {
    fsRoot: "public",
    quiet: true,
  });
});
