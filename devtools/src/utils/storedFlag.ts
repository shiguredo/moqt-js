/**
 * ブラウザに覚えておく on / off の値 (画面の欄の開け閉めなど)
 *
 * 見る人ごとの使い勝手のための値で、覚えられなくても画面は動く。localStorage が無い、または
 * 使えない (プライベートウィンドウ、保存の拒否など) ときは既定の値を使い、書けなくても投げない。
 */

const STORED_TRUE = "1";
const STORED_FALSE = "0";

/**
 * 覚えた文字列を on / off にする
 *
 * @param raw - localStorage から読んだ値 (覚えていなければ null)
 * @param fallback - 覚えていない、または読めない値のときに使う既定の値
 */
export function parseStoredFlag(raw: string | null, fallback: boolean): boolean {
  if (raw === STORED_TRUE) {
    return true;
  }
  if (raw === STORED_FALSE) {
    return false;
  }
  return fallback;
}

/**
 * 覚えた on / off を読む
 *
 * localStorage が使えないときは既定の値を返す
 */
export function readStoredFlag(key: string, fallback: boolean): boolean {
  try {
    return parseStoredFlag(localStorage.getItem(key), fallback);
  } catch {
    // localStorage が無い (Node) か、使えない (保存の拒否など)
    return fallback;
  }
}

/**
 * on / off を覚える
 *
 * localStorage が使えないときは何もしない (今の画面の状態は変わらない)
 */
export function writeStoredFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? STORED_TRUE : STORED_FALSE);
  } catch {
    // 覚えられなくても、今の画面の開け閉めはそのまま使える
  }
}
