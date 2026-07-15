import { assertEquals } from "jsr:@std/assert@1";
import {
  connects,
  endsWithN,
  evaluateTurn,
  firstKana,
  lastKana,
} from "../public/shiritori.js";

Deno.test("lastKana: 基本", () => {
  assertEquals(lastKana("りんご"), "ご");
  assertEquals(lastKana("さる"), "る");
});

Deno.test("lastKana: 長音「ー」は直前の音", () => {
  assertEquals(lastKana("らーめん"), "ん");
  assertEquals(lastKana("こんぴゅーたー"), "た");
  assertEquals(lastKana("かれー"), "れ");
});

Deno.test("lastKana: 小文字は大文字化", () => {
  assertEquals(lastKana("きしゃ"), "や");
  assertEquals(lastKana("がっき"), "き");
});

Deno.test("lastKana: 「を」は「お」", () => {
  assertEquals(lastKana("を"), "お");
});

Deno.test("firstKana: 基本", () => {
  assertEquals(firstKana("ごりら"), "ご");
  assertEquals(firstKana("しゃもじ"), "し");
});

Deno.test("endsWithN", () => {
  assertEquals(endsWithN("みかん"), true);
  assertEquals(endsWithN("りんご"), false);
  assertEquals(endsWithN("ぺんぎん"), true);
});

Deno.test("connects: 正常に繋がる", () => {
  assertEquals(connects("りんご", "ごりら"), true);
});

Deno.test("connects: 繋がらない", () => {
  assertEquals(connects("りんご", "さる"), false);
});

Deno.test("connects: 濁点ゆるめ（が=か）", () => {
  assertEquals(connects("すいか", "がりがり"), true); // か ↔ が
  assertEquals(connects("たまご", "こあら"), true); // ご ↔ こ
});

Deno.test("evaluateTurn: 一致で成功", () => {
  const r = evaluateTurn("りんご", "ごりら", new Set());
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.nextLastChar, "ら");
});

Deno.test("evaluateTurn: 不一致", () => {
  const r = evaluateTurn("りんご", "さる", new Set());
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "mismatch");
});

Deno.test("evaluateTurn: 既出", () => {
  const used = new Set(["ごりら"]);
  const r = evaluateTurn("りんご", "ごりら", used);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "reused");
});

Deno.test("evaluateTurn: 末尾んの語は ends_with_n", () => {
  const r = evaluateTurn("かに", "にんじん", new Set());
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "ends_with_n");
});
