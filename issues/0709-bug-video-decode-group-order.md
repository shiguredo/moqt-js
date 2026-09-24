# 購読した映像を Group の順序と欠落を無視して復号し、前の Group の遅着 Object で映像が崩れる

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-video-decode-group-order
- Polished: {YYYY-MM-DD}

## 目的

購読した映像の Object を、届いた順にそのまま decoder へ渡している。Group ごとに別の stream で届くため、前の Group の末尾が次の Group の先頭より後に届くことがある。この場合、次の Group のキーフレームを復号した後に前の Group の delta を復号し、参照フレームが壊れて映像が崩れる (moqt-devtools で実際に崩れる)。

draft-ietf-moq-transport-21 Section 2.1 は「Objects can be delivered out of order」とし、到着順は保証されない。relay の送出順が Group Order に従っていても、経路での損失と再送で stream の間の到着順は入れ替わりうる。受信側は Group の順序と Group 内の欠落を見て、復号できる Object だけを decoder へ渡さなければならない。

## 現状

- `devtools/src/hooks/useSubscriber.ts` の購読の `object` コールバックは、Object を Promise チェーンで到着順に `handleObject` へ渡し、`handleObject` はキーフレーム判定 (`buildVideoChunkPlan`) の後にそのまま `decode` する。コールバックのコメントに「(groupId, objectId) 順の保証がないが、現状はリオーダーバッファを持たない」とある
- `src/createMediaSubscriber.ts` の `handleVideoObject` も到着順に `videoDecoder.decode` へ渡す。Group の順序と欠落は見ない
- `VideoDecoderWrapper` (`src/codec/VideoDecoder.ts`) と Worker (`src/codec/workers/videoDecoder.worker.ts`) の `needsKeyframe` は、復号の開始時と decoder のエラー後にキーフレームを待つだけであり、古い Group の delta や Group 内の欠落は通してしまう
- 受信側は Subgroup stream の RESET_STREAM を stream の終端として扱う (`src/session/dataStreamIncoming.ts`)。reset された Subgroup の残りの Object は届かないが、後続の Object はそのまま decoder へ渡る

実測 (2026-09-24、配備 relay + moqt-devtools、30 fps、keyframeInterval 60、1280x720):

- decoder に渡った chunk 687 件のうち 301 件が「新しい Group のキーフレームの後に届いた前 Group の delta」だった
- 今日の変更前 (keyframeInterval の既定を 60 にする前) の devtools でも、keyframeInterval を 60 にすると同じ逆転が起きる (574 件中 74 件)。keyframeInterval 3600 (Group が 120 秒) では逆転は 0 件だった

## 設計方針

Group の順序と欠落から「この Object を復号してよいか」を決める純粋なクラスをライブラリに置き、`createMediaSubscriber` と devtools の両方で使う。

- 復号中の Group より古い Group の Object は復号しない (古い Group として捨てる)
- キーフレームは、復号中の Group より新しい Group なら復号を始め直す。復号を始めていないときも同じ
- 同じ Group の delta は、直前に復号した Object の次の Object ID のときだけ復号する。間の Object ID が欠けている場合は、Prior Object ID Gap (Section 10.9) がその分の Object の非存在を示すときに限り連続とみなす。示さない欠けは欠落として扱い、次のキーフレームまで delta を捨てる (Section 2.1: 欠けた Object ID はそれだけでは非存在を意味しない)
- 直前に復号した Object 以前の Object ID は重複か遅着として捨てる
- 新しい Group の delta が先に届いた場合 (その Group のキーフレームを受けていない) は、欠落として扱い、次のキーフレームまで delta を捨てる
- decoder を作り直したときは状態を初期化し、キーフレームから始める
- 1 Group の Object を 1 本の Subgroup で送る publisher (moqt-js の publisher と moqt-devtools) を前提とする。1 Group を複数の Subgroup に分ける publisher の Object ID の飛びも欠落として扱う (復号できるかを受信側が判断できないため、崩れた映像ではなくキーフレーム待ちに倒す)
- 捨てた数を理由ごとに数え、ライブラリの `VideoReceiverStats` と devtools の購読の統計 (`window.moqtDevTools.getSubscribers()`) に出す

音声は Object ごとに独立して復号できるため対象外とする。

## 完了条件

- 純粋なクラスについて fast-check で次を固定する: 任意の到着順で、復号する Object は「キーフレーム」か「直前に復号した Object と同じ Group の次の Object (Prior Object ID Gap で埋まる欠けを含む)」であり、復号する Group は非減少である
- 単体テストで次を固定する: 前の Group の遅着 delta を捨てる、Group 内の欠落の後はキーフレームまで捨てる、Prior Object ID Gap で埋まる欠けは連続とみなす、キーフレームより前に届いた delta を捨てる
- `createMediaSubscriber` と devtools が同じクラスを通して復号し、捨てた数を統計に出す
- 配備 relay + devtools で映像が崩れないことを実測する (decoder に渡る chunk に前 Group の遅着 delta が 0 件)
- `vp check` と全テスト (vitest) が通る
