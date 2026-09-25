import { signal, computed, type Signal, type ReadonlySignal } from "@preact/signals";
import type { LOC, Session, Subscriber, Catalog } from "moqt-js";
import type { StatusType } from "../types";
import type { DecoderWrapper } from "../utils/DecoderWrapper";
import type { AudioDecoderWrapper } from "../../../src/codec/AudioDecoder.ts";
import { EMPTY_PLAYBACK_TIMING, type PlaybackTimingSnapshot } from "../utils/playbackTimingStats";

/**
 * 個々の Subscriber インスタンスの状態。
 *
 * 各フィールドは Signal で保持し、フィールド単位で購読/更新する。
 * `subscriberInstances` Map は要素追加/削除のみで再生成し、フィールド更新では
 * 再生成しない (個別 Signal が再描画を駆動する)。
 * `hasActiveSubscriber` computed は `instance.subscriber.value` / `instance.audioSubscriber.value` /
 * `instance.isStarting.value` を追跡するため Signal 化が必須。
 */
export interface SubscriberInstance {
  // props として親から渡される識別子。再描画駆動には使わないため signal 不要。
  id: string;
  session: Signal<Session | null>;
  subscriber: Signal<Subscriber | null>;
  catalogSubscriber: Signal<Subscriber | null>;
  catalog: Signal<Catalog | null>;
  decoder: Signal<DecoderWrapper | null>;
  // 状態フィールド
  decoderConfigured: Signal<boolean>;
  status: Signal<StatusType>;
  statusMessage: Signal<string>;
  codec: Signal<string>;
  // 停止処理中フラグ (二重実行防止)
  isStopping: Signal<boolean>;
  // 購読を始めてから、購読するトラック (映像があれば映像、無ければ音声) の購読が確立するか
  // 後始末を終えるまで true。
  // 確立を待っている間も Stop で止められるようにする (subscriberControlState)。
  // この間も接続設定を使っているため、hasActiveSubscriber が数える
  isStarting: Signal<boolean>;
  // NEW_GROUP_REQUEST 設定 (初回接続時に新しいグループを要求)
  newGroupRequestEnabled: Signal<boolean>;
  // 統計
  framesDecoded: Signal<number>;
  keyFramesDecoded: Signal<number>;
  objectsReceived: Signal<number>;
  currentGroup: Signal<number>;
  currentSubGroup: Signal<number>;
  bytesReceived: Signal<number>;
  // デコードパイプライン統計
  objectsWithExtensions: Signal<number>;
  chunksCreated: Signal<number>;
  chunksDecoded: Signal<number>;
  chunksSkipped: Signal<number>;
  // Group の順序と欠落で復号せずに捨てた映像フレーム数 (VideoDecodeOrder)。
  // stale は復号中の Group より古い Group の Object と重複・遅着の Object、
  // missingReference は参照するフレームが欠けてキーフレームを待つ間の Object である
  staleFramesDropped: Signal<number>;
  missingReferenceFramesDropped: Signal<number>;
  decodeErrors: Signal<number>;
  // 受信から表示までの時間の統計 (到着の揺らぎ・遅延・復号時間・表示間隔の分布と、
  // 表示の止まり・表示キューのあふれの累積)。useSubscriber が一定間隔で更新する
  playbackTiming: Signal<PlaybackTimingSnapshot>;
  decoderState: Signal<string>;
  // 最大の Location
  largestLocation: Signal<{ group: bigint; object: bigint } | null>;
  // Track Properties に DYNAMIC_GROUPS=1 が含まれているかどうか。
  // draft-ietf-moq-transport-21 §9.20.20 により、true のときのみ
  // REQUEST_UPDATE で NEW_GROUP_REQUEST を送信できる。
  dynamicGroupsSupported: Signal<boolean>;
  // 音声トラックの購読 (catalog に音声トラックが無いときは null のまま)
  audioSubscriber: Signal<Subscriber | null>;
  audioDecoder: Signal<AudioDecoderWrapper | null>;
  audioDecoderConfigured: Signal<boolean>;
  // 直近に受信した音声 object の LOC Audio Level。
  // draft-ietf-moq-loc-04 §2.3.3.2 の AUDIO_LEVEL は Object スコープのみのため、
  // Audio Level が載っていない object を受けたら null に戻す (値を持ち越さない)。
  audioLastLevel: Signal<LOC.AudioLevel | null>;
  // 音声の受信数とデコード数。
  // 受信数は decode に渡す前の object も数えるため、両者の差が「復号せずに捨てた数」に
  // なる (映像の objectsReceived / chunksDecoded と同じ関係)
  audioObjectsReceived: Signal<number>;
  audioChunksDecoded: Signal<number>;
  // 受信した音声を音声出力デバイスで再生するか。既定は無効
  audioPlaybackEnabled: Signal<boolean>;
  // 受信した音声の鳴らし方の数 (src/audioPlayout.ts)。購読ごとに数える。
  // 鳴らす時刻を過ぎて届いたなどで基準を取り直した回数と、遅れが上限を超えて捨てた音の数
  audioPlayoutRebases: Signal<number>;
  audioPlayoutDrops: Signal<number>;
  // 復号した音声のレベル (dBFS)。まだ復号していない状態は null
  audioPeakDbfs: Signal<number | null>;
  audioRmsDbfs: Signal<number | null>;
  // 直近 100 ms の波形 (第 1 チャンネル)。まだ復号していない状態は null
  audioWaveform: Signal<Float32Array | null>;
}

