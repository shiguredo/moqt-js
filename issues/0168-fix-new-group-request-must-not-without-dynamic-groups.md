# REQUEST_UPDATE で NEW_GROUP_REQUEST を送る前に DYNAMIC_GROUPS Property を確認する

Created: 2026-05-11
Model: Opus 4.7

## 概要

devtools の `useSubscriber.ts:requestKeyframe` と `src/createMediaSubscriber.ts:requestKeyframe` は、Subscriber の `update()` (REQUEST_UPDATE 送信) に NEW_GROUP_REQUEST Parameter (Type 0x32) を無条件で付与している。これは `draft-ietf-moq-transport-17 §9.3.11` の MUST NOT に違反する可能性がある:

> A subscriber MUST NOT send this parameter in PUBLISH_OK or REQUEST_UPDATE if the Track did not include the DYNAMIC_GROUPS Property with value 1.

SUBSCRIBE_OK の Track Properties に DYNAMIC_GROUPS=1 が含まれていない Track に対して REQUEST_UPDATE で NEW_GROUP_REQUEST を送ると、仕様違反となる。

なお、SUBSCRIBE 送信時の NEW_GROUP_REQUEST (devtools `subscribeOptions.newGroupRequest = 0n`) は同じ §9.3.11 で明示的に許容されているため対応不要。

## 一次資料の引用

### draft-ietf-moq-transport-17 §9.3.11 (NEW GROUP REQUEST Parameter)

> The NEW_GROUP_REQUEST parameter (Parameter Type 0x32) is a varint.
> It MAY appear in PUBLISH_OK, SUBSCRIBE or REQUEST_UPDATE for a
> subscription.  It represents the largest Group ID in the Track known
> by the subscriber, plus 1.  A value of 0 indicates that the
> subscriber has no Group information for the Track.  A subscriber MUST
> NOT send this parameter in PUBLISH_OK or REQUEST_UPDATE if the Track
> did not include the DYNAMIC_GROUPS Property with value 1.  A
> subscriber MAY include this parameter in SUBSCRIBE without
> foreknowledge of support.  If the original publisher does not support
> dynamic Groups, it ignores the parameter in that case.

ポイント:

- MUST NOT 対象は `PUBLISH_OK` と `REQUEST_UPDATE` のみ
- `SUBSCRIBE` での送信は MAY (foreknowledge 不要、サポート外なら publisher が無視)

### draft-ietf-moq-transport-17 §11.5 (DYNAMIC GROUPS)

> DYNAMIC_GROUPS (Property Type 0x30) is a Track Property.  The allowed
> values are 0 or 1.  When the value is 1, it indicates that the
> subscriber can request the Original Publisher to start a new Group by
> including the NEW_GROUP_REQUEST parameter in PUBLISH_OK or
> REQUEST_UPDATE for this Track.  If an endpoint receives a value
> larger than 1, it MUST close the session with PROTOCOL_VIOLATION.
>
> If omitted, the value is 0.

ポイント:

- DYNAMIC_GROUPS は Track Property (Property Type 0x30)
- 省略時のデフォルト値は 0 (= NEW_GROUP_REQUEST 不可)

### draft-ietf-moq-transport-17 §11.6 (Immutable Properties, 抜粋)

> Unless specified by a particular Property specification, Properties
> MAY appear either in the mutable extension list or inside Immutable
> Properties.  When looking for the value of a property, processors
> MUST search both the mutable properties and the contents of Immutable
> Extensions.

ポイント: DYNAMIC_GROUPS の検索時は mutable と Immutable Properties (Type 0xB) の両方を見る必要がある。

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

DYNAMIC_GROUPS の確認なしで REQUEST_UPDATE を送る → §9.3.11 違反。

### devtools 側 (`devtools/src/hooks/useSubscriber.ts:659-682`)

