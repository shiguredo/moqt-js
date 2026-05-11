# REQUEST_UPDATE で NEW_GROUP_REQUEST を送る前に DYNAMIC_GROUPS Property を確認する

Created: 2026-05-11
Model: Opus 4.7

## 概要

devtools の `useSubscriber.ts:requestKeyframe` と `src/createMediaSubscriber.ts:requestKeyframe` は、Subscriber の `update()` (REQUEST_UPDATE 送信) に NEW_GROUP_REQUEST Parameter (Type 0x32) を無条件で付与している。これは `draft-ietf-moq-transport-17 §9.3.11` の MUST NOT に違反する:

> A subscriber MUST NOT send this parameter in PUBLISH_OK or REQUEST_UPDATE if the Track did not include the DYNAMIC_GROUPS Property with value 1.

SUBSCRIBE_OK の Track Properties に DYNAMIC_GROUPS=1 が含まれていない Track に対して REQUEST_UPDATE で NEW_GROUP_REQUEST を送ると、仕様違反となる。

なお、SUBSCRIBE 送信時の NEW_GROUP_REQUEST (devtools `subscribeOptions.newGroupRequest = 0n`) は同じ §9.3.11 で明示的に許容されているため対応不要。

## 一次資料の引用

### draft-ietf-moq-transport-17 §9.3.11 (NEW GROUP REQUEST Parameter)

> The NEW_GROUP_REQUEST parameter (Parameter Type 0x32) is a varint.
> It MAY appear in PUBLISH_OK, SUBSCRIBE or REQUEST_UPDATE for a
> subscription. It represents the largest Group ID in the Track known
> by the subscriber, plus 1. A value of 0 indicates that the
> subscriber has no Group information for the Track. A subscriber MUST
> NOT send this parameter in PUBLISH_OK or REQUEST_UPDATE if the Track
> did not include the DYNAMIC_GROUPS Property with value 1. A
> subscriber MAY include this parameter in SUBSCRIBE without
> foreknowledge of support. If the original publisher does not support
> dynamic Groups, it ignores the parameter in that case.

ポイント:

- MUST NOT 対象は `PUBLISH_OK` と `REQUEST_UPDATE` のみ
- `SUBSCRIBE` での送信は MAY (foreknowledge 不要、サポート外なら publisher が無視)
- value の意味は「largest Group ID + 1」または「0 (情報なし)」。本 issue では現状の `value=1` (= largest Group ID 0 を観測したという意味) をそのまま維持する。value の意味論を変更する作業はスコープ外

### draft-ietf-moq-transport-17 §11.5 (DYNAMIC GROUPS)

> DYNAMIC_GROUPS (Property Type 0x30) is a Track Property. The allowed
> values are 0 or 1. When the value is 1, it indicates that the
> subscriber can request the Original Publisher to start a new Group by
> including the NEW_GROUP_REQUEST parameter in PUBLISH_OK or
> REQUEST_UPDATE for this Track. If an endpoint receives a value
> larger than 1, it MUST close the session with PROTOCOL_VIOLATION.
>
> If omitted, the value is 0.

ポイント:

- DYNAMIC_GROUPS は Track Property (Property Type 0x30、偶数 ID = varint value 形式)
- 省略時のデフォルト値は 0 (= NEW_GROUP_REQUEST 不可)
- 値域は 0/1 のみ。`src/properties.ts:124-128` の `validateTrackPropertyValue` で受信時に PROTOCOL_VIOLATION 検証済みなので、複数値や範囲外を心配する必要はない

### draft-ietf-moq-transport-17 §11.6 (Immutable Properties)

> Unless specified by a particular Property specification, Properties
> MAY appear either in the mutable extension list or inside Immutable
> Properties. When looking for the value of a property, processors
> MUST search both the mutable properties and the contents of Immutable
> Extensions.

ポイント:

- DYNAMIC_GROUPS は mutable 側 / Immutable Properties (Property Type 0x0B) 配下のいずれにも出現しうる
- 検索は両方を MUST で行う必要がある

## 現状の実装

### moqt-js 側 (`src/createMediaSubscriber.ts:218-242`)