/**
 * 新しい Subscriber インスタンスを作成する
 */
export function createSubscriberInstance(id: string): SubscriberInstance {
  return {
    id,
    session: signal<Session | null>(null),
    subscriber: signal<Subscriber | null>(null),
    catalogSubscriber: signal<Subscriber | null>(null),
    catalog: signal<Catalog | null>(null),
    decoder: signal<DecoderWrapper | null>(null),
    decoderConfigured: signal(false),
    status: signal<StatusType>("disconnected"),
    statusMessage: signal("Ready to subscribe"),
    codec: signal(""),
    isStopping: signal(false),
    isStarting: signal(false),
    newGroupRequestEnabled: signal(false),
    framesDecoded: signal(0),
    keyFramesDecoded: signal(0),
    objectsReceived: signal(0),
    currentGroup: signal(0),
    currentSubGroup: signal(0),
    bytesReceived: signal(0),
    objectsWithExtensions: signal(0),
    chunksCreated: signal(0),
    chunksDecoded: signal(0),
    chunksSkipped: signal(0),
    staleFramesDropped: signal(0),
    missingReferenceFramesDropped: signal(0),
    decodeErrors: signal(0),
    playbackTiming: signal<PlaybackTimingSnapshot>(EMPTY_PLAYBACK_TIMING),
    decoderState: signal("unconfigured"),
    largestLocation: signal<{ group: bigint; object: bigint } | null>(null),
    dynamicGroupsSupported: signal(false),
    audioSubscriber: signal<Subscriber | null>(null),
    audioDecoder: signal<AudioDecoderWrapper | null>(null),
    audioDecoderConfigured: signal(false),
    audioLastLevel: signal<LOC.AudioLevel | null>(null),
    audioObjectsReceived: signal(0),
    audioChunksDecoded: signal(0),
    audioPlaybackEnabled: signal(false),
    audioPlayoutRebases: signal(0),
    audioPlayoutDrops: signal(0),
    audioPeakDbfs: signal<number | null>(null),
    audioRmsDbfs: signal<number | null>(null),
    audioWaveform: signal<Float32Array | null>(null),
  };
}

/**
 * 全ての Subscriber インスタンスを管理する Map
 *
 * Map は要素追加/削除のみで再生成する。インスタンス内のフィールド更新では再生成しない
 * (フィールド単位の Signal で再描画を駆動する)。
 */
export const subscriberInstances = signal<Map<string, SubscriberInstance>>(new Map());

/**
 * 衝突しない subscriber ID を生成する純粋関数。
 *
 * `generator` で短縮 ID 候補を生成し、`existingIds` と衝突したら再試行する。
 * `crypto.randomUUID` を直接置き換えるのではなく `generator` 引数として渡す
 * 設計にすることで、テストでは決定論的なクロージャを渡せる。
 *
 * @param existingIds 既存 ID の集合
 * @param generator 短縮 ID 候補を返す関数 (prefix 付きの完成 ID を返す)
 */
export function generateUniqueSubscriberId(
  existingIds: ReadonlySet<string>,
  generator: () => string,
): string {
  let candidate = generator();
  while (existingIds.has(candidate)) {
    candidate = generator();
  }
  return candidate;
}

