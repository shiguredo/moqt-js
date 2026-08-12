# 制御メッセージの Body 長一致検証が欠落している

- Priority: Medium
- Created: 2026-08-06
- Completed: 2026-08-13
- Model: DeepSeek V4 Flash
- Branch: feature/fix-moqt-draft-19-message-body-length-validation
- Polished: 2026-08-08

## 目的

draft-ietf-moq-transport-19 §10 の MUST「If the length does not match the length of the Message Body, the receiver MUST close the session with a PROTOCOL_VIOLATION.」を全メッセージで満たす。現在は GOAWAY / REQUEST_ERROR のみ trailing data 検証が実装されており、他のデコーダは Message Body を過不足なく消費したかを検証しない。

## 優先度根拠

Length フィールドで切り出した Body に余剰バイトを載せた不正メッセージを黙って受理する。ControlStreamReader が Length で payload を切り出すため framing 自体は整合するが、デコード結果が Body を過不足なく消費したことの検証がなく、仕様の MUST 要件を満たしていない。Medium。

## 現状

- trailing data 検証は `decodeGoawayPayload` (`src/message/session.ts`) と `decodeRequestErrorPayload` (同) のみ実装 (いずれも末尾で `offset !== data.length` を検査し `ProtocolViolationError` を throw。`decodeRequestErrorPayload` の末尾検査は Redirect デコード時のみ実行され、Redirect 無しの余剰バイトは「unexpected redirect」検査で検出される)。
- 以下のデコーダは消費バイト数と `data.length` の一致を検証していない:
  - `decodeSubscribePayload` / `decodeRequestUpdatePayload` (`src/message/subscribe.ts`)
  - `decodeTrackStatusPayload` (`src/message/trackstatus.ts`)
  - `decodePublishNamespacePayload` / `decodeSubscribeNamespacePayload` / `decodeSubscribeTracksPayload` / `decodeNamespacePayload` / `decodeNamespaceDonePayload` / `decodePublishSkippedPayload` (`src/message/namespace.ts`)
  - `decodeFetchPayload` (`src/message/fetch.ts`)
  - `decodePublishDonePayload` (`src/message/publish.ts`)
- 対象外 (検証不能の構造): `decodeRequestOkPayload` / `decodeSubscribeOkPayload` / `decodeFetchOkPayload` / `decodePublishPayload` / SETUP のデコーダは、Track Properties / Properties / Setup Options が「残りバイトすべて」を消費する末尾フィールドのため、余剰バイトが構造的に発生せず一致検証は空振りになる (例: `decodeRequestOkPayload` の `data.slice(offset)` による Properties デコード)。
- **既存バグ (本 issue の前提)**: `decodePublishSkippedPayload` (`src/message/namespace.ts`) は `decodeVarint` で取得した Track Name 長ぶんを `totalConsumed` に計上していない (`totalConsumed += Number(nameLen)` が欠落)。最後のフィールドのため現状は顕在化しないが、本 issue の一致検証を追加すると正常な PUBLISH_SKIPPED がすべて `ProtocolViolationError` になる。計上漏れの修正を本 issue に含める。
- **同様の前提**: `decodeNamespacePayload` / `decodeNamespaceDonePayload` (`src/message/namespace.ts`) は `decodeTrackNamespace` の戻り値から namespace のみを取り出し consumed バイト数を破棄している。一致検証には消費バイト数の取得が必要。
- 変更対象ファイル: `src/message/subscribe.ts` / `src/message/trackstatus.ts` / `src/message/namespace.ts` / `src/message/fetch.ts` / `src/message/publish.ts` (各デコーダ)、テストファイル (`src/message/subscribe.prop.ts` / `trackstatus.prop.ts` / `namespace.prop.ts` / `fetch.prop.ts` / `publish.prop.ts` / `session.prop.ts`)、`CHANGES.md`。

## 設計方針

