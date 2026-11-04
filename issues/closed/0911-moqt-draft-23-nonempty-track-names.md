# 通常の Track Name を非空にし namespace Redirect の空値と区別する

- Created: 2026-11-03
- Completed: 2026-11-04
- Branch: feature/change-moqt-draft-23
- Polished: 2026-11-03

## 目的

draft 23 §2.4.1 は Track Name に最低 1 バイトを要求し、長さ 0 の受信時は PROTOCOL_VIOLATION とした。draft 22 で空を許容していた codec・送信 API を変更する必要がある。

## 現状

- `src/message/parameter/trackNamespace.ts` の `encodeTrackName` / `validateFullTrackNameBytes` は上限だけを検証する
- `src/message/fetch.ts` などの payload decoder は Track Name 長 0 を受理する
- `src/fullTrackName.ts` は空 Track Name も表示する。`src/msf/fragment.ts` は逆に空を拒否しており、既存 0823 はこの拒否を取り除く旧版向け issue である
- `src/message/session.ts` の Redirect は namespace-scoped 要求では空 Track Name を必要とする

## 設計方針

- SUBSCRIBE / PUBLISH / FETCH / TRACK_STATUS / PUBLISH_SKIPPED の通常 Track Name を受信時に検証し、0 バイトなら PROTOCOL_VIOLATION とする
- `src/session/incoming.ts` の `incomingHandleFirstBidiMessage` は未対応 SUBSCRIBE / FETCH / TRACK_STATUS の通常 decoder を呼ばないため、Request ID の検証後、予約 namespace の拒否や NOT_SUPPORTED 応答より前に、共通 prefix の Track Namespace / Track Name Length / Track Name まで検証する。名前の検証を行うだけで、要求を受理するサーバー機能は追加しない。構造不正・上限超過の分類は 0902 に揃える
- 送信 API では stream 生成や認証トークン予約より前に空を拒否する。UTF-8 の文字数ではなくバイト数を使う
- Track Namespace が 0 field であることは引き続き合法であり、空 Track Name と混同しない
- namespace-scoped Redirect の空 Track Name は §9.4.2.1 に必要な表現として維持する。共用の長さ検証へ無条件の非空制約を入れて Redirect まで壊さない
- Redirect の検証は REQUEST_ERROR codec の共用部分に元要求の scope を仮定させず、要求文脈の分かる各応答処理で行う。Track-scoped 要求の Redirect は空名を PROTOCOL_VIOLATION とし、SUBSCRIBE_NAMESPACE / PUBLISH_NAMESPACE / SUBSCRIBE_TRACKS の Redirect は空名を受理して非空名を §9.4.2.1 の INVALID_FIELD とする。更新への応答も元要求の scope で判定する
- 0823 の旧方針は draft 23 移行では実施しない。0824 / 0669 の空 Track Name に関する前提も、実装時に本方針と整合させる
- format / parse の正常な round-trip は非空 Track Name を対象にし、旧版を根拠にしたコメントを更新する

## 完了条件

- 各 Track-scoped メッセージの空 Track Name が適切な受信エラーになる
- 未対応要求の実受信経路でも、空名を NOT_SUPPORTED で処理せず PROTOCOL_VIOLATION にする
- 空 namespace + 非空 Track Name は受理し、namespace Redirect の空 Track Name も受理する
- Track / namespace の両 scope の Redirect と、更新応答の Redirect の名前制約を検証する
- 1 バイト、マルチバイト UTF-8、Full Track Name の上限と超過を検証する
- 送信 API の fail-fast と既存 0823 / 0824 の方針衝突が解消される

## 参照

- `refs/moq/draft-ietf-moq-transport-23.txt` §2.4.1 / §6.5 / §9.4.2.1
- `src/message/parameter/trackNamespace.ts`、`src/message/publish.ts`、`src/message/subscribe.ts`、`src/message/fetch.ts`、`src/message/trackstatus.ts`、`src/message/namespace.ts`
- `src/session/incoming.ts` の `incomingHandleFirstBidiMessage`、`src/message/session.ts` の Redirect codec、`src/session/bidi.ts` / `src/session/namespaceLoops.ts` の REQUEST_ERROR 応答処理
- `issues/0823-bug-msf-empty-track-name.md` / `issues/0824-test-msf-fragment-error-paths.md`

## 解決方法

- draft-23 §2.4.1 に従い、Track Name の minimum length を 1 バイトとする検証を追加した。`src/message/parameter/trackNamespace.ts` に `validateTrackNameNonEmpty` を追加し、SUBSCRIBE / PUBLISH / FETCH / TRACK_STATUS / PUBLISH_SKIPPED の通常メッセージが受信時に 0 バイトの Track Name を PROTOCOL_VIOLATION として拒否する。
- `src/session/incoming.ts` の `incomingHandleFirstBidiMessage` で、未対応の SUBSCRIBE / FETCH / TRACK_STATUS でも Request ID の検証後、予約 namespace の拒否や NOT_SUPPORTED 応答より前に共通 prefix (Track Namespace / Track Name Length / Track Name) を検証するようにした。名前の検証だけを行い、要求を受理するサーバー機能は追加していない。構造不正・上限超過の分類は 0902 のエラー体系 (INVALID_TRACK_NAMESPACE / FIELD_LENGTH_EXCEEDED / MALFORMED_MESSAGE) に揃えた。
- 送信 API では `encodeTrackName` が空 Track Name を拒否し、Request ID の消費・ストリーム生成・認証トークンの予約より前に throw する (UTF-8 の文字数ではなくバイト数で判定)。`src/session/requests.ts` の各送信経路でこの検証を前段に移した。
- 共用の `validateFullTrackNameBytes` には非空制約を入れず、namespace-scoped Redirect の空 Track Name を §9.4.2.1 の表現として維持した。Redirect の検証は REQUEST_ERROR codec の共用部分に scope を仮定させず、要求文脈の分かる各応答処理で行う構造を維持した。track-scoped 要求の Redirect は空名を PROTOCOL_VIOLATION、SUBSCRIBE_NAMESPACE / PUBLISH_NAMESPACE / SUBSCRIBE_TRACKS の Redirect は空名を受理して非空名を INVALID_FIELD とする。更新への応答も元要求の scope で判定する。
- Track Namespace の 0 フィールドは引き続き合法であり、空 namespace + 非空 Track Name を受理することをテストで固定した。
- `src/fullTrackName.ts` とテストの空 Track Name に関する記述を、通常メッセージは非空 MUST、namespace-scoped Redirect の表現としてのみ空を許すという方針に更新した。msf fragment の空 Track Name 拒否は draft-23 の非空 MUST と整合するため維持した。
- テストは各メッセージの空名受信、空 namespace + 非空名の受理、1 バイト / マルチバイト UTF-8 / Track Name 上限境界、送信エンコーダの空拒否、送信 API の fail-fast (ストリーム未生成・Request ID 未消費)、未対応要求経路の空名と切り詰め、Redirect の track / namespace scope の名前制約を検証する。
- docs は 0925 で一括更新するため触っていない。

### 既知の制限

- 0823 / 0824 の issue 本文は更新していない (issues/ は編集対象外)。コード側では msf fragment の空 Track Name 拒否を維持し、fullTrackName のコメントのみ更新した。
- 実リレー E2E は統合ブランチの制約 (ALPN は移行完了まで moqt-22) のため未実施である。
