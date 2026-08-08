# .session / "." namespace の受信リクエスト拒否が未実装

- Priority: Medium
- Created: 2026-08-06
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/change-moqt-draft-19-session-level-namespace-not-rejected
- Polished: 2026-08-08

## 目的

draft-ietf-moq-transport-19 §3.2.2 の MUST「An endpoint that receives a request for an unrecognized session-level track or namespace MUST reject it with REQUEST_ERROR using error code DOES_NOT_EXIST rather than passing it to the Application.」と、§3.2.1 の MUST「A Track Namespace whose first field is exactly . (a single period, 0x2e) ... endpoints MUST reject requests referencing it with DOES_NOT_EXIST.」を満たす。受信した PUBLISH の Track Namespace 先頭フィールドが `.session` または `.` の場合に REQUEST_ERROR (DOES_NOT_EXIST) で拒否し、アプリケーションへ渡さない。

送信側の namespace 拒否は closed issue 0401 で実装済みであり、本 issue は受信側のみを対象とする。

## 優先度根拠

受信側で `.session` / `.` namespace の PUBLISH を検証せずにアプリの `onPublish` へ渡しているため、§3.2.2 の MUST (DOES_NOT_EXIST 拒否) が満たされていない。送信側の `validateTrackNamespaceForSend` は当該 namespace での送信を防ぐが、受信側はピア (不正・誤設定) が送ってきた場合の防護がない。Medium。

## 現状

- 送信側の拒否は closed issue 0401 で実装済み: `validateTrackNamespaceForSend` (`src/session/params.ts`) が `SessionImpl.publish` / `subscribe` / `fetch` / `trackStatus` / `subscribeNamespace` / `subscribeTracks` / `publishNamespace` の 7 経路 (`src/session.ts`) で呼ばれている。
- 受信側は未実装: `handleIncomingBidirectionalStream` (`src/session.ts`) は受信 PUBLISH の Track Namespace を検証せず、`matchPublishToSubscription` で prefix マッチだけを行い、マッチした場合は `onPublish` へそのまま渡す。`.session` / `.` namespace の PUBLISH でもアプリに渡る (DOES_NOT_EXIST 拒否なし)。
- `isReservedNamespace` / `isSessionLevelNamespace` (`src/message/parameter.ts`) と `RESERVED_NAMESPACE_PREFIX` / `SESSION_LEVEL_NAMESPACE` 定数は定義され公開されているが、実行パスから一切使用されていない (`src/message/index.ts` で re-export のみ)。
- 変更対象ファイル: `src/session.ts` (`handleIncomingBidirectionalStream` の受信 PUBLISH 処理)、`src/message/parameter.ts` (判定ヘルパー、必要に応じて)、`src/session.test.ts` または `src/session/bidi.test.ts` (テスト追加)、`CHANGES.md`。

## 設計方針

- **拒否対象の限定 (§3.2.1 / §3.2.2 の正確な解釈)**: 受信側で DOES_NOT_EXIST 拒否するのは次の 2 ケースのみに限定する。
  - Track Namespace 先頭フィールドが `.` 単体 (§3.2.1: "A Track Namespace whose first field is exactly . (a single period, 0x2e) is reserved and MUST NOT be used for any purpose; endpoints MUST NOT publish tracks or namespaces under it and MUST reject requests referencing it with DOES_NOT_EXIST.")
  - Track Namespace 先頭フィールドが `.session` (§3.2.2: "An endpoint that receives a request for an unrecognized session-level track or namespace MUST reject it with REQUEST_ERROR using error code DOES_NOT_EXIST rather than passing it to the Application.")
  - **それ以外の予約名前空間 (例: `.foo`) は拒否しない**。§3.2.1 は「Unless otherwise specified, an endpoint that receives a request for an unrecognized reserved namespace MUST pass it to the Application, so that future extensions can define new reserved namespaces without breaking older implementations.」と定めており、将来 IANA 登録される予約名前空間の受信を壊さないため。送信側 0401 の「`.` で始まるすべてを拒否」という方針 (§3.2.2 の "The Application MUST NOT publish tracks or namespaces whose first field is .session." と §3.2.1 の "These namespaces MUST NOT be used unless their meaning is defined through IANA registration" に基づく送信制限) を受信側には持ち込まない。送受信で仕様の非対称性がある。