- **方式の決定**: 各デコーダの末尾で「消費済みオフセットと `data.length` の一致」を検査する方式を採用する。`decodeGoawayPayload` / `decodeRequestErrorPayload` の既存パターン (末尾の `offset !== data.length` チェックで `ProtocolViolationError`) に合わせ、デコーダの戻り値は変更しない (戻り値に consumed を追加する方式は `src/message/index.ts` から export される公開関数の API 破壊を伴うため不採用)。検査はデコーダ内部に置き、各デコーダが追跡する消費量と `data.length` を比較する。対象デコーダの大半は `totalConsumed` を「`offset` からの消費量」として追跡しており、呼び出しは全て `offset=0` (ControlStreamReader が payload を切り出す) ため、`offset + totalConsumed !== data.length` の比較で統一できる。`decodeNamespacePayload` / `decodeNamespaceDonePayload` のように `offset` を直接渡すデコーダも同じ式で比較する。
- **両方向の一致検証**: MUST は不一致の方向を限定しない。余剰バイト (consumed < data.length) だけでなく、Body 短縮 (宣言されたフィールド長が残りバイトを超過し、デコードが `IncompleteDataError` 等を投げるケース) も対象とする。短縮時の `IncompleteDataError` が呼び出し元で `ProtocolViolationError` に変換されずセッションが閉じない経路があるため、デコーダ単体では `IncompleteDataError` の throw を維持しつつ、呼び出し元 (受信経路) での変換を確認する。本 issue の検証対象はデコーダ単体の trailing data 検証とし、受信経路での変換はコードレビューで担保する。
- **既存バグの修正**: `decodePublishSkippedPayload` の Track Name 長の `totalConsumed` 計上漏れを修正する (本 issue の一致検証の前提)。`decodeNamespacePayload` / `decodeNamespaceDonePayload` は `decodeTrackNamespace` の第二戻り値 (consumed) を取得して一致検証に使う。
- **検証不能デコーダの扱い**: REQUEST_OK / SUBSCRIBE_OK / FETCH_OK / PUBLISH / SETUP は「末尾フィールドが残りバイトすべてを消費する」構造のため対象外とする (理由は現状参照)。完了条件の「全制御メッセージ」はこの対象外を除いた意味である。
- **0371 との相互参照**: 0371 (未対応リクエストの NOT_SUPPORTED 応答) 実装後は、受信 bidi ストリームの先頭が分類 2 (未対応の 6 種: SUBSCRIBE / FETCH / TRACK_STATUS / PUBLISH_NAMESPACE / SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS) の場合にデコードされなくなる。ただしこの 6 種のデコーダは現状も受信経路では使用されていない (PBT 専用) ため、「0371 実装後に到達不能になる」のではなく「現状も受信経路に存在しない」点に注意する (0371 側の明記と整合)。受信経路で検証が発火するのは REQUEST_UPDATE / PUBLISH_DONE / NAMESPACE / NAMESPACE_DONE / PUBLISH_SKIPPED のみ。実装順序の制約はない (0371 とコード競合しない)。
- **0384 との相互参照**: 0384 (Full Track Name サイズ検証) も `decodeSubscribePayload` / `decodeTrackStatusPayload` / `decodeFetchPayload` を変更対象とする。変更箇所 (Track Name 長検証 vs 末尾の一致検証) は異なり、コード競合は小さい。実装順序の制約はない。
- **テスト**: 余剰バイト付きメッセージ (末尾に余分な 1 バイトを付加) と、正常メッセージが `ProtocolViolationError` を投げずにデコードできることの両方を検証する。既存の trailing data テスト (`src/message/session.prop.ts` の GOAWAY / REQUEST_ERROR の PBT) に倣い、対象デコーダの `*.prop.ts` に PBT または固定バイト列の単体テストを追加する (既存 GOAWAY trailing テストの withTrailing パターンを参考にする)。`decodePublishSkippedPayload` の計上漏れ修正後も既存 PBT (`src/message/namespace.prop.ts`) が通ること。

## 完了条件

- 対象デコーダ (SUBSCRIBE / REQUEST_UPDATE / TRACK_STATUS / PUBLISH_NAMESPACE / SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS / NAMESPACE / NAMESPACE_DONE / PUBLISH_SKIPPED / FETCH / PUBLISH_DONE) で、Body 長とデコード消費バイト数が一致しない場合に `ProtocolViolationError` になること。検証不能デコーダ (REQUEST_OK / SUBSCRIBE_OK / FETCH_OK / PUBLISH / SETUP) は対象外。
- 余剰バイト付きメッセージを検証するテストがあること。
- `decodePublishSkippedPayload` の Track Name 長計上漏れが修正され、正常な PUBLISH_SKIPPED が `ProtocolViolationError` にならないこと。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10 (Control Messages / Body 長一致の MUST 3265-3270)
- 関連: `issues/0371-moqt-draft-19-incoming-request-not-supported-response.md`（分類 2 の 6 種が受信経路でデコードされない旨の注記を本 issue に要求）
- 関連: `issues/0384-moqt-draft-19-full-track-name-size-validation.md`（`decodeSubscribePayload` / `decodeTrackStatusPayload` / `decodeFetchPayload` を共有）

## 解決方法

- draft-ietf-moq-transport-19 §10 の MUST「If the length does not match the length of the Message Body, the receiver MUST close the session with a PROTOCOL_VIOLATION.」に基づき、対象 11 デコーダの末尾で消費バイト数と `data.length` の一致検証を追加した
  - `src/message/subscribe.ts` の `decodeSubscribePayload` / `decodeRequestUpdatePayload`
  - `src/message/trackstatus.ts` の `decodeTrackStatusPayload`
  - `src/message/namespace.ts` の `decodePublishNamespacePayload` / `decodeSubscribeNamespacePayload` / `decodeSubscribeTracksPayload` / `decodeNamespacePayload` / `decodeNamespaceDonePayload` / `decodePublishSkippedPayload`
  - `src/message/fetch.ts` の `decodeFetchPayload`
  - `src/message/publish.ts` の `decodePublishDonePayload`
- 検証は既存の `decodeGoawayPayload` / `decodeRequestErrorPayload` のパターンに合わせ、不一致時は `ProtocolViolationError` を throw する。戻り値は変更しない
- `decodeNamespacePayload` / `decodeNamespaceDonePayload` は `decodeTrackNamespace` の第二戻り値 (consumed) を取得するように修正した
- `decodePublishSkippedPayload` の Track Name 長と `decodePublishDonePayload` の Reason Phrase 長の `totalConsumed` 計上漏れを修正した
- 検証不能デコーダ (REQUEST_OK / SUBSCRIBE_OK / FETCH_OK / PUBLISH / SETUP) は Track Properties / Setup Options が残りバイトすべてを消費する構造のため対象外
- テスト: 各 `src/message/*.prop.ts` に「正常メッセージの末尾に後続バイト列を連結すると `ProtocolViolationError` を throw する」PBT を追加した (SUBSCRIBE / REQUEST_UPDATE / TRACK_STATUS / PUBLISH_NAMESPACE / SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS / NAMESPACE / NAMESPACE_DONE / PUBLISH_SKIPPED / FETCH (Standalone / Joining) / PUBLISH_DONE の 12 テスト)
- `CHANGES.md` の `## develop` に `[FIX]` エントリを追加した
