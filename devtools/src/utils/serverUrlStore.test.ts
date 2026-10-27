/**
 * 接続先 (MOQT URI) の候補一覧の単体テスト
 *
 * 候補の追加・削除・有効 / 無効、保存形式の読み書き、有効な候補からの選択を固定する。
 * OPFS が使えない環境 (Node) でも投げずに空の一覧で動くことも確かめる。
 */

import { assert, test } from "vite-plus/test";
import {
  addServerUrlEntry,
  enabledServerUrlUrls,
  formatServerUrlCandidatesParam,
  formatServerUrlEntries,
  legacyServerUrlEntry,
  parseServerUrlCandidatesParam,
  parseServerUrlEntries,
  persistServerUrlEntries,
  readServerUrlEntries,
  removeServerUrlEntry,
  setServerUrlEntryEnabled,
  validateNewServerUrl,
  type ServerUrlEntry,
} from "./serverUrlStore";

/** 有効な候補 2 件と無効な候補 1 件の一覧 (テストの初期値) */
function sampleEntries(): ServerUrlEntry[] {
  return [
    { url: "moqt://relay-a.example:4443/", enabled: true },
    { url: "moqt://relay-b.example:4443/", enabled: false },
    { url: "moqt://relay-c.example:4443/", enabled: true },
  ];
}

// --- validateNewServerUrl ---

// 前後の空白を捨てた MOQT URI は登録できる
test("validateNewServerUrl: 前後の空白を捨てて登録できる", () => {
  assert.deepEqual(validateNewServerUrl([], "  moqt://example.test:4443/  "), {
    kind: "ok",
    url: "moqt://example.test:4443/",
  });
});

// fragment を含む MOQT URI も 1 つの接続先として登録できる (fragment は接続に使う)
test("validateNewServerUrl: fragment を含む MOQT URI も登録できる", () => {
  assert.deepEqual(
    validateNewServerUrl([], "moqt://example.test/#msf:room-123--catalog&c4m=QUFB"),
    { kind: "ok", url: "moqt://example.test/#msf:room-123--catalog&c4m=QUFB" },
  );
});

// 空欄は登録できない
test("validateNewServerUrl: 空欄は登録できない", () => {
  const result = validateNewServerUrl([], "   ");
  assert.equal(result.kind, "error");
  assert.equal(result.kind === "error" ? result.message : "", "MOQT URI must not be empty");
});

// moqt:// で始まらない値は登録できない (接続時の解釈と食い違わせない)
test("validateNewServerUrl: moqt:// で始まらない値は登録できない", () => {
  const result = validateNewServerUrl([], "https://example.test/");
  assert.equal(result.kind, "error");
  assert.include(result.kind === "error" ? result.message : "", "moqt://");
});

// MOQT URI として読めない fragment は登録できない (接続の直前に失敗させない)
test("validateNewServerUrl: 読めない fragment は登録できない", () => {
  const result = validateNewServerUrl([], "moqt://example.test/#bad");
  assert.equal(result.kind, "error");
  assert.include(result.kind === "error" ? result.message : "", "fragment");
});

// 登録済みの URI と同じ値は重複として登録できない (前後の空白は同じ URI とみなす)
test("validateNewServerUrl: 登録済みの URI は重複として登録できない", () => {
  const result = validateNewServerUrl(sampleEntries(), " moqt://relay-a.example:4443/ ");
  assert.equal(result.kind, "error");
  assert.equal(
    result.kind === "error" ? result.message : "",
    "this MOQT URI is already registered: moqt://relay-a.example:4443/",
  );
});

