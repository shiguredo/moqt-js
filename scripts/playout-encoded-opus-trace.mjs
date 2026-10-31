/** 同一入力で比較するため、PCM に加えて符号化済み Opus と解放時刻を保存する。 */
export function encodedOpusReplayPackets(trace) {
  if (
    trace?.valid !== true ||
    !Array.isArray(trace.packets) ||
    trace.packets.length < 2 ||
    trace.packets.length !== trace.decodedFrames?.length
  )
    throw new Error("Expected valid matching encoded packets and decoded frames");
  const first = trace.packets[0];
  return trace.packets.map((packet, index) => {
    const timestampMicros = Math.round(
      (((packet.timestamp - first.timestamp) >>> 0) / 48000) * 1000000,
    );
    if (
      packet.sequence !== index ||
      !Number.isInteger(packet.timestamp) ||
      packet.timestamp < 0 ||
      packet.timestamp > 0xffffffff ||
      !Number.isFinite(packet.releasedAtMs) ||
      (index > 0 && packet.releasedAtMs < trace.packets[index - 1].releasedAtMs) ||
      timestampMicros !== trace.decodedFrames[index].timestamp ||
      !Array.isArray(packet.payload) ||
      packet.payload.length === 0 ||
      packet.payload.length !== packet.bytes ||
      !packet.payload.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
    )
      throw new Error(`Invalid encoded Opus replay packet: ${index}`);
    return {
      timestampMicros,
      atMs: packet.releasedAtMs - first.releasedAtMs,
      payload: packet.payload,
    };
  });
}

/** 受信側の復号直前に複製したパケットを、実際の送信内容と照合する。 */
export function matchReceivedOpusPackets(sent, received) {
  if (!Array.isArray(sent) || !Array.isArray(received) || received.length === 0)
    throw new Error("Expected nonempty sent and received Opus packets");
  const byTimestamp = new Map(sent.map((packet) => [packet.timestamp, packet]));
  const seen = new Set();
  const delays = [];
  for (const packet of received) {
    const source = byTimestamp.get(packet.timestamp);
    const delay = packet.releasedAtMs - source?.releasedAtMs;
    // Worker ごとの timeOrigin + now を大きな絶対時刻へ丸めた 1 ULP だけを許す。
    // 時計の精度や配送のゆらぎの許容幅は広げず、記録した差分も丸めない。
    const roundoffMs =
      Number.EPSILON *
      Math.max(1, Math.abs(packet.releasedAtMs), Math.abs(source?.releasedAtMs ?? 0));
    if (
      source === undefined ||
      seen.has(packet.timestamp) ||
      !Number.isFinite(delay) ||
      delay < -roundoffMs ||
      source.payload.length !== packet.payload?.length ||
      !source.payload.every((value, index) => value === packet.payload[index])
    )
      throw new Error(
        `Received Opus packet does not match sent packet: timestamp=${packet.timestamp}, source=${source !== undefined}, sentFirst=${sent[0]?.timestamp}, receivedFirst=${received[0]?.timestamp}, sentBytes=${source?.payload.length}, receivedBytes=${packet.payload?.length}, deliveryMs=${delay}`,
      );
    seen.add(packet.timestamp);
    delays.push(delay);
  }
  return {
    matchedPackets: received.length,
    minimumDeliveryMs: Math.min(...delays),
    maximumDeliveryMs: Math.max(...delays),
  };
}
