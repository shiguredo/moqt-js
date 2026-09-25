/**
 * Subscriber パネルの操作の可否
 *
 * 購読を始めてから確立するまで (WebTransport の接続、catalog の購読と待ち、decoder の
 * 構成、映像トラック (映像トラックの無い catalog では音声トラック) の購読) も購読中として扱う。この間は数秒から、publisher が居なければ
 * RENDEZVOUS_TIMEOUT の間続く。利用者が Stop で止められ、Start Subscribing を重ねて
 * 押せないようにする。
 */

/** 操作の可否を決める subscriber の状態 */
export interface SubscriberControlInput {
  // 購読が確立している (映像トラック、映像トラックの無い catalog では音声トラックの購読)
  subscribed: boolean;
  // 購読を始めてから、確立するか後始末を終えるまで
  starting: boolean;
  // 停止処理の最中
  stopping: boolean;
}

/** 操作の可否 */
export interface SubscriberControlState {
  // 購読中 (確立を待っている間を含む)。購読中は接続設定を変えられない
  active: boolean;
  startDisabled: boolean;
  stopDisabled: boolean;
}

/** subscriber の状態から、Start Subscribing と Stop を押せるかを決める */
export function subscriberControlState(input: SubscriberControlInput): SubscriberControlState {
  const active = input.subscribed || input.starting;
  return {
    active,
    startDisabled: active || input.stopping,
    stopDisabled: !active || input.stopping,
  };
}
