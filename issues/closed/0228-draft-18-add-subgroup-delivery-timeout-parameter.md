# SUBGROUP_DELIVERY_TIMEOUT メッセージパラメータ (Parameter Type 0x06) を追加する

- Priority: High
- Created: 2026-06-02
- Model: deepseek-v4-pro
- Branch: feature/change-add-subgroup-delivery-timeout-param
- Polished: 2026-06-02
- Completed: 2026-06-03

## 目的

draft-ietf-moq-transport-18 §10.2.3 で定義されている SUBGROUP_DELIVERY_TIMEOUT (Parameter Type 0x06) を追加する。現在は `MessageParameterType` と `MESSAGE_PARAMETER_VALUE_ENCODING` に未定義のため、受信時に `getMessageParameterValueEncoding(0x06)` が `ProtocolViolationError` をスローする。

本 issue は issue 0208「DELIVERY_TIMEOUT を SUBGROUP_DELIVERY_TIMEOUT と OBJECT_DELIVERY_TIMEOUT に分割する」の一部先行実装である。0208 が要求する全変更（API 層の `deliveryTimeout` 分割を含む）のうち、wire format 層の 0x06 定義と PBT テストのみを先に実施する。0208 の残作業（0x02 の命名変更、API 層の分割）は本 issue の対象外。

## 優先度根拠

仕様で定義されたパラメータの欠落であり、他実装との相互運用に支障があるため High。0208 が deferred 状態であるため、wire format 層のみ独立先行実装することでリスクを低減する。

## 一次資料の引用

draft-ietf-moq-transport-18 §10.2.3 (SUBGROUP_DELIVERY_TIMEOUT Parameter):

> The SUBGROUP_DELIVERY_TIMEOUT parameter (Parameter Type 0x06) is a varint.
> It MAY appear in a PUBLISH_OK, SUBSCRIBE, or REQUEST_UPDATE message.

draft-ietf-moq-transport-18 §8 (Delivery Timeouts and Data Reliability):

> Each MOQT subscription has two timeout values associated with it: a
> SUBGROUP_DELIVERY_TIMEOUT and an OBJECT_DELIVERY_TIMEOUT. Both of
> those values are expressed in milliseconds; both are optional; a
> value of 0 means that there is no timeout set.
>
> The publisher communicates both timeout values as a Track Property;
> the subscriber communicates them as Message Parameters. For each
> type of timeout, if both the publisher and the subscriber have a non-
> zero value, the smaller of the two is used.

§8 のセマンティクス（単位はミリ秒、0 はタイムアウトなし、Publisher と Subscriber で小さい方を採用）は実装上の値域検証に影響する。0 は有効値として許可する必要がある。

## 現状

`src/message/types.ts:121`:

```typescript
DELIVERY_TIMEOUT: 0x02,  // 注: draft-18 では OBJECT_DELIVERY_TIMEOUT に名称変更
```

`src/message/types.ts` の `MessageParameterType` に `0x06` のエントリがない（0x04 RENDEZVOUS_TIMEOUT と 0x08 EXPIRES の間に挿入すべき）。

`src/message/parameter.ts:570-593` の `MESSAGE_PARAMETER_VALUE_ENCODING` に `0x06` エントリがない。既存の `DELIVERY_TIMEOUT (0x02)` のコメントは draft-18 で名称変更された `OBJECT_DELIVERY_TIMEOUT` に更新する必要があるが、本 issue の対象外（0208 で対応）。

## 設計方針

### 1. MessageParameterType への追加

`src/message/types.ts` の `MessageParameterType` に以下を追加する。既存の定数は数値順に並んでいるため、0x04 (RENDEZVOUS_TIMEOUT) と 0x08 (EXPIRES) の間に挿入する。

```typescript
// draft-ietf-moq-transport-18 Section 10.2.3 (SUBGROUP_DELIVERY_TIMEOUT Parameter)
SUBGROUP_DELIVERY_TIMEOUT: 0x06,
```

### 2. MESSAGE_PARAMETER_VALUE_ENCODING への追加

`src/message/parameter.ts` の `MESSAGE_PARAMETER_VALUE_ENCODING` に追加する。値型は varint。既存の `DELIVERY_TIMEOUT (0x02)` の直後に挿入する。

```typescript
// SUBGROUP_DELIVERY_TIMEOUT (Section 10.2.3)
0x06: "varint",
```

### 3. decodeMessageParameter の値域検証

SUBGROUP_DELIVERY_TIMEOUT は §8 により 0 が有効値（タイムアウトなしを示す）である。負の値は varint として表現不可能なため検証不要。最大値の制限も仕様上ないため検証不要。

