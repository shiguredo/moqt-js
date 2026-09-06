import { test, assert } from "vite-plus/test";
import {
  buildResolvedClosedOutcome,
  buildRejectedClosedOutcome,
  formatClosedOutcomeField,
} from "./closedOutcome";

// closed が fulfilled になるときに受け取る WebTransportCloseInfo (W3C §6.10) は、
// ピアが code / reason を渡した場合のみフィールドがセットされる (§6.6)。
// どちらの形もそのまま記録されることを検証する
test("buildResolvedClosedOutcome は closeCode と reason をそのまま記録する", () => {
  const outcome = buildResolvedClosedOutcome({ closeCode: 42, reason: "test-close-reason" });
  assert.equal(outcome.state, "resolved");
  assert.equal(outcome.closeCode, 42);
  assert.equal(outcome.reason, "test-close-reason");
});

// ピアが code / reason なしでセッションを終了した場合や、
// 実装がフィールドを省略した辞書で fulfill した場合に undefined が保持されることを検証する
test("buildResolvedClosedOutcome は空の closeInfo で closeCode / reason が undefined になる", () => {
  const outcome = buildResolvedClosedOutcome({});
  assert.equal(outcome.state, "resolved");
  assert.equal(outcome.closeCode, undefined);
  assert.equal(outcome.reason, undefined);
});

// 異常終了では closed が WebTransportError で reject される (W3C §6.5)。
// Error インスタンスの message が記録されることを検証する
test("buildRejectedClosedOutcome は Error インスタンスの message を記録する", () => {
  const outcome = buildRejectedClosedOutcome(new Error("session aborted"));
  assert.equal(outcome.state, "rejected");
  assert.equal(outcome.errorMessage, "session aborted");
});

// Promise の catch に渡される値の型は unknown のため、
// Error 以外の値も文字列化して記録されることを検証する
test("buildRejectedClosedOutcome は Error 以外の値を文字列化する", () => {
  const outcome = buildRejectedClosedOutcome("unexpected");
  assert.equal(outcome.state, "rejected");
  assert.equal(outcome.errorMessage, "unexpected");
});

// 表示 (およびブラウザ E2E からの読み出し) ではフィールドの欠落と空文字を
// 区別できる必要がある。undefined は "undefined" として表示する
test('formatClosedOutcomeField は undefined を "undefined" と表示する', () => {
  assert.equal(formatClosedOutcomeField(undefined), "undefined");
});

// 空文字は「フィールドは存在するが空」であることを示すため "(empty)" と表示する
test('formatClosedOutcomeField は空文字を "(empty)" と表示する', () => {
  assert.equal(formatClosedOutcomeField(""), "(empty)");
});

// closeCode は数値のため文字列化する。仕様上のデフォルト値 0 も表示できることを検証する
test("formatClosedOutcomeField は数値を文字列化する", () => {
  assert.equal(formatClosedOutcomeField(0), "0");
  assert.equal(formatClosedOutcomeField(42), "42");
});

// 非空文字列 (reason 等) は加工せずにそのまま表示する
test("formatClosedOutcomeField は非空文字列をそのまま返す", () => {
  assert.equal(formatClosedOutcomeField("test-close-reason"), "test-close-reason");
});
