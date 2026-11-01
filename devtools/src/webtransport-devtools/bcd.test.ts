import { test, assert } from "vite-plus/test";
import { BCD_CONFIRMED_DATE, bcdSupportEntries } from "./bcd";

// 各テストは bcd.ts の静的テーブルだけを検証する。WebTransport の接続先サーバーは
// 不要であり、モックやスタブも使わない。

test("bcdSupportEntries の name は空でなく一意である", () => {
  // name は BcdBadges の name プロパティとして使う。name が空だと
  // バッジの対象項目を特定できず、重複すると別項目のバッジが表示されてしまう
  const names = bcdSupportEntries.map((entry) => entry.name);
  for (const name of names) {
    assert.ok(name.length > 0, "name が空のエントリがある");
  }
  assert.equal(new Set(names).size, names.length, "name が重複しているエントリがある");
});

test("protocols は W3C §6.9 の設定項目で、Chrome 143 / Firefox 155 / Safari 26.4 に対応している", () => {
  // BCD の api.WebTransport.WebTransport.options_protocols_parameter (2026-10-31 時点)
  // の値。protocols はサーバーとの application-level protocol のネゴシエーションに使う
  const protocols = bcdSupportEntries.find((entry) => entry.name === "protocols");
  assert.ok(protocols !== undefined, "protocols のエントリが存在しない");
  assert.equal(protocols.section, "§6.9", "protocols の節番号が W3C §6.9 ではない");
  assert.equal(protocols.chrome, "143", "protocols の Chrome の値が BCD と一致しない");
  assert.equal(protocols.firefox, "155", "protocols の Firefox の値が BCD と一致しない");
  assert.equal(protocols.safari, "26.4", "protocols の Safari の値が BCD と一致しない");
  // BCD の status.experimental は false のため experimental を付けない
  assert.equal(protocols.experimental, undefined, "protocols は experimental ではない");
});

test("Safari の maxBufferedDatagrams はプレビュー版でのみ対応している (preview)", () => {
  // BCD は 2026-08-18 に Safari の incomingMaxBufferedDatagrams /
  // outgoingMaxBufferedDatagrams を false から preview に更新した。
  // BcdBadges は preview を「対応開始バージョン」ではなく琥珀の preview バッジで表示する
  const expectedNames = ["incomingMaxBufferedDatagrams", "outgoingMaxBufferedDatagrams"];
  for (const name of expectedNames) {
    const entry = bcdSupportEntries.find((item) => item.name === name);
    assert.ok(entry !== undefined, `${name} のエントリが存在しない`);
    assert.equal(entry.chrome, "151", `${name} の Chrome の値が BCD と一致しない`);
    assert.equal(entry.firefox, null, `${name} の Firefox の値が BCD と一致しない`);
    assert.equal(entry.safari, "preview", `${name} の Safari が preview ではない`);
  }
});

test("experimental は BCD の status.experimental が true の 4 項目だけに指定する", () => {
  // BCD 2026-10-31 時点で experimental なのは次の 4 項目。
  // experimental な項目を通常の緑の対応バッジだけで表示すると、安定版で
  // 使える API だと誤解させるため、BcdBadges は experimental バッジを追加する
  const expectedNames = [
    "anticipatedConcurrentIncomingUnidirectionalStreams",
    "anticipatedConcurrentIncomingBidirectionalStreams",
    "incomingMaxBufferedDatagrams",
    "outgoingMaxBufferedDatagrams",
  ];
  const actualNames = bcdSupportEntries
    .filter((entry) => entry.experimental === true)
    .map((entry) => entry.name);
  assert.equal(actualNames.length, 4, "experimental の項目数が BCD と一致しない");
  assert.deepEqual(
    [...actualNames].sort(),
    [...expectedNames].sort(),
    "experimental の項目が BCD と一致しない",
  );

  // BCD で experimental ではない項目には experimental を付けない
  for (const entry of bcdSupportEntries) {
    if (!expectedNames.includes(entry.name)) {
      assert.equal(entry.experimental, undefined, `${entry.name} は experimental ではない`);
    }
  }
});

test("BCD_CONFIRMED_DATE は YYYY-MM-DD 形式で、実在する日付である", () => {
  // 確認日は接続パネルにそのまま表示する。存在しない日付や別形式を表示しないようにする
  assert.match(
    BCD_CONFIRMED_DATE,
    /^\d{4}-\d{2}-\d{2}$/,
    "BCD_CONFIRMED_DATE が YYYY-MM-DD 形式ではない",
  );
  const timestamp = Date.parse(`${BCD_CONFIRMED_DATE}T00:00:00Z`);
  assert.ok(!Number.isNaN(timestamp), "BCD_CONFIRMED_DATE を日付として解釈できない");
  assert.equal(
    new Date(timestamp).toISOString().slice(0, 10),
    BCD_CONFIRMED_DATE,
    "BCD_CONFIRMED_DATE の日付が実在しない",
  );
});

test("各ブラウザの値はバージョン文字列・null・preview のいずれかである", () => {
  // BcdBadges は null を未対応、preview をプレビュー版のみの対応、それ以外を
  // 対応開始バージョンとして扱う。想定外の値があるとバッジの表示が壊れる
  for (const entry of bcdSupportEntries) {
    for (const browser of ["chrome", "firefox", "safari"] as const) {
      const version = entry[browser];
      const valid = version === null || version === "preview" || /^\d+(?:\.\d+)?$/.test(version);
      assert.ok(valid, `${entry.name} の ${browser} の値が不正: ${String(version)}`);
    }
  }
});
