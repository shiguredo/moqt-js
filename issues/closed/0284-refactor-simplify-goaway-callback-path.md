# goawayCallback の設定経路を簡略化する

- Priority: Low
- Created: 2026-06-03
- Completed: 2026-06-04
- Model: deepseek-v4 Pro
- Branch: feature/refactor-simplify-goaway-callback
- Polished: 2026-06-04

## 目的

`goawayCallback` の参照が `PendingPublish`/`PendingSubscribe`/`PendingFetch` の pending Map と `PublisherImpl`/`SubscriberImpl`/`FetcherImpl` の 2 箇所に重複保持されている。REQUEST_OK 受信時に pending から impl へコピー転送する 3 行（`pending.impl.goawayCallback = pending.goawayCallback`）が中間的な責務を持ち、機械的な代入であるにもかかわらず、新しいリクエスト種別追加時にパターンとして再現する必要がある。impl 側だけで完結するように整理する。

## 優先度根拠

- 実際の変更規模は約 9 行と小さい。 Pending 型のフィールド削除 + 転送代入の除去 + 呼び出しの書き換えのみ
- 新規リクエスト種別追加時のパターン負荷を下げる予防的措置
- 優先度は High/Medium の issue が他にあるため Low とする

## 現状

### 設定経路（3 種とも同一パターン）

1. `src/session.ts`: impl を生成し、`pendingPublish.set(requestId, { impl, goawayCallback })` で pending Map に格納（line 1278-1283）
2. `src/session/bidi.ts`: REQUEST_OK 受信時に `pending.impl.goawayCallback = pending.goawayCallback` で impl へ転送（line 291）
3. `src/session/bidi.ts` (bidiReadRequestStreamMessages): REQUEST_OK 後に GOAWAY を受信した場合 `publisher.goawayCallback(...)` で impl から読み出し（line 695-696）

### GOAWAY 受信タイミングによる分岐

- **pre-OK GOAWAY** (bidi.ts:327/438/539): `pending.goawayCallback?.(...)` で pending から直接呼び出し → 既に 1 段階
- **post-OK GOAWAY** (bidi.ts:694-705): `impl.goawayCallback(...)` で impl から読み出し → 既に 1 段階

唯一の「無駄」は REQUEST_OK 時の `pending.impl.goawayCallback = pending.goawayCallback` のコピー転送 3 行。

### 対象外の種別

- **namespace 系操作** (`startNamespaceStreamLoop`, `startTracksStreamLoop`, `startNamespacePublicationStreamLoop`): 既に callbacks オブジェクト経由で 2 段階。本 issue の対象外
- **TRACK_STATUS** (bidi.ts:584-598): 単発リクエストのため goawayCallback 不要（newSessionUri は Error.message 経由で通知）。本 issue の対象外

## 設計方針

`session.ts` で impl 生成直後に `impl.goawayCallback = callbacks?.goaway` を設定し、pending Map から `goawayCallback` フィールドを削除する。pre-OK GOAWAY は `pending.impl.goawayCallback` で呼び出せるため、pending に goawayCallback を別途持つ必要はない。

**理由**: impl クラスは既に `goawayCallback` を public フィールドとして持つ（publisher.ts:97, subscriber.ts:86, fetcher.ts:64）。設定を session.ts に寄せれば bidi.ts の転送代入 3 行が不要になる。

**コンストラクタに追加しない理由**: `PublisherImpl`/`SubscriberImpl`/`FetcherImpl` のコンストラクタはユーザー向けコールバック（object/end/error 等）を受け取る設計。`goawayCallback` はセッション内部コールバックであり、既存の `onSendObject`/`onUnsubscribe` 等と同様にプロパティ代入で設定する方が責務分離の一貫性を保てる。

## 変更内容

### 変更対象ファイル

- `src/session.ts`: impl 生成直後に `impl.goawayCallback = callbacks?.goaway` を追加、pending Map 格納時の `goawayCallback` フィールドを削除（3 箇所）、pending 型定義から `goawayCallback` フィールドを削除（3 箇所）
- `src/session/bidi.ts`: `pending.impl.goawayCallback = pending.goawayCallback` の転送代入を削除（3 箇所）、pre-OK GOAWAY の呼び出しを `pending.goawayCallback?.(...)` から `pending.impl.goawayCallback?.(...)` に変更（3 箇所）、pending 型定義から `goawayCallback` フィールドを削除（3 箇所）
- `CHANGES.md`: `[UPDATE]` エントリを追記

