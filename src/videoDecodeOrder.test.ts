/**
 * VideoDecodeOrder の単体テスト
 *
 * 任意の損失と到着順での性質 (参照先を欠いた delta を復号しない、Group が戻らない) は
 * videoDecodeOrder.prop.ts が固定する。ここでは実際に起きる到着の形と、捨てる理由の
 * 区別を固定する。
 */

import { test, assert } from "vite-plus/test";
import { VideoDecodeOrder, type VideoObjectAdmission } from "./videoDecodeOrder";

const DECODE: VideoObjectAdmission = { decode: true };
const STALE: VideoObjectAdmission = { decode: false, reason: "stale" };
const MISSING_REFERENCE: VideoObjectAdmission = { decode: false, reason: "missing-reference" };

function key(groupId: number, objectId = 0) {
  return {
    groupId: BigInt(groupId),
    objectId: BigInt(objectId),
    isKeyFrame: true,
    priorObjectIdGap: 0n,
  };
}

function delta(groupId: number, objectId: number, priorObjectIdGap = 0) {
  return {
    groupId: BigInt(groupId),
    objectId: BigInt(objectId),
    isKeyFrame: false,
    priorObjectIdGap: BigInt(priorObjectIdGap),
  };
}

test("次の Group のキーフレームの後に届いた前の Group の delta は古いとして捨てる", () => {
  // Group ごとに別の stream で届くため、前の Group の末尾が次の Group の先頭より後に
  // 届く。前の Group の delta を復号すると、次の Group のキーフレームから始めた参照が
  // 壊れる (draft-ietf-moq-transport-21 Section 2.1)
  const decodeOrder = new VideoDecodeOrder();
  assert.deepEqual(decodeOrder.admit(key(0)), DECODE);
  assert.deepEqual(decodeOrder.admit(delta(0, 1)), DECODE);
  assert.deepEqual(decodeOrder.admit(key(1)), DECODE);
  assert.deepEqual(decodeOrder.admit(delta(0, 2)), STALE);
  assert.deepEqual(decodeOrder.admit(delta(1, 1)), DECODE);
  assert.deepEqual(decodeOrder.admit(delta(0, 3)), STALE);
  assert.deepEqual(decodeOrder.admit(delta(1, 2)), DECODE);
});

test("Group 内で Object が欠けたら、次のキーフレームまで delta を捨てる", () => {
  // Object 2 が届かない (損失、または reset された Subgroup の残り)。Object 3 以降は
  // 参照先が無いため復号しない
  const decodeOrder = new VideoDecodeOrder();
  assert.deepEqual(decodeOrder.admit(key(0)), DECODE);
  assert.deepEqual(decodeOrder.admit(delta(0, 1)), DECODE);
  assert.deepEqual(decodeOrder.admit(delta(0, 3)), MISSING_REFERENCE);
  assert.deepEqual(decodeOrder.admit(delta(0, 4)), MISSING_REFERENCE);
  // 欠けた Object が後から届いても、その先が復号できないことに変わりはない
  assert.deepEqual(decodeOrder.admit(delta(0, 2)), MISSING_REFERENCE);
  assert.deepEqual(decodeOrder.admit(key(1)), DECODE);
  assert.deepEqual(decodeOrder.admit(delta(1, 1)), DECODE);
});

test("Prior Object ID Gap が示す非存在の範囲に収まる欠けは連続とみなす", () => {
  // draft-ietf-moq-transport-21 Section 10.9: Object 3 の Prior Object ID Gap が 2 なら
  // Object 1 と 2 は存在しない。Object 3 は Object 0 の次に存在する Object である
  const decodeOrder = new VideoDecodeOrder();
  assert.deepEqual(decodeOrder.admit(key(0)), DECODE);
  assert.deepEqual(decodeOrder.admit(delta(0, 3, 2)), DECODE);
  assert.deepEqual(decodeOrder.admit(delta(0, 4)), DECODE);
});

test("Prior Object ID Gap が欠けの一部しか覆わなければ欠落として扱う", () => {
  // Object 4 の Prior Object ID Gap は 2 (Object 2 と 3 が存在しない) だが、Object 1 は
  // 非存在を示されていない。Section 2.1 は欠けた Object ID がそれだけでは何も示さない
  // とするため、Object 1 は届いていないだけかもしれない
  const decodeOrder = new VideoDecodeOrder();
  assert.deepEqual(decodeOrder.admit(key(0)), DECODE);
  assert.deepEqual(decodeOrder.admit(delta(0, 4, 2)), MISSING_REFERENCE);
});

test("キーフレームより前に届いた delta は捨てる", () => {
  // 購読を Group の途中から始めた場合と、新しい Group の delta がキーフレームより先に
  // 届いた場合。どちらも参照先のキーフレームを復号していない
  const decodeOrder = new VideoDecodeOrder();
  assert.deepEqual(decodeOrder.admit(delta(3, 5)), MISSING_REFERENCE);
  assert.deepEqual(decodeOrder.admit(key(4)), DECODE);
  assert.deepEqual(decodeOrder.admit(delta(5, 1)), MISSING_REFERENCE);
  // Group 5 でキーフレームを待ち始めたので、Group 4 の残りは古い
  assert.deepEqual(decodeOrder.admit(delta(4, 1)), STALE);
  assert.deepEqual(decodeOrder.admit(key(5)), DECODE);
});

test("直前に復号した Object 以前の Object ID は重複として捨てる", () => {
  const decodeOrder = new VideoDecodeOrder();
  assert.deepEqual(decodeOrder.admit(key(0)), DECODE);
  assert.deepEqual(decodeOrder.admit(delta(0, 1)), DECODE);
  assert.deepEqual(decodeOrder.admit(delta(0, 1)), STALE);
  assert.deepEqual(decodeOrder.admit(key(0)), STALE);
  assert.deepEqual(decodeOrder.admit(delta(0, 2)), DECODE);
});

test("reset の後はキーフレームから復号を始め、以前の Group より古い Group も古いとしない", () => {
  // decoder を作り直したときは復号の状態を持ち越さない
  const decodeOrder = new VideoDecodeOrder();
  assert.deepEqual(decodeOrder.admit(key(7)), DECODE);
  assert.deepEqual(decodeOrder.admit(delta(7, 1)), DECODE);
  decodeOrder.reset();
  // reset の前に復号した Object の次でも、キーフレームを復号し直すまでは参照先が無い
  assert.deepEqual(decodeOrder.admit(delta(7, 2)), MISSING_REFERENCE);
  decodeOrder.reset();
  // reset の前に復号していた Group 7 より古い Group 2 から始められる
  assert.deepEqual(decodeOrder.admit(key(2)), DECODE);
  assert.deepEqual(decodeOrder.admit(delta(2, 1)), DECODE);
});
