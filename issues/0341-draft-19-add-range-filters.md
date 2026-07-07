# Range Filters と MAX_FILTER_RANGES Setup Option を追加する (draft-19 追従)

- Priority: Low
- Created: 2026-07-07
- Model: Fable 5
- Branch: feature/add-draft-19-range-filters
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-19 Section 5.1.3 (Range Filters) で、サブスクリプションと SUBSCRIBE_TRACKS からオブジェクトをフィルタする範囲フィルタが新設された (draft-18 → 19 変更履歴 "Add Range Filters that can filter Objects from Subscriptions and SUBSCRIBE_TRACKS (#1765)")。

新設された Message Parameters (Section 10.2.10-10.2.14):

- SUBGROUP_FILTER (0x25)
- OBJECTID_FILTER (0x26)
- PRIORITY_FILTER (0x27)
- OBJECT_PROPERTY_FILTER (0x28)
- TRACK_PROPERTY_FILTER (0x29)

いずれも Length + SetID (8bit) + Range の列 (Property Filter は Property Type を追加)。Range は Start / End の inclusive range で delta encode。同一 SetID は AND、異なる SetID 間は OR で結合される (Section 5.1.4 Combining Filters)。Track Property Filter は SUBSCRIBE_TRACKS / REQUEST_UPDATE で、その他は FETCH / SUBSCRIBE / SUBSCRIBE_TRACKS / PUBLISH_OK / REQUEST_UPDATE で使用できる。

あわせて以下が新設された:

- MAX_FILTER_RANGES Setup Option (Option Type 0x06、Section 10.3.1.6):
  > The default value is 0, so if not specified, the peer MUST NOT
  > send any such filter parameters.
- REQUEST_ERROR コード CONFLICTING_FILTERS (0x35) / INVALID_FILTER (0x36):
  > If this limit is exceeded, an endpoint MUST reject this with
  > REQUEST_ERROR with error code INVALID_FILTER

draft-18 には範囲フィルタの概念自体が存在しない。

## 優先度根拠

MAX_FILTER_RANGES のデフォルトは 0 であり、moqt-js が広告しない限りピアは Range Filter を送ってこない (MUST NOT)。そのため未対応でも相互運用は壊れない。subscriber として不要なオブジェクトを削減できる有用な機能だが additive な拡張であり Low。

## 現状

- Range Filter (0x25-0x29) の実装は皆無。`src/message/types.ts:114-196` の `MessageParameterType` に未定義
- `src/message/parameter.ts:594-621`: `MESSAGE_PARAMETER_VALUE_ENCODING` に 0x25-0x29 が未登録のため、これらを含むメッセージを受信すると `getMessageParameterValueEncoding` (`src/message/parameter.ts:633-639`) が ProtocolViolationError を throw する (自分が MAX_FILTER_RANGES を広告しない限り正当なピアからは届かない)
- `src/message/types.ts:83-96`: `SetupOptionType` に MAX_FILTER_RANGES (0x06) が未定義
- `src/error.ts`: `RequestErrorCode` に CONFLICTING_FILTERS (0x35) / INVALID_FILTER (0x36) が未定義

## 設計方針

- Range / SetID を含む Range Filter 5 種のエンコード・デコードを `src/message/parameter.ts` に追加し、`MessageParameterType` / `MESSAGE_PARAMETER_VALUE_ENCODING` / パラメータスコープに登録する
- `SetupOptionType.MAX_FILTER_RANGES = 0x06` を追加し、受信側として Range Filter を受け付ける場合は SETUP で広告し、受信 Range 数の上限検証を行う
- 送信側 API として `subscribe()` / `fetch()` / `subscribeTracks()` のオプションに Range Filter 指定を追加する (ピアが MAX_FILTER_RANGES を広告している場合のみ送信を許可し、Range 総数の上限を検証する)
- `RequestErrorCode.CONFLICTING_FILTERS = 0x35` / `RequestErrorCode.INVALID_FILTER = 0x36` を追加する
- publisher 側 (client-as-publisher) での Range Filter 適用 (マッチしないオブジェクトの送信抑止) の実装範囲は設計時に判断する
- 仕様参照は draft-19 Section 5.1.3 / 5.1.4 / 10.2.10-10.2.14 / 10.3.1.6 を引用する

## 完了条件

- Range Filter 5 種のエンコード・デコードのラウンドトリップテストがあること (SetID の AND / OR 結合の解釈を含む)
- MAX_FILTER_RANGES の広告と上限検証が動作すること
- ピアが MAX_FILTER_RANGES を広告していない場合に Range Filter を送信しないこと
- lint / build / typecheck / 既存テストが通ること
