# `addSubscriber` で短縮 ID の衝突を検出してリトライする

Created: 2026-05-11
Model: Opus 4.7

## 概要

`devtools/src/signals/subscriber.ts:122-129` の `addSubscriber` は
`subscriber-${crypto.randomUUID().slice(0, 8)}` で 8 桁 16 進 (32 bit 空間)
の短縮 ID を生成しているが、生成した ID が `subscriberInstances` Map に既に
存在するかを確認していない。万一同じ ID が生成された場合、

```typescript
const newMap = new Map(subscriberInstances.value);
newMap.set(id, instance);
subscriberInstances.value = newMap;
```

によって既存エントリが新しい `SubscriberInstance` で **上書きされる** ため、
旧 instance が保持していた `session` / `decoder` / 各種 signal が
`subscriberInstances` 経由では到達不能になる。本 issue では衝突検出ロジックを
依存注入可能な純粋関数として抽出し、`addSubscriber` から利用する形に変更する。

## 根拠

### 衝突確率の評価

- 32 bit 空間 (`16 ** 8` ≈ 4.29 × 10^9)
- 誕生日問題で 50% 衝突に必要な個数: √(2N ln 2) ≈ 77,163 個
- 現実的な devtools セッションでの subscriber 個数は数個から数百個オーダーで、
  100 個生成時の衝突確率は約 1.16 × 10^-6
- 平常運用での衝突は実質ゼロだが、HMR + 自動再生成のループや、テスト・
  開発時の連続生成シナリオでは、確率が低くても発生時に静かに上書きされる
  挙動は致命的 (Remove ボタンや close 経路を経由しない instance 入れ替えに
  なるため、リソース解放の責務が宙に浮く)

### 上書き発生時の影響

`subscriberInstances` の `set(existingId, newInstance)` は **同期的に** 旧
instance への `subscriberInstances.value` 経由の参照を断つ。本リポジトリの
旧 instance の所有関係は以下のとおり:

- `WebTransport` セッション (`instance.session.value`)
- `DecoderWrapper` (`instance.decoder.value`)
- 各種 signal (`subscriber.value`, `catalog.value`, `decoder.value` 等)

これらは `removeSubscriber` および `useSubscriber.ts:cleanupSubscriber` 経由で
明示的に `close()` を呼ばないと解放されない (#0144 / #0162 で `removeSubscriber`
に close を集約予定)。上書きで参照が消えると `close()` 呼び出し経路自体が
失われ、WebTransport 接続と VideoDecoder ハードウェアリソースがリークする。
これは Signal の GC 可否を超えた、再利用不能リソースの永久リークである。

### 短縮 ID 採用の経緯 (0141)

`devtools/src/signals/subscriber.ts:123` で `crypto.randomUUID().slice(0, 8)` を
採用したのは issue #0141 (HMR 時のカウンタ問題回避と UI 表示用 8 文字短縮)。
本 issue は #0141 を撤回するものではなく、「短縮形式を保ったまま、衝突時に
リトライする」ことで両立する。UUID v4 の先頭 8 文字は `xxxxxxxx-...` 部分の
完全ランダム領域 (version nibble は 3 番目のグループ先頭にあり、先頭 8 文字には
影響しない) のため、32 bit エントロピーは保たれる。

### #0165 との整合性

issue #0165 (`SubscriberPanel` 局所購読化) は `getSubscriberInstanceSignal(id)`
キャッシュを `removeSubscriber` で破棄する設計で、「削除済み ID が再生成
されないこと」を前提にしている。本 issue で導入する衝突検出は **現存する Map
内の ID** との重複のみ防ぐ。`removeSubscriber` で削除された後の ID が後続
`addSubscriber` で再選される可能性はゼロにはできないが、

- 削除済み ID と将来の新 ID が一致する確率は新規衝突と同じ 32 bit 確率
- #0165 のキャッシュは `removeSubscriber` 時点で破棄されるため、同 ID が
  再選されても新規 `computed` が作られる (`getSubscriberInstanceSignal` は
  キャッシュ無ければ作成する設計)

