# 配信の再開時に Prior Group ID Gap を送らない

- Created: 2026-10-17
- Completed: {YYYY-MM-DD}
- Branch: feature/add-publisher-prior-group-id-gap
- Polished: 2026-11-15
- Refreshed: 2026-11-14

## 目的

draft-ietf-moq-msf-02 §6.1 は、再起動を跨いで状態を保持し前の Group ID を知っている publisher に対し、MOQT Prior Group ID Gap Extension header でギャップを知らせることを SHOULD とする (「If a publisher maintains state across a restart and knows the previous Group ID, it SHOULD signal the gap using the MOQT Prior Group ID Gap Extension header.」)。

moqt-js の publisher は `allocateInitialGroupId` と `noteGroupId` (同一プロセス内の単調ガード) によって、再開時の開始 Group ID が前回 publish したどの Group ID よりも大きくなる状態を作っている。単調ガードは全トラック共有で track ごとの前回値そのものは保持していないが、音声・映像は `MediaPublisherImpl` が前回の Group ID を保持しており、Catalog も最後に送信した Group ID を保持できる。本 issue で track ごとの前回値を保持すれば「前の Group ID を知っている」状態になり、この SHOULD の条件を満たす。しかし Prior Group ID Gap (Property Type 0x3C) を送っていないため、購読側は「前の Group が存在したか」を推測できない (draft-ietf-moq-transport-23 §10.8: 「If Prior Group ID Gap is not present, the receiver cannot infer any information about the existence of prior groups」)。

## 現状

- 受信側は実装済みである。`src/properties.ts` が Property Type 0x3C を復号して `priorGroupIdGap` を返し、`src/session/priorGapTracking.ts` と `session.priorGapTrackingByTrack` が Track 単位で追跡し、同一 Object 内の複数出現などの malformed 条件も検出する (closed/0568 / closed/0569)
- `encodePriorGroupIdGap` / `parseProperties` は実装済みだが、gap の計算 helper は無い。closed/0357 は計算 helper を実装せずに closed になり、`createMediaPublisher` への配線時に helper を追加する方針を示している
- `createMediaPublisher` の送信側は未実装である。`src/createMediaPublisher.ts` は `LOC.encodeAudioProperties` と `LOC.encodeVideoProperties` で LOC Properties だけを組み立てており、Prior Group ID Gap を載せる経路が無い (`src/createMediaPublisher.ts` に gap を扱う記述は無い)
- 前回の Group ID を知り得る状態は既にある。音声と映像の Group ID は `MediaPublisherImpl` が保持し、`stop()` → `start()` で同じインスタンスを使う場合は前回の値がそのまま残る。Catalog は `start()` のたびに `allocateInitialGroupId()` で払い出し直すため、`catalogGroupId` だけでは前回の値を保持できない。最後に送信した catalog Group ID を別に保持する必要がある。単調ガード (`maxGroupIdSeen`) は全トラックで共有しており、track ごとの前回最大値は保持していない (closed/0628)
- 音声・映像は、前回の配信で Group を 1 つ以上送っていれば、再開後に最初に送る Group は前回の Group ID + 1 になり、gap は 0 である。Catalog は `allocateInitialGroupId()` により前回の catalog Group より大きい開始 Group ID が払い出され、gap は 0 より大きくなり得る。いずれも Prior Group ID Gap を送る対象になる

## 前提の更新 (2026-11-16)

`0998` で publisher の送信経路を実装した。`MediaPublisherOptions.priorGroupIdGap` を指定すると、音声と映像の最初の Object に `PRIOR_GROUP_ID_GAP` が載る (`src/loc.ts` / `src/createMediaPublisher.ts`)。

残る作業は次の 2 点である。

- track ごとの前回 Group ID の自動捕捉 (現状は呼び出し側が値を渡す)
- Catalog track の前回 Group ID の保持と gap の計算

本 issue の設計方針のうち「値を計算して載せる」部分は実装済みであり、残りは自動化である。

## 設計方針

