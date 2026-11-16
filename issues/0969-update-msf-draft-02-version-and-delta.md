# catalog の version と delta update の骨格を draft-02 にする

- Created: 2026-11-16
- Completed: {YYYY-MM-DD}
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

draft-02 §5.1.1 は catalog の `version` を `"draft-XX"` 規約とし、仕様の例 16 件はすべて `"draft-02"` を使う。delta update は §5.3 で処理モデルが変わり、`generatedAt` の必須化、他の Root Catalog fields の禁止、`update` operation の追加、操作の逐次正当性検査が入った。現行実装は draft-01 のままで、draft-02 の catalog を受理できない。

draft-01 との互換性は維持しない。`"draft-01"` と `"1"` は受理しない。

## 現状

- `src/msf/version.ts` の `MSF_VERSION` は `"draft-01"` を返し、`MsfVersion` は `"draft-01"` と `"1"` の union である。`MSF_KNOWN_VERSIONS` も同じ 2 値を持つ
- `src/msf/catalogValidation.ts` の `validateCatalog` は `MSF_KNOWN_VERSIONS` に無い version を拒否する。したがって draft-02 の catalog は decode 時点で捨てられる
- `src/msf/types.ts` の `CatalogDeltaOperation` は `add` / `remove` / `clone` の 3 種類で、`update` を持たない
- `src/msf/catalogCodec.ts` の `decodeCatalogDeltaOperation` は未知の `op` を拒否する。`update` はここで `unknown op 'update'` になる
- `decodeCatalogDelta` は `version` と `tracks` の同時出現だけを拒否し、`publishTracks` / `isComplete` / `initDataList` を未知フィールドとして保持する
- `decodeCatalogDelta` は `generatedAt` を任意として扱う
- `applyCatalogDelta` は操作を配列順に適用するが、操作ごとの正当性を検査しない。実測では `add` で既存名を追加し、同じ delta 内の後続 `remove` で消すと受理される。draft-02 は「adding an existing name」を illogical operation として catalog の拒否を MUST とする
- `decodeCatalogMessage` には draft-00 形式の delta (`addTracks` / `removeTracks` / `cloneTracks`) を検出して拒否する分岐がある。draft-01 以前との互換のための防御である
- `validateCatalogTrack` は `parentName` / `parentNamespace` を clone operation 専用として拒否する。draft-02 は `update` operation でも許可する

## 設計方針

- `MsfVersion` を `"draft-02"` の 1 リテラルにし、`MSF_VERSION` を `"draft-02"` にする。`MSF_KNOWN_VERSIONS` は `"draft-02"` だけを持つ集合にする。エラー文言の期待値一覧も 1 要素になる
- version による検証分岐をコードに持たせない。delta update の検証は draft-02 の規則だけを実装する
- `CatalogDeltaOperation` に `{ type: "update"; tracks: CatalogTrack[] }` を追加する。`update` の track は `clone` と同じく `parentName` を MUST、`parentNamespace` を MAY とし、`name` は上書き対象の識別に使わない
- `decodeCatalogDelta` の Root フィールド検査を「`deltaUpdate` と `generatedAt` 以外を拒否」に変える。`generatedAt` は必須にする。未知フィールドの保持は full catalog の経路だけに残す
- `applyCatalogDelta` に操作ごとの正当性検査を入れる。`add` は追加時点で Full Track Name が未登録であること、`clone` は親が存在し子の Full Track Name が未登録であること、`update` は親が存在すること、`remove` は対象が存在することを、操作を適用するたびに検査する。delta 全体を適用した後ではなく、操作の適用前に判定する
- `update` の適用は、親 track の属性を `parentName` で引き、宣言されたフィールドだけを上書きする。上書き後の track に対して、packaging / role / audio codec の条件付き MUST を clone と同じく再検証する
- `validateCatalogTrack` の `parentName` / `parentNamespace` の拒否は `source` が `clone` と `update` のときだけ許可する形にする。`ValidationContext["source"]` に `"update"` を追加する
- `decodeCatalogMessage` の draft-00 形式の検出分岐を削除する

## 完了条件

- `MSF_VERSION` が `"draft-02"` で、`decodeCatalogMessage` が `"draft-02"` の catalog を受理し、`"draft-01"` と `"1"` を拒否する。単体テストで固定する
- `"op": "update"` の delta update を decode して `applyCatalogDelta` で適用でき、宣言したフィールドだけが上書きされる。単体テストで固定する
- `generatedAt` の無い delta update を拒否する。単体テストで固定する
- `deltaUpdate` と `generatedAt` 以外の Root フィールドを持つ delta update を拒否する。単体テストで固定する
- `add` で既存名を追加する delta、存在しない track の `update` / `remove`、既存名への `clone` を、どの操作順でも拒否する。単体テストで固定する
- draft-00 形式の delta を検出する分岐が消えている
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る