であり、#0165 の動作上の問題にはならない。両 issue は **独立に成立** する。
本 issue 完了後、#0165 着手時に同 ID 再選の可能性に関する一文を念のため
#0165 のキャッシュ管理コメントに追記する余地がある (本 issue の作業外)。

## 修正方針

### 1. 純粋関数 `generateUniqueSubscriberId` を抽出する

`signals/subscriber.ts` モジュールスコープに以下を追加する。

```typescript
/**
 * 衝突しない subscriber ID を生成する純粋関数。
 *
 * `generator` で短縮 ID 候補を生成し、`existingIds` と衝突したら再試行する。
 * `crypto.randomUUID` をスタブしない方針 (CLAUDE.md) のため、テストでは
 * `generator` に決定論的な関数を渡して衝突検出ロジックを検証する。
 *
 * @param existingIds 既存 ID の集合
 * @param generator 短縮 ID 候補を返す関数 (prefix 付きの完成 ID を返す)
 * @returns existingIds に含まれない新規 ID
 */
export function generateUniqueSubscriberId(
  existingIds: ReadonlySet<string>,
  generator: () => string,
): string {
  let candidate = generator();
  while (existingIds.has(candidate)) {
    candidate = generator();
  }
  return candidate;
}

/**
 * 本番用の短縮 ID 生成関数 (UUID v4 の先頭 8 文字)。
 */
function defaultSubscriberIdGenerator(): string {
  return `subscriber-${crypto.randomUUID().slice(0, 8)}`;
}
```

設計上のポイント:

- `existingIds: ReadonlySet<string>` を引数に取る。`Map<string, unknown>` の
  ような型でも `has` は使えるが、`Set<string>` に限定することで「ID の集合」
  という意味が型に乗り、テスト時に Map を組み立てる手間も省ける。`new
  Set(map.keys())` の構築コストは subscriber 個数 (devtools 上は数十まで) の
  オーダーで無視できる
- `generator` は prefix 込みの完成 ID を返す。prefix を関数の外で結合する設計
  にすると、テスト時にも prefix を意識する必要が生じるため生成側に責務を集約する
- ループ上限は設けない。32 bit 空間で `subscriberInstances.size` が全埋め
  される事態は現実的に発生せず、上限を入れると fail 経路の設計判断が増える
  (Premature Optimization is the root of all evil)

### 2. `addSubscriber` を `generateUniqueSubscriberId` 利用に書き換える

現状 (122-129 行):

```typescript
export function addSubscriber(): string {
  const id = `subscriber-${crypto.randomUUID().slice(0, 8)}`;
  const instance = createSubscriberInstance(id);
  const newMap = new Map(subscriberInstances.value);
  newMap.set(id, instance);
  subscriberInstances.value = newMap;
  return id;
}
```

を以下に変更する。

```typescript
export function addSubscriber(): string {
  const existingIds = new Set(subscriberInstances.value.keys());
  const id = generateUniqueSubscriberId(existingIds, defaultSubscriberIdGenerator);
  const instance = createSubscriberInstance(id);
  const newMap = new Map(subscriberInstances.value);
  newMap.set(id, instance);
  subscriberInstances.value = newMap;
  return id;
}
```

`new Set(subscriberInstances.value.keys())` のコストは `subscriberInstances`
のサイズに比例するが、devtools で subscriber 個数は数十オーダー、`addSubscriber`
呼び出しは UI 操作頻度 (人手操作 + HMR) のため許容範囲。

### 3. 代替案として検討して採用しない案

- 案 A: UUID v4 全長 (36 文字) をそのまま使う
  - 採用しない理由: #0141 で意図的に 8 文字短縮を採用しており、`DebugPanel`
    のコピーボタンラベル等の UI 表示性を優先している。32 bit 衝突対策のために
    UI 表示性を犠牲にする必要はない (衝突検出ループで両立できる)
- 案 B: `addSubscriber` 内に do-while を直書きする
  - 採用しない理由: `crypto.randomUUID` をスタブできないため、衝突検出
    ロジックを直書きすると単体テストでカバーできない。純粋関数として抽出し
    `generator` を依存注入するのが唯一の現実的なテスト戦略

## 影響範囲