- 配信を始めるときに track ごとの前回の Group ID を捕捉し、その Group で最初に送る Object の時点で Prior Group ID Gap の値を計算して properties に載せる。値は `BigInt` の「新しい開始 Group ID - 前回の Group ID - 1」である (§10.8: 「the number of Groups prior to the current Group that do not, and will never, exist」)
- 音声・映像は `audioGroupId` / `videoGroupId` と `audioGroupStarted` / `videoGroupStarted` を `stop()` → `start()` で引き継ぐため、前回の配信で Group を送っていれば再開後の最初の Group は前回の Group ID + 1 であり、gap は 0 になる。`start()` の入口で前回値を捕捉し、最初の Object を送る時点でその Group に載せる
- Catalog は前回の配信で最後に送信した catalog Group ID と、`createPublishers()` が払い出す新しい開始 Group ID の差から gap を計算する。開始時の catalog が paused で送られない場合は、実際に最初に送る catalog Object の Group ID で計算する (開始時に確保した Group ID は送信に使われず、次の送り直しは +1 を使う)
- 同じ Group の中で複数の Object を送る場合は同じ値を使う (§10.8: 「A Group contains more than one Object with different values for Prior Group ID Gap」は malformed)。映像は Group の先頭がキーフレームなので最初の Object に載せ、同じ Group の続きの Object にも同じ値を載せる。gap を載せるのは再開後の最初の Group だけとし、次の Group 以降には載せない (同じ gap を繰り返すと、前回受信した Group を覆う malformed 条件に当たり得る)
- 前回の Group ID が分からない場合は載せない (§10.8 は optional とする)。新しい `MediaPublisherImpl` での再開と、Group を 1 つも送っていない初回の `start()` が該当する
- track ごとの前回の Group ID は `MediaPublisherImpl` が持つ。音声・映像は既存の `audioGroupId` / `videoGroupId` (送信に使った Group ID) と `audioGroupStarted` / `videoGroupStarted` (Group を送ったか) を使い、Catalog は `catalogGroupId` とは別に「最後に送信した catalog Group ID」を保持する。単調ガードは全トラック共有で track ごとの前回最大値を持たないため、開始 Group ID の払い出しとは別に、送信に使った Group ID を track ごとに保持する
- `LOC.encodeVideoProperties` / `LOC.encodeAudioProperties` は内部で `Property[]` を組み立てて `encodeProperties` に渡している。gap を載せるには、LOC の Property と Prior Group ID Gap の Property を 1 つの `Property[]` にまとめて `encodeProperties` で delta encoding する (LOC の encoder の出力と `encodePriorGroupIdGap` の出力を別々に連結しない)。encoder の入力型に `priorGroupIdGap` を追加するか、`Property[]` を組み立てる関数を追加するかを決め、gap を載せるかどうかの判断は純関数に切り出し、単体テストから固定できるようにする

## 完了条件

- 同一プロセス内で `stop()` → `start()` を繰り返したとき、新しい開始 Group の最初の Object に Prior Group ID Gap が載る (音声・映像は gap 0、Catalog は前回の catalog Group ID との差から計算される)。単体テストで固定する
- Catalog の開始時の送信が paused で見送られた場合、実際に最初に送る catalog Object の Group ID で gap が計算される。単体テストで固定する
- 前回の Group ID が分からない場合 (初回の `start()`、新しい `MediaPublisherImpl`) は載らない。単体テストで固定する
- 同じ Group の 2 つ目以降の Object にも同じ値が載り、次の Group には載らない。単体テストで固定する
- 送った properties を `src/properties.ts` が復号して `priorGroupIdGap` を返し、`src/session/priorGapTracking.ts` の追跡が成立する (往復のテスト)
- `vp check` / `tsc --noEmit` / `vp test run` が通ること
- どの条件で送るかを `docs/HIGH_LEVEL_API.md` に書く。`docs/LOW_LEVEL_API.md` には Property 0x3C の scope と、低レベル API では `sendObject` の `properties` に raw で載せられることを書く

## 参照

- draft-ietf-moq-msf-02 §6.1 (Group numbering)
- draft-ietf-moq-transport-23 §10.8 (Prior Group ID Gap) / §2.3.1 (Group IDs) / §12.1 (Malformed Tracks)
- closed/0357 (Prior Group ID Gap の encode→parse 往復を確認済み。計算 helper は実装せずに closed になった) / closed/0568 / closed/0569 (受信側の追跡と検証)
- closed/0628 (開始 Group ID の割当てを単調ガードに統一した。単調ガードは全トラック共有である) / closed/0683 (Catalog の Group ID を start() のたびに払い出し直す実装)

## 解決方法

{対応時に記入}
