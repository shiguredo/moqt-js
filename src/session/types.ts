/**
 * SessionInternal インターフェースと共有型
 *
 * bidi.ts の BidiSessionInternal を継承し、抽出先モジュール
 * (namespaceLoops.ts / publish.ts / incoming.ts) が必要とする追加フィールドを宣言する。
 *
 * 公開型は publicTypes.ts に分離してあるため、types.ts から session.ts への
 * 型参照は発生しない。bidi.ts とは型レベルで相互参照するが、すべての辺が
 * import type であるため TypeScript コンパイラは受理する。
 * 値レベル（実行時）での循環依存は発生しない。
 */

import type { BidiSessionInternal, FillFetchTarget } from "./bidi";
import type { ControlStreamReader } from "../controlStream";
import type { AuthorizationToken } from "../message/authorizationToken";
import type { Parameter, RangeFilterSpec } from "../message/parameter";
import type { FullTrackNameKey } from "../fullTrackName";
import type { Property } from "../properties";
import type {
  PublisherImpl,
  ResolvedSubgroup,
  SharedLargestLocation,
  SharedSubgroupState,
} from "../publisher";
import type {
  ConnectCallbacks,
  NamespaceSubscriptionCallbacks,
  TracksSubscriptionCallbacks,
  NamespacePublicationCallbacks,
  NamespaceSubscription,
  TracksSubscription,
  NamespacePublication,
} from "./publicTypes";

// namespaceLoops.ts / incoming.ts / publish.ts から参照される状態型

export interface NamespaceSubscriptionState {
  callbacks: NamespaceSubscriptionCallbacks;
  state: "active" | "closed";
  namespacePrefix: string[];
  /**
   * SUBSCRIBE_NAMESPACE 送信時の Authorization Token (REQUEST_UPDATE への再利用)
   *
   * draft-ietf-moq-msf-02 §11.5.3:
   * "When a token is associated with a track, it MUST be included in ALL control
   *  messages that accept the AUTHORIZATION TOKEN parameter and are associated with
   *  that track. For end subscribers, this includes SUBSCRIBE, SUBSCRIBE_NAMESPACE,
   *  FETCH, and REQUEST_UPDATE messages."
   * 更新対象の prefix に紐づく購読を認可したトークンであるため、REQUEST_UPDATE にも
   * 同じ値を付与する。REGISTER は初回要求で送信済みのため USE_ALIAS に変換した値を
   * 保持する (再 REGISTER は DUPLICATE_AUTH_TOKEN_ALIAS でセッションを閉じるため)。
   * DELETE で退役させたトークンは引き継がない。
   */
  // exactOptionalPropertyTypes の下で AuthorizationToken | undefined を代入するため `| undefined` を付ける
  authorizationToken?: AuthorizationToken | undefined;
  /**
   * REQUEST_UPDATE で送信中 (REQUEST_OK 未受信) の新 Track Namespace Prefix。
   * draft-ietf-moq-transport-23 §9.5.2:
   * REQUEST_OK 受信時に namespacePrefix へ反映し、REQUEST_ERROR 時は反映せずクリアする。
   */
  // セッション内部の状態オブジェクトで、解放時に明示的に undefined を代入するため `| undefined` を付ける
  pendingPrefix?: string[] | undefined;
  stream?: WebTransportBidirectionalStream | undefined;
  streamReader?: ReadableStreamDefaultReader<Uint8Array> | undefined;
  controlReader?: ControlStreamReader | undefined;
  writer?: WritableStreamDefaultWriter<Uint8Array> | undefined;
  /**
   * 確立前の Promise の reject
   *
   * SUBSCRIBE_NAMESPACE の REQUEST_OK / REQUEST_ERROR を待つ Promise の reject を保持する。
   * Session の終了時に、確立していない購読の await を残さないために使う
   * (src/session/lifecycle.ts の sessionRejectPendingRequests)。
   * REQUEST_OK を受けて確立したら undefined に戻す (確立後の終了は state で観測できる)。
   * state は Session の終了処理 (sessionMarkRequestObjectsClosed) が先に "closed" に
   * するため、確立前かどうかは state ではなくこの値の有無で判定する。
   */
  reject?: ((error: Error) => void) | undefined;
}

