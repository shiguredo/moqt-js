# Range Filters と MAX_FILTER_RANGES Setup Option を追加する (draft-19 追従)

- Priority: Low
- Created: 2026-07-07
- Model: Fable 5
- Branch: feature/add-draft-19-range-filters
- Polished: 2026-07-23

## 目的

draft-ietf-moq-transport-19 Section 5.1.3 (Range Filters) で範囲フィルタが新設された。変更履歴は Appendix A.1 `#1765` ("Add Range Filters that can filter Objects from Subscriptions and SUBSCRIBE_TRACKS")。

draft-19 Section 5.1.3:

> Range Filters are parameters in SUBSCRIBE, FETCH, or SUBSCRIBE_TRACKS
> that tell a publisher to filter tracks (via TRACK PROPERTY FILTER)
> and objects according to subscriber-provided criteria.

新設された Message Parameters (Section 10.2.10–10.2.14):

| Parameter | Type |
| --- | --- |
| SUBGROUP_FILTER | `0x25` |
| OBJECTID_FILTER | `0x26` |
| PRIORITY_FILTER | `0x27` |
| OBJECT_PROPERTY_FILTER | `0x28` |
| TRACK_PROPERTY_FILTER | `0x29` |

いずれも Length + SetID (8 bit) + Range の列 (Property Filter は Property Type を追加)。Range は Start / End の inclusive range で delta encode。

同一 SetID 内は AND、異なる SetID 間は OR で結合する (Section 5.1.3)。Location Filters / Range Filters / Forward をさらに AND で結合するのは Section 5.1.4 (Combining Filters) であり、SetID 結合とは別である。

```
Pass = Forward AND Location Filters AND Range Filters
```

出現メッセージの制約 (Section 5.1.3):

- TRACK_PROPERTY_FILTER: SUBSCRIBE_TRACKS、またはその REQUEST_UPDATE (`REQUEST_UPDATE for it`)
- その他の Range Filter: FETCH / SUBSCRIBE / SUBSCRIBE_TRACKS / PUBLISH_OK / REQUEST_UPDATE (on a subscription, from the subscriber only)

あわせて以下が新設された。

MAX_FILTER_RANGES Setup Option (Section 10.3.1.6、Type `0x06`):

> The default value is 0, so if not specified, the peer MUST NOT
> send any such filter parameters. If this limit is exceeded, an
> endpoint MUST reject this with REQUEST_ERROR with error code
> INVALID_FILTER.

REQUEST_ERROR コード (Section 10.6 / IANA Section 15.11.2):

- CONFLICTING_FILTERS (`0x35`): SUBSCRIBE_TRACKS 応答で、フィルタが多数 subscriber 間で衝突し upstream 集約等ができない場合
- INVALID_FILTER (`0x36`): フィルタパラメータが不正、または MAX_FILTER_RANGES 上限超過など

## 優先度根拠

MAX_FILTER_RANGES のデフォルトは 0 であり、moqt-js が広告しない限りピアは Range Filter を送ってこない (MUST NOT)。そのため未対応でも相互運用は壊れない。subscriber として不要なオブジェクトを削減できるが additive な拡張であり Low。

## 現状

- Range Filter (`0x25`–`0x29`) の実装は皆無。`MessageParameterType` に未定義
- `MESSAGE_PARAMETER_VALUE_ENCODING` に未登録のため、これらを含むメッセージを受信すると ProtocolViolationError になる (自分が MAX_FILTER_RANGES を広告しない限り正当なピアからは届かない)
- `SetupOptionType` に MAX_FILTER_RANGES (`0x06`) が未定義
- `RequestErrorCode` に CONFLICTING_FILTERS (`0x35`) / INVALID_FILTER (`0x36`) が未定義

## 設計方針

- Range / SetID を含む Range Filter 5 種のエンコード・デコードを追加し、`MessageParameterType` / `MESSAGE_PARAMETER_VALUE_ENCODING` / パラメータスコープに登録する (出現メッセージ制約は Section 5.1.3 に従う)
- `SetupOptionType.MAX_FILTER_RANGES = 0x06` を追加し、受信側として Range Filter を受け付ける場合は SETUP で広告し、受信 Range 数の上限検証を行う (超過時は INVALID_FILTER)
- 送信側 API として `subscribe()` / `fetch()` / `subscribeTracks()` のオプションに Range Filter 指定を追加する (ピアが MAX_FILTER_RANGES を広告している場合のみ送信を許可し、Range 総数の上限を検証する)
- `RequestErrorCode.CONFLICTING_FILTERS = 0x35` / `RequestErrorCode.INVALID_FILTER = 0x36` を追加する
- publisher 側 (client-as-publisher) での Range Filter 適用 (マッチしないオブジェクトの送信抑止) の実装範囲は設計時に判断する
- 仕様参照は Section 5.1.3 / 5.1.4 / 10.2.10–10.2.14 / 10.3.1.6 / 10.6 を分けて引用する

## 完了条件

- Range Filter 5 種のエンコード・デコードのラウンドトリップテストがあること (SetID の AND / OR 結合の解釈を含む)
- MAX_FILTER_RANGES の広告と上限検証が動作すること
- ピアが MAX_FILTER_RANGES を広告していない場合に Range Filter を送信しないこと
- lint / build / typecheck / 既存テストが通ること