// 接続時に失敗する msf fragment は登録できない (接続時と同じライブラリの検証を通す)
test("validateNewServerUrl: 接続時に失敗する msf fragment は登録できない", () => {
  // msf の値が空
  assert.equal(validateNewServerUrl([], "moqt://example.test/#msf:").kind, "error");
  // namespace と track 名の区切り (--) が無い
  assert.equal(validateNewServerUrl([], "moqt://example.test/#msf:room").kind, "error");
  // connection=q は Native QUIC が必要で未対応
  const unsupportedTransport = validateNewServerUrl(
    [],
    "moqt://example.test/#msf:room-123--catalog&connection=q",
  );
  assert.equal(unsupportedTransport.kind, "error");
  assert.include(
    unsupportedTransport.kind === "error" ? unsupportedTransport.message : "",
    "Native QUIC",
  );
});

// c4m が Base64 として復号できない候補は登録できない (接続時の検証と同じ)
test("validateNewServerUrl: 復号できない c4m は登録できない", () => {
  const result = validateNewServerUrl([], "moqt://example.test/#msf:room-123--catalog&c4m=!!!");
  assert.equal(result.kind, "error");
  assert.include(result.kind === "error" ? result.message : "", "c4m");
});

// msf fragment の namespace が送信できない値 (予約 namespace) の候補は登録できない
test("validateNewServerUrl: 予約 namespace を持つ候補は登録できない", () => {
  // ".2esession" は §2.4.3 の予約 namespace (".session") の §8.8 の表記
  const result = validateNewServerUrl([], "moqt://example.test/#msf:.2esession--catalog");
  assert.equal(result.kind, "error");
  assert.include(result.kind === "error" ? result.message : "", "reserved");
});

// --- addServerUrlEntry / removeServerUrlEntry / setServerUrlEntryEnabled ---

// 追加した候補は末尾に並び、接続に使う (enabled: true) 状態になる
test("addServerUrlEntry: 有効な候補として末尾に追加する", () => {
  const entries = addServerUrlEntry(sampleEntries(), "moqt://relay-d.example:4443/");
  assert.deepEqual(entries, [
    { url: "moqt://relay-a.example:4443/", enabled: true },
    { url: "moqt://relay-b.example:4443/", enabled: false },
    { url: "moqt://relay-c.example:4443/", enabled: true },
    { url: "moqt://relay-d.example:4443/", enabled: true },
  ]);
});

// 追加しても元の一覧は書き換えない (Preact の signal へ新しい配列を渡すため)
test("addServerUrlEntry: 元の一覧を書き換えない", () => {
  const entries = sampleEntries();
  addServerUrlEntry(entries, "moqt://relay-d.example:4443/");
  assert.deepEqual(
    entries.map((entry) => entry.url),
    [
      "moqt://relay-a.example:4443/",
      "moqt://relay-b.example:4443/",
      "moqt://relay-c.example:4443/",
    ],
  );
});

// 指定した位置の候補だけを取り除く。範囲外の位置では何もしない
test("removeServerUrlEntry: 指定した位置の候補だけを取り除く", () => {
  assert.deepEqual(
    removeServerUrlEntry(sampleEntries(), 1).map((entry) => entry.url),
    ["moqt://relay-a.example:4443/", "moqt://relay-c.example:4443/"],
  );
  assert.deepEqual(removeServerUrlEntry(sampleEntries(), 99), sampleEntries());
});

// 指定した位置の候補だけを無効にできる。一覧からは消さない
test("setServerUrlEntryEnabled: 指定した位置の候補だけを無効にする", () => {
  const entries = setServerUrlEntryEnabled(sampleEntries(), 0, false);
  assert.deepEqual(entries, [
    { url: "moqt://relay-a.example:4443/", enabled: false },
    { url: "moqt://relay-b.example:4443/", enabled: false },
    { url: "moqt://relay-c.example:4443/", enabled: true },
  ]);
  assert.deepEqual(setServerUrlEntryEnabled(sampleEntries(), 0, true), sampleEntries());
  assert.deepEqual(setServerUrlEntryEnabled(sampleEntries(), 99, false), sampleEntries());
});

