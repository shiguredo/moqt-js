/**
 * 動的キーでフィールドを設定するヘルパー
 *
 * `JSON.parse` は `"__proto__"` を own data property として作るため `Object.keys` に
 * 現れる。これを通常の代入 (`record[key] = value`) で別のオブジェクトへ写すと、継承した
 * `Object.prototype` の `__proto__` setter が呼ばれ、写した先の `[[Prototype]]` が
 * 差し替わる。差し替わると本来無いプロパティが継承経由で見え、null プロトタイプに
 * された場合は `Object.prototype` のメソッドを継承経由で呼べなくなる。値は受信した
 * JSON であり攻撃者が制御できる。
 *
 * MSF Catalog の未知フィールド保持 (draft-ietf-moq-msf-01 §5 / §5.4) のように、外部から
 * 来た JSON のキーをそのまま使ってフィールドを写す箇所で使う。利用者側で複製するときは
 * `Object.assign` (内部で `[[Set]]` を使う) ではなく spread を使う。
 */

/**
 * `record[key]` へ値を設定する。
 *
 * `key` が `"__proto__"` のときだけ `Object.defineProperty` で own data property を作り、
 * それ以外は通常の代入にする。属性は writable / enumerable / configurable をすべて true
 * とし、`JSON.parse` が作る own data property と同じ形にする。これにより以降の代入・
 * spread・`JSON.stringify` の扱いが `JSON.parse` 由来の値と一致し、round-trip が保たれる。
 *
 * 呼び出し元が渡す `record` は新しく作ったオブジェクトに限る (`Object.defineProperty` は
 * 非 extensible なオブジェクトや非 configurable な own `__proto__` に対して throw する)。
 */
export function setOwnField(record: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") {
    // 通常の代入では Object.prototype の setter が呼ばれ [[Prototype]] が差し替わるため、
    // own data property として定義する。
    Object.defineProperty(record, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return;
  }
  record[key] = value;
}
