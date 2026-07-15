/**
 * しりとりアプリのフロント制御。
 * - 勝敗判定は shiritori.js（決定論）に委ねる
 * - よみ・実在・カテゴリ判定、ヒント生成はサーバー経由で AI に委ねる
 * - 状態はこのクライアントが保持する（サーバーはステートレス）
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
  history: [], // [{ word, reading, category }]
  categoryCounts: {}, // { どうぶつ: 2, ... }
  hintLevel: 0,
  gameOver: false,
};

// DOM 参照
const el = {
  currentWord: document.getElementById("current-word"),
  currentReading: document.getElementById("current-reading"),
  nextChar: document.getElementById("next-char"),
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
};

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

function setBusy(busy) {
  el.submitBtn.disabled = busy;
  el.hintBtn.disabled = busy;
  el.input.disabled = busy;
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
    li.className = "history-item";
    const cat = item.category
      ? `<span class="tag">${item.category}</span>`
      : "";
    li.innerHTML = `<span class="hw">${item.word}</span>${cat}`;
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

/** 語を1つ進める（成功時） */
function advance(word, reading, category) {
  state.used.add(normalizeWord(reading));
  state.history.push({ word, reading, category });
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

/** 送信ハンドラ */
async function onSubmit(e) {
  e.preventDefault();
  if (state.gameOver) return;
  const word = el.input.value.trim();
  if (!word) return;
  clearMessage();
  setBusy(true);
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
      // reused / ends_with_n はゲーム終了
      endGame(result.reason, {
        word,
        reading: j.reading,
        category: j.category,
      });
      return;
    }

    // 成功
    advance(word, j.reading, j.category);
    el.input.value = "";
    showMessage("いいね！ 🎉", "ok");
    speak(word);
  } catch (err) {
    console.error(err);
    showMessage("うまく つながらなかった。もういちど ためしてね", "warn");
  } finally {
    setBusy(false);
    el.input.focus();
  }
}

/** ヒント（段階スキャフォールド） */
async function onHint() {
  if (state.gameOver) return;
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
    el.hintBtn.disabled = false;
  }
}

/** ゲーム終了 */
function endGame(reason, lastEntry) {
  state.gameOver = true;
  const reasons = {
    ends_with_n: "「ん」で おわっちゃった！",
    reused: `「${lastEntry?.word ?? ""}」は もう つかったよ！`,
  };
  el.endReason.textContent = reasons[reason] ?? "おしまい！";
  el.endCount.textContent = String(state.history.length);
  el.endCategories.innerHTML = "";
  for (const [cat, n] of Object.entries(state.categoryCounts)) {
    const span = document.createElement("span");
    span.className = "cat-chip";
    span.textContent = `${cat} ${n}`;
    el.endCategories.appendChild(span);
  }
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
  state.history = [{ ...seed }];
  state.categoryCounts = seed.category ? { [seed.category]: 1 } : {};
  state.hintLevel = 0;
  state.gameOver = false;
  el.endOverlay.classList.add("hidden");
  el.input.disabled = false;
  el.submitBtn.disabled = false;
  el.hintBtn.disabled = false;
  el.input.value = "";
  el.hintText.textContent = "";
  clearMessage();
  renderCurrent();
  renderHistory();
  el.input.focus();
}

// イベント登録
el.form.addEventListener("submit", onSubmit);
el.hintBtn.addEventListener("click", onHint);
el.speakBtn.addEventListener("click", () => speak(state.current?.word));
el.resetBtn.addEventListener("click", reset);
el.endResetBtn.addEventListener("click", reset);

// 起動
reset();
