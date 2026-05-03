# renderFrame の Joining FETCH timestamp ゲートが描画フレームを落とす

Created: 2026-05-03
Model: Opus 4.7

## 概要

`devtools/src/hooks/useSubscriber.ts` の Joining FETCH 完了処理と `renderFrame` の組み合わせにより、Joining FETCH 直後にデコーダから出力される複数フレームのうち、最後の 1 フレーム以外が破棄される。

具体的には:

1. `useSubscriber.ts:497-588` の `onEnd` (Joining FETCH 完了時コールバック) は、ライブバッファ内の各オブジェクトを LOC から timestamp 抽出して `lastTimestamp` を **最後の要素の値** で上書きする (`useSubscriber.ts:543-552`)。
2. `lastTimestamp` を `joiningFetchLastTimestamp` に保存する (`useSubscriber.ts:556`)。
3. `renderFrame` (`useSubscriber.ts:43-60`) は `frame.timestamp < joiningFetchLastTimestamp` のフレームを `frame.close()` で破棄し、`>=` に達した時点で `joiningFetchLastTimestamp` を 0 に戻して描画再開する。

結果として、`onEnd` 通過直後にデコーダから出力されるバッファ済みライブオブジェクト由来のフレームのうち、最後の 1 フレームに到達するまでのデコード済みフレームが全て描画されない。さらに WebCodecs の VideoDecoder は出力順が入力順と完全には一致せず、reorder 後の重要フレーム (key を含む) を timestamp 比較だけで落とす危険がある。

## RFC 根拠

draft-ietf-moq-transport-17 §9.14.2.1 は FETCH と SUBSCRIBE の範囲を「contiguous かつ non-overlapping」にする責務を **Publisher** に課しており、Subscriber 側で timestamp ベースの重複排除を行う必要はない。Joining Location が確定した時点で FETCH の終端と SUBSCRIBE の始端が一意に定まる。

LOC 仕様 (draft-ietf-moq-loc-02) も timestamp は単調増加を要求しておらず、再エンコード等で同一値や逆転が発生し得る。

## 該当箇所

- `devtools/src/hooks/useSubscriber.ts:43-60` — renderFrame の timestamp ゲート
- `devtools/src/hooks/useSubscriber.ts:484` — Joining FETCH onObject 内で `joiningFetchLastTimestamp` を毎回上書き
- `devtools/src/hooks/useSubscriber.ts:543-556` — onEnd 内でバッファ最後尾の timestamp に上書き
- `devtools/src/signals/subscriber.ts` — `joiningFetchLastTimestamp` フィールド定義 (削除対象)

## 期待される動作

timestamp ベースの描画ゲートを撤去する。Joining FETCH 区間と SUBSCRIBE 区間の連続性は draft-17 §9.14.2.1 に従い Publisher 側で保証されるため、Subscriber 側はデコード結果をそのまま順次描画すれば良い。

もし「FETCH 区間 (履歴) は描画スキップして live edge から表示する」という UX 要件があるなら、その判定は timestamp ではなく `(groupId, objectId)` の Location 比較で行うべき (`joiningFetchLastLocation` は既に保持されている)。ただし現状の実装は live edge 描画を意図しているか不明確で、UX 要件として明文化されていないため、まず既定動作を「Joining FETCH 区間も live もすべて描画」に揃える。

## 優先度

高。ライブ再生開始時の数フレームから数十フレームが描画されない可能性があり、視覚的な再生開始の遅延として観測される。LOC timestamp の単調性が崩れた瞬間にキーフレームを落として黒画面になる回帰リスクもある。