// 接続に使う候補だけを登録順に返す
test("enabledServerUrlUrls: 有効な候補だけを登録順に返す", () => {
  assert.deepEqual(enabledServerUrlUrls(sampleEntries()), [
    "moqt://relay-a.example:4443/",
    "moqt://relay-c.example:4443/",
  ]);
  assert.deepEqual(enabledServerUrlUrls([]), []);
});

// --- pickServerUrlCandidate ---

// 乱数を候補の位置へ写す規則は PBT (serverUrlStore.prop.ts) が全入力について確かめる。

// --- parseServerUrlEntries / formatServerUrlEntries ---

// 保存形式は urlEntries を持つ JSON にする (画面に出さない値を混ぜない)
test("formatServerUrlEntries: url と enabled だけを保存する", () => {
  assert.equal(
    formatServerUrlEntries([{ url: "moqt://a.example/", enabled: true }]),
    '{"urlEntries":[{"url":"moqt://a.example/","enabled":true}]}',
  );
});

// 壊れた JSON、urlEntries を持たない値、構造の違う候補を含む値は空の一覧にする
test("parseServerUrlEntries: 読めない保存内容は空の一覧にする", () => {
  assert.deepEqual(parseServerUrlEntries(""), []);
  assert.deepEqual(parseServerUrlEntries("not json"), []);
  assert.deepEqual(parseServerUrlEntries("{}"), []);
  assert.deepEqual(parseServerUrlEntries('{"urlEntries":null}'), []);
  assert.deepEqual(parseServerUrlEntries('{"urlEntries":{}}'), []);
  // enabled が boolean でない
  assert.deepEqual(
    parseServerUrlEntries('{"urlEntries":[{"url":"moqt://a.example/","enabled":1}]}'),
    [],
  );
  // url が空
  assert.deepEqual(parseServerUrlEntries('{"urlEntries":[{"url":"","enabled":true}]}'), []);
  // 1 件でも壊れていれば全体を空にする
  assert.deepEqual(
    parseServerUrlEntries(
      '{"urlEntries":[{"url":"moqt://a.example/","enabled":true},{"url":"moqt://b.example/"}]}',
    ),
    [],
  );
});

// 保存内容に接続に使えない MOQT URI が混ざっていたら、その候補だけを捨てる
// (手で書き換えた保存内容や古い形式の値で、接続のたびに失敗しないようにする)
test("parseServerUrlEntries: 接続に使えない MOQT URI の候補は捨てる", () => {
  assert.deepEqual(
    parseServerUrlEntries(
      '{"urlEntries":[{"url":"https://example.test/","enabled":true},{"url":"moqt://ok.example/","enabled":false}]}',
    ),
    [{ url: "moqt://ok.example/", enabled: false }],
  );
  // c4m の Base64 が壊れている候補も捨てる
  assert.deepEqual(
    parseServerUrlEntries(
      '{"urlEntries":[{"url":"moqt://example.test/#msf:a--b&c4m=!!!","enabled":true}]}',
    ),
    [],
  );
});

// 同じ URI の候補が並んでいても 1 つにまとめる (抽選確率と画面の行が重複しないようにする)
test("parseServerUrlEntries: 同じ URI の候補は 1 つにまとめる", () => {
  assert.deepEqual(
    parseServerUrlEntries(
      '{"urlEntries":[{"url":"moqt://a.example/","enabled":true},{"url":" moqt://a.example/ ","enabled":false}]}',
    ),
    [{ url: "moqt://a.example/", enabled: true }],
  );
});

// 保存した候補に余分なプロパティがあっても、url と enabled だけを取り出す
test("parseServerUrlEntries: 余分なプロパティは捨てる", () => {
  assert.deepEqual(
    parseServerUrlEntries('{"urlEntries":[{"url":"moqt://a.example/","enabled":false,"x":1}]}'),
    [{ url: "moqt://a.example/", enabled: false }],
  );
});

// --- 旧形式からの移行 ---

