# Full Track Name の 4,096 バイト検証がデコード経路で欠落している

- Priority: Low
- Created: 2026-08-06
- Completed: 2026-08-13
- Model: DeepSeek V4 Flash
- Branch: feature/fix-moqt-draft-19-full-track-name-size-validation
- Polished: 2026-08-12

## 目的

draft-ietf-moq-transport-19 §2.4.1 の「If an endpoint receives a Track Namespace or a Full Track Name exceeding 4,096 bytes, it MUST close the session with a PROTOCOL_VIOLATION.」をデコード経路で満たす。受信側デコードパスでは `decodePublishPayload` のみ Full Track Name の合計検証が行われ、SUBSCRIBE / FETCH / TRACK_STATUS / Redirect (REQUEST_ERROR) のデコーダでは Track Namespace + Track Name の合計サイズが検証されない。

## 優先度根拠

§2.4.1 の MUST 要件の適用漏れ。Track Namespace 単体の 4,096 バイト検証は `decodeTrackNamespace` で全メッセージ共通に実施済みだが、Full Track Name (Namespace + Name) の合計検証が SUBSCRIBE / FETCH / TRACK_STATUS / Redirect のデコーダにない。SUBSCRIBE / FETCH / TRACK_STATUS のデコーダは PBT 専用 (リレーサーバー実装用。ランタイムでは使用しない) であり実害はないが、`decodeRedirect` (REQUEST_ERROR の Redirect 経由) はランタイムで使用される。Low。

## 現状

- 受信側デコードパスでは `decodePublishPayload` (`src/message/publish.ts`) のみ `validateFullTrackName` を呼ぶ。送信パス (`src/session.ts` の `publish()` / `subscribe()` / `fetch()` / `trackStatus()`) は closed issue 0329 で `validateFullTrackName` 呼び出しを統合済み。
- `decodeSubscribePayload` (`src/message/subscribe.ts`)、`decodeTrackStatusPayload` (`src/message/trackstatus.ts`)、`decodeFetchPayload` の STANDALONE ブランチ (`src/message/fetch.ts`)、`decodeRedirect` (`src/message/session.ts`) は Track Name 長を含む Full Track Name 合計の検証がない。
- `validateFullTrackName` (`src/message/parameter.ts`) は string ベース (TextEncoder で再エンコードして長さを計測) であり、`decodePublishPayload` は TextDecoder 経由で渡している。§2.4.1 は Track Name を「a sequence of bytes」「not constrained to a specific encoding」と定義するため、不正な UTF-8 バイト列は TextDecoder の置換 (U+FFFD) で長さが水増しされ、誤って超過判定されたり、BOM 除去で短く計測されたりする (ランタイム経路の実バグ)。
- 変更対象ファイル: `src/message/parameter.ts` (バイト長版検証関数の新設)、`src/message/publish.ts` (既存呼び出しの置き換え)、`src/message/subscribe.ts` / `src/message/trackstatus.ts` / `src/message/fetch.ts` / `src/message/session.ts` (検証追加)、各テスト (`src/message/*.test.ts` / `*.prop.ts`)、`CHANGES.md`。

## 設計方針

