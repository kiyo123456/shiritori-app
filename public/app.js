/**
 * しりとりアプリのフロント制御。
 * - 勝敗判定は shiritori.js（決定論）に委ねる
 * - よみ・実在・カテゴリ判定、ヒント、AIの手はサーバー経由で AI に委ねる
 * - 状態はこのクライアントが保持する（サーバーはステートレス）
 *
 * ゲーム形式: 子（きみ）と AI が交互に打つ対戦。
 */
import { evaluateTurn, lastKana, normalizeWord } from "./shiritori.js";

/** 初期単語の候補（「ん」で終わらない身近な語をランダムに選ぶ） */
const SEED_WORDS = [
  { word: "りんご", reading: "りんご", category: "たべもの" },
  { word: "ぞう", reading: "ぞう", category: "どうぶつ" },
  { word: "さくら", reading: "さくら", category: "しぜん" },
  { word: "でんしゃ", reading: "でんしゃ", category: "のりもの" },
  { word: "ねこ", reading: "ねこ", category: "どうぶつ" },
  { word: "すいか", reading: "すいか", category: "たべもの" },
];

/** ゲーム状態 */
const state = {
  current: null, // { word, reading, category }
  used: new Set(), // 正規化よみの集合
  history: [], // [{ word, reading, category, speaker }]
  categoryCounts: {}, // { どうぶつ: 2, ... }
  hintLevel: 0,
  gameOver: false,
  difficulty: "easy", // "easy" | "normal"
  aiThinking: false,
};

// DOM 参照
const el = {
  currentWord: document.getElementById("current-word"),
  currentReading: document.getElementById("current-reading"),
  nextChar: document.getElementById("next-char"),
  turnIndicator: document.getElementById("turn-indicator"),
  form: document.getElementById("input-form"),
  input: document.getElementById("word-input"),
  submitBtn: document.getElementById("submit-btn"),
  message: document.getElementById("message"),
  hintBtn: document.getElementById("hint-btn"),
  hintText: document.getElementById("hint-text"),
  speakBtn: document.getElementById("speak-btn"),
  historyList: document.getElementById("history-list"),
  wordCount: document.getElementById("word-count"),
  categoryCounts: document.getElementById("category-counts"),
  resetBtn: document.getElementById("reset-btn"),
  endOverlay: document.getElementById("end-overlay"),
  endTitle: document.getElementById("end-title"),
  endReason: document.getElementById("end-reason"),
  endCount: document.getElementById("end-count"),
  endCategories: document.getElementById("end-categories"),
  endResetBtn: document.getElementById("end-reset-btn"),
  aiStatus: document.getElementById("ai-status"),
  modeButtons: Array.from(document.querySelectorAll(".mode-btn")),
};

const SPEAKER_ICON = { child: "🧒", ai: "🤖", start: "✨" };

