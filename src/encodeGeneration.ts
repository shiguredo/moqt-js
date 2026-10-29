/**
 * 符号化の出力を送るかどうかの判定 (映像)
 *
 * WebCodecs の `VideoEncoder` の出力は、依頼した順に届く保証が無い (既定の `latencyMode` は
 * `"quality"` であり、実装によっては並べ替わる)。そのため到着順ではなく、**符号化を依頼した
 * 時点の世代**を入力フレームの `timestamp` を鍵にして記録し、出力の `timestamp` で引いて
 * 現在の世代と比べる。
 * ただし、停止前後の世代で同じ timestamp を再利用した場合は、出力の timestamp だけでは
 * どちらの世代の入力か区別できない。同一世代内の重複は未出力数として保持する。
 *
 * これは配信を止める経路のために要る。止めた時点で開いている Subgroup を閉じる
 * (draft-ietf-moq-transport-22 §11.3.2) ため、止める前に依頼した出力を閉じた Subgroup へ
 * 送ってはならない。停止と再開をまたいだ古い出力が、新しい Group の先頭 Object として
 * 送られるのも防ぐ (Group の先頭はキーフレームでなければならない)。
 *
 * ライブラリ (src/createMediaPublisher.ts) と moqt-devtools
 * (devtools/src/hooks/usePublisher.ts) が同じ規則を使う。片方だけ直すと静かに食い違うため、
 * 規則はここに 1 つだけ置く。
 */

/** timestamp ごとの世代と未出力数。同じ取得時刻の複数フレームも別々に数える。 */
export type EncodeGenerationRecords = Map<number, { readonly generation: number; pending: number }>;

/**
 * 符号化を依頼した時点の世代を記録する
 *
 * @param records - 記録先 (入力フレームの timestamp を鍵にする)
 * @param generation - 依頼した時点の世代 (送信を止めるたびに進む)
 * @param timestamp - 入力フレームの `timestamp` (`EncodedVideoChunk.timestamp` に写る)
 */
export function recordEncodeGeneration(
  records: EncodeGenerationRecords,
  generation: number,
  timestamp: number,
): void {
  const previous = records.get(timestamp);
  if (previous?.generation === generation) {
    // WebCodecs は同じ timestamp の入力も符号化する。後の依頼で上書きすると、片方の
    // 出力を送らず参照フレームが欠けるため、現在の世代で残っている枚数を増やす。
    previous.pending += 1;
  } else {
    records.set(timestamp, { generation, pending: 1 });
  }
}

/**
 * 出力を送るかどうかを決める
 *
 * 取り出した枚数を減らし、すべて出力された timestamp の記録は消す。記録が無い出力
 * (配信を始める前の出力、配信ごとの初期化で記録を消した後の出力) も送らない。
 *
 * @param records - 符号化を依頼した時点の世代の記録
 * @param currentGeneration - いまの世代
 * @param timestamp - 出力の `EncodedVideoChunk.timestamp`
 * @returns 送る場合は true
 */
export function shouldSendEncodedChunk(
  records: EncodeGenerationRecords,
  currentGeneration: number,
  timestamp: number,
): boolean {
  const record = records.get(timestamp);
  if (record === undefined) return false;
  if (record.generation !== currentGeneration) {
    records.delete(timestamp);
    return false;
  }
  record.pending -= 1;
  if (record.pending === 0) records.delete(timestamp);
  return true;
}

/**
 * 映像の符号化出力を送るかの判定に使う状態
 *
 * ライブラリの `MediaPublisher` はループの世代 (`processingGeneration`) をそのまま使うため
 * この型を使わないが、moqt-devtools は自前の世代を持つためこの型でまとめる。
 */
export interface EncodeState {
  /** いまの世代。送信を止めるたびに進む */
  generation: number;
  /** 符号化を依頼した時点の世代 (入力フレームの timestamp を鍵にする) */
  readonly records: EncodeGenerationRecords;
}

/**
 * 送信を止めるときの状態遷移: 世代を進め、記録を消す
 *
 * Encoder を閉じた後も emit 済みの出力はコールバックへ届き得る。世代を進めることで、
 * 止める前に依頼した出力を閉じた Subgroup へ送らない (draft-ietf-moq-transport-22
 * §11.3.2)。記録を消すのは次の配信へ持ち越さないためである。
 *
 * ライブラリの MediaPublisher は使わない。世代が処理ループの制御と共有されており、進める
 * 主体 (pause() / stop() / close() と配信ごとの初期化) が分かれているため、世代と記録を
 * 1 つのオブジェクトにまとめられない (`EncodeState` の JSDoc を参照)。
 */
export function advanceEncodeGeneration(state: EncodeState): void {
  state.generation += 1;
  state.records.clear();
}