```ts
async requestKeyframe(): Promise<void> {
  if (this.currentState !== "active") {
    return;
  }

  // SUBSCRIBE_UPDATE で NEW_GROUP_REQUEST を送信
  if (this.videoSubscriber && this.videoSubscriber.state === "active") {
    await this.videoSubscriber.update({
      parameters: [
        {
          // draft-ietf-moq-transport-17 Section 9.3.11
          // NEW_GROUP_REQUEST = 0x32
          type: 0x32,
          value: new Uint8Array([0x01]),
        },
      ],
    });
    ...
  }
}
```

DYNAMIC_GROUPS の確認なしで REQUEST_UPDATE を送る → §9.3.11 違反。コメント中の `SUBSCRIBE_UPDATE` という用語は draft-17 では `REQUEST_UPDATE` に改名されているため本 issue でついでに修正する。

### devtools 側 (`devtools/src/hooks/useSubscriber.ts:659-682`)

```ts
const requestKeyframe = async (): Promise<void> => {
  ...
  try {
    await subscriberInstance.update({
      parameters: [
        {
          type: 0x32,
          value: new Uint8Array([0x01]),
        },
      ],
    });
  } catch (error) {
    console.error(`[${subscriberId}] requestKeyframe: failed`, error);
  }
};
```

同様の問題。

### SUBSCRIBE 経路 (devtools `useSubscriber.ts:408-411`) は修正対象外

`subscribeOptions.newGroupRequest = 0n` は §9.3.11 で明示的に許可されているため触らない。当該箇所のコメントに「§9.3.11 により SUBSCRIBE では MAY (foreknowledge 不要)」と明記する。

## DYNAMIC_GROUPS の取得経路

DYNAMIC_GROUPS は MSF Catalog のフィールドではなく、**MOQT Track Property** として SUBSCRIBE_OK で運ばれる。

- `TrackPropertyId.DYNAMIC_GROUPS = 0x30n` (`src/properties.ts:83`)
- `MOQTPropertyId.IMMUTABLE_PROPERTIES = 0x0bn` (`src/properties.ts:26`)
- `Subscriber.trackProperties: ReadonlyArray<Property>` (`src/subscriber.ts`) が SUBSCRIBE_OK の Track Properties を露出
- `decodeProperties` (`src/properties.ts:567-596`) は **フラットにデコード** する。Immutable Properties エントリは odd ID 0x0Bn として `{ id: 0x0Bn, data: ... }` の単一エントリとして格納される。内部は `decodeImmutableProperties` (`src/properties.ts:386`) で展開する必要がある

`Property` 型 (`src/properties.ts`):

```ts
export interface Property {
  id: bigint;
  value?: bigint; // 偶数 ID は varint value (DYNAMIC_GROUPS はここ)
  data?: Uint8Array; // 奇数 ID は length + bytes (Immutable Properties はここ)
}
```

moqt-js 側 API 追加は不要 (`subscriberInstance.trackProperties` で取得可能)。新規 export は `supportsDynamicGroups` ヘルパ関数のみ。

## 修正方針

### 1. `supportsDynamicGroups` 純関数を `src/properties.ts` に追加

```ts
import { decodeImmutableProperties } from "./properties";

/**
 * Track Properties に DYNAMIC_GROUPS=1 が含まれているかを判定する。
 *
 * draft-ietf-moq-transport-17 §11.6: "When looking for the value of a property,
 * processors MUST search both the mutable properties and the contents of Immutable
 * Extensions."
 *
 * mutable list と Immutable Properties (Type 0x0B) 配下の両方を検索する。
 * DYNAMIC_GROUPS の値域は §11.5 により 0 / 1 のみで、受信時に validateTrackPropertyValue
 * が PROTOCOL_VIOLATION 検証済みのため、複数値や範囲外は考慮不要。
 *
 * @param properties - Subscriber.trackProperties (decodeProperties の出力)
 */
export function supportsDynamicGroups(properties: ReadonlyArray<Property>): boolean {
  for (const property of properties) {
    if (property.id === TrackPropertyId.DYNAMIC_GROUPS && property.value === 1n) {
      return true;
    }
    if (property.id === MOQTPropertyId.IMMUTABLE_PROPERTIES && property.data) {
      const immutable = decodeImmutableProperties(property.data);
      for (const inner of immutable.extensions) {
        if (inner.id === TrackPropertyId.DYNAMIC_GROUPS && inner.value === 1n) {
          return true;
        }
      }
    }
  }
  return false;
}
```

`src/index.ts` から export する。

### 2. moqt-js 側 (`src/createMediaSubscriber.ts:requestKeyframe`)