// 本番用の短縮 ID 生成関数 (UUID v4 の先頭 8 文字)。
// HMR 時のカウンタ問題を回避するため crypto.randomUUID ベース。
function defaultSubscriberIdGenerator(): string {
  return `subscriber-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * 新しい Subscriber を追加する。
 * 短縮 ID の衝突 (32 bit 空間) が発生した場合に旧 instance が静かに上書きされて
 * WebTransport セッションと VideoDecoder がリークするのを防ぐため、
 * `generateUniqueSubscriberId` で既存 ID との衝突を回避する。
 */
export function addSubscriber(): string {
  const existingIds = new Set(subscriberInstances.value.keys());
  const id = generateUniqueSubscriberId(existingIds, defaultSubscriberIdGenerator);
  const instance = createSubscriberInstance(id);
  const newMap = new Map(subscriberInstances.value);
  newMap.set(id, instance);
  subscriberInstances.value = newMap;
  return id;
}

/**
 * Subscriber を削除する。
 *
 * Map 削除契機での外部リソース close 責務を集約する。
 * 停止経路の closeSubscriberResources (teardown 経由) と順序を揃えて
 * decoder → audioDecoder → catalog → audio subscriber → session の順で
 * fire-and-forget で解除する。close 完了は待たない。
 *
 * `Session.close` / `DecoderWrapper.close` / `AudioDecoderWrapper.close` /
 * `Subscriber.unsubscribe` は冪等で二重実行は no-op のため、停止経路との
 * 二重発火でも実害はない。
 *
 * 再生中の AudioContext は hook 側 (useSubscriber のアンマウント) が停止する。
 */
export function removeSubscriber(id: string): void {
  const instance = getSubscriber(id);
  if (instance) {
    try {
      instance.decoder.value?.close();
    } catch {
      // 既にクローズ済みなら無視
    }
    instance.decoder.value = null;

    // 音声デコーダも停止する。Worker モードでは Worker ごと破棄される
    try {
      instance.audioDecoder.value?.close();
    } catch {
      // 既にクローズ済みなら無視
    }
    instance.audioDecoder.value = null;
    instance.audioDecoderConfigured.value = false;
    // パネルが消えるため、再生トグルも既定 (無効) に戻す
    instance.audioPlaybackEnabled.value = false;

    // catalog 購読を graceful に解除する。 session.close 任せにしない。
    // 制御メッセージのため session.close より先に行う。
    // 二重解除は解除前の null チェックと解除後の null 化で抑止し、
    // 逐次二重は unsubscribe 自体の冪等に委ねる。失敗は握り潰す。
    const catalogSubscriberInstance = instance.catalogSubscriber.value;
    instance.catalogSubscriber.value = null;
    if (catalogSubscriberInstance) {
      void catalogSubscriberInstance.unsubscribe().catch(() => {
        // 送信失敗時は握り潰す (session.close と同形)
      });
    }

    // 音声トラックの購読も catalog と同じ扱いで解除する
    const audioSubscriberInstance = instance.audioSubscriber.value;
    instance.audioSubscriber.value = null;
    if (audioSubscriberInstance) {
      void audioSubscriberInstance.unsubscribe().catch(() => {
        // 送信失敗時は握り潰す (session.close と同形)
      });
    }

    instance.session.value?.close().catch(() => {
      // 既にクローズ済みなら無視
    });
  }
  const newMap = new Map(subscriberInstances.value);
  newMap.delete(id);
  subscriberInstances.value = newMap;
  // Map 差し替えで cached `computed` が undefined への変化通知を発火させた後に
  // キャッシュエントリを削除する。逆順では undefined 通知が壊れる。
  subscriberInstanceSignalCache.delete(id);
}

/**
 * Subscriber インスタンスを取得する
 */
export function getSubscriber(id: string): SubscriberInstance | undefined {
  return subscriberInstances.value.get(id);
}

/**
 * ID ごとの派生 `ReadonlySignal` キャッシュ。
 *
 * `subscriberInstances` Map 全体を購読せず、対象 ID の `SubscriberInstance`
 * 参照変化だけを通知する派生 signal を提供するためのキャッシュ。
 * テスト用にキャッシュ状態を観測できるよう export している。
 */
export const subscriberInstanceSignalCache = new Map<
  string,
  ReadonlySignal<SubscriberInstance | undefined>
>();

/**
 * 特定 ID 用の派生 `ReadonlySignal` を返す。
 *
 * `computed` の参照等値比較により、対象 ID の instance 参照が変わらない限り
 * 下流購読者には通知されない。Subscriber の追加・削除で Map 参照が
 * 差し替わっても、対象 ID 自身の instance が変化していなければ
 * `SubscriberPanel` の再評価は発生しない。
 *
 * https://github.com/preactjs/signals
 */
export function getSubscriberInstanceSignal(
  id: string,
): ReadonlySignal<SubscriberInstance | undefined> {
  let cached = subscriberInstanceSignalCache.get(id);
  if (cached === undefined) {
    cached = computed(() => subscriberInstances.value.get(id));
    subscriberInstanceSignalCache.set(id, cached);
  }
  return cached;
}

/**
 * Subscriber ID のリストを取得する computed signal
 */
export const subscriberIds = computed(() => {
  return Array.from(subscriberInstances.value.keys());
});

/**
 * 購読が確立しているか
 *
 * 映像トラックの購読があれば確立している。映像トラックの無い catalog では音声トラック
 * だけを購読するため、音声トラックの購読があるときも確立しているとみなす
 */
export function hasEstablishedSubscription(instance: SubscriberInstance): boolean {
  return instance.subscriber.value !== null || instance.audioSubscriber.value !== null;
}

/**
 * 接続設定を使っている Subscriber があるかどうか
 *
 * 購読が確立しているか (hasEstablishedSubscription)、確立を待っている (isStarting)
 * インスタンスがあれば true。
 * startSubscribing は接続の後にも Track Name や Catalog Timeout を読むため、確立を
 * 待っている間も使っているとみなす。Publisher や他の Subscriber を止めたときや、それらの開始の
 * 失敗や切断で後始末するときに、接続設定の入力を有効に戻してよいかの判定に使う
 * (cleanupPublisher / resetSubscriberState)。
 */
export const hasActiveSubscriber = computed(() => {
  for (const instance of subscriberInstances.value.values()) {
    if (hasEstablishedSubscription(instance) || instance.isStarting.value) {
      return true;
    }
  }
  return false;
});