- **判定の入力形式**: 受信 PUBLISH のデコード結果 `decodedPublish.trackNamespace` は `TrackNamespace` (`{ tuple: Uint8Array[] }`、`src/message/parameter.ts` の `TrackNamespace` インターフェース) であり、`isReservedNamespace` / `isSessionLevelNamespace` (`src/message/parameter.ts`) はその `.tuple` を入力にとる。ただし現行の `isSessionLevelNamespace` は `.session` 判定のみで `.` 単体を区別しないため、`.` 単体判定を含む受信側専用のヘルパー (例: `isRejectedReceiveNamespace(tuple: Uint8Array[]): boolean` を `src/message/parameter.ts` に追加) を用意するか、判定ロジックを `handleIncomingBidirectionalStream` 内の純関数として追加して既存 2 関数は使わないかを実装時に確定する。既存 2 関数が (受信側でも) 未使用のまま残る場合は、0390 (未使用 export の非公開化) の対象に含めるよう 0390 側へ相互参照を残す (0390 の現状リストには現時点で含まれていないため、注記の追記が必要)。
- **拒否の実装**: `handleIncomingBidirectionalStream` の PUBLISH デコード後・`matchPublishToSubscription` の前に判定を挿入する。拒否時は REQUEST_ERROR (DOES_NOT_EXIST) を送信し、ストリームを閉じる (`RequestErrorCode.DOES_NOT_EXIST` は `src/error.ts` に既存)。セッションは閉じない (アプリの入力ミスでもなくピアの不適切な送信であり、セッション全体の終了は §3.2.2 の MUST も要求しない)。応答には §3.3.3 の SHOULD「When an endpoint rejects a request without performing any application processing, it SHOULD send a REQUEST_ERROR and FIN the stream.」に従い、REQUEST_ERROR 送信後に送信方向を FIN で閉じる (受信方向は cancel)。Reason Phrase はテストでバイト列を検証できるよう固定文言 (例: `request references reserved namespace`) を指定する。拒否ヘルパーは 0371 の `incomingSendRequestErrorAndClose` (REQUEST_ERROR 書込 → FIN → 受信方向 cancel の拒否フロー) を流用する。
- **判定位置の順序**: `.session` / `.` 判定は `matchPublishToSubscription` より前に置く。`matchPublishToSubscription` が先に実行されると、非マッチの PUBLISH は UNINTERESTED で応答され、DOES_NOT_EXIST の MUST が成立しないため。`validateParameterScope` (パラメータスコープ検証) との順序は、デコードの失敗 (ProtocolViolationError) が先に検出される構造を乱さない範囲で、`.session` / `.` 判定をスコープ検証と同じ位置 (デコード後) に置く。両方違反がある場合の優先順位 (DOES_NOT_EXIST か PROTOCOL_VIOLATION か) は実装時に確定する (§3.2.2 の MUST 違反である `.session` 拒否が優先される設計とする)。
- **0371 との相互参照**: 0371 (未対応リクエストの NOT_SUPPORTED 応答) 実装後は、受信 bidi ストリームの先頭が型分類 2 (未対応の 6 種) の場合 NOT_SUPPORTED が先に適用される。本 issue の DOES_NOT_EXIST 拒否は「受信 PUBLISH」(型分類 1) にのみ適用されるため、0371 実装後も主目的のパスは残る。ただし完了条件に「非 PUBLISH リクエストへの DOES_NOT_EXIST (§3.2.2) は 0371 実装後は NOT_SUPPORTED が先に適用される (判定順序は型分類が先)」旨を明記する。なお §3.2.2 の DOES_NOT_EXIST MUST と §4 の NOT_SUPPORTED SHOULD の優先順位は draft が定義しておらず、NOT_SUPPORTED が先に適用されるのは 0371 の判定順序による解釈であり、残余リスクとして明示する。また 0371 は既存の `sendRequestErrorAndCancel` (`src/session.ts`) を `incomingSendRequestErrorAndClose` (`src/session/incoming.ts`) に移設して private メソッドを削除する計画のため、本 issue の拒否ヘルパー参照は 0371 実装後は `incomingSendRequestErrorAndClose` を指す (実装順序: 0371 を先に実施し、本 issue は移設後のヘルパーを参照する)。
- **エッジケース**: (a) `.session` + 空 Track Name: §3.2.2 の MUST「A request with a Track Namespace whose first field is .session and an empty Track Name MUST be rejected with DOES_NOT_EXIST.」に該当し、本 issue の拒否対象に含まれる (送信側では `validateTrackNamespaceForSend` が既に空 Track Name を拒否するが、受信側は別途判定する)。(b) `.session` + 非空 Track Name (unrecognized session-level track): §3.2.2 の MUST により同じく DOES_NOT_EXIST 拒否。(c) `.` 単体 + 任意 Track Name: §3.2.1 の MUST により DOES_NOT_EXIST 拒否。(d) `.foo` 等のその他の予約名前空間: 拒否せずアプリへ渡す (§3.2.1)。(e) namespace が空 (先頭フィールドなし): 拒否対象外。