/** 音声読み上げ（Web Speech API・ブラウザ完結） */
function speak(text) {
  if (!("speechSynthesis" in window) || !text) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "ja-JP";
  u.rate = 0.9;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

/** AI おやすみ（縮退運転）バッジの表示切替 */
function setDegraded(on) {
  el.aiStatus.classList.toggle("hidden", !on);
}

function showMessage(text, type = "info") {
  el.message.textContent = text;
  el.message.className = `message ${type}`;
}

function clearMessage() {
  el.message.textContent = "";
  el.message.className = "message";
}

/** 手番表示と入力可否の切替 */
function setTurn(who) {
  const aiTurn = who === "ai";
  state.aiThinking = aiTurn;
  el.turnIndicator.textContent = aiTurn
    ? "🤖 AIが かんがえてるよ…"
    : "🧒 きみの ばん";
  el.turnIndicator.classList.toggle("thinking", aiTurn);
  const lock = aiTurn || state.gameOver;
  el.input.disabled = lock;
  el.submitBtn.disabled = lock;
  el.hintBtn.disabled = lock;
  if (!lock) el.input.focus();
}

/** 送信ボタンの「かんがえちゅう」表示（判定リクエスト中） */
function setSubmitting(busy) {
  el.submitBtn.disabled = busy;
  el.submitBtn.textContent = busy ? "かんがえちゅう…" : "こたえる";
}

/** 現在語の表示更新 */
function renderCurrent() {
  const c = state.current;
  el.currentWord.textContent = c.word;
  el.currentReading.textContent = c.reading && c.reading !== c.word
    ? `（${c.reading}）`
    : "";
  el.nextChar.textContent = lastKana(c.reading);
}

/** 履歴・カテゴリ集計の表示更新 */
function renderHistory() {
  el.wordCount.textContent = `${state.history.length}こ`;
  el.historyList.innerHTML = "";
  for (const item of state.history) {
    const li = document.createElement("li");
    li.className = `history-item speaker-${item.speaker ?? "start"}`;
    const icon = SPEAKER_ICON[item.speaker] ?? SPEAKER_ICON.start;
    const cat = item.category
      ? `<span class="tag">${item.category}</span>`
      : "";
    li.innerHTML =
      `<span class="who">${icon}</span><span class="hw">${item.word}</span>${cat}`;
    el.historyList.prepend(li);
  }
  el.categoryCounts.innerHTML = "";
  for (const [cat, n] of Object.entries(state.categoryCounts)) {
    const span = document.createElement("span");
    span.className = "cat-chip";
    span.textContent = `${cat} ${n}`;
    el.categoryCounts.appendChild(span);
  }
}

/** 語を1つ進める */
function advance(word, reading, category, speaker) {
  state.used.add(normalizeWord(reading));
  state.history.push({ word, reading, category, speaker });
  if (category) {
    state.categoryCounts[category] = (state.categoryCounts[category] ?? 0) + 1;
  }
  state.current = { word, reading, category };
  state.hintLevel = 0;
  el.hintText.textContent = "";
  renderCurrent();
  renderHistory();
}

/** サーバーに単語判定を依頼 */
async function judge(word) {
  const res = await fetch("/api/judge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ word }),
  });
  if (!res.ok) throw new Error(`judge ${res.status}`);
  return await res.json(); // { reading, isReal, category, degraded }
}

/** 送信ハンドラ（子の手番） */
async function onSubmit(e) {
  e.preventDefault();
  if (state.gameOver || state.aiThinking) return;
  const word = el.input.value.trim();
  if (!word) return;
  clearMessage();
  setSubmitting(true);
  try {
    const j = await judge(word);
    setDegraded(!!j.degraded);

    // 実在チェック（知育: 本当にある言葉かをやさしく確認）
    if (j.isReal === false) {
      showMessage("「" + word + "」…そのことば、ほんとうにあるかな？", "warn");
      return;
    }

    const result = evaluateTurn(state.current.reading, j.reading, state.used);
    if (!result.ok) {
      if (result.reason === "mismatch") {
        showMessage(result.message, "warn");
        return;
      }
      // 子が「ん」/既出 → 子のまけ
      endGame("lose", result.reason);
      return;
    }

    // 子の手が成立
    advance(word, j.reading, j.category, "child");
    el.input.value = "";
    showMessage("いいね！ 🎉", "ok");
    speak(word);

    // AI が使えるなら AI の手番へ（使えなければソロ継続）
    if (!j.degraded) {
      await aiTurn();
    }
  } catch (err) {
    console.error(err);
    showMessage("うまく つながらなかった。もういちど ためしてね", "warn");
  } finally {
    setSubmitting(false);
    if (!state.gameOver && !state.aiThinking) el.input.focus();
  }
}