// 旧形式 (1 行の MOQT URI) は有効な候補 1 件として移行する
test("legacyServerUrlEntry: 1 行の MOQT URI を有効な候補にする", () => {
  assert.deepEqual(legacyServerUrlEntry("  moqt://remembered.example:4443/ \n"), {
    url: "moqt://remembered.example:4443/",
    enabled: true,
  });
});

// 空の内容と複数行の内容は覚えていないものとして扱う (旧形式の読み方と同じ)
test("legacyServerUrlEntry: 空の内容と複数行は候補にしない", () => {
  assert.isNull(legacyServerUrlEntry(""));
  assert.isNull(legacyServerUrlEntry("   "));
  assert.isNull(legacyServerUrlEntry("moqt://a.example/\nmoqt://b.example/"));
});

// 接続に使えない MOQT URI は移行しない (壊れた旧形式が候補として復活しないようにする)
test("legacyServerUrlEntry: 接続に使えない MOQT URI は候補にしない", () => {
  assert.isNull(legacyServerUrlEntry("https://example.test/"));
  assert.isNull(legacyServerUrlEntry("moqt://example.test/#msf:room"));
});

// --- Copy URL の urlCandidates ---

// 有効な候補を JSON の文字列配列にして、読み戻せる
test("parseServerUrlCandidatesParam / formatServerUrlCandidatesParam: 共有リンクの候補を往復できる", () => {
  const formatted = formatServerUrlCandidatesParam(sampleEntries());
  assert.equal(formatted, '["moqt://relay-a.example:4443/","moqt://relay-c.example:4443/"]');
  assert.deepEqual(formatted === null ? null : parseServerUrlCandidatesParam(formatted), [
    { url: "moqt://relay-a.example:4443/", enabled: true },
    { url: "moqt://relay-c.example:4443/", enabled: true },
  ]);
});

// 有効な候補が無ければクエリに載せない
test("formatServerUrlCandidatesParam: 有効な候補が無ければ null を返す", () => {
  assert.isNull(formatServerUrlCandidatesParam([]));
  assert.isNull(formatServerUrlCandidatesParam([{ url: "moqt://a.example/", enabled: false }]));
});

// 共有リンクの候補はすべて有効な候補として扱い、重複は 1 つにまとめる
test("parseServerUrlCandidatesParam: 文字列の配列を有効な候補にする", () => {
  assert.deepEqual(
    parseServerUrlCandidatesParam('["moqt://a.example/","moqt://a.example/","moqt://b.example/"]'),
    [
      { url: "moqt://a.example/", enabled: true },
      { url: "moqt://b.example/", enabled: true },
    ],
  );
});

// 読めない値、MOQT URI でない要素、空文字を含む値は無視する (候補を変えない)
test("parseServerUrlCandidatesParam: 読めない値は null を返す", () => {
  assert.isNull(parseServerUrlCandidatesParam("not json"));
  assert.isNull(parseServerUrlCandidatesParam('{"urls":[]}'));
  assert.isNull(parseServerUrlCandidatesParam('["moqt://a.example/",1]'));
  assert.isNull(parseServerUrlCandidatesParam('["moqt://a.example/",""]'));
  assert.isNull(parseServerUrlCandidatesParam('["https://a.example/"]'));
  // msf fragment として読めない (接続時に失敗する) 値も受け付けない
  assert.isNull(parseServerUrlCandidatesParam('["moqt://a.example/#msf:room"]'));
});

// 空の配列は「候補を使わない」指定として読む
test("parseServerUrlCandidatesParam: 空の配列は空の一覧にする", () => {
  assert.deepEqual(parseServerUrlCandidatesParam("[]"), []);
});

// --- OPFS が使えない環境 ---

// OPFS が無い環境 (Node) では空の一覧で動き、保存は失敗として false を返す (投げない)
test("readServerUrlEntries / persistServerUrlEntries: OPFS が無い環境でも投げない", async () => {
  assert.deepEqual(await readServerUrlEntries(), []);
  assert.isFalse(await persistServerUrlEntries(sampleEntries()));
  assert.isFalse(await persistServerUrlEntries([]));
});