## 完了条件

- 受信 PUBLISH の Track Namespace 先頭フィールドが `.session` (空 Track Name 含む) または `.` の場合、REQUEST_ERROR (DOES_NOT_EXIST) が応答され、送信方向が FIN で閉じられ (§3.3.3 SHOULD)、アプリの `onPublish` に渡らないこと。
- それ以外の予約名前空間 (例: `.foo`) の受信 PUBLISH は従来どおりアプリへ渡ること (§3.2.1 の MUST)。
- 正常な namespace (`.` で始まらない) の受信 PUBLISH は従来どおり処理されること。
- 上記を検証するテストがあること。判定ロジックを純関数 (例: `isRejectedReceiveNamespace`) として `src/message/parameter.ts` に抽出し、その単体テストを追加する。あわせて、受信経路 (`handleIncomingBidirectionalStream` 内の判定呼び出し) の配線は private メソッドのため自動テスト対象外であり、コードレビューで担保する。e2e は `TEST_MOQT_URI` 依存で常時実行されないため対象外。
- 非 PUBLISH リクエストへの DOES_NOT_EXIST (§3.2.2) は 0371 実装後は NOT_SUPPORTED が先に適用される (判定順序は型分類が先) 旨を完了条件に反映済みであること。
- 後方互換: 公開 API は変更しない。挙動変化は「受信 `.session` / `.` namespace の PUBLISH が REQUEST_ERROR (DOES_NOT_EXIST) で拒否される」の 1 点。従来アプリへ渡っていた受信が拒否に変わるため、`CHANGES.md` は `[CHANGE]` で記載する (ファイル名・Branch のカテゴリ "change" と整合)。
- `CHANGES.md` の `## develop` に `[CHANGE]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §3.2.1 (Reserved Namespaces / `.` 単体の MUST 拒否 / unrecognized reserved namespace はアプリへ渡す MUST)
- draft-ietf-moq-transport-19 §3.2.2 (Session-Level Tracks and Namespaces / `.session` の MUST 拒否 / 空 Track Name の MUST 拒否)
- 関連: `issues/closed/0401-add-reserved-namespace-rejection.md`（送信側の拒否を実装済み。本 issue はその受信側対応）
- 関連: `0371-moqt-draft-19-incoming-request-not-supported-response.md`（受信リクエストの型分類。NOT_SUPPORTED が先に適用される旨の注記を本 issue に要求）

## 解決方法

未着手。
