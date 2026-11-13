/**
 * Subscriber の外部リソースの解除
 *
 * `signals/subscriber.ts` の `removeSubscriber` (パネルの削除経路) と
 * `hooks/useSubscriber.ts` の `closeSubscriberResources` (停止経路) が、同じ順序で
 * 後始末を書き続けて順序を手で揃えていたのを 1 か所へ寄せる。解除は fire-and-forget で
 * 行い、完了は待たない (停止経路と同じ)。`unsubscribe` と `close` は冪等で二重実行は
 * no-op のため、両経路からの二重発火でも実害は無い。
 *
 * 解除の順序 (停止経路と同じ):
 * 映像 decoder → 音声 decoder → `onDecodersClosed` → catalog 購読 → 音声トラックの購読 →
 * event timeline トラックの購読 → SUBSCRIBE_TRACKS の購読 → 確立した PUBLISH 購読 → session。
 *
 * - decoder を閉じるのは「停止した decoder の最終フレームが残る」表示不整合を避けるため。
 *   `onDecodersClosed` のランナー (canvas の塗り潰し) は decoder を閉じた直後に行う
 * - catalog と各 track の購読は制御メッセージのため session の close より先に解除する
 *   (session.close 任せにしない)
 * - `session.value = null` を `session.close()` より先に立てる。WebTransport が close
 *   コールバックを同期 dispatch する実装で teardown が再入する可能性があるため
 */

import type { SubscriberInstance } from "../signals/subscriber";
import { addLog } from "../signals/debugLog";

/** 解除の各段で呼び出し側が挟む表示の後始末 */
export interface SubscriberResourceReleaseHooks {
  /** 映像と音声の decoder を閉じた直後に呼ぶ (canvas の塗り潰し。削除経路では省略) */
  onDecodersClosed?: () => void;
}

/**
 * `SubscriberInstance` が保持する外部リソースを解除する
 *
 * signal の値は閉じる前ではなく、解除処理の置所を null にしてから次の段へ進む
 * (解除前の null チェックと解除後の null 化で逐次二重を抑止し、失敗は握り潰す)。
 * 再生トグルや panel 表示の状態は触らない (呼び出し側の責務)。
 *
 * @param instance - 対象の Subscriber インスタンス
 * @param hooks - 段の間に挟む表示の後始末 (省略可)
 */
export function releaseSubscriberResources(
  instance: SubscriberInstance,
  hooks: SubscriberResourceReleaseHooks = {},
): void {
  const decoderInstance = instance.decoder.value;
  instance.decoder.value = null;
  if (decoderInstance) {
    try {
      decoderInstance.close();
    } catch {
      // 既にクローズ済みなら無視
    }
  }

  // 音声デコーダも同じく停止する。復号途中の AudioData は decoder 側が捨てる
  const audioDecoderInstance = instance.audioDecoder.value;
  instance.audioDecoder.value = null;
  instance.audioDecoderConfigured.value = false;
  if (audioDecoderInstance) {
    try {
      audioDecoderInstance.close();
    } catch {
      // 既にクローズ済みなら無視
    }
  }

  hooks.onDecodersClosed?.();

  // catalog 購読を graceful に解除する。 session.close 任せにしない。
  // 制御メッセージのため session.close より先に行う。
  // 逐次二重は unsubscribe 自体の冪等に委ねる。失敗は握り潰す。
  const catalogSubscriberInstance = instance.catalogSubscriber.value;
  instance.catalogSubscriber.value = null;
  if (catalogSubscriberInstance) {
    void catalogSubscriberInstance.unsubscribe().catch(() => {
      // 送信失敗時は握り潰す (session.close と同形)
    });
  }

  // 音声トラックの購読も catalog 購読と同じ順序で解除する
  const audioSubscriberInstance = instance.audioSubscriber.value;
  instance.audioSubscriber.value = null;
  if (audioSubscriberInstance) {
    void audioSubscriberInstance.unsubscribe().catch(() => {
      // 送信失敗時は握り潰す (session.close と同形)
    });
  }

  // event timeline トラックの購読も catalog 購読と同じ順序で解除する
  const eventSubscriberInstance = instance.eventSubscriber.value;
  instance.eventSubscriber.value = null;
  if (eventSubscriberInstance) {
    void eventSubscriberInstance.unsubscribe().catch(() => {
      // 送信失敗時は握り潰す (session.close と同形)
    });
  }

  // SUBSCRIBE_TRACKS の購読を解除する。SUBSCRIBE_TRACKS の解除では既に確立した
  // PUBLISH の購読は残るため (§3.6 "Cancelling a SUBSCRIBE_TRACKS has no effect on
  // existing subscriptions.")、確立した購読も購読単位で解除する。
  const tracksSubscription = instance.tracksSubscription.value;
  instance.tracksSubscription.value = null;
  if (tracksSubscription) {
    void tracksSubscription.unsubscribe().catch(() => {
      // 送信失敗時は握り潰す (他の解除と同じ)
    });
  }
  const publishedSubscriptions = instance.publishedSubscriptions.value;
  instance.publishedSubscriptions.value = [];
  // SUBSCRIBE_TRACKS から受理した Object の累計を、解除のときに 1 回だけ残す
  // (Object ごとにログを出すと Debug パネルの上限をすぐに埋めるため)
  const publishedObjectsReceived = instance.publishedObjectsReceived.value;
  instance.publishedObjectsReceived.value = 0;
  for (const published of publishedSubscriptions) {
    void published.subscriber.unsubscribe().catch(() => {
      // 送信失敗時は握り潰す (他の解除と同じ)
    });
  }
  if (tracksSubscription !== null || publishedObjectsReceived > 0) {
    addLog("info", `[${instance.id}] [SUBSCRIBE_TRACKS] released`, {
      publishedSubscriptionsCount: publishedSubscriptions.length,
      publishedObjectsReceived,
    });
  }

  // 再入時に sessionInstance が null になっているよう close() より先に立てる。
  const sessionInstance = instance.session.value;
  instance.session.value = null;
  if (sessionInstance) {
    sessionInstance.close().catch(() => {
      // 既にクローズされている場合は無視
    });
  }
}