/** AI の手番 */
async function aiTurn() {
  if (state.gameOver) return;
  setTurn("ai");
  try {
    const res = await fetch("/api/opponent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nextChar: lastKana(state.current.reading),
        usedWords: state.history.map((h) => h.reading),
        difficulty: state.difficulty,
      }),
    });
    const data = await res.json();
    setDegraded(!!data.degraded);

    if (data.degraded) {
      // AI おやすみ → ソロにフォールバック（子の番に戻す）
      setTurn("child");
      return;
    }
    if (data.gaveUp) {
      // AI が続けられない → 子のかち！
      endGame("win", "ai_gaveup");
      return;
    }

    // 念のためクライアントでも決定論検証（サーバーと二重チェック）
    const check = evaluateTurn(state.current.reading, data.reading, state.used);
    if (!check.ok) {
      endGame("win", "ai_gaveup");
      return;
    }

    advance(data.word, data.reading, data.category, "ai");
    speak(data.word);
    setTurn("child");
  } catch (err) {
    console.error(err);
    setDegraded(true);
    setTurn("child"); // 通信失敗時もゲームは止めない
  }
}

/** ヒント（段階スキャフォールド） */
async function onHint() {
  if (state.gameOver || state.aiThinking) return;
  state.hintLevel = Math.min(4, state.hintLevel + 1);
  const nextChar = lastKana(state.current.reading);
  el.hintBtn.disabled = true;
  el.hintText.textContent = "…";
  try {
    const res = await fetch("/api/hint", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nextChar,
        level: state.hintLevel,
        usedWords: state.history.map((h) => h.word),
        category: state.current.category ?? undefined,
      }),
    });
    const data = await res.json();
    setDegraded(!!data.degraded);
    el.hintText.textContent = data.hint;
    speak(data.hint);
  } catch (err) {
    console.error(err);
    el.hintText.textContent =
      `「${nextChar}」からはじまることばを かんがえてみよう！`;
  } finally {
    if (!state.gameOver && !state.aiThinking) el.hintBtn.disabled = false;
  }
}

/** ゲーム終了（outcome: "win" | "lose"） */
function endGame(outcome, reason) {
  state.gameOver = true;
  const win = outcome === "win";
  el.endTitle.textContent = win ? "🎉 きみの かち！" : "おしまい！";
  const reasons = {
    ai_gaveup: "AIが つづけられなかったよ！ すごい！",
    ends_with_n: "「ん」で おわっちゃった…つぎ がんばろう！",
    reused: "その ことばは もう つかったよ！",
  };
  el.endReason.textContent = reasons[reason] ?? "またあそぼう！";
  el.endCount.textContent = String(state.history.length);
  el.endCategories.innerHTML = "";
  for (const [cat, n] of Object.entries(state.categoryCounts)) {
    const span = document.createElement("span");
    span.className = "cat-chip";
    span.textContent = `${cat} ${n}`;
    el.endCategories.appendChild(span);
  }
  el.endOverlay.classList.toggle("win", win);
  el.endOverlay.classList.remove("hidden");
  el.input.disabled = true;
  el.submitBtn.disabled = true;
  el.hintBtn.disabled = true;
}

/** リセット／初期化 */
function reset() {
  const seed = SEED_WORDS[Math.floor(Math.random() * SEED_WORDS.length)];
  state.current = { ...seed };
  state.used = new Set([normalizeWord(seed.reading)]);
  state.history = [{ ...seed, speaker: "start" }];
  state.categoryCounts = seed.category ? { [seed.category]: 1 } : {};
  state.hintLevel = 0;
  state.gameOver = false;
  state.aiThinking = false;
  el.endOverlay.classList.add("hidden");
  el.input.value = "";
  el.hintText.textContent = "";
  el.submitBtn.textContent = "こたえる";
  clearMessage();
  renderCurrent();
  renderHistory();
  setTurn("child");
}

/** 難易度セレクタ */
function onSelectDifficulty(e) {
  const btn = e.currentTarget;
  state.difficulty = btn.dataset.diff === "normal" ? "normal" : "easy";
  for (const b of el.modeButtons) {
    b.classList.toggle("is-active", b === btn);
  }
}

// イベント登録
el.form.addEventListener("submit", onSubmit);
el.hintBtn.addEventListener("click", onHint);
el.speakBtn.addEventListener("click", () => speak(state.current?.word));
el.resetBtn.addEventListener("click", reset);
el.endResetBtn.addEventListener("click", reset);
for (const b of el.modeButtons) {
  b.addEventListener("click", onSelectDifficulty);
}

// 起動
reset();
