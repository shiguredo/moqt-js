# 仕様参照コメントを draft-ietf-moq-transport-19 に一括更新する

- Priority: Medium
- Created: 2026-07-07
- Model: Fable 5
- Branch: feature/update-draft-19-spec-reference-comments
- Polished: 2026-07-23

## 目的

moqt-js のコード・テスト・devtools は仕様参照コメントとして `draft-ietf-moq-transport-18` を多数参照している。draft-19 ではセクション番号の振り直しと用語変更があるため、参照ドラフト番号と節番号・引用文言を一括で draft-19 に更新する。

polish-refs による引用検証の正確性は refs/ の一次資料とコメントの一致に依存する。実装系の draft-19 対応 issue (0332–0342) がすべて closed になった後、残りの参照を本 issue で一括更新する。

## 優先度根拠

コメントのみの変更で動作に影響はないが、古い版の参照が残ると以後のレビュー・polish-refs 検証が draft-18 基準になり、仕様追従の妨げになる。他の draft-19 対応 issue 完了後に速やかに実施すべきなので Medium。

## 現状

`draft-ietf-moq-transport-18` の参照は src / tests / devtools に広く分布している (主なもの: `src/session.ts`、`src/dataStream.ts`、`src/message/parameter.ts`、`src/properties.ts`、`src/session/params.ts`、`src/message/types.ts`)。

refs/moq/ には `draft-ietf-moq-transport-19.txt` が取り込み済みである。本 issue の実装時はこれを一次資料として照合する。

コードから参照されているセクションのうち、draft-19 で番号または名称が変わるもの:

| draft-18 | draft-19 | 主な参照箇所 |
| --- | --- | --- |
| 3.1.3 WebTransport | 3.1.4 WebTransport (3.1.3 は新設 Dereferencing a MOQT URI) | `src/moqtUri.ts`、`src/moqtUri.test.ts` |
| 3.1.4 Native QUIC | 3.1.5 Native QUIC | SETUP 関連コメント |
| 3.6 Migration | 3.6 Session Migration (名称変更のみ) | `src/session.ts` |
| 3.3.2 Request Cancellation and Rejection | 3.3.3 Request Cancellation and Rejection (3.3.2 は新設 Graceful Request Stream Closure) | `src/subscriber.ts`、`src/fetcher.ts` |
| 3.3.3 Stream Reset Error Codes | 3.3.4 Stream Reset Error Codes | `src/error.ts` |
| 5.1.2 Subscription Filters | 5.1.2 Location Filters (名称変更) | `src/message/types.ts` |
| 5.1.3 Joining an Ongoing Track | 5.1.5 Joining an Ongoing Track | subscriber 系 |
| 10.2.9 SUBSCRIPTION FILTER | 10.2.9 LOCATION FILTER (名称変更) | `src/session/params.ts` ほか |
| 10.2.10 EXPIRES | 10.2.15 EXPIRES | `src/session/params.ts` |
| 10.2.11 LARGEST OBJECT | 10.2.16 LARGEST OBJECT | `src/session/params.ts` |
| 10.2.12 FORWARD | 10.2.17 FORWARD | `src/session/params.ts` ほか |
| 10.2.13 NEW GROUP REQUEST | 10.2.18 NEW GROUP REQUEST | `src/session/params.ts`、devtools |
| 10.2.14 TRACK_NAMESPACE_PREFIX | 10.2.19 TRACK_NAMESPACE_PREFIX | `src/message/parameter.ts` ほか |
| 10.20 PUBLISH_BLOCKED | 10.20 PUBLISH_SKIPPED (名称変更) | `src/message/types.ts` ほか |
| 15.10 Error Codes | 15.11 Error Codes (15.9 Object Status 新設による繰り下がり) | `src/error.ts` |
| 15.10.4 Stream Reset Error Codes | 15.11.4 Stream Reset Error Codes | `src/error.ts` |

また、制御メッセージの "Message Payload" フィールドは draft-19 で "Message Body" にリネームされたため、引用している箇所 (`src/message/session.ts`、`src/message/session.prop.ts`) の文言更新が必要。変更履歴は Appendix A.1 `#1756`。

番号が据え置きの高頻度参照 (10.4 GOAWAY、10.5 REQUEST_OK、10.19 SUBSCRIBE_TRACKS、11.4.2 Subgroup Header、12.x MOQT Properties、1.4.3 KVP など) はドラフト番号のみの置換で足りる。

## 設計方針

- 前提: 実装変更を伴う draft-19 対応 issue (0332–0342) がすべて closed になっていること。各 issue が自分の変更箇所の参照を更新するため、本 issue は残りを対象とする
- 上記の対応表に従い、節番号が変わる参照を先に個別修正し、その後 `draft-ietf-moq-transport-18` → `draft-ietf-moq-transport-19` を一括置換する
- 英文引用を含むコメントは draft-19 の原文と突き合わせて文言差分 (Message Body 等) を反映する
- 完了後に polish-refs で全引用を検証する
- `src/msf.ts` の draft-ietf-moq-msf-01 参照は別仕様のため対象外

## 完了条件

- コードベース (src / tests / devtools) に `draft-ietf-moq-transport-18` への参照が残っていないこと
- 節番号シフト対象の参照がすべて draft-19 の正しい節番号になっていること
- polish-refs の検証で引用の不一致が報告されないこと
- lint / build / typecheck / 既存テストが通ること
