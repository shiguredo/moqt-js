/**
 * Uint8Array 連結の共通ヘルパー
 *
 * MOQT のエンコーダは「ワイヤフォーマットのフィールド順に Uint8Array を
 * 配列へ積み、最後に 1 つの Uint8Array へ連結する」パターンを繰り返す。
 * 連結処理 (合計長の算出 → 1 回の領域確保 → 順次 set) をここに集約する。
 *
 * draft-ietf-moq-transport-23: 各メッセージのエンコーディングは
 * Section 9 (Control Messages) / Section 11 (Data Streams and Datagrams) が
 * 個別に定義する。本モジュールはバイト列の連結のみを担い、値の解釈はしない。
 * 節番号は仕様将来版で変わる可能性がある。
 */

/**
 * Uint8Array の配列を 1 つの Uint8Array に連結する
 *
 * 要素数 0 の場合は長さ 0 の Uint8Array を返す。各要素の内容はコピーされる
 * (呼び出し側が渡した配列を後から変更しても結果は変わらない)。
 *
 * @param arrays - 連結するバイト列 (この順序で連結する)
 * @param totalLength - 呼び出し元で集計済みなら、各配列の合計バイト数を渡す
 * @returns 連結後のバイト列
 */
export function concatUint8Arrays(
  arrays: Uint8Array[],
  totalLength = arrays.reduce((sum, array) => sum + array.length, 0),
): Uint8Array {
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const array of arrays) {
    result.set(array, offset);
    offset += array.length;
  }
  return result;
}

/**
 * 2 つのバイト列が等しいかどうかを返す
 */
export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

const EMPTY_BYTES = new Uint8Array(0);

/**
 * ストリームで受け取った未消費のバイト列。
 *
 * 読取位置を進めて処理済みの領域を残し、容量が足りないときだけ詰め直すか拡張する。
 * 断片が続いても、到着するたびに未消費のバイト列全体をコピーする必要がない。
 */
export class ReceiveBuffer {
  private start = 0;
  private end: number;

  /** 初期バイト列を渡した場合は所有権を引き継ぐ。 */
  constructor(private storage: Uint8Array = EMPTY_BYTES) {
    this.end = storage.byteLength;
  }

  get byteLength(): number {
    return this.end - this.start;
  }

  /** 次の変更まで有効な読取用ビュー。長く保持するデータは呼び出し側でコピーする。 */
  view(): Uint8Array {
    return this.storage.subarray(this.start, this.end);
  }

  append(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    if (this.end + chunk.byteLength > this.storage.byteLength) {
      const unread = this.byteLength;
      const required = unread + chunk.byteLength;
      // 空いた領域が未消費分以上なら詰め直す。読取位置が少し進んだだけなら
      // 倍増して、少量の読み書きで詰め直しを繰り返さない。
      if (this.start >= unread && required <= this.storage.byteLength) {
        this.storage.copyWithin(0, this.start, this.end);
      } else {
        const next = new Uint8Array(Math.max(required, this.storage.byteLength * 2));
        next.set(this.view());
        this.storage = next;
      }
      this.start = 0;
      this.end = unread;
    }
    this.storage.set(chunk, this.end);
    this.end += chunk.byteLength;
  }

  consume(count: number): void {
    if (count === 0) return;
    const unread = this.byteLength - count;
    if (unread === 0) {
      this.clear();
    } else if (unread * 4 <= this.storage.byteLength) {
      // 大きなフレームの残りが少量なら領域を縮め、次の read 中に余分な容量を保持しない。
      this.storage = this.storage.slice(this.start + count, this.end);
      this.start = 0;
      this.end = unread;
    } else {
      this.start += count;
    }
  }

  clear(): void {
    this.storage = EMPTY_BYTES;
    this.start = 0;
    this.end = 0;
  }
}
