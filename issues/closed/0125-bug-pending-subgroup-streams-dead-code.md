# pendingSubgroupStreams がデッドコードで Track Alias 未確立 Subgroup を buffer していない

Created: 2026-05-02
Reopened: 2026-05-03
Completed: 2026-05-03
Model: Opus 4.7

## 概要

`Session#pendingSubgroupStreams` (`src/session.ts`) は宣言と読み出し / 削除のみが実装されており、ストリームを格納する `set` / `push` 経路が一切存在しない。コメントでは未確立 Track Alias の Subgroup を一時 buffer する意図が示されているが、実態は単に 5 秒タイムアウトでストリームを `cancel()` するだけになっている。

## Reopen 理由

前回 (2026-05-02 の commit `a2ac5d6`) では「buffer 機能を断念して abandon オンリーに統一する」方針で対応し、`pendingSubgroupStreams` Map / 関連統計 / `processPendingSubgroupStream` 関数を削除した。

これは draft-ietf-moq-transport-17 §10.4.2 が許容する 2 つの選択肢 (abandon / buffer) のうち、より受信側に優しい buffer を捨てて abandon に倒した判断であり、moqt-js が Subscriber として QUIC のストリーム間順序非保証下で reordering 耐性を欠く結果になっていた。`waitForSubscriber` で 5 秒間 read を停止する代替実装は flow control を浪費する性質が異なる挙動であり、buffer の代替にはなっていなかった。

「コード意図 (buffer する) と実装 (abandon オンリー) の乖離」を「デッドコードを削除する」方向で解消するのは妥協であり、本来は「buffer を実装で埋める」方向で解消するべきという判断のもと reopen する。前回の commit は revert 済み (`f3df7c2`)。

## RFC 根拠

draft-ietf-moq-transport-17 §10.4.2 (l.4727-4736):

> If an endpoint receives a subgroup with an unknown Track Alias, it MAY abandon the stream, or choose to buffer it for a brief period to handle reordering with the control message that establishes the Track Alias. The endpoint MAY withhold stream flow control beyond the SUBGROUP_HEADER until the Track Alias has been established. To prevent deadlocks, endpoints MUST allocate connection flow control to the control streams before allocating it to any data streams.

abandon と buffer はどちらも MAY だが、reordering 対策として buffer する方が QUIC の特性 (ストリーム間の順序保証なし) に対して堅牢。"brief period" はタイムアウトと容量上限の必要性を示唆する。

## 該当箇所 (revert 後の状態)

- `src/session.ts` — `pendingSubgroupStreams: Map<...>` の宣言、消費側ロジック (`handleSubscribeOk` 内で `processPendingSubgroupStream` を呼ぶ)、`processPendingSubgroupStream` 関数本体は存在
- 欠けているのは「ストリーム受信時に Map に entry を put する生産側」のみ
- `handleIncomingStream` の Subgroup パスで `await waitForSubscriber()` が read を停止しており、buffer に移行できていない

## 期待される動作

draft-ietf-moq-transport-17 §10.4.2 に準拠した buffer を実装する。具体的には:

1. SUBGROUP_HEADER 受信後、Track Alias が未確立なら以降のチャンクを buffer に積む
2. SUBSCRIBE_OK 受信時に buffer を該当 Subscriber に flush して通常パスに合流
3. buffer サイズは per-stream / per-session で上限 (1 MiB / 16 MiB) を設けて DoS を防ぐ
4. タイムアウト (5 秒、"brief period") 経過時は abandon (`reader.cancel()`)
5. session close 時は全 buffer を解放

## 優先度

中。動作上は abandon に倒れているため即座のクラッシュにはならないが、QUIC 順序非保証下で SUBSCRIBE_OK と Subgroup ストリームの reordering が発生した際に Subscriber が object を取り損なうため、Subscriber としての堅牢性に直接影響する。

## 解決方法

draft-ietf-moq-transport-17 §10.4.2 の buffer 経路を実装した。

