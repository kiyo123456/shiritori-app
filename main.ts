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
  judgeWord,
  NoApiKeyError,
  suggestHintWord,
} from "./lib/ai.ts";

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
    const degraded = {
      reading: word,
      isReal: true, // 実在チェックはスキップ
      category: null,
      degraded: true,
    };
    if (e instanceof NoApiKeyError || e instanceof AiError) {
      return json(degraded);
    }
    console.error("judge failed:", e);
    return json(degraded);
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
    if (!(e instanceof NoApiKeyError || e instanceof AiError)) {
      console.error("hint failed:", e);
    }
    // 縮退: 固定文言
    return json({
      hint: `「${nextChar}」からはじまることばを かんがえてみよう！`,
      level,
      degraded: true,
    });
  }
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (req.method === "POST" && url.pathname === "/api/judge") {
    return await handleJudge(req);
  }
  if (req.method === "POST" && url.pathname === "/api/hint") {
    return await handleHint(req);
  }

  // 静的配信（public/ 配下）
  return await serveDir(req, {
    fsRoot: "public",
    quiet: true,
  });
});
