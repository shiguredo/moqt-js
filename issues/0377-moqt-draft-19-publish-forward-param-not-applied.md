# 受信 PUBLISH の FORWARD パラメータが SubscriberImpl に反映されない

- Priority: Low
- Created: 2026-08-06
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/fix-moqt-draft-19-publish-forward-param-not-applied
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-19 §10.2.17 (FORWARD Parameter) に従い、SUBSCRIBE_TRACKS 経由で受信した PUBLISH の FORWARD パラメータを SubscriberImpl に反映する。現在は値域検証のみで、Forward State がサブスクライバ側の状態管理に反映されない。

## 優先度根拠

§10.19.1 は「If the FORWARD parameter is present in this message and equal to 0, PUBLISH messages resulting from this SUBSCRIBE_TRACKS will set the FORWARD parameter to 0.」と定める。受信 PUBLISH の FORWARD=0 は「オブジェクトはまだ送られない」ことを示すため、サブスクライバ側で状態を保持しないと forward 状態遷移を正しく扱えない。Low。

## 現状

- `src/session.ts:3368-3396` (`handleIncomingBidirectionalStream`) で受信 PUBLISH のパラメータは `PUBLISH_ALLOWED_PARAMS` によるスコープ検証のみ行われ、FORWARD の値は `extractForwardState` 等で取り出されていない。
- SubscriberImpl に FORWARD 状態を保持するフィールドがなく、後続の REQUEST_UPDATE 処理との整合も取れていない。

## 設計方針

- 受信 PUBLISH の FORWARD パラメータを抽出し、SubscriberImpl に保持する。
- 値域検証 (0 / 1) は `decodeMessageParameter` 側で既に実施済みのため、受信側では抽出と保持のみ。
- アプリケーションへの通知 (コールバック) の要否は API 設計として判断する。

## 完了条件

- 受信 PUBLISH の FORWARD パラメータが SubscriberImpl に保持されること。
- 上記を検証するテストがあること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10.2.17 (FORWARD Parameter)
- draft-ietf-moq-transport-19 §10.19.1 (Parameters on SUBSCRIBE_TRACKS)

## 注記 (0371 実装時)

- 0371 (未対応リクエストの NOT_SUPPORTED 応答) の実装で session.ts の `handleIncomingBidirectionalStream` の構造が変更され行がドリフトしたため、`src/session.ts:3368-3396` の行番号参照をシンボル名 (`handleIncomingBidirectionalStream` 内の該当処理) に書き換えること。

## 解決方法

未着手。
