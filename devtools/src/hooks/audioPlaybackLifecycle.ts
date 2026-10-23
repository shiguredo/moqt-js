/**
 * 音声の再生 (AudioContext と `<audio>`) の開始・停止の判定
 *
 * 音声の再生の開始は AudioContext の生成・`resume()`・`<audio>` の `play()` をまたいで
 * await するため、その間に停止が始まり完了することがある。停止の前後で何を残すか・何を
 * 有効とするかは、フックの中に条件を散らすと経路によってずれる。ここに判定と後始末の形で
 * 置き、ブラウザ API を使わずに検証する。
 *
 * 判定はオブジェクトの同一性だけを見るため、対象の型を限定しない (テストでは同一性の
 * トークンとして名前を持つだけのオブジェクトを渡す)。
 */

/**
 * 停止したあとに残す再生の入口を決める
 *
 * 停止の drain の間に購読がやり直されて入口が作り直されることがある。停止した入口を
 * 捨てるときに、今の入口がそれと同じなら null にし、作り直されていれば今の入口を残す。
 *
 * @param current - 今の再生の入口
 * @param stopping - 停止した再生の入口
 * @returns 残す入口。今の入口が停止した入口と同じなら null
 */
export function playoutToKeepAfterStop<T>(current: T | null, stopping: T | null): T | null {
  return current === stopping ? null : current;
}

/**
 * 再生中の AudioContext を、作り直した入口へ鳴らす先として付けるかを決める
 *
 * 停止の drain の途中は、その AudioContext をまもなく閉じるため付けない。付けると、閉じる
 * Context を新しい入口が掴んだままになり、次の音を閉じた Context へ予約してしまう。
 *
 * @param playback - 再生中の audio graph (無ければ null)
 * @param isStopping - 停止の drain の途中か
 * @returns 付けるか。true のとき `playback` は非 null
 */
export function shouldAttachAudioPlayback<T>(
  playback: T | null,
  isStopping: boolean,
): playback is T {
  return playback !== null && !isStopping;
}

/**
 * 開始した音声の再生が、await のあとも今の再生かを決める
 *
 * 開始の途中に停止が始まると、停止は開始が作った AudioContext を閉じ、再生の対象を null に
 * する。停止が完了すると停止中かどうかも false に戻るため、停止中かどうかだけでは開始が
 * 今も有効かを判定できない (停止完了後に有効と誤判定する)。開始に使った audio graph が
 * 今も再生の対象であることと、停止中でないことの両方で判定する。
 *
 * @param current - 今の再生の対象
 * @param started - 開始に使った audio graph
 * @param isStopping - 停止の drain の途中か
 * @returns 開始した再生が今も有効か
 */
export function isAudioPlaybackStartCurrent<T>(
  current: T | null,
  started: T,
  isStopping: boolean,
): boolean {
  return current === started && !isStopping;
}

/**
 * 開始を今の再生として確定するときに注入する処理 (テストでは記録用の関数を渡す)
 *
 * 判定は値で受け取り、後始末だけを関数として注入する。フックでは「今の再生の対象か」を
 * `audioPlaybackRef` で、「停止中か」を `SubscriberAudioStop` で調べる。
 */
export interface AudioPlaybackStartSettlement {
  /** 開始に使った audio graph が今も再生の対象か */
  readonly isCurrent: boolean;
  /** 停止の drain の途中か */
  readonly isStopping: boolean;
  /** 今の再生として確定する (鳴らす先を付け、有効にする) */
  readonly commit: () => void;
  /** 開始が作った audio graph を捨てる (AudioContext を閉じる) */
  readonly discard: () => Promise<void>;
}

/**
 * await を終えた開始を、今の再生として確定するかを決めて後始末する
 *
 * 開始の途中に停止が始まるか、停止の後に新しい開始が始まることがある。古い開始が新しい
 * 再生の共有の `<audio>` を止めたり、停止の drain が閉じる Context を二重に閉じたりしない
 * よう、判定と後始末をこの 1 か所にまとめる。
 *
 * - 停止の drain の途中: 停止が Context を閉じるため、何もしない (discard も commit もしない)
 * - 新しい開始に置き換えられた: 共有の `<audio>` は触らず、自分が作った Context だけ閉じる
 * - 今の再生のまま: commit する
 *
 * @param settlement - 判定と後始末
 * @returns 今の再生として確定したか
 */
export async function settleAudioPlaybackStart(
  settlement: AudioPlaybackStartSettlement,
): Promise<boolean> {
  if (settlement.isStopping) {
    return false;
  }
  if (!settlement.isCurrent) {
    await settlement.discard();
    return false;
  }
  settlement.commit();
  return true;
}

/**
 * 開始の途中で対象が変わったときに、開始が作ったものだけを捨てる
 *
 * 停止の drain の途中は停止が Context を閉じるため何もしない。そうでなければ (新しい開始に
 * 置き換えられた) 自分が作った Context だけを閉じる。共有の `<audio>` は新しい開始のものに
 * なり得るため触らない。
 *
 * @param isStopping - 停止の drain の途中か
 * @param discard - 開始が作った audio graph を捨てる
 */
export async function discardStaleAudioPlaybackStart(
  isStopping: boolean,
  discard: () => Promise<void>,
): Promise<void> {
  if (isStopping) {
    return;
  }
  await discard();
}
