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
- 現実的な devtools セッションでの subscriber 個数は数個から数百個オーダーで、100 個生成時の衝突確率は約 1.16 × 10^-6
- 平常運用での衝突は実質ゼロだが、静かに上書きされる挙動が **発生時に致命的** (Remove ボタンや close 経路を経由しない instance 入れ替えになるためリソース解放の責務が宙に浮く)

### Premature Optimization との関係

CLAUDE.md「Premature Optimization is the Root of All Evil」とは異なり、本 issue は性能最適化ではなく **発生確率は極小だが発生時の影響が致命的なバグの防御** である。リーク経路を残したまま将来の HMR / 連続生成パターン変更で衝突確率が上がるよりも、純関数 1 個と数行の置換で恒久的に潰す方が合理的と判断する。

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

- `existingIds: ReadonlySet<string>` を引数に取り、`has(string)` で衝突判定する。`ReadonlyMap<string, unknown>` でも `has` は使えるが、Set の方が型シグネチャから意図 (ID の集合) が読みやすい。生成コスト (`new Set(map.keys())`) は subscriber 個数 (数十) オーダーで無視できる
- `generator` は prefix 込みの完成 ID を返す。prefix 変更時の修正箇所を `defaultSubscriberIdGenerator` 1 箇所に閉じ込め、`generateUniqueSubscriberId` を prefix 非依存に保つ
- ループ上限は設けない。32 bit 空間で `subscriberInstances.size` が全埋めされる事態は現実的に発生せず、production で無限ループする経路は無い。テスト誤用 (`generator` が常に同じ値を返す等) で無限ループが発生した場合は Vitest の `testTimeout` で失敗するため、明示的な上限ガードは追加しない

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
  const result = generateUniqueSubscriberId(new Set(["subscriber-aaaaaaaa"]), () => {
    const next = candidates.shift();
    if (next === undefined) {
      throw new Error("generator called more than provided");
    }
    return next;
  });
  assert.equal(result, "subscriber-bbbbbbbb");
});
```

テスト 1 / 3 も同じパターンで `existingIds` と `candidates` を入れ替えて記述する。

### 既存テストへの影響

既存テストへの影響なし (本 issue は新規テストの追加のみで、既存テストの挙動は維持される)。

### コマンド

- `vp run test` で全テストパス
- `vp run build:devtools` でビルド成功

## CHANGES.md 記載方針

種別選定:

- `[FIX]`: 実際に発生して観測されたバグの修正。本 issue は潜在的欠陥への防御で、観測実例はない。狭義の FIX には該当しない
- `[UPDATE]`: 下位互換のある改善。本 issue は `addSubscriber` の戻り値の公開 API 形状は変えず、内部の衝突回避ロジックを足すだけ。下位互換あり
- `[ADD]`: 下位互換のある追加。本 issue は `generateUniqueSubscriberId` を新規 export するが、主目的はバグ予防であり、新規 API 追加は副作用

選択: **`[FIX]`** を採用する。理由は (1) 0141 で導入された短縮 ID 設計の欠陥 (衝突時の静かな上書き) を塞ぐ修正で、リソースリークの予防対応は実害発生前であっても FIX に分類する運用が CHANGES.md `### misc` で既に確立している (#0147 / #0149 / #0150 / #0152 / #0154 / #0155 / #0156)。(2) `[ADD]` は新規 API export の副次的な事実で、ユーザー (devtools 利用者) にとっての変更の本質は「衝突時にリークしなくなる」点であり FIX 的セマンティクスが優位。

`### misc` サブセクションに `[FIX]` で記載する。

エントリ例:

```
- [FIX] devtools の `addSubscriber` で短縮 ID 衝突時に旧 `SubscriberInstance` が上書きされて WebTransport セッションと VideoDecoder がリークする経路を塞ぐ (#0169)
  - `signals/subscriber.ts` に `generateUniqueSubscriberId` を純粋関数として追加し、`addSubscriber` から利用する
  - @voluntas
```

## 完了条件

- `signals/subscriber.ts` に `generateUniqueSubscriberId` が export されている
- `addSubscriber` が `generateUniqueSubscriberId` を経由して ID を生成し、Map
  内の既存 ID とは絶対に衝突しないことが型 + コードレベルで明確
- 上記 3 件の単体テストが `subscriber.test.ts` に追加されている
- `vp run test` で全テストがパスする
- `vp run build:devtools` が成功する
- CHANGES.md の `## develop` `### misc` に `[FIX]` エントリが追記されている