### 具体的な変更

`src/session.ts`（publish の例、subscribe/fetch も同様）:

```typescript
// impl 生成後に追加:
impl.goawayCallback = callbacks?.goaway;

// pendingPublish.set から goawayCallback を削除:
this.pendingPublish.set(requestId, {
  resolve,
  reject,
  impl,
  // goawayCallback: callbacks?.goaway,  ← 削除
});
```

`src/session/bidi.ts`（publish の例、subscribe/fetch も同様）:

```typescript
// REQUEST_OK 分岐から削除:
// pending.impl.goawayCallback = pending.goawayCallback;  ← 削除

// pre-OK GOAWAY 分岐を変更:
// 変更前: pending.goawayCallback?.(decoded.newSessionUri);
// 変更後: pending.impl.goawayCallback?.(decoded.newSessionUri);
```

```typescript
// pending 型定義から goawayCallback フィールドを削除:
interface PendingPublish {
  resolve: (pub: Publisher) => void;
  reject: (err: Error) => void;
  impl: PublisherImpl;
  // goawayCallback?: (newSessionUri: string) => void;  ← 削除
}
```

## テスト方針

変更前後で挙動が変わらないことを確認する。新規テストは不要だが、既存テストの確認が必要。

### 確認すべき既存テスト

- `src/publisher.test.ts`: goawayCallback のプロパティ設定・呼び出しテスト（変更なしで PASS すること）
- `src/subscriber.test.ts`: 同上
- `src/fetcher.test.ts`: 同上（存在する場合）
- `src/session/bidi.test.ts`: GOAWAY 関連テスト（存在する場合）
- `src/message/session.prop.ts`: GOAWAY encode/decode ラウンドトリップ

モックやスタブは利用しないこと。

## 後方互換の影響

- なし。内部実装のリファクタリングであり、公開 API に変更はない
- goawayCallback の呼び出しタイミング・引数は変更されない

## 完了条件

- `PendingPublish`/`PendingSubscribe`/`PendingFetch` の型定義から `goawayCallback` フィールドが削除されている
- `pending.impl.goawayCallback = pending.goawayCallback` の転送代入 3 行が削除されている
- `session.ts` で impl 生成直後に `impl.goawayCallback` が設定されている（3 種すべて）
- pre-OK GOAWAY が `pending.impl.goawayCallback` で呼ばれている（3 箇所すべて）
- 全テストが PASS する
- `CHANGES.md` に `[UPDATE]` エントリを追記する

## 解決方法

`goawayCallback` を pending Map と impl の 2 箇所で重複保持していたのを、impl 側に一本化した。

- `src/session.ts`: `PublisherImpl`/`SubscriberImpl`/`FetcherImpl` 生成直後に `impl.goawayCallback = callbacks?.goaway`（publish）/ `callbacks.goaway`（subscribe/fetch）を設定し、`pendingPublish`/`pendingSubscribe`/`pendingFetch` の格納と Map のインライン型定義から `goawayCallback` を削除した
- `src/session/bidi.ts`: `PendingPublish`/`PendingSubscribe`/`PendingFetch` 型から `goawayCallback` を削除し、REQUEST_OK 受信時の転送代入 `pending.impl.goawayCallback = pending.goawayCallback` 3 行を削除、pre-OK GOAWAY の呼び出しを `pending.goawayCallback?.(...)` から `pending.impl.goawayCallback?.(...)` に変更した

`session.ts` のインライン型定義の削除は、`bidi.ts` の `BidiSessionInternal`（`Map<bigint, PendingPublish>`）と構造的に整合させデッドフィールドを防ぐために必要であり、issue の「変更内容」の指示どおりである。

挙動は不変である。`impl.goawayCallback` は impl 生成直後かつリクエスト送信前に設定されるため、pre-OK / post-OK のいずれの GOAWAY でも同じコールバックが同じ引数 `decoded.newSessionUri` で呼ばれる。

### 触ったファイル

- `src/session.ts`
- `src/session/bidi.ts`
- `CHANGES.md`

### 残課題（別 issue 推奨）

- pending 型が `src/session.ts` のインライン型と `src/session/bidi.ts` の `PendingPublish` 等で二重定義されており、構造的型付けに依存しているため片方だけ更新すると乖離するリスクがある。`bidi.ts` の型を export して単一定義にする整理を別 issue で検討する。
