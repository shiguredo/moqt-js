# pendingSubgroupStreams がデッドコードで Track Alias 未確立 Subgroup を bufferしていない

Created: 2026-05-02
Completed: 2026-05-02
Model: Opus 4.7

## 概要

`Session#pendingSubgroupStreams` (`src/session.ts:666`) は宣言と読み出し / 削除のみが実装されており、ストリームを格納する `set` / `push` 経路が一切存在しない。コメントでは未確立 Track Alias の Subgroup を一時 buffer する意図が示されているが、実態は単に 5 秒タイムアウトでストリームを `cancel()` するだけになっている。

## RFC 根拠

draft-ietf-moq-transport-17 Section 10.4 (line 4727-4731):

> If an endpoint receives a subgroup with an unknown Track Alias, it MAY abandon the stream, or choose to buffer it for a brief period to handle reordering with the control message that establishes the Track Alias.

abandon と buffer はどちらも MAY だが、現状はコードが「buffer する意図」で書かれているのに「実際は abandon しかしない」状態であり、コードオーナーシップ上のバグである。

## 該当箇所

- `src/session.ts:666-669` — `pendingSubgroupStreams: Map<...>` の宣言
- `src/session.ts:1948-1952, 1961-1962` — 統計 (`pendingSubgroupStreamsCount` / `pendingSubgroupStreamsBytes`) は常に 0 を返す
- `src/session.ts:2862-2873` — `get` / `delete` のみ存在
- `src/session.ts` 全体に対して `pendingSubgroupStreams.set` / `.push` の grep 結果が 0 件
- `src/session.ts:3725-3739` — `handleIncomingStream` は `waitForSubscriber` で 5 秒タイムアウト後 `reader.cancel()`

## 期待される動作

次のいずれかに揃える。

1. buffer 意図に合わせて配線する。Subgroup Header をデコードした時点で Subscriber が未確立であれば、以降のチャンクを `pendingSubgroupStreams` Map に蓄積し、Subscribe 確立 (SUBSCRIBE_OK / PUBLISH 受信) のタイミングで `processPendingSubgroupStream` を呼んで配信する。
2. buffer 機能を断念する。`pendingSubgroupStreams` Map・統計フィールド・`processPendingSubgroupStream` 関数を削除し、abandon オンリーであることをコメントに明記する。

仕様 §10.4 が `MUST allocate connection flow control to the control streams before allocating it to any data streams` を要求している点を踏まえ、buffer サイズに上限を設けないとデッドロックを誘発しうる点も併せて検討する。

## 優先度

中。動作上は abandon に倒れているため即座のクラッシュにはならないが、コードと意図の乖離が大きく、将来的にバッファ統計に依存した運用判断 (例: devtools の `pendingSubgroupStreamsBytes` 表示) が誤情報を流す。

## 解決方法

buffer 機能を断念し、abandon オンリーに統一した。以下の削除を実施した。

- `Session#pendingSubgroupStreams` Map の宣言を削除
- `SessionStatistics` から `pendingSubgroupStreamsCount` と `pendingSubgroupStreamsBytes` を削除
- `processPendingSubgroupStream` 関数を削除
- `pendingSubgroupStreams` の `get` / `delete` 呼び出し箇所を削除
- devtools の `DebugPanel.tsx` から `Pending Subgroup Streams` と `Pending Subgroup Bytes` の表示を削除

現在の実装では `waitForSubscriber` で Subscriber が登録されるまで待機し、タイムアウト後に `cancel()` する方法が取られているため、`pendingSubgroupStreams` はデッドコードであった。