- `src/pendingSubgroupBuffer.ts` を新設し `PendingSubgroupBuffer` / `PendingSubgroupEntry` / `PendingSubgroupBufferOptions` / `DEFAULT_PENDING_SUBGROUP_BUFFER_OPTIONS` を切り出した
  - 上限値はコンストラクタで `Partial<PendingSubgroupBufferOptions>` を受け取り、未指定の field は `DEFAULT_PENDING_SUBGROUP_BUFFER_OPTIONS` (1 MiB / 16 MiB / 5000 ms) で補完する
  - ハードコードしていた定数 (`PENDING_SUBGROUP_TIMEOUT_MS` / `PENDING_SUBGROUP_PER_STREAM_BYTES` / `PENDING_SUBGROUP_PER_SESSION_BYTES`) を session.ts から排除し、設定面 (`ConnectOptions.pendingSubgroup`) と既定値 (`DEFAULT_PENDING_SUBGROUP_BUFFER_OPTIONS`) に分離した
  - `notify(reason)` で `subscriber` / `timeout` / `overflow-per-stream` / `overflow-per-session` / `session-close` / `end-of-stream` の通知を resolve する Promise を提供する
- `src/session.ts` の改修
  - `pendingSubgroupStreams: Map<...>` を `pendingSubgroupBuffer: PendingSubgroupBuffer` に置き換える
  - `ConnectOptions` に `pendingSubgroup?: Partial<PendingSubgroupBufferOptions>` を追加し、`SessionImpl` のコンストラクタで `SessionImplOptions` 経由で受け取って `PendingSubgroupBuffer` に渡す
  - `handleIncomingStream` から Subgroup ストリーム処理を `handleSubgroupStream` メソッドに分割する
  - `handleSubgroupStream` は subscriber 未登録時に pending mode に入り、Promise.race で `reader.read()` と `entry.notified` を並走させる。subscriber 登録通知を受けたら累積 chunks を 1 本に concat して `processSubgroupObjects(buffer, subscriber, header, -1n)` で flush し、その後通常 mode に合流する
  - subscriber mode 移行時に `pendingRead` を持ち越し、subscriber mode の最初の read として消費する (ReadableStreamDefaultReader.read は中断不能のため)
  - `handleSubscribeOk` 内の処理を `pendingSubgroupBuffer.notifyAlias(trackAlias, "subscriber")` に置き換える (実際の Map からの削除と flush は所有者 = `handleSubgroupStream` 側が行うことで race condition を排除)
  - `processPendingSubgroupStream` を削除し、`processSubgroupObjects` に処理を一本化する (重複コードの整理)
  - `waitForSubscriber` / `subscriberReadyCallbacks` を削除する
  - `close()` で `pendingSubgroupBuffer.notifyAll("session-close")` を呼び全 entry を解放する
  - `SessionStatistics.pendingSubgroupStreamsCount` / `pendingSubgroupStreamsBytes` を `PendingSubgroupBuffer` の集計値 (`streamCount` / `totalBytes`) で復活させる
- `src/index.ts` から `connect()` の `options.pendingSubgroup` を `SessionImpl` に伝搬し、`PendingSubgroupBufferOptions` / `DEFAULT_PENDING_SUBGROUP_BUFFER_OPTIONS` を public API として export する
- `src/pendingSubgroupBuffer.test.ts` を新設し 15 ケースで `PendingSubgroupBuffer` の振る舞い (add/append/remove/notifyAlias/notifyAll/timeout/overflow/idempotent notify、デフォルト値の検証、Partial オプションのマージ) を検証した
- `devtools/src/components/DebugPanel.tsx` の "Pending Subgroup Streams" / "Pending Subgroup Bytes" 表示はそのまま機能する

これにより QUIC のストリーム間順序非保証下で SUBSCRIBE_OK と Subgroup ストリームの reordering が発生しても、Subscriber が object を取り損なわず buffer 経由で reordering を吸収できるようになる。
