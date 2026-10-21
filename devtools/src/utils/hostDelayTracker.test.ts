/**
 * HostDelayTracker (メインスレッドの停止と音声の到着の重なり) の単体テスト
 *
 * 停止区間と到着の間隔が重なるかどうかを、内側・外側・境界・複数の停止・古い停止の
 * 破棄について固定する。時刻はすべて `performance.now()` と同じ軸のミリ秒である。
 */

import { test, assert } from "vite-plus/test";
import { EMPTY_HOST_DELAY, HOST_DELAY_WINDOW_MS, HostDelayTracker } from "./hostDelayTracker";

// 停止区間の内側で観測された到着を、重なった到着として数える。
test("HostDelayTracker: 停止区間の内側の到着を数える", () => {
  const tracker = new HostDelayTracker();
  // 90 ms から 150 ms にかけて続いた到着の待ちの間に、100 ms から 200 ms の停止がある
  tracker.recordArrival(90);
  tracker.recordArrival(150);
  tracker.recordStall(100, 100);

  const snapshot = tracker.snapshot(250);
  assert.equal(snapshot.stallCount, 1);
  assert.equal(snapshot.stallMs, 100);
  assert.equal(snapshot.overlappedArrivalCount, 1, "停止の間の待ちで観測された到着を数えること");
});

// 停止区間の外側だけで観測された到着は数えない。
test("HostDelayTracker: 停止区間の外側の到着は数えない", () => {
  const before = new HostDelayTracker();
  // 停止より前に到着が終わっている
  before.recordArrival(700);
  before.recordArrival(800);
  before.recordStall(1_000, 200);
  assert.equal(before.snapshot(1_300).overlappedArrivalCount, 0, "停止より前の到着を数えないこと");

  const after = new HostDelayTracker();
  // 停止より後に到着が始まり、その間隔も停止の後に閉じている
  after.recordArrival(1_300);
  after.recordArrival(1_400);
  after.recordStall(1_000, 200);
  assert.equal(after.snapshot(1_500).overlappedArrivalCount, 0, "停止より後の到着を数えないこと");
});

// 到着が停止の始まり・終わりに接する場合は、停止の外側の到着として扱う。
test("HostDelayTracker: 停止区間の境界に接する到着は数えない", () => {
  // 停止の始まった瞬間に到着した (直前の到着との間隔は停止の前で閉じている)
  const atStart = new HostDelayTracker();
  atStart.recordArrival(990);
  atStart.recordArrival(1_000);
  atStart.recordStall(1_000, 200);
  assert.equal(
    atStart.snapshot(1_300).overlappedArrivalCount,
    0,
    "停止の開始時刻ちょうどの到着を数えないこと",
  );

  // 停止の終わった瞬間が直前の到着であり、次の到着は停止の後である
  const afterEnd = new HostDelayTracker();
  afterEnd.recordArrival(1_200);
  afterEnd.recordArrival(1_250);
  afterEnd.recordStall(1_000, 200);
  assert.equal(
    afterEnd.snapshot(1_300).overlappedArrivalCount,
    0,
    "停止の終了時刻から始まる間隔を数えないこと",
  );
});

// 停止の終わった瞬間に到着した音は、停止の間の待ちを含むため数える。
test("HostDelayTracker: 停止の終了時刻に到着した音を数える", () => {
  const tracker = new HostDelayTracker();
  tracker.recordArrival(1_100);
  tracker.recordArrival(1_200);
  tracker.recordStall(1_000, 200);

  assert.equal(
    tracker.snapshot(1_300).overlappedArrivalCount,
    1,
    "停止の終了時刻ちょうどの到着を数えること",
  );
});

// 複数の停止があっても、1 つの到着は 1 回だけ数える。停止の回数と合計はそれぞれ足す。
test("HostDelayTracker: 複数の停止を数え、到着は重なった分だけ 1 回ずつ数える", () => {
  const tracker = new HostDelayTracker();
  // 停止の外側の到着だけを置く (実際には停止の間はコールバックが動かない)
  tracker.recordArrival(50);
  tracker.recordArrival(250);
  tracker.recordArrival(400);
  // 100 ms から 200 ms と、300 ms から 350 ms の 2 回の停止
  tracker.recordStall(100, 100);
  tracker.recordStall(300, 50);

  const snapshot = tracker.snapshot(500);
  assert.equal(snapshot.stallCount, 2);
  assert.equal(snapshot.stallMs, 150);
  // (50, 250] は最初の停止と、(250, 400] は 2 つ目の停止と重なる。停止が 2 回でも、
  // 到着は重なった間隔の数だけ数える
  assert.equal(snapshot.overlappedArrivalCount, 2, "停止ごとに到着を 1 回ずつ数えること");
});

// 1 つの到着の間隔が 2 つの停止と重なっても、その到着は 1 回だけ数える。
test("HostDelayTracker: 2 つの停止にまたがる到着を 1 回だけ数える", () => {
  const tracker = new HostDelayTracker();
  tracker.recordArrival(0);
  tracker.recordArrival(400);
  tracker.recordStall(100, 50);
  tracker.recordStall(200, 50);

  assert.equal(
    tracker.snapshot(500).overlappedArrivalCount,
    1,
    "複数の停止と重なる到着を 1 回だけ数えること",
  );
});

// 窓より古い停止は捨て、その停止と重なっていた到着も数えない。
test("HostDelayTracker: 窓より古い停止を捨てる", () => {
  const tracker = new HostDelayTracker(HOST_DELAY_WINDOW_MS);
  tracker.recordArrival(1_000);
  tracker.recordArrival(1_100);
  tracker.recordStall(1_000, 200);
  assert.equal(tracker.snapshot(1_200).overlappedArrivalCount, 1);

  // 窓の長さより後に統計を読むと、停止も到着も窓の外になる
  const snapshot = tracker.snapshot(1_000 + HOST_DELAY_WINDOW_MS + 500);
  assert.equal(snapshot.stallCount, 0, "古い停止を数えないこと");
  assert.equal(snapshot.stallMs, 0, "古い停止の長さを足さないこと");
  assert.equal(snapshot.overlappedArrivalCount, 0, "古い停止との重なりを数えないこと");
});

// 停止の報告が到着より後に届いても、記録した順序に依らず重なりを数える。
test("HostDelayTracker: 停止の報告が到着より後でも重なりを数える", () => {
  const tracker = new HostDelayTracker();
  tracker.recordArrival(100);
  tracker.recordArrival(250);
  // 停止の報告は止まった後に届く (到着の記録より後になる)
  tracker.recordStall(150, 200);

  assert.equal(
    tracker.snapshot(500).overlappedArrivalCount,
    1,
    "停止の報告の順序に依らず重なりを数えること",
  );
});

// 長さ 0 や不正な値の停止は数えない (longtask は 50 ms 以上だが、純粋な論理として弾く)。
test("HostDelayTracker: 不正な停止区間を記録しない", () => {
  const tracker = new HostDelayTracker();
  tracker.recordStall(100, 0);
  tracker.recordStall(Number.NaN, 100);
  tracker.recordStall(100, Number.POSITIVE_INFINITY);
  assert.deepEqual(tracker.snapshot(1_000), EMPTY_HOST_DELAY);
});

// 記録を消すと、停止も到着も数えない。
test("HostDelayTracker: reset で記録を消す", () => {
  const tracker = new HostDelayTracker();
  tracker.recordArrival(100);
  tracker.recordArrival(150);
  tracker.recordStall(120, 50);

  tracker.reset();

  assert.deepEqual(tracker.snapshot(200), EMPTY_HOST_DELAY);
});
