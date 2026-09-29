/**
 * 網羅済みの union 型に対する防御
 *
 * すべての case を列挙した switch の default から呼び、型システム上は到達しない
 * 値が実行時に渡された場合 (JavaScript からの利用など) を検出する。関数の
 * 戻り値として使うことで、switch の網羅性と一致した return を保つ。
 */

/**
 * 到達しない値を受け取ったときに投げる
 */
export function unreachableValue(value: never): never {
  throw new Error(`unhandled value: ${String(value)}`);
}
