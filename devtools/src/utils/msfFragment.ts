/**
 * MSF URI Fragment の解析
 *
 * MOQT URI / URI Fragment の入力欄から msf fragment を取り出し、draft-ietf-moq-msf-01 §11.1 の
 * 形式で解析する。c4m の取り出し (`utils/c4m.ts`) と同じく、入力途中の値でも例外を投げない。
 */

import { parseMsfFragmentValue, type MsfFragmentValue } from "moqt-js";

/**
 * 入力から msf fragment の値を解析する
 *
 * 入力は `moqt://example.com/moqt#msf:room-123--catalog&c4m=...` のような URL 全体、
 * または `msf:room-123--catalog&c4m=...` のような fragment 単体を受け付ける。
 * fragment が `msf:` で始まらない場合、および値を解析できない場合は undefined を返す
 * (入力途中の値を渡しても例外を投げない)。
 *
 * draft-ietf-moq-msf-01 §11.1.2: track-identifier の `--` より左が Track Namespace の
 * フィールド列、右が Track Name になる。
 */
export function parseMsfFragmentFromInput(input: string): MsfFragmentValue | undefined {
  // `#` 以降を fragment として扱う。`#` が無い場合は入力全体を fragment とみなす
  const hashIndex = input.indexOf("#");
  const fragment = hashIndex === -1 ? input : input.slice(hashIndex + 1);
  if (!fragment.startsWith("msf:")) {
    return undefined;
  }
  try {
    return parseMsfFragmentValue(fragment.slice("msf:".length));
  } catch {
    return undefined;
  }
}
