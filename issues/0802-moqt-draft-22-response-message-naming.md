# REQUEST_ERROR のリクエスト別別名に追随する

- Created: 2026-10-02
- Completed: {YYYY-MM-DD}
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

{未着手}
