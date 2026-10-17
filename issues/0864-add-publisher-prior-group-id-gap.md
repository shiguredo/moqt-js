# 配信の再開時に Prior Group ID Gap を送らない

- Created: 2026-10-17
- Completed: {YYYY-MM-DD}
- Branch: feature/add-publisher-prior-group-id-gap
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-msf-01 §6.1 は、再起動を跨いで状態を保持し前の Group ID を知っている publisher に対し、MOQT Prior Group ID Gap Extension header でギャップを知らせることを SHOULD とする (「If a publisher maintains state across a restart and knows the previous Group ID, it SHOULD signal the gap using the MOQT Prior Group ID Gap Extension header.」)。

moqt-js の publisher は `allocateInitialGroupId` と `noteGroupId` (同一プロセス内の単調ガード) によって、再開時の開始 Group ID が前回 publish したどの Group ID よりも大きくなる状態を作っている。つまり「前の Group ID を知っている」状態にあり、この SHOULD の条件を満たし得る。しかし Prior Group ID Gap (Property Type 0x3C) を送っていないため、購読側は「前の Group が存在したか」を推測できない (draft-ietf-moq-transport-22 §10.8: 「If Prior Group ID Gap is not present, the receiver cannot infer any information about the existence of prior groups」)。

## 現状

- 受信側は実装済みである。`src/properties.ts` が Property Type 0x3C を復号して `priorGroupIdGap` を返し、`src/session/priorGapTracking.ts` と `session.priorGapTrackingByTrack` が track 横断で追跡し、同一 Object 内の複数出現などの malformed 条件も検出する (closed/0357 / closed/0568 / closed/0569)
- 送信側は未実装である。`src/createMediaPublisher.ts` は `LOC.encodeAudioProperties` と `LOC.encodeVideoProperties` で LOC Properties だけを組み立てており、Prior Group ID Gap を載せる経路が無い (`src/createMediaPublisher.ts` に gap を扱う記述は無い)
- 前回の Group ID を知り得る状態は既にある。音声と映像の Group ID は `MediaPublisherImpl` が保持し、`stop()` → `start()` で同じインスタンスを使う場合は前回の値がそのまま残る。Catalog は `start()` のたびに `allocateInitialGroupId()` で払い出し直す。単調ガード (`maxGroupIdSeen`) は全トラックで共有しており、track ごとの前回最大値は保持していない (closed/0628)
- 停止と再開を繰り返すと、開始 Group ID は単調ガードによって前回の最大値より大きい値になる。前回の Group と新しい開始 Group の間の Group は存在しないため、Prior Group ID Gap で知らせられる情報がある

## 設計方針

- 配信を始めるとき (`start()` と `setupEncoders()`) に、track ごとの前回の Group ID と新しい開始 Group ID の差から Prior Group ID Gap の値を計算し、その Group で最初に送る Object の properties に載せる。値は「新しい開始 Group ID - 前回の Group ID - 1」である (§10.8: 「the number of Groups prior to the current Group that do not, and will never, exist」)
- 同じ Group の中で複数の Object を送る場合は同じ値を使う (§10.8: 「A Group contains more than one Object with different values for Prior Group ID Gap」は malformed)。映像は Group の先頭がキーフレームなので最初の Object に載せ、同じ Group の続きの Object にも同じ値を載せる
- 前回の Group ID が分からない場合は載せない (§10.8 は optional とする)。プロセスを跨いだ再開 (新規インスタンス) と、Group を 1 つも送っていない初回の `start()` が該当する
- track ごとの前回の Group ID は `MediaPublisherImpl` が持つ。単調ガードは全トラック共有で track ごとの前回最大値を持たないため、開始 Group ID の払い出しとは別に、送信した Group ID を track ごとに保持する
- properties を組み立てる純関数 (`LOC.encodeVideoProperties` / `LOC.encodeAudioProperties` の呼び出し側、または properties の配列を組み立てる箇所) に、gap を載せるかどうかの判断を切り出し、単体テストから固定できるようにする

## 完了条件

- 同一プロセス内で `stop()` → `start()` を繰り返したとき、新しい開始 Group の最初の Object に Prior Group ID Gap が載る (値は前回の Group ID との差から計算される)。単体テストで固定する
- 前回の Group ID が分からない場合 (初回の `start()`、新しい `MediaPublisherImpl`) は載らない。単体テストで固定する
- 同じ Group の 2 つ目以降の Object にも同じ値が載る。単体テストで固定する
- 送った properties を `src/properties.ts` が復号して `priorGroupIdGap` を返し、`src/session/priorGapTracking.ts` の追跡が成立する (往復のテスト)
- `vp check` / `tsc --noEmit` / `vp test run` が通ること
- どの条件で送るかを `docs/LOW_LEVEL_API.md` と `docs/HIGH_LEVEL_API.md` に書くこと

## 参照

- draft-ietf-moq-msf-01 §6.1 (Group numbering)
- draft-ietf-moq-transport-22 §10.8 (Prior Group ID Gap) / §2.3.1 / §12.1 (malformed の条件)
- closed/0357 (Prior Group ID Gap 計算 helper) / closed/0568 / closed/0569 (受信側の追跡と検証)
- closed/0628 (開始 Group ID の割当てを単調ガードに統一した。単調ガードは全トラック共有である)

## 解決方法

{対応時に記入}
