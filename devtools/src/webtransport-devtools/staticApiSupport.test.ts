/**
 * 静的な WebTransport API 存在確認のテスト
 *
 * 接続を使わない判定なので、Node の globalThis (WebTransport 非搭載) と、
 * 純粋関数に渡すデータだけで検証する。ブラウザ実装での存在確認は、
 * 接続を必要としない Playwright E2E で確認する。
 */

import { assert, test } from "vite-plus/test";
import {
  computePresenceSummary,
  detectStaticApiPresence,
  presenceBadgeClass,
  presenceBadgeText,
  type StaticApiGroup,
} from "./staticApiSupport";

// Node の globalThis には WebTransport が無いため、全項目が absent になる
test("WebTransport が無い環境では全項目が absent になる", () => {
  const groups = detectStaticApiPresence();
  assert.equal(groups.length, 10);
  const items = groups.flatMap((group) => group.items);
  assert.equal(items.length, 52);
  assert.ok(items.every((item) => !item.supported));
});

// 静的チェックの一覧は W3C WebTransport CR (2026-07-30) の IDL を網羅する。
// 一覧から項目が落ちる回帰を検出するため、主要な API が含まれることを確認する。
test("CR 2026-07-30 の主要 API が一覧に含まれる", () => {
  const names = new Set(
    detectStaticApiPresence()
      .flatMap((group) => group.items)
      .map((item) => item.name),
  );
  const required = [
    "WebTransport.prototype.exportKeyingMaterial",
    "WebTransport.supportsReliableOnly",
    "WebTransportDatagramsWritable",
    "WebTransportDatagramsWritable.prototype.sendGroup",
    "WebTransportDatagramsWritable.prototype.sendOrder",
    "WebTransportWriter",
    "WebTransportWriter.prototype.atomicWrite",
    "WebTransportWriter.prototype.commit",
    "WebTransportSendStream.prototype.getWriter",
    "WebTransportError constructor",
    "Datagram send path (writable or createWritable)",
  ];
  for (const name of required) {
    assert.ok(names.has(name), `${name} が静的チェックの一覧に無い`);
  }
});

// サマリの母集団は deprecated (writable) と対で判定する詳細項目 (createWritable) を除く
function groupsWith(items: StaticApiGroup["items"]): StaticApiGroup[] {
  return [
    {
      name: "Global",
      items: [{ name: "WebTransport", supported: true, required: true }, ...items],
    },
  ];
}

// 実データの母集団は 52 項目から deprecated 1 件と詳細 1 件を除いた 50 項目である
test("実データのサマリの分母は 50 項目である", () => {
  const summary = computePresenceSummary(detectStaticApiPresence());
  assert.equal(summary.totalCount, 50);
});

test("全項目が存在すれば all になる", () => {
  const groups = groupsWith([
    { name: "a", supported: true },
    { name: "b", supported: true },
  ]);
  const summary = computePresenceSummary(groups);
  assert.deepEqual(summary, { state: "all", presentCount: 3, totalCount: 3 });
  assert.equal(presenceBadgeText(summary), "All Present (3 / 3)");
});

test("存在しない項目があれば partial になる", () => {
  const groups = groupsWith([
    { name: "a", supported: true },
    { name: "b", supported: false },
  ]);
  const summary = computePresenceSummary(groups);
  assert.deepEqual(summary, { state: "partial", presentCount: 2, totalCount: 3 });
  assert.equal(presenceBadgeText(summary), "Partially Present (2 / 3)");
});

test("required を付けた WebTransport 自体が無ければ unsupported になる", () => {
  const groups: StaticApiGroup[] = [
    {
      name: "Global",
      items: [
        { name: "WebTransport", supported: false, required: true },
        { name: "a", supported: true },
      ],
    },
  ];
  const summary = computePresenceSummary(groups);
  assert.deepEqual(summary, { state: "unsupported", presentCount: 1, totalCount: 2 });
  assert.equal(presenceBadgeText(summary), "WebTransport Not Present");
});

test("deprecated と excludeFromSummary は母集団から外れる", () => {
  const groups = groupsWith([
    { name: "a", supported: true },
    { name: "deprecated", supported: false, deprecated: true },
    { name: "detail", supported: false, excludeFromSummary: true },
  ]);
  const summary = computePresenceSummary(groups);
  assert.deepEqual(summary, { state: "all", presentCount: 2, totalCount: 2 });
});

test("サマリの色クラスは状態ごとに異なる", () => {
  assert.ok(presenceBadgeClass("all").includes("green"));
  assert.ok(presenceBadgeClass("partial").includes("yellow"));
  assert.ok(presenceBadgeClass("unsupported").includes("red"));
});
