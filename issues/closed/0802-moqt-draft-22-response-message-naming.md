# REQUEST_ERROR のリクエスト別別名に追随する

- Created: 2026-10-02
- Completed: 2026-10-03
- Branch: feature/update-response-message-naming
- Polished: 2026-10-02

## 目的

draft-ietf-moq-transport-22 §1.5 は REQUEST_OK の別名に加えて、REQUEST_ERROR のリクエスト種別ごとの別名 (SUBSCRIBE_ERROR / FETCH_ERROR / PUBLISH_ERROR / SUBSCRIBE_NAMESPACE_ERROR / SUBSCRIBE_TRACKS_ERROR / PUBLISH_NAMESPACE_ERROR / TRACK_STATUS_ERROR / REQUEST_UPDATE_ERROR) を定義した。v21 ではショートハンドは REQUEST_OK 側のみで (§9.3 (REQUEST_OK) に併記。§1.5 は Modularity)、REQUEST_ERROR 側の別名は無かった。v22 で §1.5 (Response Message Naming) に移設され、REQUEST_ERROR 側が追加された。

別名は仕様文書中の呼称であり、ワイヤ上の Message Type は REQUEST_ERROR (0x05) のまま変わらない。moqt-js の表示・検証コンテキスト名との対応を確認する。

## 現状

- `src/message/debug.ts` の `getMessageTypeName` はワイヤ名 (REQUEST_OK / REQUEST_ERROR) を返す。`getRequestOkAliasName` / `REQUEST_OK_ALIASES` は過去に未使用のため削除済み
- `src/session/bidi.ts` と `src/session/namespaceLoops.ts` は検証コンテキスト名として PUBLISH_OK / SUBSCRIBE_OK / FETCH_OK / TRACK_STATUS_OK / REQUEST_UPDATE_OK / SUBSCRIBE_NAMESPACE_OK / SUBSCRIBE_TRACKS_OK / PUBLISH_NAMESPACE_OK を使用している。ERROR 側は `requestLabel` (PUBLISH / SUBSCRIBE / FETCH / TRACK_STATUS) とエラー文言で区別している
- `src/error.ts` の `RequestErrorCode` / `SessionErrorCode` / 各メッセージのデコーダは REQUEST_ERROR を単一の型 (`RequestError`) で扱う

## 設計方針

- §1.5 の別名一覧と実装の表示名・コンテキスト名の対応を確認し、結果をコードコメントに残す。対応表では SUBSCRIBE_OK (§9.7) / FETCH_OK (§9.12) が独立したワイヤメッセージ (0x04 / 0x18) であり §1.5 の OK 別名一覧には含まれない一方、SUBSCRIBE_ERROR / FETCH_ERROR は REQUEST_ERROR (0x05) の別名である点を区別する
- 別名はワイヤ表示に必須ではないため、`getMessageTypeName` はワイヤ名を返す現状を維持する (別名を表示に使う方針に変える場合は、リクエスト種別が判明している経路でだけ使う)
- REQUEST_ERROR の別名の語をエラー文言・ログに使う利点があるか確認し、使わない場合はその判断理由 (wire 名との混在を避ける) をコメントに書く。使うと判断した場合のみ、使用経路と理由をコメントに残し、挙動変更として取り扱う
- テスト変更は不要。別名の対応表をテストで固定する必要は無い (wire 形式に影響しないため)。使うと判断した場合のみ挙動変更の検証としてテストが必要になる

## 完了条件

- §1.5 の別名一覧と実装の対応がコードのコメントとして記録されている
- 必要に応じたコメント更新が完了している (使うと判断した場合を除き挙動変更無し)
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-22 §1.5 (Response Message Naming) / §9.3 (REQUEST_OK) / §9.4 (REQUEST_ERROR) / §9.7 (SUBSCRIBE_OK) / §9.12 (FETCH_OK)
- `src/message/debug.ts` の `getMessageTypeName`
- `src/session/bidi.ts` の `requestLabel` / `okType` / `BidiResponseContext`
- `src/session/namespaceLoops.ts` の `namespaceValidateInitialOk`
- `issues/closed/0220-draft-18-update-define-textual-aliases-for-request-ok.md` (OK 別名の経緯)

## 解決方法

draft-ietf-moq-transport-22 §1.5 の別名と実装の対応を確認し、結果をコードコメントに記録した。挙動の変更はない。

### 1. §1.5 の別名一覧と実装の対応

- `src/message/debug.ts` の冒頭に、§1.5 の別名を列挙した (REQUEST_OK の別名 6 種 / REQUEST_ERROR の別名 8 種)。別名は仕様文書中の呼称であり、ワイヤ上の Message Type は REQUEST_OK (§9.3、0x07) / REQUEST_ERROR (§9.4、0x05) のままである
- 実装で別名を使うのは、リクエスト種別が判明している検証のコンテキスト名だけである (`src/session/bidi.ts` の PUBLISH_OK / REQUEST_UPDATE_OK / TRACK_STATUS_OK と `src/session/namespaceLoops.ts` の REQUEST_UPDATE_OK / SUBSCRIBE_NAMESPACE_OK / SUBSCRIBE_TRACKS_OK / PUBLISH_NAMESPACE_OK)。応答の種別判定に使う `okType` はワイヤ型 (MessageType) であり、別名ではないことも併記した
- SUBSCRIBE_OK (§9.7、Type 0x04) と FETCH_OK (§9.12、Type 0x18) は独立したワイヤメッセージであり、REQUEST_OK の別名ではないことを書き分けた

### 2. 表示とエラー文言での扱い

- `src/message/debug.ts` の `getMessageTypeName` はワイヤ名 (MessageType のキー) を返す現状を維持する。別名を使うと同じ Type が経路によって別の名前で表示され、デバッグ表示とワイヤの対応が読み取りにくくなるためである (関数の JSDoc に明記した)
- REQUEST_ERROR の別名は実行時のエラー文言・表示には使わない。理由は 2 つあり、`RequestError` がリクエスト種別を持たず応答を受け取る経路が名前を決める以上、種別ごとの別名を文言に混ぜても情報が増えないこと、エラーは `errorCode` と `requestLabel` で十分に特定できることである (`src/session/bidi.ts` の `requestLabel` の JSDoc に記録した)
- `src/session/namespaceLoops.ts` の `namespaceValidateInitialOk` の `contextName` が §1.5 の別名そのものであり、ワイヤ上は REQUEST_OK (Type 0x07) であることを `@param` に書いた
- `src/message/trackstatus.ts` の TRACK_STATUS_OK の参照を v21 §9.3 から v22 §1.5 に更新した (v21 は §9.3 に併記していた)

### 3. テスト

別名はワイヤ形式に影響しないため、テストの変更は行っていない (issue の設計方針どおり)。

### 4. 検証

`vp check` (1284 files 整形 / 475 files lint・型エラーなし) / `tsc --noEmit` / `vp test run` (198 files / 3569 tests) が通る。`/review-diff-code` を 3 周回し、指摘 (`okType` の混同、別名の所在、実行時の文言に限定する記述) はすべて反映した。CHANGES.md の `## develop` の `### misc` に [UPDATE] エントリを追加した。
