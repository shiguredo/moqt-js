# devtools の初期 Group ID の割当てを単調ガード付きに統一する

- Created: 2026-09-20
- Completed: {YYYY-MM-DD}
- Branch: feature/update-devtools-group-id-allocation
- Polished: 2026-09-29

## 目的

draft-ietf-moq-msf-01 §6.1 は Group ID について次を MUST とする。

- `Group IDs for a track MUST be unique and MUST increase monotonically.`
- `When a publisher restarts (e.g., after connectivity loss or encoder restart), it MUST ensure the new starting Group ID is greater than any previously published Group ID for that track.`

devtools の publisher は音声トラックについて `allocateInitialGroupId` (同一プロセス内で前回割り当てた開始値を必ず上回る単調ガード付きの割当て) を使うようにしたが、映像トラックと Catalog トラックは `Date.now()` をそのまま初期値にしている。`Date.now()` だけでは、短時間に停止と再開を繰り返した場合や、chunk をまとめて送った場合に、再開時の開始 Group ID が前回 publish した最大 Group ID を上回ることを保証できない。

3 本のトラックの割当てを同じ規則に揃え、MSF §6.1 の MUST を実装として保証する。

なお、event timeline トラック (`pub.eventGroup`) は closed/0768 で既に `allocateInitialGroupId` を使うようになっており、本 issue の対象外とする (ただしまだ初期値の割当てだけで、Group の進行におけるガードへの追随は無い。設計方針の追随で一緒に保全する)。

## 現状

- `devtools/src/hooks/usePublisher.ts` の `startPublishing` は映像トラックの `pubCurrentGroup` と Catalog の `catalogGroup` を `Date.now()` で初期化する
- 同じ関数内で音声トラックの `pubCurrentAudioGroup` だけが `allocateInitialGroupId` (ライブラリ `src/createMediaPublisher.ts` の単調ガード付き割当て) を使う
- ライブラリ本体の `createMediaPublisher` は映像と音声の両方に `allocateInitialGroupId` を使っており、devtools だけが揃っていない
- Catalog の Group ID は「次回の `startPublishing` が `Date.now()` で設定し直す。0 に戻すと再起動後の Group ID が前回より小さくなり MSF §6.1 の MUST に反するため触らない」というコメント付きで `cleanupPublisher` でも保持しているが、`Date.now()` が前回の最大値を上回る保証はコメントの主張ほど強くない
- `allocateInitialGroupId` の単調ガード (`lastAllocatedInitialGroupId`) は、割当て時とライブラリ本体の送信経路でしか進まない。ライブラリは音声 chunk (`handleAudioEncodedChunk`) と映像キーフレーム (`handleVideoEncodedChunk`) で Group を進めたときに送信済み最大値へ追随させる (closed/0488) が、devtools の送信経路 (映像のキーフレームは `buildObjectSendPlan`、音声の chunk ごとは `allocateAudioObject`、Catalog の送り直しは `sendCatalogUpdate` の +1、event timeline のメッセージごとには `sendEventMessage` の +1) はどれも追随させない

## 設計方針

- `devtools/src/hooks/usePublisher.ts` の 3 箇所 (`pubCurrentGroup` / `pubCurrentAudioGroup` / `catalogGroup`) の初期化を `allocateInitialGroupId()` に統一する
- `allocateInitialGroupId` は `src/createMediaPublisher.ts` が export しており `src/index.ts` の公開 API には含まれないため、codec-test と同じ deep import で使う (`usePublisher.ts` は既に同じモジュールを deep import している)
- 配信中に Group を進めたら、進めた Group ID を `allocateInitialGroupId` へ候補として渡し、単調ガードを送信済み最大値へ追随させる (ライブラリの `handleAudioEncodedChunk` / `handleVideoEncodedChunk` が `groupAdvanced` のときに追随するのと同じ)。追随しないと、chunk をまとめて届いた直後の再開では開始値が前回の Group 進行の最大値を下回り得て、目的で挙げた MUST が守れない。ガードは全トラックで共有されるため、どのトラックの経路で追随しても他トラックの再開も保全される
- 割当て規則の統一を単体テストで固定する。`Date.now()` 依存をやめることで、テストから決定的に検証できるようになる。`startPublishing` の経路は WebCodecs と実 WebTransport に依存し単体テストで再現できない (closed/0624) ため、初期割当てとガードへの追随を純関数に切り出して export し、固定値で駆動する単体テスト (`src/createMediaPublisher.test.ts` の `allocateInitialGroupId` のテスト群と同じ形) で検証する
- `cleanupPublisher` のコメント (catalogGroup を残す理由) は、次回の `startPublishing` が `Date.now()` ではなく `allocateInitialGroupId` で設定し直すことを踏まえて更新する

## 完了条件

- 映像 / 音声 / Catalog の初期 Group ID がすべて `allocateInitialGroupId` から払い出される
- Group を進めたとき単調ガードが送信済み最大値へ追随し、停止 → 再開後の開始 Group ID が前回送信済みの最大 Group ID を上回る (単体テストで固定)
- `vp check` / `vp test run` / `vp run e2e-test` が通る

## 参照

- draft-ietf-moq-msf-01 §6.1 (Group numbering) / §6.2 (Object Numbering)
- draft-ietf-moq-loc-04 §4.1 (Application with one audio track: 音声は chunk 1 つごとに Group を進める)
- closed/0488 (ライブラリの開始 Group ID の単調化。単調ガードと送信最大値の追随の出所) / closed/0624 (catalogGroup の導入と publish 経路の単体テストの制約) / closed/0768 (event timeline トラックで `allocateInitialGroupId` を導入) / 0683 (ライブラリの catalog Publisher の Group ID。対象が devtools とは異なる)

## 解決方法

{未着手}
