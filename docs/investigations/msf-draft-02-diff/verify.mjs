// MSF draft-02 追従差分の実測スクリプト
//
// 差分レポート (README.md) の P0 判定を、実際の公開 API で確認する。
// 事前に `pnpm run build` してから `node docs/investigations/msf-draft-02-diff/verify.mjs` を実行する。
//
// 各ケースは「draft-02 の仕様に適合する入力」または「draft-02 で不正になる入力」を
// 現行実装へ渡し、受理 / 拒否とエラー文言を出す。期待どおりでない結果に `NG` を付ける。
//
// コメントはすべて日本語、出力するログはすべて英語にする (AGENTS.md の規約)。

const m = await import("../../../dist/index.js");

const encoder = new TextEncoder();

let failed = 0;

/**
 * 1 ケースを実行して結果を 1 行で出す
 *
 * @param {string} label - ケース名 (英語)
 * @param {boolean} expectedAccepted - 仕様上受理されるべきなら true
 * @param {() => unknown} run - 実行する処理
 */
function check(label, expectedAccepted, run) {
  let accepted = false;
  let detail = "";
  try {
    const value = run();
    accepted = true;
    detail = typeof value === "string" ? value : "";
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error);
  }
  const ok = accepted === expectedAccepted;
  if (!ok) {
    failed += 1;
  }
  const verdict = accepted ? "ACCEPTED" : "REJECTED";
  console.log(`${ok ? "ok  " : "NG  "} ${label}: ${verdict}${detail ? ` (${detail})` : ""}`);
}

// ---------------------------------------------------------------------------
// Catalog ルート
// ---------------------------------------------------------------------------

// draft-02 §5.1.1: 全例が "draft-02"。現行実装は受理集合に無いので拒否する
check("version draft-02 is accepted per Section 5.1.1", true, () =>
  m.decodeCatalogMessage(
    encoder.encode(
      JSON.stringify({
        version: "draft-02",
        tracks: [],
      }),
    ),
  ),
);

// 決定事項: draft-01 互換は維持しないため、"draft-01" と "1" は受理しない
check("version draft-01 is rejected because draft-01 compatibility is dropped", false, () =>
  m.decodeCatalogMessage(encoder.encode(JSON.stringify({ version: "draft-01", tracks: [] }))),
);

// draft-01 の例が使っていた "1" も受理しない
check("version '1' is rejected because draft-01 compatibility is dropped", false, () =>
  m.decodeCatalogMessage(encoder.encode(JSON.stringify({ version: "1", tracks: [] }))),
);

// draft-02 §5.3: delta update は generatedAt を MUST で含む。無い delta は不正になる
check("delta update without generatedAt is rejected per Section 5.3", false, () =>
  m.decodeCatalogMessage(
    encoder.encode(JSON.stringify({ deltaUpdate: [{ op: "remove", tracks: [{ name: "a" }] }] })),
  ),
);

// draft-02 §5.3: delta update は generatedAt 以外の Root Catalog fields を MUST NOT で含む
check("delta update with publishTracks is rejected per Section 5.3", false, () =>
  m.decodeCatalogMessage(
    encoder.encode(
      JSON.stringify({
        generatedAt: 1,
        deltaUpdate: [{ op: "remove", tracks: [{ name: "a" }] }],
        publishTracks: [],
      }),
    ),
  ),
);

// draft-02 §5.1.6: update operation が定義されている
check("delta update op 'update' is accepted per Section 5.1.6", true, () =>
  m.decodeCatalogMessage(
    encoder.encode(
      JSON.stringify({
        generatedAt: 1,
        deltaUpdate: [{ op: "update", tracks: [{ name: "a", parentName: "a" }] }],
      }),
    ),
  ),
);

// ---------------------------------------------------------------------------
// Track フィールド
// ---------------------------------------------------------------------------

const locVideo = {
  name: "v",
  packaging: "loc",
  isLive: true,
  role: "video",
  codec: "avc1.42E01E",
  bitrate: 1,
  framerate: 30,
};

// draft-02 §5.2.15: depends の Number 要素は renderGroup 参照
check("depends with a renderGroup number is accepted per Section 5.2.15", true, () =>
  m.decodeCatalogMessage(
    encoder.encode(
      JSON.stringify({
        version: "draft-02",
        tracks: [
          // depends の Number は renderGroup を指すため、その renderGroup を持つ track が要る
          { ...locVideo, renderGroup: 1 },
          { ...locVideo, name: "mt", packaging: "mediatimeline", depends: [1] },
        ],
      }),
    ),
  ),
);

// draft-02 §7.2 と §8.3 は mimeType を要求しない
check("mediatimeline without mimeType is accepted per Section 7.2", true, () =>
  m.decodeCatalogMessage(
    encoder.encode(
      JSON.stringify({
        version: "draft-02",
        tracks: [
          // depends の String はちょうど 1 つの他 track の Track Name を指すため、参照先の track が要る
          locVideo,
          { ...locVideo, name: "mt", packaging: "mediatimeline", depends: ["v"] },
        ],
      }),
    ),
  ),
);

// draft-02 §8.3 は depends を index が media timeline を参照する場合だけ MUST とする
check("eventtimeline without depends is accepted per Section 8.3", true, () =>
  m.decodeCatalogMessage(
    encoder.encode(
      JSON.stringify({
        version: "draft-02",
        tracks: [
          { ...locVideo, name: "et", packaging: "eventtimeline", eventType: "com.example.x" },
        ],
      }),
    ),
  ),
);

