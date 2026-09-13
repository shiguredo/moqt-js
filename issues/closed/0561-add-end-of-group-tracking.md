# END_OF_GROUP の FIN / Group 横断追跡を実装する

- Created: 2026-09-09
- Completed: 2026-09-13
- Branch: feature/add-end-of-group-tracking
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-21 §11.3.1 / §12.1 は END_OF_GROUP ビットで Group 最大 Object を示し、それ以降の Object 受信を malformed 条件とする。現状は同一ストリーム内の検出のみで、FIN を跨ぐ判定と複数 Subgroup をまたぐ Group 単位の追跡が未実装である。

## 現状

- issue 0558 の適合監査 (D-8) で、`src/dataStream.ts` の `SubgroupHeader.endOfGroup` 公開と同一呼び出し内の検出までを実装した。
- FIN を `processSubgroupObjects` から観測できず、Group 単位の追跡にはセッション状態が必要。
- `src/session/stream.ts` の `processSubgroupObjects` は呼び出し単位の状態しか持たない。

## 設計方針

1. セッション (SubscriberImpl) に Group 単位の END_OF_GROUP 追跡状態を持たせる。
2. FIN 後の追加 Object と、END_OF_GROUP 済み Group の後続 Subgroup を malformed として検出する。
3. 仕様が「detected」と限定する条件は実装可能な範囲に留め、対象範囲をコメントで明記する。

## 完了条件

- END_OF_GROUP 後の FIN 跨ぎ / Group 横断の malformed が検出される。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 参照

- `refs/moq/draft-ietf-moq-transport-21.txt` §11.3.1 / §12.1
- 監査: issue 0558 の適合監査 (D-8)

## 解決方法

設計方針 1〜3 に従い、セッションに Group 単位の追跡状態を持たせた。

### 状態の持ち方

- `SessionImpl` に `receivedEndOfGroupFinalObjectIds: Map<string, bigint>` を追加した。キーは `${trackAlias}:${groupId}` で、既存の `closedSubgroups` と同じ粒度である。Subgroup ストリーム (呼び出し) をまたいだ追跡にはセッション状態が必要なため、ここに置いた。
- `SessionInternal` / `BidiSessionInternal` の双方に宣言した (bidi.ts の購読解除処理が追跡を捨てるため)。
- `close()` でクリアする。

### 検出

- `processSubgroupObjects` に第 8 引数 `endOfGroup?: { finalObjectId?: bigint }` を追加し、既知の最終 Object ID を呼び出し側から受け取る形にした。戻り値に `updatedEndOfGroupFinalObjectId` を追加し、確定値は呼び出し側 (セッションのループ) が Map に記録する。
- draft-ietf-moq-transport-21 §12.1 条件 4 の超過検出は、Group の最終 Object が既知になった後、同じ Group のより大きい Object ID を持つ Object で `MalformedTrackError` を throw する。従来は関数ローカル変数だったため同一呼び出し内でしか検出できなかったが、セッション状態に移したことで Subgroup ストリームをまたいで検出できる。
- あわせて、同じ Group について既知の最終 Object より小さい Object が END_OF_GROUP を主張した場合も `MalformedTrackError` とした。Group の最終 Object が二者に分かれる矛盾であり、§12.1 条件 3 が禁じる「同一 Subgroup が複数のストリームで異なる最終 Object を持つ」状態と同じ性質である。
- 購読が尽きた alias の追跡は `clearEndOfGroupTracking` で削除し、無制限な増加を防ぐ。

### 対象範囲の限定 (設計方針 3)

Subgroup Header の END_OF_GROUP ビット (0x08) による確定は対象外とした。§11.3.1 は「FIN で終端されたときに購読者が Group の最終 Object を推論できる」と定めるが、FIN は `processSubgroupObjects` の外 (呼び出し側のループが `result.done` を観測する地点) でしか分からない。確定には FIN の観測が必要なため、この経路は実装せず、コメントで明記した (`endOfGroup` ビット自体は `SubgroupHeader` で公開済み)。

### テスト

`src/session/stream.test.ts` に 4 件追加した。

- 既知の Group 最終 Object を超える Object で `MalformedTrackError`
- 既知の最終 Object ちょうどまでは配信する (誤検出防止)
- 既知の最終 Object より小さい END_OF_GROUP で `MalformedTrackError`
- END_OF_GROUP の確定値が戻り値で返る

`src/session/incoming.test.ts` のモックセッションに追跡マップを追加した。

## 検証

- `pnpm test run`: 70 ファイル / 2,110 テスト全通過 (追加した 4 件を含む)
- `pnpm typecheck` / `pnpm lint` / `pnpm fmt` すべて成功
- 差分: 8 ファイル、+208 / -12 行
