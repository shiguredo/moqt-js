# devtools の初期 Group ID の割当てを単調ガード付きに統一する

- Created: 2026-09-20
- Completed: 2026-10-17
- Branch: feature/update-devtools-group-id-allocation
- Polished: 2026-09-28

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

- ライブラリの単調ガード (`maxGroupIdSeen`。旧名 `lastAllocatedInitialGroupId`) へ送信に使う Group ID を伝える `noteGroupId(groupId)` を `src/createMediaPublisher.ts` に追加した。設計方針では `allocateInitialGroupId` へ候補として渡すとしていたが、`allocateInitialGroupId` は `Math.max(candidate, guard + 1)` を返すため候補として渡すと Group ID を 1 つ余分に消費する。送信済みの値を記録する専用の関数に分けた (この点は設計方針と異なる)
- `noteGroupId` は安全整数のみ受け付ける (`Number.isSafeInteger`)。安全整数でない値でガードが固定すると `guard + 1 === guard` となり、全トラックが同じ Group ID を払い出し続けて draft-ietf-moq-msf-01 §6.1 の一意性 MUST に反する。`allocateInitialGroupId` の候補の検証も有限数から安全整数へ揃え、払い出す値 (`guard + 1`) も検証する
- ライブラリの追随は既存の 3 箇所 (Catalog の送り直し / 音声 chunk / 映像キーフレーム) を `noteGroupId` に寄せ、規則を 1 つにした。呼び出し側のコメントは `noteGroupId` の JSDoc へ集約した
- devtools の初期 Group ID を `applyPublishStartGroupIds()` に統一した (`devtools/src/hooks/usePublisher.ts`)。映像 (`pubCurrentGroup`) と Catalog (`catalogGroup`) は `Date.now()` だったものを `allocateInitialGroupId` にし、音声 (`pubCurrentAudioGroup`) と event timeline (`eventGroup`) と合わせて 4 トラックすべてを配信の始めにまとめて払い出す (設計方針の「3 箇所」に event timeline を加えた形)
- devtools で Group を進める経路で `noteGroupId` を呼び、単調ガードを送信済み最大値へ追随させた。映像のキーフレーム (`plan.groupId`) / 音声の chunk (`allocation.groupId`。進めたときだけ) / Catalog の送り直し / complete catalog / event timeline のメッセージごと
- `cleanupPublisher` の `catalogGroup` を残す理由、`devtools/src/signals/publisher.ts` の 4 つの初期値の説明、`devtools/src/signals/snapshotCoverage.test.ts` の除外理由を、新しい払い出しに合わせて書き直した
- 追加・更新したテスト
  - `src/createMediaPublisher.test.ts`: `noteGroupId` が送信済みの最大値へ追随し、停止 → 再開の開始 Group ID が前回の最大値を上回ること、小さい値ではガードが下がらないこと、安全整数でない値を拒否してガードを汚染しないこと、`allocateInitialGroupId` が安全整数でない候補を拒否すること
  - `devtools/src/hooks/usePublisher.test.ts`: 4 トラックの開始値が単調ガードから払い出され、次の配信で前回を上回ること、event timeline と complete catalog の送信経路が `noteGroupId` を呼ぶこと (共有ガードが前提を満たしているかを assert で明示する)。映像と音声と Catalog の送り直しの経路は WebCodecs と実セッションに依存するため単体テストから駆動できない旨をコメントに残した
- `vp check` / `tsc --noEmit` / `vp test run` (228 ファイル / 3996 テスト) / `vp run e2e-test` (111 テスト) が通ることを確認した
- `CHANGES.md` は `CODEBASE.md` の「MOQT RFC ドラフト中の特別ルール」により更新していない (この issue の対象でもない)

### 残した穴 (別 issue 候補)

- draft-ietf-moq-msf-01 §6.1 の Prior Group ID Gap Extension を送る SHOULD は未実装である。ガードは全トラック共有で track ごとの前回最大値を保持しておらず、プロセスを跨いだ再開では前の Group ID は原理的に分からない。実装するには track ごとの前回最大値と Publisher の properties 生成への追加が要る (draft-ietf-moq-transport-22 §10.8 は Property 0x3C を optional とするため、送らないこと自体は許容である)
- ガードをトラック間で共有しているため、devtools とライブラリの `MediaPublisher` を同じページで併用すると互いの開始値が飛ぶ。§6.1 が MUST とするのは track 内の一意性と単調増加であり、実装はトラック横断でも一意になる安全側である
- devtools の映像と event timeline は払い出した開始値を最初に送らず、初回送信は 1 つ進んだ Group から始まる (`buildObjectSendPlan` がキーフレームで必ず Group を進めるため。ライブラリの `allocateVideoObject` は初回に進めない)。表示される「開始 Group ID」と実際の初回送信値が 1 ずれる
- 共有ガードはプロセス内のみで、ページ再読み込みを跨ぐ単調性は壁時計に依存する (値は `Date.now()` 起点のため、通常は壁時計が勝つ)
- 実機で「停止 → 即再開」を繰り返したときの 4 トラックの Group ID を観測する経路は無い (単体テストはガードの値までしか固定しない)