- `devtools/src/signals/subscriber.ts`
  - `generateUniqueSubscriberId` を新規 export
  - `defaultSubscriberIdGenerator` をモジュールスコープに追加 (非 export)
  - `addSubscriber` の本体を 2 行差し替え
- `devtools/src/signals/subscriber.test.ts`
  - `generateUniqueSubscriberId` の単体テストを追加
  - 既存テストには影響なし

`SubscriberPanel.tsx` / `App.tsx` / `useSubscriber.ts` は ID を不透明な文字列
として扱うため変更不要。

## テスト戦略

### CLAUDE.md「モック・スタブ禁止」に対する対応

`crypto.randomUUID` を直接スタブできないため、衝突検出ロジックを純粋関数
`generateUniqueSubscriberId(existingIds, generator)` として抽出し、テストでは
`generator` に **決定論的な配列イテレータ** を渡す。これは `crypto.randomUUID`
の置き換えではなく、関数の引数を渡しているだけのため、モック・スタブ禁止
規約に抵触しない。

### 追加するテスト (`devtools/src/signals/subscriber.test.ts`)

`generator` に配列 + `shift` のクロージャを渡し、決定論的に検証する。
`shift` が `undefined` を返した場合はテストの想定不一致なので、明示的に
例外を投げてテストを失敗させる (chai の `assert.ok` は型ガードを返さない
ため、`if (next === undefined) throw new Error(...)` で TypeScript の戻り値
型 `string` を満たす)。

1. `existingIds` が空のとき、最初の候補をそのまま返す
2. 最初の候補が `existingIds` に含まれているとき、2 番目の候補を返す
3. 最初と 2 番目が連続衝突するとき、3 番目の候補を返す (リトライが繰り返し
   発生しても破綻しないことを確認)

代表例 (テスト 2 のみ抜粋):

```typescript
test("generateUniqueSubscriberId retries when first candidate collides", () => {
  const candidates = ["subscriber-aaaaaaaa", "subscriber-bbbbbbbb"];
  const result = generateUniqueSubscriberId(
    new Set(["subscriber-aaaaaaaa"]),
    () => {
      const next = candidates.shift();
      if (next === undefined) {
        throw new Error("generator called more than provided");
      }
      return next;
    },
  );
  assert.equal(result, "subscriber-bbbbbbbb");
});
```

テスト 1 / 3 も同じパターンで `existingIds` と `candidates` を入れ替えて記述する。

### 既存テストへの影響

`addSubscriber generates unique ids` (`subscriber.test.ts:52`) は `addSubscriber`
の戻り値の一意性を確認しているのみで、衝突検出ロジックの追加によって挙動は
変わらない。修正不要。

### コマンド

- `vp run test` で全テストがパスすること (新規 3 テスト + 既存 9 テスト)
- `vp run build:devtools` がエラーなく完了すること

## CHANGES.md 記載方針

- `### misc` サブセクションに `[FIX]` で記載する
- エントリ例:

```
- [FIX] devtools の `addSubscriber` で短縮 ID 衝突時にリトライするようにする (#0169)
  - `signals/subscriber.ts` に `generateUniqueSubscriberId` を純粋関数として追加し、`addSubscriber` から利用する
  - 8 桁短縮 ID (32 bit 空間) の衝突発生時に旧 `SubscriberInstance` が上書きされて WebTransport セッションと VideoDecoder がリークする経路を塞ぐ
  - @voluntas
```

develop には #0141 で既に `[CHANGE] addSubscriber の ID をモジュールスコープ・カウンタから crypto.randomUUID().slice(0, 8) ベースに変更する` エントリが存在する。本 issue はその同じ修正対象に対する `[FIX]` であり、別エントリとして追加する。

## 完了条件

- `signals/subscriber.ts` に `generateUniqueSubscriberId` が export されている
- `addSubscriber` が `generateUniqueSubscriberId` を経由して ID を生成し、Map
  内の既存 ID とは絶対に衝突しないことが型 + コードレベルで明確
- 上記 3 件の単体テストが `subscriber.test.ts` に追加されている
- `vp run test` で全テストがパスする
- `vp run build:devtools` が成功する
- CHANGES.md の `## develop` `### misc` に `[FIX]` エントリが追記されている
