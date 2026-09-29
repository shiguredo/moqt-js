# END_OF_GROUP の最終 Object ID 追跡が Group ごとに増え続ける

- Created: 2026-09-21
- Completed: 2026-09-29
- Branch: feature/fix-end-of-group-tracking-growth
- Polished: 2026-09-22

## 目的

`src/session/dataStreamIncoming.ts` は確定した Group の最終 Object ID を `session.receivedEndOfGroupFinalObjectIds` に記録する。この Map のエントリは購読が終わるまで 1 件も破棄されないため、長時間の購読では Group 数に比例して増え続ける。エントリが増えるのは Object Status が END_OF_GROUP の Object を受信した Group ごとに 1 件で、1 Group/秒で配信される Track を 24 時間購読すると約 86,400 件になる。同じ受信追跡である `src/session/priorGapTracking.ts` は上限を持っており、扱いが非対称である。

## 現状

- `src/session/dataStreamIncoming.ts` の `dataStreamHandleSubgroupStream` が `dataStreamProcessSubgroupObjects` の戻り値 `updatedEndOfGroupFinalObjectId` を `${trackAlias}:${groupId}` キーで `session.receivedEndOfGroupFinalObjectIds` に set する
- `src/session/incoming.ts` の `incomingProcessSubgroupObjects` が同じキーで読み出し、draft-ietf-moq-transport-21 §12.1 条件 4 (Group の最終 Object より大きい Object ID の検出) に使う
- 破棄するのは `src/session/bidi.ts` の `clearEndOfGroupTracking` だけで、呼ばれるのは `deleteSubscriber` と `bidiCancelSubscription` の「その Track Alias の購読が 0 件になったとき」に限る。実装は `${trackAlias}:` の前方一致で全走査している。セッション終了時は `src/session/lifecycle.ts` の `sessionClose` が全消しする
- 保持先の型は `Map<string, bigint>` で、`src/session.ts` / `src/session/bidi.ts` / `src/session/lifecycle.ts` / `src/session/dataStreamIncoming.ts` の内部型と、`src/session/incoming.test.ts` / `src/session/incoming.prop.ts` のフィクスチャで構築される。公開 API (`src/index.ts`) には出ない
- `src/session/priorGapTracking.ts` は `MAX_TRACKED_GROUP_IDS` / `MAX_TRACKED_OBJECT_IDS_PER_GROUP` / `MAX_TRACKED_GAP_RANGES` / `MAX_TRACKED_TRACKS` (いずれも 1024) を持ち、Map の挿入順で最古から破棄する。ただしキーは `FullTrackNameKey` で、破棄の寿命も購読 / FETCH が尽きるまでであり、Track Alias 単位で破棄する本追跡とは一致しない

## 設計方針

- 方式は「Track Alias と Group ID の 2 段 Map (`Map<bigint, Map<bigint, bigint>>`) にし、上限を設けて最古から破棄する」に確定する。`priorGapTracking` への統合は、キーが `FullTrackNameKey` であること、set 経路が Track Alias しか持たないこと、破棄の寿命が Track 単位であること、Group の最終 Object ID を保持する場所が無い (同モジュールは受信済み Object ID の集合だけを持つ) ことから採らない
- 追跡の型と操作は新モジュール `src/session/endOfGroupTracking.ts` に置く (`priorGapTracking.ts` と同じ構成)。記録・取得・Track Alias 単位の破棄・上限の適用を関数として公開し、Node の単体テストから直接駆動できるようにする
  - 記録: Group の最終 Object ID を set する。破棄ループは新しい Group を挿入するときだけ回す (既存 Group の上書きで他の Group を失わない)
  - 取得: Track Alias と Group ID から値を返す (未登録は undefined)
  - 破棄: Track Alias のエントリを 1 操作で消す (前方一致の全走査とキー文字列の生成をやめる)
- 上限は `MAX_TRACKED_TRACK_ALIASES = 1024` と `MAX_TRACKED_GROUPS_PER_ALIAS = 1024` にする (`priorGapTracking.ts` の上限と揃える)。Track Alias 数が上限を超えたら最古の Track Alias を丸ごと破棄し、1 Track Alias の Group 数が上限を超えたらその Track Alias の最古の Group を破棄する。挿入順が古い順であることは Map の仕様に依存するため、`priorGapTracking.ts` と同じコメントで根拠を残す。最悪値は 1024 × 1024 で 1,048,576 件だが、Track Alias 数は購読数に比例し、Group 数は Track Alias ごとに抑えられる
- 上限で破棄した Track Alias / Group では §12.1 条件 4 の超過を検出できなくなる。既知の最終 Object が無ければ判定自体を行わないため、検出漏れだけが生じ、誤検出は生まない。この内容を新モジュールの関数、`src/session.ts` と `src/session/bidi.ts` の宣言コメントに書く (追記先は宣言コメントに固定する)
- `clearEndOfGroupTracking` は現行どおり、テストのモックセッションが追跡マップを持たない場合に備えて undefined を許容する (呼び出し側のガードを残す)。`src/testSupport/bidi.ts` は変更しない
- 変更対象は `src/session/endOfGroupTracking.ts` (新規) と `src/session/endOfGroupTracking.test.ts` (新規)、`src/session/dataStreamIncoming.ts` / `src/session/incoming.ts` / `src/session/bidi.ts` / `src/session/lifecycle.ts` / `src/session.ts`、フィクスチャの `src/session/incoming.test.ts` / `src/session/incoming.prop.ts` とする。`incoming.prop.ts` の記録の写経は新モジュールの記録関数を呼ぶ形に寄せる。上限と破棄順のテストは `priorGapTracking.test.ts` の書き方に合わせる
- `CHANGES.md` の `## develop` の先頭に `[FIX]` を追記する (セクション内は新しい順)