export interface TracksSubscriptionState {
  callbacks: TracksSubscriptionCallbacks;
  state: "active" | "closed";
  namespacePrefix: string[];
  /**
   * SUBSCRIBE_TRACKS 送信時の Authorization Token (REQUEST_UPDATE への再利用)
   *
   * draft-ietf-moq-msf-02 §11.5.3 の MUST (SUBSCRIBE_NAMESPACE / REQUEST_UPDATE を
   * 含む列挙) に従い、更新時も同じ値を付与する。REGISTER は初回要求で送信済みの
   * ため USE_ALIAS に変換した値を保持する。DELETE で退役させたトークンは引き継がない。
   * この要求から PUBLISH で確立した購読の `Subscriber.update()` にも同じ値を引き継ぐ。
   */
  // exactOptionalPropertyTypes の下で AuthorizationToken | undefined を代入するため `| undefined` を付ける
  authorizationToken?: AuthorizationToken | undefined;
  /**
   * SUBSCRIBE_TRACKS 送信時に指定された Range Filters。
   * draft-ietf-moq-transport-23 §3.3.2:
   * TRACK_PROPERTY_FILTER は受信 PUBLISH の評価に使用する。
   */
  // セッション内部の状態オブジェクトで、解放時に明示的に undefined を代入するため `| undefined` を付ける
  rangeFilters?: RangeFilterSpec[] | undefined;
  /**
   * REQUEST_UPDATE で送信中 (REQUEST_OK 未受信) の新 Track Namespace Prefix。
   * draft-ietf-moq-transport-23 §9.5.2:
   * REQUEST_OK 受信時に namespacePrefix へ反映し、REQUEST_ERROR 時は反映せずクリアする。
   */
  pendingPrefix?: string[] | undefined;
  stream?: WebTransportBidirectionalStream | undefined;
  streamReader?: ReadableStreamDefaultReader<Uint8Array> | undefined;
  controlReader?: ControlStreamReader | undefined;
  writer?: WritableStreamDefaultWriter<Uint8Array> | undefined;
  /**
   * 確立前の Promise の reject
   *
   * SUBSCRIBE_TRACKS の REQUEST_OK / REQUEST_ERROR を待つ Promise の reject を保持する。
   * 使い方と確立時に undefined に戻すことは NamespaceSubscriptionState.reject と同じ。
   */
  reject?: ((error: Error) => void) | undefined;
}

export interface NamespacePublicationState {
  // セッション内部の状態オブジェクトで、callbacks 未指定時に undefined を保持するため `| undefined` を付ける
  callbacks?: NamespacePublicationCallbacks | undefined;
  state: "pending" | "active" | "closed";
  namespace: string[];
  stream: WebTransportBidirectionalStream;
  streamReader: ReadableStreamDefaultReader<Uint8Array>;
  controlReader: ControlStreamReader;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  /**
   * 確立前の Promise の reject
   *
   * PUBLISH_NAMESPACE の REQUEST_OK / REQUEST_ERROR を待つ Promise の reject を保持する。
   * Session の終了時に、確立していない publication の await を残さないために使う
   * (src/session/lifecycle.ts の sessionRejectPendingRequests)。
   * REQUEST_OK を受けて確立したら undefined に戻す (確立後の終了は state で観測できる)。
   */
  reject?: ((error: Error) => void) | undefined;
}

export interface PublisherStreamState {
  groupId: bigint;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  previousObjectId: bigint;
  /** 既に送信した Header の Subgroup ID と Publisher Priority。 */
  subgroup?: ResolvedSubgroup;
  /** 購読と共有する見送り履歴。終了処理ではストリームを閉じてから破棄する。 */
  subgroupOmissions?: ReadonlyMap<bigint, ReadonlySet<bigint>>;
  /**
   * §11.3.2: フィルタ変更によって配信を途中で打ち切ったストリームを RESET する。
   * 実際に見送った Object ID は購読側で別途追跡する。
   */
  omittedObjects: boolean;
}

/**
 * 公開済み Track の registry エントリ
 *
 * draft-ietf-moq-transport-23 §3.6.1 (Filtering SUBSCRIBE_TRACKS):
 * 受信 SUBSCRIBE_TRACKS の TRACK_PROPERTY_FILTER は Track Properties で評価する。
 * draft-ietf-moq-transport-23 §3.1 (Subscriptions):
 * 1 つの Track に複数 subscription が一致し得る。
 */
export interface PublishedTrackState {
  readonly namespace: string[];
  readonly trackName: string;
  /** PUBLISH に載せた Track Properties (TRACK_PROPERTY_FILTER の評価に使う) */
  readonly trackProperties: Property[];
  /**
   * Track 全体で共有する Subgroup の値
   *
   * draft-ietf-moq-transport-23 §7.1 / §12.1:
   * 同じ Track の同じ (Group, Object) を複数の PUBLISH subscription へ送るとき、
   * Subgroup ID と Publisher Priority が subscription 間で食い違うと受信側は
   * その Track を Malformed として扱う。Track で最初に Subgroup を開いた値を
   * ここに 1 つだけ保持し、この Track の全 PublisherImpl が同じオブジェクトを
   * 参照する (PublisherImpl.setSharedSubgroupState)。
   */
  readonly sharedSubgroup: SharedSubgroupState;
  /** §3.1.4: 同じ Track の全購読が更新・参照する最大位置。 */
  readonly sharedLargestLocation: SharedLargestLocation;
  /** アプリが publish した Publisher (最後の 1 つが終了するまで registry に残す) */
  readonly publishers: Set<PublisherImpl>;
  /** その Track の全 PUBLISH subscription (アプリ由来と SUBSCRIBE_TRACKS 由来の両方) */
  readonly subscriptions: Set<PublisherImpl>;
}

