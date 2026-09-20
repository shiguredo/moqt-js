# devtools の初期 Group ID の割当てを単調ガード付きに統一する

- Created: 2026-09-20
- Completed: {YYYY-MM-DD}
- Branch: feature/update-devtools-group-id-allocation
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-msf-01 §6.1 は Group ID について次を MUST とする。

- `Group IDs for a track MUST be unique and MUST increase monotonically.`
- `When a publisher restarts (e.g., after connectivity loss or encoder restart), it MUST ensure the new starting Group ID is greater than any previously published Group ID for that track.`

devtools の publisher は音声トラックについて `allocateInitialGroupId` (同一プロセス内で前回割り当てた開始値を必ず上回る単調ガード付きの割当て) を使うようにしたが、映像トラックと Catalog トラックは `Date.now()` をそのまま初期値にしている。`Date.now()` だけでは、短時間に停止と再開を繰り返した場合や、chunk をまとめて送った場合に、再開時の開始 Group ID が前回 publish した最大 Group ID を上回ることを保証できない。

3 本のトラックの割当てを同じ規則に揃え、MSF §6.1 の MUST を実装として保証する。

## 現状

- `devtools/src/hooks/usePublisher.ts` の `startPublishing` は映像トラックの `pubCurrentGroup` と Catalog の `catalogGroup` を `Date.now()` で初期化する
- 同じ関数内で音声トラックの `pubCurrentAudioGroup` だけが `allocateInitialGroupId` (ライブラリ `src/createMediaPublisher.ts` の単調ガード付き割当て) を使う
- ライブラリ本体の `createMediaPublisher` は映像と音声の両方に `allocateInitialGroupId` を使っており、devtools だけが揃っていない
- Catalog の Group ID は「次回の `startPublishing` が `Date.now()` で設定し直す。0 に戻すと再起動後の Group ID が前回より小さくなり MSF §6.1 の MUST に反するため触らない」というコメント付きで `cleanupPublisher` でも保持しているが、`Date.now()` が前回の最大値を上回る保証はコメントの主張ほど強くない

## 設計方針

- `devtools/src/hooks/usePublisher.ts` の 3 箇所 (`pubCurrentGroup` / `pubCurrentAudioGroup` / `catalogGroup`) の初期化を `allocateInitialGroupId()` に統一する
- `allocateInitialGroupId` は `src/createMediaPublisher.ts` が export しており `src/index.ts` の公開 API には含まれないため、codec-test と同じ deep import で使う
- 割当て規則の統一を単体テストで固定する。`Date.now()` 依存をやめることで、テストから決定的に検証できるようになる

## 完了条件

- 映像 / 音声 / Catalog の初期 Group ID がすべて `allocateInitialGroupId` から払い出される
- 割当てが単調であること (再開時に前回の開始値を上回ること) を単体テストで固定する
- `npx vp check` / `npx vp test --run` / `npx vp run e2e-test` が通る

## 参照

- draft-ietf-moq-msf-01 §6.1 (Group numbering) / §6.2 (Object Numbering)
- draft-ietf-moq-loc-04 §4.1 (Application with one audio track: 音声は chunk 1 つごとに Group を進める)

## 解決方法

{未着手}