## 完了条件

- 1 Track Alias あたり 1024 件を超えると、その Track Alias の最古の Group から破棄されることが単体テストで固定される (既存 Group の上書きでは他の Group を失わないことも固定する)
- Track Alias が 1024 件を超えると、最古の Track Alias のエントリが丸ごと破棄されることが単体テストで固定される
- 上限内では既存と同じ記録・取得・上書きが動き、未登録の Group は undefined になる
- Track Alias 単位の破棄が 1 操作になり、前方一致の全走査とキー文字列の生成が無くなる。テストのモックセッションが追跡マップを持たない場合の undefined 許容は残る
- 保持先の型を `Map<bigint, Map<bigint, bigint>>` に変えたうえで、`src/session/incoming.test.ts` / `src/session/incoming.prop.ts` を含む既存テストが通る
- 破棄した Track Alias / Group で §12.1 条件 4 を検出できないこと (検出漏れのみで誤検出は生まない) が、新モジュールの関数と `src/session.ts` / `src/session/bidi.ts` の宣言コメントに書かれている
- `CHANGES.md` の `## develop` の先頭に `[FIX]` が入る
- `npx vp check` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-transport-21 §12.1 (条件 4: Group の最終 Object より大きい Object ID の検出)
- `src/session/priorGapTracking.ts` (上限付きの受信追跡の前例)

## 解決方法

`src/session/endOfGroupTracking.ts` を新設し、追跡の型と操作を `src/session/priorGapTracking.ts` と同じ構成でまとめた。保持先を `Map<string, bigint>` (`${trackAlias}:${groupId}` のキー文字列) から `EndOfGroupTracking = Map<bigint, Map<bigint, bigint>>` の 2 段 Map に変え、`recordEndOfGroupFinalObjectId` / `getEndOfGroupFinalObjectId` / `clearEndOfGroupTracking` の 3 関数を公開している。

上限は `MAX_TRACKED_TRACK_ALIASES = 1024` と `MAX_TRACKED_GROUPS_PER_ALIAS = 1024` とした (priorGapTracking と同値)。Track Alias 数が上限を超えたら最古の Track Alias を丸ごと破棄し、1 Track Alias の Group 数が上限を超えたらその Track Alias の最古の Group を破棄する。挿入順が古い順であることは Map の仕様に依存するため、priorGapTracking と同じコメントで根拠を残した。破棄ループは新しい Group を挿入するときだけ回し、既存 Group の上書きで他の Group を失わないようにしている (上書きでは件数が増えないため)。

上限で破棄した Track Alias / Group では §12.1 条件 4 の超過を検出できなくなる。既知の最終 Object が無ければ判定自体を行わないため、生じるのは検出漏れだけで誤検出は生まない。この内容を新モジュールの関数と `src/session.ts` / `src/session/bidi.ts` の宣言コメントに書いた。上限で破棄した Track Alias が後で再登録された場合も、破棄した Group の履歴は戻らないため、その Track Alias では検出できないままになることも記した。

`clearEndOfGroupTracking` は前方一致の全走査とキー文字列の生成をやめ、Track Alias のエントリを 1 操作 (`Map.delete`) で消す。`src/session/bidi.ts` の呼び出し側は、テストのモックセッションが追跡マップを持たない場合に備えて undefined を許容する形を維持した (モックは `unknown` 経由で構築されるため実行時に undefined になり得る)。

テストは `src/session/endOfGroupTracking.test.ts` に 6 件 (記録と取得、上書き、既存 Group の上書きで他を失わないこと、Group 数の上限、Track Alias 数の上限で内側の Group ごと破棄されること、Track Alias 単位の破棄) を追加し、`src/session.test.ts` に本番の書き込み経路のテストを 1 件追加した。このテストは実 `SessionImpl` を 2 本の Subgroup ストリームで駆動し、Track Alias 7 / Group 1 の END_OF_GROUP (Object ID 5) の記録と、別 Subgroup の Object ID 6 が malformed として cancel されることを固定する (記録呼び出しの削除・引数の取り違え・上限の不等号の誤りをいずれも検出する)。`src/session/incoming.test.ts` にも読み出し経路の回帰テストを 1 件追加した。

`CHANGES.md` の `## develop` の FIX 群先頭に `[FIX]` を追記した。あわせて、削除済みの `SessionImpl.handleSubgroupStream` を参照していたコメント (incoming.ts / incoming.prop.ts / dataStreamIncoming.ts / session.test.ts / docs/LOW_LEVEL_API.md) を現在の関数名に直した。

`npx vp check` と `npx vp test --run` (3406 テスト) が通る。
