# packagingMetadata と streamMapping を実装し、object モードを受信する

- Created: 2026-11-16
- Completed: 2026-11-16
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

draft-02 §5.2.5 は `packagingMetadata` を追加し、packaging ごとの追加パラメータを `key=value` の `;` 区切りで運ぶ。packaging が `loc` のときは `streamMapping` キーだけが定義され、値は `group` (既定) と `object` である (§4.1.1)。§4.1.1 は publisher にどちらかのモードの選択を MUST、subscriber に両モードの消費を MUST とする。前者は「Group 内の全 Object を 1 つの Subgroup に Object ID 順で送る」、後者は「Object ごとに別の Subgroup に送る」である。

現行実装は `packagingMetadata` の型もパーサも持たず、publisher は group モード相当で動いているがそのことをシグナリングしない。subscriber は Subgroup を区別して受信できるが、同一 Group 内の Object 順序の入れ替えを吸収しないため、object モードの publisher と接続すると映像が途切れる。

## 現状

- `src/msf/types.ts` の `CatalogTrack` に `packagingMetadata` が無い。decode では未知フィールドとして保持されるだけである
- `src/createMediaPublisher.ts` の catalog 生成は `packagingMetadata` を出さない
- `src/session/publish.ts` と `src/publisher.ts` は Group が変わったときだけ新しい Subgroup stream を開き、Group 内の Object は同じ stream に書く。これは group モードに一致する
- `src/session/stream.ts` は Subgroup Header の SUBGROUP_ID_MODE を解決して Subgroup を区別する
- `src/groupSwitchGate.ts` は Group ごとに複数の Subgroup を保持できる
- `src/videoDecodeOrder.ts` は同一 Group 内で Object ID が飛ぶと missing-reference として扱い、次のキーフレームまで復号を待つ。object モードでは Subgroup 間の順序保証が無いため、到着順が入れ替わるとこの判定に当たる
- 音声は 1 Object = 1 Group であり、既定の配送は Datagram である

## 設計方針

- `CatalogTrack.packagingMetadata` を `string` として追加する
- `packagingMetadata` のパーサを `src/msf/catalogTrackValidation.ts` に追加する。`;` で分割し、各要素を最初の `=` で key と value に分ける。key と value は大文字と小文字を区別し、空白、`=`、`;` を含まないことを要求する。同じ key が複数回現れたら最初の出現を使う。未定義の key は無視する
- `loc` の `streamMapping` を解釈する helper を追加する。未指定または `packagingMetadata` が無い場合は `group` とする。`group` と `object` 以外の値を拒否する
- publisher は `packagingMetadata: "streamMapping=group"` を LOC の track に出す。既定値の明示であり、相手に依存しない
- subscriber は catalog の `streamMapping` を読み、`object` モードのときに限り Group 内の Object 順序の並べ替えを有効にする。並べ替えは Subgroup をまたいで行うため、Group 単位で Object ID の到着を待つバッファを入れる
- `object` モードでは Group の全 Object が 1 つずつ別の Subgroup で届くため、Group の終了は Subgroup の FIN ではなく、次の Group の先頭 Object か PUBLISH_DONE で判定する。Group を閉じる条件を決めて実装する
- 遅延を増やさないため、並べ替えバッファは `object` モードのときだけ確保する

## 完了条件

- `packagingMetadata` の `key=value` を解析でき、同一 key は最初の出現、未定義 key は無視になる。単体テストで固定する
- `streamMapping` が無い場合に `group` と解釈する。単体テストで固定する
- `streamMapping` が `group` と `object` 以外の値なら track を拒否する。単体テストで固定する
- publisher が LOC の track に `streamMapping=group` を出す。単体テストで固定する
- object モードの catalog を購読すると、Group 内の Object が到着順によらず Object ID 順で復号器に渡る。単体テストで固定する
- group モードの既存挙動が変わらない。既存テストが通る
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る

## 解決方法

- `src/msf/types.ts` の `CatalogTrack` に `packagingMetadata` を追加した
- `src/msf/version.ts` に `LocStreamMapping`、`DEFAULT_LOC_STREAM_MAPPING`、`parsePackagingMetadata`、`resolveLocStreamMapping` を追加した。key と value は空白 / `=` / `;` を含まないこと、同じ key は最初の出現を使うことを検証する
- `src/msf/catalogTrackValidation.ts` で packagingMetadata の型と形式を検証し、`loc` の `streamMapping` の値を `group` か `object` に限定した
- `src/createMediaPublisher.ts` が LOC の音声 / 映像 track に `streamMapping=group` を載せる
- `src/groupObjectOrderer.ts` を追加した。object モードのときだけ `src/createMediaSubscriber.ts` の映像受信経路で Group 内の Object を Object ID 順に並べ直し、group モード (既定) の挙動は変えない
- `parsePackagingMetadata` と `resolveLocStreamMapping` の単体テスト、GroupObjectOrderer の単体テストを追加した