DYNAMIC_GROUPS=1 でない場合は **throw** する (silent 化すると原因不明のキーフレーム不到来を生むため)。現行の「videoSubscriber 不在/非 active で no-op return」というセマンティクスは維持する (state 系は silent return、Property 系は throw、と原則を統一)。

```ts
import { supportsDynamicGroups } from "./properties";

async requestKeyframe(): Promise<void> {
  if (this.currentState !== "active") {
    return;
  }
  if (!this.videoSubscriber || this.videoSubscriber.state !== "active") {
    return;
  }
  // draft-ietf-moq-transport-17 §9.3.11:
  // "A subscriber MUST NOT send this parameter in PUBLISH_OK or
  //  REQUEST_UPDATE if the Track did not include the DYNAMIC_GROUPS
  //  Property with value 1."
  if (!supportsDynamicGroups(this.videoSubscriber.trackProperties)) {
    throw new Error(
      "cannot request keyframe: track did not include DYNAMIC_GROUPS property with value 1",
    );
  }
  // REQUEST_UPDATE を送信 (draft-17 における REQUEST_UPDATE。古いコメントの SUBSCRIBE_UPDATE は誤記)
  await this.videoSubscriber.update({
    parameters: [
      { type: 0x32, value: new Uint8Array([0x01]) },
    ],
  });
  this.videoDecoder?.resetKeyframeWait();
}
```

### 3. devtools 側 (`devtools/src/hooks/useSubscriber.ts:requestKeyframe`)

devtools は UI 経由で呼ばれる前提で、UI ボタンを disable することで違反送信は起きない設計とする。万一ボタン状態が古い場合の保険として、関数冒頭でガードし `console.warn` (現行スタイル維持) で警告して早期 return する。`addLog` への置き換えは本 issue のスコープ外。

```ts
import { supportsDynamicGroups } from "moqt-js";

const requestKeyframe = async (): Promise<void> => {
  const instance = sub.getSubscriber(subscriberId);
  const subscriberInstance = instance?.subscriber.value;
  if (!subscriberInstance || subscriberInstance.state !== "active") {
    console.warn(`[${subscriberId}] requestKeyframe: subscriber not active`);
    return;
  }
  if (!supportsDynamicGroups(subscriberInstance.trackProperties)) {
    console.warn(
      `[${subscriberId}] requestKeyframe: track did not include DYNAMIC_GROUPS=1, skipped`,
    );
    return;
  }
  try {
    await subscriberInstance.update({
      parameters: [{ type: 0x32, value: new Uint8Array([0x01]) }],
    });
  } catch (error) {
    console.error(`[${subscriberId}] requestKeyframe: failed`, error);
  }
};
```

### 4. devtools UI ボタンの disable 連動

`SubscriberInstance` (`devtools/src/signals/subscriber.ts`) に `dynamicGroupsSupported: Signal<boolean>` を追加する (命名は publisher 由来であることを示すため `supports` ではなく `Supported` で末尾形容詞)。`Subscriber.trackProperties` は SUBSCRIBE_OK 受信時に 1 回確定するが Signal ではないため、computed では reactive 追跡できない。

代わりに `startSubscribing` 内の `session.subscribe(...)` 解決後 (= SUBSCRIBE_OK 受信後) に `instance.dynamicGroupsSupported.value = supportsDynamicGroups(subscriberInstance.trackProperties);` を 1 回書き込む。

`SubscriberPanel.tsx` の Keyframe 要求ボタンは `disabled={!instance.dynamicGroupsSupported.value || ...既存条件}` で連動させる。

### 5. SUBSCRIBE 経路の更新内容

`devtools/src/hooks/useSubscriber.ts:408-411` のコメントに「§9.3.11 により SUBSCRIBE では MAY (foreknowledge 不要)」と追記するのみ。挙動は変更しない。

## 影響範囲

- `src/properties.ts`: `supportsDynamicGroups` 関数の追加
- `src/index.ts`: `supportsDynamicGroups` の export 追加
- `src/createMediaSubscriber.ts:requestKeyframe`: DYNAMIC_GROUPS ガード追加、`SUBSCRIBE_UPDATE` コメント修正
- `devtools/src/hooks/useSubscriber.ts:requestKeyframe`: DYNAMIC_GROUPS ガード追加、SUBSCRIBE 経路コメント追記
- `devtools/src/signals/subscriber.ts`: `dynamicGroupsSupported: Signal<boolean>` 追加
- `devtools/src/components/SubscriberPanel.tsx`: Keyframe 要求ボタンの `disabled` に `!dynamicGroupsSupported.value` を加算

