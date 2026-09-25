/**
 * shouldSendAudioAsDatagram のテスト
 *
 * Datagram を選んでも、WT-H2 (reliable-only) では Subgroup で送る。
 */

import { assert, test } from "vite-plus/test";
import { shouldSendAudioAsDatagram } from "./audioDelivery";

test("Subgroup を選んだときは datagram で送らない", () => {
  assert.equal(shouldSendAudioAsDatagram("subgroup", "supports-unreliable"), false);
  assert.equal(shouldSendAudioAsDatagram("subgroup", undefined), false);
});

test("Datagram を選んで WT-H3 または reliability 不明のときは datagram で送る", () => {
  assert.equal(shouldSendAudioAsDatagram("datagram", "supports-unreliable"), true);
  // 安定版 Chromium は reliability を出さない。接続は HTTP/3 なので datagram を使う
  assert.equal(shouldSendAudioAsDatagram("datagram", undefined), true);
});

test("Datagram を選んでも WT-H2 では Subgroup で送る", () => {
  assert.equal(shouldSendAudioAsDatagram("datagram", "reliable-only"), false);
});