// draft-02 §5.2.3: Track Name は空文字列を MUST NOT
check("empty track name is rejected per Section 5.2.3", false, () =>
  m.decodeCatalogMessage(
    encoder.encode(JSON.stringify({ version: "draft-02", tracks: [{ ...locVideo, name: "" }] })),
  ),
);

// draft-02 §5.2.2: namespace は 1〜32 個の非空フィールド。連続 '/' は不正
check("namespace with consecutive slashes is rejected per Section 5.2.2", false, () =>
  m.decodeCatalogMessage(
    encoder.encode(
      JSON.stringify({ version: "draft-02", tracks: [{ ...locVideo, namespace: "a//b" }] }),
    ),
  ),
);

// draft-02 §5.2.37 と Table 4: JSON 名は connectionURI
// 未知フィールドは保持されるため「受理されるか」ではなく「型付きフィールドに入るか」で判定する
check("connectionURI is read into the typed publish track per Table 4", true, () => {
  const decoded = m.decodeCatalogMessage(
    encoder.encode(
      JSON.stringify({
        version: "draft-02",
        tracks: [],
        publishTracks: [
          {
            ...locVideo,
            name: "log",
            packaging: "moqlog",
            role: "log",
            connectionURI: "moqt://logs.example.com",
          },
        ],
      }),
    ),
  );
  if (decoded.publishTracks?.[0]?.connectionUri === undefined) {
    throw new Error("connectionURI was kept as an unknown field, not as connectionUri");
  }
  return "connectionUri is populated";
});

// draft-02 §5.2.39: cipherSuite は encryptionScheme が "moq-secure-objects" のときだけ必須
check("custom encryption scheme without cipherSuite is accepted per Section 5.2.39", true, () =>
  m.decodeCatalogMessage(
    encoder.encode(
      JSON.stringify({
        version: "draft-02",
        tracks: [{ ...locVideo, encryptionScheme: "com.example.custom-encryption" }],
      }),
    ),
  ),
);

// ---------------------------------------------------------------------------
// Catalog document の符号化 (Section 11.2.1)
// ---------------------------------------------------------------------------

const utf8Bom = new Uint8Array([0xef, 0xbb, 0xbf]);

// draft-02 §11.2.1: catalog document は BOM で始まってはならない
const bomCatalog = new Uint8Array([
  ...utf8Bom,
  ...encoder.encode(JSON.stringify({ version: "draft-02", tracks: [] })),
]);
check("catalog document starting with a BOM is rejected per Section 11.2.1", false, () =>
  m.decodeCatalogMessage(bomCatalog),
);

// draft-02 §11.2.1: 孤立サロゲートを含む名前は catalog を invalid にする
check("track name with an unpaired surrogate is rejected per Section 11.2.1", false, () =>
  m.decodeCatalogMessage(
    encoder.encode(
      JSON.stringify({ version: "draft-02", tracks: [{ ...locVideo, name: "\uDEAD" }] }),
    ),
  ),
);

// draft-02 §11.2.1: Track Name に NUL を MUST NOT
check("track name containing NUL is rejected per Section 11.2.1", false, () =>
  m.decodeCatalogMessage(
    encoder.encode(
      JSON.stringify({ version: "draft-02", tracks: [{ ...locVideo, name: "a\u0000b" }] }),
    ),
  ),
);

// draft-02 §11.2.1: catalog document は UTF-8。不正なバイト列は invalid
const invalidUtf8 = new Uint8Array([
  ...encoder.encode('{"version":"draft-02","tracks":[{"name":"'),
  0xff,
  ...encoder.encode(
    '","packaging":"loc","isLive":true,"role":"video","codec":"avc1","bitrate":1,"framerate":30}]}',
  ),
]);
check("catalog with invalid UTF-8 bytes is rejected per Section 11.2.1", false, () =>
  m.decodeCatalogMessage(invalidUtf8),
);

// ---------------------------------------------------------------------------
// Event Timeline (Section 8.2)
// ---------------------------------------------------------------------------

// draft-02 §8.2: index reference は 'T' / 'L' / 'M'
for (const key of ["T", "L", "M"]) {
  check(`event timeline index '${key}' is accepted per Section 8.2`, true, () =>
    m.decodeEventTimeline(
      encoder.encode(JSON.stringify([{ [key]: key === "L" ? [0, 0] : 1, data: "x" }])),
    ),
  );
}

// draft-01 の小文字 key は draft-02 では不正
check("event timeline index 't' is rejected per Section 8.2", false, () =>
  m.decodeEventTimeline(encoder.encode(JSON.stringify([{ t: 1, data: "x" }]))),
);

// ---------------------------------------------------------------------------
// URL fragment (Section 11.1.1)
// ---------------------------------------------------------------------------

// draft-02 Table 12: 予約パラメータは "cat"
const fragmentWithCat = m.parseMsfFragmentValue("ns--name&cat=AAAA");
console.log(
  `info msf fragment keeps 'cat' as a parameter: ${JSON.stringify(fragmentWithCat.parameters)}`,
);

// ---------------------------------------------------------------------------
// 終了
// ---------------------------------------------------------------------------

if (failed > 0) {
  console.log(`\n${failed} case(s) do not match the draft-02 expectation.`);
  process.exitCode = 1;
} else {
  console.log("\nAll cases match the draft-02 expectation.");
}