## テスト戦略

CLAUDE.md の方針 (Vitest Chai API / モック禁止) に従い、純関数 `supportsDynamicGroups` の単体テストで仕様準拠を担保する。`requestKeyframe` 本体は MOQT サーバが必要で書けないため自動テスト対象外、手動確認でカバーする。

### 単体テスト (`src/properties.test.ts` の拡張)

- DYNAMIC_GROUPS=1 が mutable 側に含まれる配列で `true`
- DYNAMIC_GROUPS=0 が mutable 側に含まれる配列で `false`
- DYNAMIC_GROUPS が存在しない配列で `false`
- DYNAMIC_GROUPS=1 が Immutable Properties (id=0x0Bn) の data 内にエンコードされた配列で `true` (`encodeImmutableProperties` を使ってエンコードしたバイト列を `decodeProperties` でデコードした結果を渡す)
- DYNAMIC_GROUPS=0 が Immutable Properties 内にエンコードされた配列で `false`
- mutable 側 DYNAMIC_GROUPS=0、Immutable 側 DYNAMIC_GROUPS=1 が混在した場合に `true` (どちらかが 1 なら true)

### 手動確認

- moqt-js: テスト用 MOQT サーバが DYNAMIC_GROUPS=1 を返す Track で `requestKeyframe()` 呼び出し → REQUEST_UPDATE 送出を WebTransport の trace で確認
- moqt-js: DYNAMIC_GROUPS が無い Track で `requestKeyframe()` 呼び出し → throw されること
- devtools: DYNAMIC_GROUPS=1 の Track 接続時に Keyframe ボタンが有効、非対応 Track では無効になること
- `vp run test` で全テストパス
- `vp run build` / `vp run build:devtools` でビルド成功

## CHANGES.md 記載方針

`## develop` 直下 `[FIX]` セクション (UPDATE → ADD → CHANGE → FIX 順):

```
- [FIX] `createMediaSubscriber.requestKeyframe` と devtools の `useSubscriber.requestKeyframe` で Track Properties に DYNAMIC_GROUPS=1 が含まれていない場合に REQUEST_UPDATE の NEW_GROUP_REQUEST 送信を抑止する (#0168)
  - draft-ietf-moq-transport-17 §9.3.11 の MUST NOT 準拠
  - @voluntas
```

## ブランチ命名

`feature/fix-` を使う。

## 完了条件

- `src/properties.ts` に `supportsDynamicGroups(properties: ReadonlyArray<Property>): boolean` が追加され、`src/index.ts` から export されている
- `supportsDynamicGroups` は mutable list と Immutable Properties (id=0x0Bn) の両方を検索する
- `src/createMediaSubscriber.ts:requestKeyframe` が DYNAMIC_GROUPS=1 の Track でのみ REQUEST_UPDATE/NEW_GROUP_REQUEST を送出する。違反時は Error を throw する
- `devtools/src/hooks/useSubscriber.ts:requestKeyframe` が DYNAMIC_GROUPS=1 の Track でのみ REQUEST_UPDATE/NEW_GROUP_REQUEST を送出する。違反時は `console.warn` で警告し早期 return する
- devtools UI で DYNAMIC_GROUPS が 1 でない場合に Keyframe 要求ボタンが disabled になる
- `SubscriberInstance` に `dynamicGroupsSupported: Signal<boolean>` が追加され、`startSubscribing` で SUBSCRIBE_OK 後に書き込まれる
- SUBSCRIBE 経路 (`subscribeOptions.newGroupRequest`) は変更しない (§9.3.11 で MAY のため、コメント追記のみ)
- 該当コードコメントに `draft-ietf-moq-transport-17 §9.3.11` の MUST NOT 文を英語のまま引用する
- `createMediaSubscriber.ts` 内の `SUBSCRIBE_UPDATE` コメントが `REQUEST_UPDATE` に修正されている
- `supportsDynamicGroups` の単体テスト (上記 6 件) が追加されパスする
- `vp run build` / `vp run build:devtools` / `vp run test` が成功する
- CHANGES.md に `[FIX]` エントリを追記する
