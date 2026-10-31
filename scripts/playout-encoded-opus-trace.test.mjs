/** NetEq 比較に使う符号化済みの入力を、欠けたパケット列のまま採用しない。 */
import { test, assert } from "vite-plus/test";
import {
  encodedOpusReplayPackets,
  matchReceivedOpusPackets,
} from "./playout-encoded-opus-trace.mjs";

function recording() {
  return {
    valid: true,
    decodedFrames: [{ timestamp: 0 }, { timestamp: 20000 }],
    packets: [
      { sequence: 0, timestamp: 0xfffffce0, bytes: 2, payload: [0x78, 0], releasedAtMs: 1000 },
      { sequence: 1, timestamp: 160, bytes: 2, payload: [0x78, 1], releasedAtMs: 1020 },
    ],
  };
}

test("RTP 時刻の周回を保ち、同じ Opus バイト列と解放間隔を取り出す", () => {
  const result = encodedOpusReplayPackets(recording());
  assert.deepEqual(result, [
    { timestampMicros: 0, atMs: 0, payload: [0x78, 0] },
    { timestampMicros: 20000, atMs: 20, payload: [0x78, 1] },
  ]);
});

test("無効な測定、パケットの欠落、時刻の不一致と壊れたバイト列を拒否する", () => {
  const valid = recording();
  for (const invalid of [
    { ...valid, valid: false },
    { ...valid, packets: valid.packets.slice(1) },
    { ...valid, decodedFrames: [{ timestamp: 0 }, { timestamp: 40000 }] },
    ...[
      { sequence: 0 },
      { bytes: 3 },
      { payload: undefined },
      { payload: [256, 0] },
      { payload: [Number.NaN, 0] },
      { releasedAtMs: 999 },
    ].map((change) => ({
      ...valid,
      packets: [valid.packets[0], { ...valid.packets[1], ...change }],
    })),
  ])
    assert.throws(() => encodedOpusReplayPackets(invalid));
});

test("受信直前に複製した Opus が送信内容と一致し、配送時間が前後しないことを確かめる", () => {
  // 実パケットの保存形式を検査する。ネットワークやデコーダーの代用品は使わない。
  const sent = recording().packets;
  const received = sent.map((packet) => ({ ...packet, releasedAtMs: packet.releasedAtMs + 1.5 }));
  assert.deepEqual(matchReceivedOpusPackets(sent, received), {
    matchedPackets: 2,
    minimumDeliveryMs: 1.5,
    maximumDeliveryMs: 1.5,
  });
  for (const invalid of [
    [{ ...received[0], payload: [0, 1] }],
    [{ ...received[0], timestamp: 123 }],
    [{ ...received[0], releasedAtMs: 999 }],
    [received[0], received[0]],
  ])
    assert.throws(() => matchReceivedOpusPackets(sent, invalid));
});

test("大きな絶対時刻の 1 ULP の丸めだけを許し、配送時間を丸めて隠さない", () => {
  // 実測した -0.000244140625 ms は、この大きさの絶対時刻の 1 ULP に一致する。
  const epoch = 1793430000000;
  const unit = 2 ** (Math.floor(Math.log2(epoch)) - 52);
  const sent = [{ timestamp: 123, releasedAtMs: epoch, payload: [0xf8, 0xff, 0xfe] }];
  const received = [{ ...sent[0], releasedAtMs: epoch - unit }];
  const result = matchReceivedOpusPackets(sent, received);
  assert.equal(result.minimumDeliveryMs, -unit, "保存する差分自体は変更しないこと");
  // 隣接する浮動小数点数の丸めを超える逆行は拒否する。
  assert.throws(() =>
    matchReceivedOpusPackets(sent, [{ ...sent[0], releasedAtMs: epoch - 2 * unit }]),
  );
});