### 4. 既存 DELIVERY_TIMEOUT (0x02) の扱い

本 issue では 0x02 の定数名 `DELIVERY_TIMEOUT` は変更しない（0208 で対応）。ただし `parameter.ts:571` のコメント `// DELIVERY_TIMEOUT (Section 10.2.4)` は実際の RFC の節名 `OBJECT_DELIVERY_TIMEOUT` と不一致だが、これも本 issue の対象外。

### 5. API 層への影響

本 issue では wire format 層（`types.ts` + `parameter.ts`）のみ修正する。`SubscribeOptions` / `PublishOptions` への `subgroupDeliveryTimeout` 追加と `deliveryTimeout` 削除は 0208 の範囲であり、本 issue では実施しない。

### 6. 関連 issue

- Track Property 側の SUBGROUP_DELIVERY_TIMEOUT (Type 0x06) は issue 0230 で対応する
- 0x02 の改名と API 層分割は issue 0208 で対応する

## テスト戦略

### PBT テスト (parameter.prop.ts)

`src/message/parameter.prop.ts` の `varintParameterArb` (115 行目付近) に `0x06` を追加する。

```typescript
// 変更前
constantFrom(0x02, 0x04, 0x08, 0x32),
// 変更後
constantFrom(0x02, 0x06, 0x04, 0x08, 0x32),
```

0x06 が PUBLISH_OK / SUBSCRIBE / REQUEST_UPDATE に出現可能であるため、以下の 6 prop ファイルでも `varintParameterArb` または同等の arb が使われていることを確認し、必要に応じて更新する:

- `src/message/subscribe.prop.ts:29`
- `src/message/publish.prop.ts:29`
- `src/message/fetch.prop.ts:31`
- `src/message/session.prop.ts:33`
- `src/message/namespace.prop.ts:38`
- `src/message/trackstatus.prop.ts:39`

SUBSCRIBE と PUBLISH_OK と REQUEST_UPDATE の 3 メッセージが対象。他メッセージ（FETCH, TRACK_STATUS 等）の arb に 0x06 が含まれている場合は除去する。

## 影響範囲

- `src/message/types.ts`: `MessageParameterType` に `SUBGROUP_DELIVERY_TIMEOUT: 0x06` を追加
- `src/message/parameter.ts`: `MESSAGE_PARAMETER_VALUE_ENCODING` に `0x06: "varint"` を追加
- `src/message/parameter.prop.ts`: `varintParameterArb` に `0x06` を追加
- PBT prop ファイル 6 件: 0x06 の出現可否を確認し修正

## 後方互換

- 受信側: 既存の未知パラメータによる PROTOCOL_VIOLATION が 0x06 に対して発生しなくなる。後方互換あり
- 送信側: 本 issue では送信機能は追加しない。既存の SUBSCRIBE 送信は 0x02 を送るため変更なし

## 完了条件

- `MessageParameterType` に `SUBGROUP_DELIVERY_TIMEOUT: 0x06` が定義されている
- `MESSAGE_PARAMETER_VALUE_ENCODING` に `0x06: "varint"` エントリがある
- `parameter.prop.ts` の `varintParameterArb` に `0x06` が含まれている
- 0x06 を受信可能なメッセージ 3 種 (PUBLISH_OK, SUBSCRIBE, REQUEST_UPDATE) の prop ファイルで正しく扱われる
- `vp run test` 全パス
- `vp run build` 成功

## 解決方法

### 変更ファイル

- `src/message/types.ts`: `MessageParameterType` に `SUBGROUP_DELIVERY_TIMEOUT: 0x06` を追加（0x04 と 0x08 の間、数値順）
- `src/message/parameter.ts`: `MESSAGE_PARAMETER_VALUE_ENCODING` に `0x06: "varint"` を追加
- `src/message/parameter.prop.ts`: `varintParameterArb` に `0x06` を数値順で追加
- `src/message/subscribe.prop.ts`: `varintParameterArb` に `0x06` を追加（SUBSCRIBE / REQUEST_UPDATE が受信可能）
- `src/message/publish.prop.ts`: `varintParameterArb` に `0x06` を追加（PUBLISH_OK が受信可能）

### 未変更のファイル（意図的）

- `session.prop.ts` / `fetch.prop.ts` / `namespace.prop.ts` / `trackstatus.prop.ts`: 0x06 はこれらのメッセージに出現不可のため `varintParameterArb` に追加しない

### テスト

- PBT のラウンドトリップテストが 0x06 を含めた全 varint パラメータで通過
- `vp run test` 全 586 テスト通過
- `vp run build` 成功