/**
 * 受信 SUBSCRIBE_TRACKS の受理状態
 *
 * draft-ietf-moq-transport-23 §3.6 (Subscribing to Tracks by Prefix) の publisher 側。
 * 送信側 (subscriber としての SUBSCRIBE_TRACKS) の TracksSubscriptionState とは
 * 別の型と Map で管理し、送信側と混ぜない。
 */
export interface IncomingTracksSubscriptionState {
  readonly requestId: bigint;
  state: "active" | "closed";
  /** 受信した Track Namespace Prefix (REQUEST_UPDATE で更新され得る) */
  namespacePrefix: string[];
  /** 応答側の writer。PUBLISH_SKIPPED と REQUEST_UPDATE_OK / ERROR を送る */
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly controlReader: ControlStreamReader;
  /**
   * 受理した Message Parameters (REQUEST_UPDATE で更新される)
   *
   * 結果 PUBLISH に載せる parameter の選択と、TRACK_PROPERTY_FILTER 以外の
   * Range Filters / LOCATION_FILTER / PAUSED を購読ごとの送信状態へ反映するのに使う。
   */
  parameters: Parameter[];
  /** 今後の一致 PUBLISH に載せる PAUSED (REQUEST_UPDATE で更新される) */
  paused: boolean;
  /** 今後の Track 一致判定に使う Range Filters (TRACK_PROPERTY_FILTER を含む) */
  rangeFilters: RangeFilterSpec[];
  /** この要求から PUBLISH 済みの Full Track Name (再 PUBLISH を防ぐ) */
  readonly publishedTracks: Set<FullTrackNameKey>;
  /** PUBLISH_SKIPPED を送った Full Track Name (PUBLISH を送らない) */
  readonly publishSkipped: Set<FullTrackNameKey>;
}

/**
 * SessionInternal = BidiSessionInternal の全フィールド + 抽出先が必要とする追加フィールド
 *
 * SessionImpl が implements する。抽出先 free function はこのインターフェースを引数に受け取る。
 */
export interface SessionInternal extends BidiSessionInternal {
  // ============================================================
  // namespaceLoops.ts 用
  // ============================================================
  readonly namespacePublications: Map<bigint, NamespacePublicationState>;

  createNamespaceSubscription(requestId: bigint): NamespaceSubscription;
  createTracksSubscription(requestId: bigint): TracksSubscription;
  createNamespacePublication(requestId: bigint): NamespacePublication;

  // ============================================================
  // incomingPublish.ts / dataStreamIncoming.ts 用 (PUBLISH 初期 fill)
  // ============================================================
  /**
   * PUBLISH 初期 fill の受信先登録を待つ
   *
   * draft-ietf-moq-transport-23 §3.4: PUBLISH の FILL_PARAMETERS による
   * 初期 fill fetch ストリームは PUBLISH の Request ID を運ぶ。
   */
  waitForPublishFillTarget(requestId: bigint): Promise<FillFetchTarget | null>;

  // ============================================================
  // publish.ts 用
  // ============================================================
  // publisherStreams / publisherSendQueues / closedSubgroups は
  // BidiSessionInternal 側で宣言済み (REQUEST_UPDATE 失敗時の終了処理で使う)。
  // Writable である必要あり: getDatagramWriter が ??= で遅延代入するため
  datagramWriter: WritableStreamDefaultWriter<Uint8Array> | undefined;
  // 抽出先 free function からインクリメントされるため readonly 不可
  statsUnidirectionalStreamsOpened: number;

  // ============================================================
  // incoming.ts 用
  // ============================================================
  // handleIncomingDatagram が statsUnidirectionalStreamsReceived をインクリメントする。
  statsUnidirectionalStreamsReceived: number;

  // receivedEndOfGroupFinalObjectIds は BidiSessionInternal 側で宣言済み
  // (SessionInternal extends BidiSessionInternal のため継承する)。
  // validateIncomingRequestId も同様に BidiSessionInternal 側で宣言済み。
  // priorGapTrackingByTrack (§10.8 / §10.9 の Track 単位追跡、FETCH の End of
  // Group / End of Track indicator が確定した終端、および §12.1 条件 10 の
  // 受信済み位置 / 確定した非存在範囲の追跡) も同じく BidiSessionInternal 側で
  // 宣言済みであり、この interface へ継承される。

  // ============================================================
  // その他 (incoming.ts / namespaceLoops.ts / publish.ts / session.ts)
  // ============================================================
  // draft-ietf-moq-transport-23 §13 (Grease): true のとき Track / Object Properties に
  // GREASE Property を 1 つ注入する。ConnectOptions.grease を initialize() で受け渡す。
  readonly grease: boolean;

  readonly callbacks: ConnectCallbacks;
}