```ts
const requestKeyframe = async (): Promise<void> => {
  ...
  try {
    // NEW_GROUP_REQUEST パラメータを含む REQUEST_UPDATE を送信
    // draft-ietf-moq-transport-17 §9.3.11
    // NEW_GROUP_REQUEST = 0x32
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

### SUBSCRIBE 経路 (devtools `useSubscriber.ts:408-411`)

```ts
// NEW_GROUP_REQUEST: 0 = グループ情報なし、新規開始を要求
if (newGroupRequestEnabled) {
  subscribeOptions.newGroupRequest = 0n;
}
```

これは SUBSCRIBE 送信なので §9.3.11 の MUST NOT 対象外。**修正不要**。

## DYNAMIC_GROUPS の取得経路

DYNAMIC_GROUPS は MSF Catalog のフィールドではなく、**MOQT Track Property** として SUBSCRIBE_OK で運ばれる。`src/properties.ts:83` で `TrackPropertyId.DYNAMIC_GROUPS = 0x30n` が定義済み。

moqt-js 側では既に `Subscriber.trackProperties` が SUBSCRIBE_OK の Track Properties を露出している (`src/subscriber.ts:54-60, 117-119`):

```ts
/**
 * SUBSCRIBE_OK で受信した Track Properties
 * draft-ietf-moq-transport-17 Section 9.9 (SUBSCRIBE_OK):
 * DELIVERY_TIMEOUT, MAX_CACHE_DURATION, DEFAULT_PUBLISHER_PRIORITY,
 * DEFAULT_PUBLISHER_GROUP_ORDER, DYNAMIC_GROUPS 等。
 */
readonly trackProperties: ReadonlyArray<Property>;
```

`Property` 型は `src/properties.ts:161-165`:

```ts
export interface Property {
  id: bigint;
  value?: bigint;
  data?: Uint8Array;
}
```

DYNAMIC_GROUPS (Property Type 0x30) は偶数 ID = varint value 形式なので `value` フィールドに格納される (`data` ではない)。

すなわち、**moqt-js 側 API 追加は不要**。`subscriberInstance.trackProperties` から `id === TrackPropertyId.DYNAMIC_GROUPS` のエントリを検索し、`value === 1n` を確認するだけでよい。

`TrackPropertyId` は `src/index.ts:108` から既に export 済み。

## 修正方針

### 1. moqt-js 側 (`src/createMediaSubscriber.ts:requestKeyframe`)

`videoSubscriber.trackProperties` から DYNAMIC_GROUPS Property を検索し、値が `1n` でない場合は早期 return する (またはエラーを throw する)。

実装案:

```ts
import { TrackPropertyId } from "./properties";

