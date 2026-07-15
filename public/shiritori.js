/**
 * しりとりの決定論ロジック（ブラウザ・Deno 共用の素の JS ESモジュール）。
 *
 * 設計原則: ゲームの勝敗（末尾一致・「ん」終了・既出）は、AI のゆらぎに
 * 依存させず、必ずこの決定論コードで確定させる。AI が返す「よみ（ひらがな）」
 * を入力として受け取り、しりとり用の末尾/先頭かなを正規化して比較する。
 */

/** 小文字（拗音・促音など）→ 大文字への正規化表 */
const SMALL_TO_LARGE = {
  "ぁ": "あ",
  "ぃ": "い",
  "ぅ": "う",
  "ぇ": "え",
  "ぉ": "お",
  "ゃ": "や",
  "ゅ": "ゆ",
  "ょ": "よ",
  "ゎ": "わ",
  "っ": "つ",
};

/** 濁点・半濁点 → 清音への正規化表（幼児向けにゆるく繋げる用） */
const DAKUTEN_TO_SEION = {
  "が": "か",
  "ぎ": "き",
  "ぐ": "く",
  "げ": "け",
  "ご": "こ",
  "ざ": "さ",
  "じ": "し",
  "ず": "す",
  "ぜ": "せ",
  "ぞ": "そ",
  "だ": "た",
  "ぢ": "ち",
  "づ": "つ",
  "で": "て",
  "ど": "と",
  "ば": "は",
  "び": "ひ",
  "ぶ": "ふ",
  "べ": "へ",
  "ぼ": "ほ",
  "ぱ": "は",
  "ぴ": "ひ",
  "ぷ": "ふ",
  "ぺ": "へ",
  "ぽ": "ほ",
};

/**
 * 幼児向けに濁点をゆるく許容するか（が=か で繋げてよい）。
 * true にすると難易度が下がる。知育プロダクトの方針としてデフォルト有効。
 */
export const LOOSE_DAKUTEN = true;

/** カタカナをひらがなへ変換（AIがカタカナを返した場合の保険） */
function toHiragana(s) {
  return s.replace(
    /[ァ-ヶ]/g,
    (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60),
  );
}

/** よみを比較用に前処理（ひらがな化・トリム・空白除去） */
function clean(reading) {
  return toHiragana(reading).trim().replace(/\s+/g, "");
}

/** 小文字→大文字・「を」→「お」の1文字正規化 */
function normalizeChar(ch) {
  if (SMALL_TO_LARGE[ch]) ch = SMALL_TO_LARGE[ch];
  if (ch === "を") ch = "お";
  return ch;
}

/** マッチング用に濁点をゆるくする（LOOSE_DAKUTEN 有効時のみ） */
function forMatch(ch) {
  if (LOOSE_DAKUTEN && DAKUTEN_TO_SEION[ch]) return DAKUTEN_TO_SEION[ch];
  return ch;
}

/**
 * しりとり上の「末尾のかな」を得る。
 * 長音「ー」で終わる場合は直前の音を採用し、小文字・「を」を正規化する。
 * @param {string} reading
 * @returns {string}
 */
export function lastKana(reading) {
  const s = clean(reading);
  if (s.length === 0) return "";
  let i = s.length - 1;
  while (i > 0 && s[i] === "ー") i--; // 末尾の長音を飛ばす
  return normalizeChar(s[i]);
}

/**
 * しりとり上の「先頭のかな」を得る（小文字・「を」を正規化）。
 * @param {string} reading
 * @returns {string}
 */
export function firstKana(reading) {
  const s = clean(reading);
  if (s.length === 0) return "";
  return normalizeChar(s[0]);
}

/**
 * 末尾が「ん」で終わるか（負け判定）。
 * @param {string} reading
 * @returns {boolean}
 */
export function endsWithN(reading) {
  return lastKana(reading) === "ん";
}

/**
 * 直前の語の末尾と、入力語の先頭が繋がるか。
 * @param {string} prevReading
 * @param {string} nextReading
 * @returns {boolean}
 */
export function connects(prevReading, nextReading) {
  const tail = forMatch(lastKana(prevReading));
  const head = forMatch(firstKana(nextReading));
  return tail !== "" && head !== "" && tail === head;
}

/**
 * 既出判定用に語を正規化（よみベースで重複を検出）。
 * @param {string} reading
 * @returns {string}
 */
export function normalizeWord(reading) {
  return clean(reading);
}

/**
 * 1手を判定する。UI に依存しない純粋関数。
 * @param {string} prevReading 直前の語のよみ
 * @param {string} nextReading 入力語のよみ
 * @param {Set<string>} usedReadings これまでに使われた語（正規化済みよみ）の集合
 * @returns {{ok:true,nextLastChar:string}|{ok:false,reason:"mismatch"|"reused"|"ends_with_n",message:string}}
 */
export function evaluateTurn(prevReading, nextReading, usedReadings) {
  if (!connects(prevReading, nextReading)) {
    return {
      ok: false,
      reason: "mismatch",
      message: `「${lastKana(prevReading)}」からはじまることばだよ`,
    };
  }
  if (usedReadings.has(normalizeWord(nextReading))) {
    return {
      ok: false,
      reason: "reused",
      message: "そのことばはもうつかったよ！",
    };
  }
  if (endsWithN(nextReading)) {
    return {
      ok: false,
      reason: "ends_with_n",
      message: "「ん」でおわっちゃった！",
    };
  }
  return { ok: true, nextLastChar: lastKana(nextReading) };
}