- **バイト長版検証の新設**: Track Namespace フィールドのバイト長合計 + Track Name のワイヤバイト長 (`trackNameBytes.length`) を加算し、4,096 バイト (ちょうどは許容) を超える場合に ProtocolViolationError を送出する検証関数を新設する (§2.4.1 の「The length of a Full Track Name is computed as the sum of the Track Namespace Field Length fields and the Track Name Length field.」に正確に一致。Length フィールドの値のみ加算し、varint エンコードサイズは含まない)。string ベースの `validateFullTrackName` は使わない (不正 UTF-8 バイト列の誤計測を伝搬させるため)。
- **検証の追加箇所**: `decodeSubscribePayload` / `decodeTrackStatusPayload` / `decodeFetchPayload` (STANDALONE ブランチ内。Joining ブランチには Track Namespace / Track Name がない) / `decodeRedirect` にバイト長版検証を追加する。
- **decodePublishPayload の置き換え**: 既存の TextDecoder 経由呼び出しをバイト長版検証に置き換える (ランタイム経路の誤拒否・過小受理の修正。同一 MUST の充足であり本 issue のスコープに含める)。
- **送信パスは維持**: 送信パス (`session.ts` の 4 箇所) の string 版 `validateFullTrackName` は、アプリから渡される文字列の長さを直接計測するため正確であり、そのまま維持する。
- **スコープ外の明記**: `decodePublishSkippedPayload` (`src/message/namespace.ts`) の Track Namespace Suffix + Track Name は、suffix が SUBSCRIBE_TRACKS (§10.19) の Track Namespace Prefix に対する相対値であり、§2.4.1 の MUST が適用される完全な Full Track Name がペイロードに含まれないため、厳密な検証は対象外とする (suffix + name の合計が 4,096 超ならば Full Track Name も必ず超えるという十分条件の検証は、別 issue として起票が必要な場合は create-issue 経由で対応する。現時点では未作成)。
- **テスト**: 固定バイト列で 4,096 バイト超過ケースを検証する。境界条件: (a) namespace を 4,096 未満に分割し、name を足して合計 4,097 の違反ケース (namespace 単体が 4,096 超のケースは `decodeTrackNamespace` の既存検証が先に throw するため、新規検証を実行するテストにはならない)、(b) 合計 4,096 ちょうどは違反にならない、(c) 不正 UTF-8 バイト列を含む Track Name がバイト長で正確に計測されること。

## 完了条件

- SUBSCRIBE / FETCH (STANDALONE) / TRACK_STATUS / Redirect (REQUEST_ERROR) のデコーダで Full Track Name が 4,096 バイトを超える場合に ProtocolViolationError が送出されること (セッションクローズは受信ループの責務であり、本 issue の検証対象外)。
- `decodePublishPayload` の検証がバイト長版に置き換えられ、不正 UTF-8 バイト列を含む Track Name でもワイヤバイト長で正確に計測されること。
- 上記を検証する固定バイト列テストがあること (境界条件 (a)(b)(c) を含む)。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §2.4.1 (Track Naming / Full Track Name の 4,096 バイト上限と長さの定義)
- 関連: `issues/closed/0329-bug-track-name-full-name-validation.md`（`validateFullTrackName` 導入元。送信パスと PUBLISH デコードを対応し、他デコーダへの追加は任意とした）
- 関連: `0378-moqt-draft-19-message-body-length-validation.md`（同じ 3 デコーダを変更対象とする。変更箇所は異なり、コード競合は小さい。実装順序の制約はない）
- 関連: `0382-moqt-draft-19-redirect-connect-uri-length-limit.md`（`decodeRedirect` の別修正。同じ関数を変更対象とする）

## 解決方法

- `src/message/parameter.ts` に `validateFullTrackNameBytes` を新設した。§2.4.1 の「The length of a Full Track Name is computed as the sum of the Track Namespace Field Length fields and the Track Name Length field」に正確に一致し、Track Namespace フィールドのバイト長合計 + Track Name のワイヤバイト長を加算して 4,096 バイト超過を検証する (4,096 ちょうどは許容)
- string ベースの `validateFullTrackName` は TextEncoder による再エンコードで長さを計測するため、不正な UTF-8 バイト列は TextDecoder の置換 (U+FFFD) で長さが水増しされる。デコード経路ではワイヤバイト長を直接加算する `validateFullTrackNameBytes` を使用する
- 検証を追加したデコーダ: `decodeSubscribePayload` / `decodeTrackStatusPayload` / `decodeFetchPayload` (STANDALONE ブランチ内。Joining ブランチには Track Namespace / Track Name がないため対象外) / `decodeRedirect`
- `decodePublishPayload` の既存 TextDecoder 経由呼び出しをバイト長版に置き換えた (ランタイム経路の誤拒否・過小受理の修正)
- 送信パス (session.ts の 4 箇所) の string 版 `validateFullTrackName` はアプリから渡される文字列の長さを直接計測するため正確であり、そのまま維持した
- テスト: `src/message/parameter.test.ts` に境界テスト 3 件 (合計 4,097 で違反 / 4,096 ちょうどは許容 / 不正 UTF-8 がバイト長で計測される) と、`src/message/session.prop.ts` に decodeRedirect 経由の統合テスト 1 件 (4,097 バイトの Redirect で ProtocolViolationError) を追加した
- `CHANGES.md` の `## develop` に `[FIX]` エントリを追加した