function supportsDynamicGroups(subscriber: Subscriber): boolean {
  const property = subscriber.trackProperties.find(
    (p) => p.id === TrackPropertyId.DYNAMIC_GROUPS,
  );
  return property?.value === 1n;
}

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
  if (!supportsDynamicGroups(this.videoSubscriber)) {
    throw new Error(
      "cannot request keyframe: track did not include DYNAMIC_GROUPS property with value 1",
    );
  }

  await this.videoSubscriber.update({
    parameters: [
      { type: 0x32, value: new Uint8Array([0x01]) },
    ],
  });
  this.videoDecoder?.resetKeyframeWait();
}
```

挙動の選択 (要決定): 違反時に「早期 return」か「throw」か。本 issue では一切妥協しない方針として **throw** を採用する。理由: silent な no-op は呼び出し側で原因不明のキーフレーム不到来を生む。

### 2. devtools 側 (`devtools/src/hooks/useSubscriber.ts:requestKeyframe`)

同じガードを実装し、違反時は `addLog("warn", ...)` で警告して早期 return する (devtools の他 `requestKeyframe` 経路は throw を上に伝播させていないため、UI 上の警告に統一する)。

加えて、`SubscriberPanel.tsx` の Keyframe 要求ボタンを DYNAMIC_GROUPS が 1 でない場合は disable する。

`SubscriberInstance` (`devtools/src/signals/subscriber.ts`) に `supportsDynamicGroups: Signal<boolean>` を追加する。`Subscriber.trackProperties` は SUBSCRIBE_OK 受信時に確定し、その後は変化しないため、`startSubscribing` 内で `session.subscribe()` の解決後 (= SUBSCRIBE_OK 受信後) に値を一度書き込めばよい。Catalog から `videoTrack.name` で得た主 SUBSCRIBE の `subscriberInstance.trackProperties` のみを見る (Catalog 自体の SUBSCRIBE_OK の Track Properties ではない点に注意)。

`subscriberInstance.subscriber` が Signal なので、`SubscriberInstance.subscriber.value?.trackProperties` を読む computed signal でも代替可能。実装側で simpler な方を選ぶ。

### 3. SUBSCRIBE 経路は触らない

`subscribeOptions.newGroupRequest = 0n` は §9.3.11 で明示的に許可されているため、現状のままで仕様準拠。コメントに「SUBSCRIBE では §9.3.11 により MAY (foreknowledge 不要)」と明記する。

## 影響範囲

- `src/createMediaSubscriber.ts:requestKeyframe` (バグ修正本体)
- `src/properties.ts` または `src/subscriber.ts` に `supportsDynamicGroups(properties)` 純関数を追加し index.ts から export
- `devtools/src/hooks/useSubscriber.ts:requestKeyframe` (バグ修正本体)
- `devtools/src/signals/subscriber.ts` (`supportsDynamicGroups` computed signal を追加)
- `devtools/src/components/SubscriberPanel.tsx` (Keyframe 要求ボタンの disabled 制御)

`Subscriber` インターフェース自体の変更はなし (`Subscriber.trackProperties` は既存)。新規 export は `supportsDynamicGroups` ヘルパ関数のみ。

## テスト戦略

CLAUDE.md の方針 (Vitest Chai API / it/describe/expect 禁止 / モック禁止) に従う。

### 1. moqt-js 側

`supportsDynamicGroups(properties: ReadonlyArray<Property>): boolean` を `src/properties.ts` (または `src/subscriber.ts`) に export し、純関数として単体テスト可能にする。シグネチャは `Subscriber` インスタンスではなく `trackProperties` 配列を直接受け取る形にして、テスト時にモック相当の Subscriber オブジェクトを作る必要を排除する。

呼び出し側 (`createMediaSubscriber.requestKeyframe`) では:

```ts
if (!supportsDynamicGroups(this.videoSubscriber.trackProperties)) {
  throw new Error("...");
}
```

テスト (`src/properties.test.ts` または新規 `src/dynamicGroups.test.ts`):

- DYNAMIC_GROUPS=1 を含む配列で `true`
- DYNAMIC_GROUPS=0 を含む配列で `false`
- DYNAMIC_GROUPS が存在しない配列で `false`
- DYNAMIC_GROUPS が複数含まれる場合の挙動を明示 (最後の値を採用するか、最初の値を採用するかを決め、テストで固定する。仕様上は §11.5 で「If omitted, the value is 0」のみ規定。本実装では最初に見つけた値を採用する方針を提案)
- Immutable Properties (Property Type 0xB) 経由でネストされた DYNAMIC_GROUPS をどう扱うか: §11.6 で「Properties MAY appear either in the mutable extension list or inside Immutable Properties. When looking for the value of a property, processors MUST search both the mutable properties and the contents of Immutable Extensions.」 → **両方を検索する必要がある**。`Subscriber.trackProperties` が Immutable Properties をどう保持しているかを `src/session.ts` の SUBSCRIBE_OK 処理で確認のうえ、`supportsDynamicGroups` は mutable と immutable の両方を検索する実装にする。

### 2. devtools 側 (`devtools/src/hooks/useSubscriber.test.ts`)

- `supportsDynamicGroups` computed signal が `subscriberInstance.trackProperties` の DYNAMIC_GROUPS=1 で `true` になること
- DYNAMIC_GROUPS が無い / 0 の場合は `false` になり、`requestKeyframe` 呼び出しが REQUEST_UPDATE を送出しないこと (送出有無は addLog の引数で確認する)

## CHANGES.md 記載方針

`## develop` 直下に以下を追記する (UPDATE → ADD → CHANGE → FIX の順を守り、`[FIX]` セクションへ):

```
- [FIX] `createMediaSubscriber.requestKeyframe` と devtools の `useSubscriber.requestKeyframe` で、Track Properties に DYNAMIC_GROUPS=1 が含まれていない場合に REQUEST_UPDATE の NEW_GROUP_REQUEST 送信を抑止するという修正をする
  - draft-ietf-moq-transport-17 §9.3.11 の MUST NOT 準拠
  - @voluntas
```

## 完了条件

- `src/createMediaSubscriber.ts:requestKeyframe` が DYNAMIC_GROUPS=1 の Track でのみ REQUEST_UPDATE/NEW_GROUP_REQUEST を送出する
- `devtools/src/hooks/useSubscriber.ts:requestKeyframe` が DYNAMIC_GROUPS=1 の Track でのみ REQUEST_UPDATE/NEW_GROUP_REQUEST を送出する
- devtools UI で DYNAMIC_GROUPS が 1 でない場合に Keyframe 要求ボタンが disabled になる
- SUBSCRIBE 経路 (`subscribeOptions.newGroupRequest`) には変更を加えない (§9.3.11 で MAY のため)
- 該当コードコメントに `draft-ietf-moq-transport-17 §9.3.11` の MUST NOT 文を英語のまま引用する
- `vp run build` と `vp run build:devtools` が成功する
- 追加した単体テスト含め全テストが通過する
- CHANGES.md に `[FIX]` エントリを追記する
