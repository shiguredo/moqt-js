/**
 * namespace 系リクエストの free function 群
 *
 * SessionImpl の subscribeNamespace / subscribeTracks / publishNamespace と、
 * それぞれが返す購読 / 配信オブジェクトの生成 (createNamespaceSubscription /
 * createTracksSubscription / createNamespacePublication)、解除
 * (closeNamespaceSubscription / closeTracksSubscription /
 * closeNamespacePublication)、REQUEST_UPDATE 送信
 * (sendNamespaceRequestUpdate)、受信ループ開始
 * (startNamespaceStreamLoop / startTracksStreamLoop /
 * startNamespacePublicationStreamLoop) を free function として抽出する。
 *
 * draft-ietf-moq-transport-23 §9.14 (SUBSCRIBE_NAMESPACE) /
 * §9.17 (SUBSCRIBE_TRACKS) / §9.13 (PUBLISH_NAMESPACE) は、いずれも専用の
 * 双方向ストリームを開く namespace 系の要求である。ストリーム上のメッセージ処理は
 * namespaceLoops.ts が担当する。
 *
 * namespacesSubscribeNamespace / namespacesSubscribeTracks / namespacesPublishNamespace は
 * 同期関数である (SessionImpl の対応するメソッドは async のまま、同期の throw を rejection に
 * 変換する)。送信より前に失敗し得る処理を済ませてから応答待ちの Promise を作り、その reject を
 * 送信待ちの Map (pendingNamespaceSubscription / pendingTracksSubscription /
 * pendingNamespacePublication) に登録して、送信の async 部を detached に開始し、Promise を
 * 送信より先に返す。これにより、送信待ち (ストリーム作成 / write の await) の間に
 * Session が終了しても、Promise は終了の理由で 1 回だけ settle する
 * (draft-ietf-moq-transport-23 §6.6。根拠の仕様はドラフトであり将来変更される可能性がある)。
 *
 * debug の send イベントを出す位置は 2 つに分かれる。namespacesSubscribeNamespace /
 * namespacesSubscribeTracks は送信の async 部 (namespacesSendSubscription) で、ストリームの
 * 作成と reader / writer の取得と認可トークンの予約の後、write の前に出す。
 * namespacesPublishNamespace は同期部で出す (このため Promise の executor で Session の状態を
 * 再確認する)。
 */

import {
  MessageType,
  encodePublishNamespacePayload,
  encodeSubscribeNamespacePayload,
  encodeSubscribeTracksPayload,
  createTrackNamespace,
  getMessageTypeName,
  type AuthorizationToken,
} from "../message";
import { ControlStreamReader, ControlStreamWriter } from "../controlStream";
import * as bidi from "./bidi";
import {
  requestsNormalizeAuthorizationToken,
  requestsReadSessionState,
  requestsReleaseUnlockedStream,
  requestsReleaseAuthorizationToken,
  requestsReserveAuthorizationToken,
  requestsTokenForRequestUpdate,
  requestsTokenUnlessDelete,
} from "./requests";
import {
  REQUEST_UPDATE_STREAM_CLOSED_MESSAGE,
  namespaceStartNamespaceStreamLoop,
  namespaceStartPublicationStreamLoop,
  namespaceStartTracksStreamLoop,
  rejectPendingNamespaceUpdates,
} from "./namespaceLoops";
import {
  buildSubscribeNamespaceParameters,
  buildSubscribeTracksParameters,
  collectSubscriptionRangeFilters,
  encodeAuthorizationTokenParameter,
  validateRangeFilterLimits,
  validateTrackNamespaceForSend,
} from "./params";
import type {
  NamespacePublicationState,
  NamespaceSubscriptionState,
  SessionInternal,
  TracksSubscriptionState,
} from "./types";
import type {
  NamespacePublication,
  NamespacePublicationCallbacks,
  NamespaceSubscription,
  NamespaceSubscriptionCallbacks,
  PublishNamespaceOptions,
  SessionState,
  SubscribeTracksOptions,
  TracksSubscription,
  TracksSubscriptionCallbacks,
  NamespaceUpdateOptions,
  TracksUpdateOptions,
} from "./publicTypes";

/**
 * namespace 系リクエストが必要とする SessionImpl のビュー
 *
 * SessionImpl は `as unknown as NamespacesSessionInternal` で渡す。
 */
export interface NamespacesSessionInternal {
  /**
   * 後続メッセージへ付与する Authorization Token を正規化する
   * (draft-ietf-moq-transport-23 §8.9 / §9.1.4)
   */
  normalizeAuthorizationTokenForSend(token: AuthorizationToken): AuthorizationToken;
  /**
   * 送信直前の登録サイズを判定して予約する
   * (draft-ietf-moq-transport-23 §9.1.3 の登録サイズの総和)
   */
  reserveAuthorizationTokenForSend(token: AuthorizationToken | undefined): boolean;
  /**
   * 送信に至らなかった REGISTER の予約を取り消す
   * (draft-ietf-moq-transport-23 §9.1.3 の登録サイズの総和)
   */
  releaseAuthorizationTokenForSend(token: AuthorizationToken | undefined): void;

  sessionState: SessionState;
  readonly transport: WebTransport;
  readonly callbacks: {
    debug?: (message: unknown) => void;
  };
  /**
   * debug コールバックへ制御メッセージの送受信を通知する
   *
   * 制御メッセージの送信統計は加算しない。
   */
  emitDebug(
    direction: "send" | "recv",
    type: number,
    payload: Uint8Array,
    decoded?: Record<string, unknown>,
  ): void;

  nextRequestId: bigint;
  receivedGoaway: boolean;
  peerMaxFilterRanges: number;
  /**
   * 自 endpoint が SETUP で広告した MAX_CONTROL_MESSAGE_SIZE
   * (draft-ietf-moq-transport-23 §9.1.8)。リクエストストリームの受信上限に使う。
   */
  readonly localMaxControlMessageSize: number;
  /**
   * ピアが SETUP で広告した MAX_CONTROL_MESSAGE_SIZE
   * (draft-ietf-moq-transport-23 §9.1.8)。リクエストストリームの送信上限に使う。
   */
  readonly peerMaxControlMessageSize: number;

  readonly namespaceSubscriptions: Map<bigint, NamespaceSubscriptionState>;
  readonly tracksSubscriptions: Map<bigint, TracksSubscriptionState>;
  readonly namespacePublications: Map<bigint, NamespacePublicationState>;
  /**
   * 送信待ちの PUBLISH_NAMESPACE の reject
   *
   * ストリームの作成と PUBLISH_NAMESPACE の書き込みの await 中は
   * namespacePublications に登録されていないため、Session 終了時の reject 対象
   * (sessionRejectPendingRequests) として別に保持する。
   */
  readonly pendingNamespacePublication: Map<bigint, { reject: (err: Error) => void }>;
  /**
   * 送信待ちの SUBSCRIBE_NAMESPACE の reject
   *
   * ストリームの作成と SUBSCRIBE_NAMESPACE の書き込みの await 中は
   * namespaceSubscriptions に登録されていないため、Session 終了時の reject 対象
   * (sessionRejectPendingRequests) として別に保持する。
   */
  readonly pendingNamespaceSubscription: Map<bigint, { reject: (err: Error) => void }>;
  /**
   * 送信待ちの SUBSCRIBE_TRACKS の reject
   *
   * ストリームの作成と SUBSCRIBE_TRACKS の書き込みの await 中は
   * tracksSubscriptions に登録されていないため、Session 終了時の reject 対象
   * (sessionRejectPendingRequests) として別に保持する。
   */
  readonly pendingTracksSubscription: Map<bigint, { reject: (err: Error) => void }>;
}

/**
 * SUBSCRIBE_NAMESPACE を送信し、REQUEST_OK で解決する Promise を返す
 *
 * draft-ietf-moq-transport-23 §9.14 (SUBSCRIBE_NAMESPACE)
 *
 * 同期関数であり、送信より前に失敗し得る処理 (状態と GOAWAY の確認・検証・認可トークンの
 * 正規化・パラメータ構築・encode・フレーミング) は Promise の作成より前に済ませて同期で
 * throw する (このときストリームを開かず、認可トークンの予約も送信待ちの登録もしない)。
 * Promise を作って pendingNamespaceSubscription に登録したら、送信を
 * namespacesSendSubscription で detached に開始し、Promise を送信より先に返す。
 */
export function namespacesSubscribeNamespace(
  session: NamespacesSessionInternal,
  namespacePrefix: string[],
  callbacks: NamespaceSubscriptionCallbacks,
  options?: { authorizationToken?: AuthorizationToken },
): Promise<NamespaceSubscription> {
  if (session.sessionState === "closed") {
    throw new Error("session is closed");
  }

  // GOAWAY 受信後は新規リクエストを拒否
  if (session.receivedGoaway) {
    throw new Error("cannot subscribe namespace after receiving GOAWAY");
  }

  const requestId = session.nextRequestId;
  session.nextRequestId += 2n;

  const trackNamespacePrefix = createTrackNamespace(namespacePrefix);

  // draft-ietf-moq-transport-23 §2.4.3 / §6.5: 予約 namespace / .session の送信拒否
  validateTrackNamespaceForSend(namespacePrefix);

  // draft-ietf-moq-transport-23 §8.9 / §9.1.4: SETUP の登録成否に応じて正規化する。
  // REGISTER の予約は送信の直前 (namespacesSendSubscription) に行い、送信に至らなければ
  // 取り消す
  const normalizedOptions = requestsNormalizeAuthorizationToken(session, options);

  // SUBSCRIBE_NAMESPACE メッセージを構築
  // AUTHORIZATION_TOKEN (0x03) - draft-ietf-moq-msf-01 §11.4.3: SUBSCRIBE_NAMESPACE に MUST 付与。
  const subscribeNamespaceMsg = {
    type: MessageType.SUBSCRIBE_NAMESPACE,
    requestId,
    trackNamespacePrefix,
    parameters: buildSubscribeNamespaceParameters(normalizedOptions),
  };

  // メッセージをエンコードする
  // draft-ietf-moq-transport-23 §9 (Control Messages):
  // Type (vi64) + Message Length (vi64) + Payload のフレーミングを
  // ControlStreamWriter に委譲する。encode とフレーミング (ピアの
  // MAX_CONTROL_MESSAGE_SIZE の判定。§9.1.8) は Promise の作成より前に行い、
  // ストリームを開く前の同期の throw にする
  const payload = encodeSubscribeNamespacePayload(subscribeNamespaceMsg);
  const controlWriter = new ControlStreamWriter(session.peerMaxControlMessageSize);
  const framed = controlWriter.encode(MessageType.SUBSCRIBE_NAMESPACE, payload);

  // draft-ietf-moq-msf-01 §11.4.3: 購読に紐づくトークンは REQUEST_UPDATE にも
  // 付与する MUST のため、初回要求の値を保持する。REGISTER は初回要求で送信済み
  // のため USE_ALIAS に変換して保持する (再 REGISTER は DUPLICATE_AUTH_TOKEN_ALIAS
  // でセッションを閉じる)。DELETE は退役の指示であり更新で繰り返さない
  const authorizationToken = requestsTokenForRequestUpdate(
    requestsTokenUnlessDelete(normalizedOptions?.authorizationToken),
  );

  // 送信の入力は、呼び出し元の Promise の resolve / reject を除いて Promise の作成より前に
  // 組み立てる (購読の state を作るための値を含む)
  const request: Omit<
    NamespaceSubscriptionSendRequest<NamespaceSubscriptionState, NamespaceSubscription>,
    "resolve" | "reject"
  > = {
    requestId,
    type: MessageType.SUBSCRIBE_NAMESPACE,
    payload,
    framed,
    decoded: {
      requestId: requestId.toString(),
      trackNamespacePrefix: namespacePrefix,
    },
    normalizedOptions,
    pending: session.pendingNamespaceSubscription,
    subscriptions: session.namespaceSubscriptions,
    createSubscriptionState: (streams) => ({
      callbacks,
      state: "active",
      namespacePrefix,
      authorizationToken,
      ...streams,
    }),
    startStreamLoop: namespacesStartNamespaceStreamLoop,
  };

  // REQUEST_OK / REQUEST_ERROR を待つ Promise を送信より先に作り、その reject を
  // pendingNamespaceSubscription に登録する。送信は detached に行い、呼び出し元へは
  // Promise をすぐ返す。送信待ちの間に Session が終了しても、
  // sessionRejectPendingRequests が終了の理由で reject する
  return new Promise<NamespaceSubscription>((resolve, reject) => {
    session.pendingNamespaceSubscription.set(requestId, { reject });
    void namespacesSendSubscription(session, { ...request, resolve, reject });
  });
}

/**
 * SUBSCRIBE_TRACKS を送信し、REQUEST_OK で解決する Promise を返す
 *
 * draft-ietf-moq-transport-23 §3.6 / §9.17 (SUBSCRIBE_TRACKS)
 *
 * 同期関数であり、送信より前に失敗し得る処理 (状態と GOAWAY の確認・検証・認可トークンの
 * 正規化・パラメータ構築・encode・フレーミング) は Promise の作成より前に済ませて同期で
 * throw する (このときストリームを開かず、認可トークンの予約も送信待ちの登録もしない)。
 * Promise を作って pendingTracksSubscription に登録したら、送信を
 * namespacesSendSubscription で detached に開始し、Promise を送信より先に返す。
 */
export function namespacesSubscribeTracks(
  session: NamespacesSessionInternal,
  namespacePrefix: string[],
  callbacks: TracksSubscriptionCallbacks,
  options?: SubscribeTracksOptions,
): Promise<TracksSubscription> {
  if (session.sessionState === "closed") {
    throw new Error("session is closed");
  }

  // GOAWAY 受信後は新規リクエストを拒否
  if (session.receivedGoaway) {
    throw new Error("cannot subscribe tracks after receiving GOAWAY");
  }

  const requestId = session.nextRequestId;
  session.nextRequestId += 2n;

  const trackNamespacePrefix = createTrackNamespace(namespacePrefix);

  // draft-ietf-moq-transport-23 §2.4.3 / §6.5: 予約 namespace / .session の送信拒否
  validateTrackNamespaceForSend(namespacePrefix);

  // draft-ietf-moq-transport-23 §9.1.6: ピアの MAX_FILTER_RANGES が 0 のとき、および
  // 購読単位の Ranges 合計が上限を超えるときは Range Filter を送信できない。
  // draft-ietf-moq-transport-23 §3.6.1: SUBSCRIBE_TRACKS で Range Filter を送信できる。
  // FILL_PARAMETERS を運ぶ場合、内側の fill.rangeFilters も同じ購読に載るため
  // 外側と合算する (collectSubscriptionRangeFilters の第 2 引数)。
  // 上限の解釈は SUBSCRIBE 経路と共通であり、検証はストリーム生成より前に行う。
  validateRangeFilterLimits(
    collectSubscriptionRangeFilters(options?.rangeFilters, options?.fill),
    session.peerMaxFilterRanges,
    "SUBSCRIBE_TRACKS",
  );

  // draft-ietf-moq-transport-23 §8.9 / §9.1.4: SETUP の REGISTER の登録成否に応じて
  // 付与するトークンを正規化する (登録成功 → USE_ALIAS、登録失敗 → USE_VALUE。詳細は
  // normalizeAuthorizationTokenForSend の JSDoc)。REGISTER の予約は送信の直前
  // (namespacesSendSubscription) に行い、送信に至らなければ取り消す
  const normalizedOptions = requestsNormalizeAuthorizationToken(session, options);

  // SUBSCRIBE_TRACKS メッセージを構築
  // SUBSCRIBE_TRACKS の許可一覧と扱いは draft-ietf-moq-transport-23 §9.17 / §3.6.2。
  // 各 Parameter の定義は §9.19 (timeouts / priority / LOCATION_FILTER /
  // FILL_PARAMETERS / PAUSED / GROUP_ORDER / Range Filters) を参照する。
  const subscribeTracksMsg = {
    type: MessageType.SUBSCRIBE_TRACKS,
    requestId,
    trackNamespacePrefix,
    parameters: buildSubscribeTracksParameters(normalizedOptions),
  };

  // メッセージをエンコードする
  // draft-ietf-moq-transport-23 §9 (Control Messages):
  // Type (vi64) + Message Length (vi64) + Payload のフレーミングを
  // ControlStreamWriter に委譲する。encode とフレーミング (ピアの
  // MAX_CONTROL_MESSAGE_SIZE の判定。§9.1.8) は Promise の作成より前に行い、
  // ストリームを開く前の同期の throw にする
  const payload = encodeSubscribeTracksPayload(subscribeTracksMsg);
  const controlWriter = new ControlStreamWriter(session.peerMaxControlMessageSize);
  const framed = controlWriter.encode(MessageType.SUBSCRIBE_TRACKS, payload);

  // draft-ietf-moq-msf-01 §11.4.3: 購読に紐づくトークンは REQUEST_UPDATE にも
  // 付与する MUST のため、初回要求の値を保持する (USE_ALIAS へ変換)。
  // DELETE は退役の指示であり更新で繰り返さない
  const authorizationToken = requestsTokenForRequestUpdate(
    requestsTokenUnlessDelete(normalizedOptions?.authorizationToken),
  );
  // draft-ietf-moq-transport-23 §3.3.2:
  // TRACK_PROPERTY_FILTER は受信 PUBLISH の評価に使用するため保持する
  const rangeFilters = options?.rangeFilters;

  // 送信の入力は、呼び出し元の Promise の resolve / reject を除いて Promise の作成より前に
  // 組み立てる (購読の state を作るための値を含む)
  const request: Omit<
    NamespaceSubscriptionSendRequest<TracksSubscriptionState, TracksSubscription>,
    "resolve" | "reject"
  > = {
    requestId,
    type: MessageType.SUBSCRIBE_TRACKS,
    payload,
    framed,
    decoded: {
      requestId: requestId.toString(),
      trackNamespacePrefix: namespacePrefix,
    },
    normalizedOptions,
    pending: session.pendingTracksSubscription,
    subscriptions: session.tracksSubscriptions,
    createSubscriptionState: (streams) => ({
      callbacks,
      state: "active",
      namespacePrefix,
      authorizationToken,
      rangeFilters,
      ...streams,
    }),
    startStreamLoop: namespacesStartTracksStreamLoop,
  };

  // REQUEST_OK / REQUEST_ERROR を待つ Promise を送信より先に作り、その reject を
  // pendingTracksSubscription に登録する。送信は detached に行い、呼び出し元へは
  // Promise をすぐ返す。送信待ちの間に Session が終了しても、
  // sessionRejectPendingRequests が終了の理由で reject する
  return new Promise<TracksSubscription>((resolve, reject) => {
    session.pendingTracksSubscription.set(requestId, { reject });
    void namespacesSendSubscription(session, { ...request, resolve, reject });
  });
}

/**
 * SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS 共用の、送信の型引数 S (購読の state) の制約
 *
 * 確立前の Promise の reject を namespacesSendSubscription が登録時に設定するため、
 * reject を持つ型 (NamespaceSubscriptionState / TracksSubscriptionState) に限る。
 */
interface SubscriptionStateWithReject {
  reject?: ((error: Error) => void) | undefined;
}

/**
 * SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS 共用の、購読の state に載せる専用の双方向ストリームと
 * 取得済みの reader / writer
 *
 * 送信の完了後に namespacesSendSubscription が組み立て、
 * NamespaceSubscriptionSendRequest.createSubscriptionState へ渡す。
 */
interface NamespaceSubscriptionStreams {
  stream: WebTransportBidirectionalStream;
  streamReader: ReadableStreamDefaultReader<Uint8Array>;
  controlReader: ControlStreamReader;
  writer: WritableStreamDefaultWriter<Uint8Array>;
}

/**
 * SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS 共用の、送信 (namespacesSendSubscription) に必要な入力
 *
 * 引数が多くなり取り違えやすいため 1 つのオブジェクトにまとめる
 * (NamespacePublishSendRequest / requests.ts の RequestSendRequest と同じ)。2 API で
 * 異なる送信待ちの登録先、送信の完了後の登録先と購読の state の構築、受信ループの
 * 開始関数もここで渡す。
 *
 * @typeParam S - 購読の state (NamespaceSubscriptionState / TracksSubscriptionState)。
 *   制約は SubscriptionStateWithReject を参照する
 * @typeParam T - 呼び出し元の Promise が解決する値 (NamespaceSubscription / TracksSubscription)
 */
interface NamespaceSubscriptionSendRequest<S extends SubscriptionStateWithReject, T> {
  requestId: bigint;
  /** メッセージタイプ (debug の send イベントに使う) */
  type: number;
  /** エンコード済みペイロード (debug の send イベントに使う) */
  payload: Uint8Array;
  /** 同期部でフレーミングしたメッセージ */
  framed: Uint8Array;
  /** debug の send イベントに載せるデコード済みメッセージ */
  decoded: Record<string, unknown>;
  /**
   * 認可トークンを正規化した options
   *
   * draft-ietf-moq-transport-23 §9.1.3: REGISTER のトークンは write の直前に予約し、
   * 送信に至らなかった場合は取り消す。
   */
  normalizedOptions: { authorizationToken?: AuthorizationToken } | undefined;
  /** 呼び出し元の Promise の resolve (受信ループが REQUEST_OK を受けて呼ぶ) */
  resolve: (subscription: T) => void;
  /** 呼び出し元の Promise の reject */
  reject: (error: Error) => void;
  /**
   * 送信待ちの登録先 (pendingNamespaceSubscription / pendingTracksSubscription)
   *
   * 送信待ち専用の登録であり、受信ループを開始する場合もしない場合も、送信の async 部
   * (namespacesSendSubscription) を抜けるまでに requestId のエントリを必ず削除する。
   */
  pending: { delete(requestId: bigint): boolean };
  /** 送信の完了後の登録先 (namespaceSubscriptions / tracksSubscriptions) */
  subscriptions: Map<bigint, S>;
  /**
   * 送信の完了後に登録する購読の state を作る
   *
   * ストリームと reader / writer 以外の値 (callbacks / namespacePrefix / REQUEST_UPDATE に
   * 引き継ぐ認可トークンなど) は同期部で求めたものを使う。確立前の Promise の reject は
   * namespacesSendSubscription が登録時に設定する。
   */
  createSubscriptionState: (streams: NamespaceSubscriptionStreams) => S;
  /**
   * 送信の完了後に開始する受信ループ (namespacesStartNamespaceStreamLoop /
   * namespacesStartTracksStreamLoop)
   */
  startStreamLoop: (
    session: NamespacesSessionInternal,
    requestId: bigint,
    resolve: (subscription: T) => void,
    reject: (error: Error) => void,
  ) => Promise<void>;
}

/**
 * 受信ループを開始しない購読の送信待ちの登録を削除し、呼び出し元の Promise を reject する
 *
 * 送信を終えられなかった場合と、送信後に Session が閉じていた場合に呼ぶ (requests.ts の
 * requestsAbandonRequest に相当する)。Map.delete は throw しないため、この関数は throw
 * しない。
 *
 * 呼び出し元はこの関数をストリームの解放 (await を伴う) より先に呼ぶ。解放の await 中に
 * Session が終了しても、sessionRejectPendingRequests が送信待ちの登録から汎用の終了の
 * 理由で先に reject しないようにするためである。sessionRejectPendingRequests が既に
 * reject している場合でも、Promise の settle は 1 回だけなので reject は no-op になる。
 *
 * @param error - reject の理由 (Error 以外の throw 値は Error に変換する)
 */
function namespacesAbandonSubscription<S extends SubscriptionStateWithReject, T>(
  request: NamespaceSubscriptionSendRequest<S, T>,
  error: unknown,
): void {
  request.pending.delete(request.requestId);
  request.reject(error instanceof Error ? error : new Error(String(error)));
}

/**
 * SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS を専用の双方向ストリームで送信し、受信ループを
 * 開始しない場合は呼び出し元の Promise を reject する (送信の async 部)
 *
 * draft-ietf-moq-transport-23 §9.14 (SUBSCRIBE_NAMESPACE) / §9.17 (SUBSCRIBE_TRACKS):
 * どちらも新しい双方向ストリームで送信する。
 *
 * 呼び出し元 (namespacesSubscribeNamespace / namespacesSubscribeTracks) は、フレーミング
 * までの同期部を終えて、自身が返す Promise の reject を送信待ちの Map に登録してから、
 * この関数を await せずに開始する。この関数が返す Promise は reject しない。
 *
 * requests.ts の requestsSendRequest と同じ手順であり、差は次のとおりである。手順 3 で
 * reader も取得し、解放では reader を cancel / releaseLock する。手順 4-2 で制御メッセージの
 * 送信統計を加算しない。手順 5 で送信待ちの登録を状態の確認より前に無条件で削除し、開いて
 * いれば requestStreams ではなく購読の state を登録して専用の受信ループを開始する。失敗した
 * 経路の解放の理由が "namespace request send failed" である。手順は次のとおりである。
 *
 * 1. 双方向ストリームを作成する
 * 2. Session の状態を確認する (作成の await 中の終了)
 * 3. 受信用の ControlStreamReader と reader / writer を作る
 * 4. 1 つの try の中で、次を順に行う (予約を取り消す catch を 1 つにするため)
 *    1. 認可トークンを予約する
 *    2. debug の send イベントを出す
 *    3. Session の状態を確認する (debug コールバックによる同期的な終了)。閉じていれば
 *       write せずに try を抜け、try の後で後始末する
 *    4. write する
 * 5. 送信待ちの Map から削除し、Session の状態を確認する (write の await 中の終了)。
 *    開いていれば購読の state を登録して受信ループを開始する
 *
 * 受信ループを開始しない経路 (送信を終えられなかった、または送信後に Session が
 * 閉じていた) では、予約していれば取り消し (手順 5 の経路は送信済みのため取り消さない)、
 * 送信待ちの Map からの削除と reject (namespacesAbandonSubscription) を先に行い、
 * ストリームの解放 (await を伴う) を最後に行う。reject の理由は、失敗した経路では元の
 * エラー、Session が閉じていた経路では "session closed" である。cancel / abort の理由は、
 * 失敗した経路では "namespace request send failed"、Session が閉じていた経路では
 * "session closed" である (namespacesSendPublishNamespace と同じ)。
 *
 * create / write の await が解決しないまま Session が終了した場合、close() と
 * ピア起点の終了 (transport.closed の解決または reject) では、呼び出し元の Promise は
 * sessionRejectPendingRequests が送信待ちの Map から終了の理由で settle させる。この
 * 関数は await が後から解決した時点でストリームを解放する。
 */
async function namespacesSendSubscription<S extends SubscriptionStateWithReject, T>(
  session: NamespacesSessionInternal,
  request: NamespaceSubscriptionSendRequest<S, T>,
): Promise<void> {
  const {
    requestId,
    type,
    payload,
    framed,
    decoded,
    normalizedOptions,
    resolve,
    reject,
    pending,
    subscriptions,
    createSubscriptionState,
    startStreamLoop,
  } = request;

  // 1. 双方向ストリームを作成する
  let stream: WebTransportBidirectionalStream;
  try {
    stream = await session.transport.createBidirectionalStream();
  } catch (error) {
    // ストリームは作成されていないため、解放するものは無い
    namespacesAbandonSubscription(request, error);
    return;
  }

  // 2. ストリーム作成の await 中に Session が終了した場合は、閉じた Session へ
  // 書き込まない。送信待ちの登録を削除して reject してから、ロックを取らずにストリームを
  // 解放する
  if (requestsReadSessionState(session) === "closed") {
    namespacesAbandonSubscription(request, new Error("session closed"));
    await requestsReleaseUnlockedStream(stream, "session closed");
    return;
  }

  // 3. 受信用の ControlStreamReader と reader / writer を作る。ロックの取得 (getReader /
  // getWriter) を最後にして、ロックを取った後に throw し得る処理を getWriter だけにする。
  // ロック済みのストリームを返す transport では getReader / getWriter が throw するため、
  // detached な async 処理で未処理の rejection を残さないよう try に含める
  let streamReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let controlReader: ControlStreamReader;
  let writer: WritableStreamDefaultWriter<Uint8Array>;
  try {
    // draft-ietf-moq-transport-23 §9.1.8: リクエストストリームの受信上限は、
    // 自 endpoint が SETUP で広告した MAX_CONTROL_MESSAGE_SIZE である
    controlReader = new ControlStreamReader(session.localMaxControlMessageSize);
    streamReader = stream.readable.getReader();
    writer = stream.writable.getWriter();
  } catch (error) {
    // 送信待ちの登録を削除して元のエラーで reject してから、取得済みのリソースだけを
    // 掃除する (getWriter の失敗で reader のロックを残さない)
    namespacesAbandonSubscription(request, error);
    if (streamReader !== undefined) {
      try {
        await streamReader.cancel("namespace request send failed");
      } catch {
        // 閉じかけのストリーム操作の失敗は無視する
      }
      streamReader.releaseLock();
    } else {
      // reader を取得する前に失敗した場合は、ロックを取らずに作成済みのストリームを解放する
      await requestsReleaseUnlockedStream(stream, "namespace request send failed");
    }
    return;
  }

  // 4. 予約から write までを 1 つの try に入れ、予約を取り消す catch を 1 つにする
  let reservedAuthToken = false;
  let closedBeforeWrite = false;
  try {
    // 4-1. draft-ietf-moq-transport-23 §9.1.3: 登録サイズの総和の判定と予約は
    // 送信の直前に行う。予約のローカルな失敗 (再 REGISTER / 上限超過) でも、
    // 作成済みのストリームは catch で解放する
    reservedAuthToken = requestsReserveAuthorizationToken(session, normalizedOptions);
    // 4-2. 予約の失敗では send イベントを出さないよう、予約の後に置く。ストリームの作成と
    // reader / writer の取得の後に出すため、それらに失敗したメッセージは send イベントに
    // 出ない (write の前に出すため、4-3 / 4-4 で送らなかったメッセージには send イベントが
    // 出る)。制御メッセージの送信統計は加算しない
    session.emitDebug("send", type, payload, decoded);
    // 4-3. debug コールバックが同期的に Session を閉じた場合は、閉じた Session へ
    // write しない。reject と cancel / abort の理由が catch 側と異なるため、throw で
    // catch に流さず、印を立てて try を抜ける。後始末は try の後で行うため、catch の
    // 後始末と重なることは無い
    if (requestsReadSessionState(session) === "closed") {
      closedBeforeWrite = true;
    } else {
      // 4-4. メッセージを書き込む
      await writer.write(framed);
    }
  } catch (error) {
    // 予約 / debug コールバック / write の失敗。送信に至らなかったため予約を取り消し、
    // 送信待ちの登録を削除して元のエラーで reject してから、取得済みのリソースを掃除する
    if (reservedAuthToken) {
      requestsReleaseAuthorizationToken(session, normalizedOptions);
    }
    namespacesAbandonSubscription(request, error);
    await namespacesCleanupSendFailure(streamReader, writer);
    return;
  }

  // 4-3 の後始末。まだ送っていないため予約を取り消し、送信待ちの登録を削除して reject
  // してからストリームを解放する
  if (closedBeforeWrite) {
    if (reservedAuthToken) {
      requestsReleaseAuthorizationToken(session, normalizedOptions);
    }
    namespacesAbandonSubscription(request, new Error("session closed"));
    await namespacesCleanupSendFailure(streamReader, writer, "session closed");
    return;
  }

  // 5. 送信が完了した。送信待ちの登録は送信待ち専用のため、状態の確認より前に削除する
  pending.delete(requestId);
  // write の await 中に Session が終了した場合は、購読の state を登録せず、受信ループも
  // 開始しない。sessionRejectPendingRequests が送信待ちの登録を reject も clear もしない
  // 経路 (状態だけを閉じる経路) でも Promise を settle させるため、明示的に reject する
  // (送信待ちの登録は削除済みのため、namespacesAbandonSubscription の削除は何もしない)。
  // 予約は送信済みのため取り消さない
  if (requestsReadSessionState(session) === "closed") {
    namespacesAbandonSubscription(request, new Error("session closed"));
    await namespacesCleanupSendFailure(streamReader, writer, "session closed");
    return;
  }

  // 購読の state を登録して、専用ストリームの受信ループを開始する。確立前の Promise の
  // reject は、Session の終了時に sessionRejectPendingRequests が呼ぶために state に載せる
  // (受信ループが REQUEST_OK を受けて確立したら undefined に戻す)
  const subscription = createSubscriptionState({ stream, streamReader, controlReader, writer });
  subscription.reject = reject;
  subscriptions.set(requestId, subscription);
  void startStreamLoop(session, requestId, resolve, reject);
}

/**
 * PUBLISH_NAMESPACE の送信処理に必要な入力
 *
 * 引数が多くなり取り違えやすいため 1 つのオブジェクトにまとめる。
 */
interface NamespacePublishSendRequest {
  requestId: bigint;
  namespace: string[];
  framed: Uint8Array;
  normalizedOptions: PublishNamespaceOptions | undefined;
  callbacks: NamespacePublicationCallbacks | undefined;
  resolve: (publication: NamespacePublication) => void;
  reject: (error: Error) => void;
}

/**
 * PUBLISH_NAMESPACE を送信し、結果を呼び出し元の Promise に届ける
 *
 * 呼び出し元の Promise は送信より先に作って pendingNamespacePublication に登録する
 * (送信待ちの間の Session 終了でも settle させるため)。送信が完了したら
 * namespacePublications に登録して受信ループを開始する。失敗したら元のエラーで
 * reject したあと、取得済みのリソースを解放する。
 */
async function namespacesSendPublishNamespace(
  session: NamespacesSessionInternal,
  request: NamespacePublishSendRequest,
): Promise<void> {
  const { requestId, namespace, framed, normalizedOptions, callbacks, resolve, reject } = request;
  let stream: WebTransportBidirectionalStream | undefined;
  let streamReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let controlReader: ControlStreamReader | undefined;
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  try {
    stream = await session.transport.createBidirectionalStream();
    // ストリーム作成の await 中に Session が終了した場合は、ロックを取らずに
    // ストリームを解放して reject する。終了済みのセッションへ書き込まない
    if (requestsReadSessionState(session) === "closed") {
      session.pendingNamespacePublication.delete(requestId);
      reject(new Error("session closed"));
      await requestsReleaseUnlockedStream(stream, "session closed");
      return;
    }
    // reader / writer の取得も同じ try に含める。ロック済みのストリームを返す
    // transport では getReader / getWriter が throw するため、detached な
    // async 処理で未処理 rejection を残さないようにする
    streamReader = stream.readable.getReader();
    controlReader = new ControlStreamReader(session.localMaxControlMessageSize);
    writer = stream.writable.getWriter();
  } catch (error) {
    // 取得済みのリソースだけを掃除する (getWriter の失敗で reader を残さない)。
    // 後始末の await 中に Session が終了して sessionRejectPendingRequests が
    // 汎用エラーで reject するのを避けるため、登録の削除と元のエラーでの reject を
    // 後始末より先に行う (write 失敗側と同じ順序)
    session.pendingNamespacePublication.delete(requestId);
    reject(error instanceof Error ? error : new Error(String(error)));
    if (streamReader !== undefined) {
      try {
        await streamReader.cancel("namespace request send failed");
      } catch {
        // 閉じかけのストリーム操作の失敗は無視する
      }
      streamReader.releaseLock();
    } else if (stream !== undefined) {
      // getReader 自体が失敗した場合も、作成済みのストリームを解放する
      await requestsReleaseUnlockedStream(stream, "namespace request send failed");
    }
    return;
  }

  let reservedAuthToken = false;
  try {
    reservedAuthToken = requestsReserveAuthorizationToken(session, normalizedOptions);
    await writer.write(framed);
  } catch (error) {
    // 送信失敗時は予約を取り消し、取得済みリソースを掃除する。後始末の await 中に
    // Session が終了して sessionRejectPendingRequests が汎用エラーで reject するのを
    // 避けるため、登録の削除と元のエラーでの reject を後始末より先に行う
    if (reservedAuthToken) {
      requestsReleaseAuthorizationToken(session, normalizedOptions);
    }
    session.pendingNamespacePublication.delete(requestId);
    reject(error instanceof Error ? error : new Error(String(error)));
    await namespacesCleanupSendFailure(streamReader, writer);
    return;
  }

  // 送信が完了した。Session が既に終了している場合は登録せず、呼び出し元の
  // Promise を reject する。sessionRejectPendingRequests が既に reject している
  // 場合でも Promise の settle は 1 回だけなので no-op になる
  session.pendingNamespacePublication.delete(requestId);
  if (requestsReadSessionState(session) === "closed") {
    reject(new Error("session closed"));
    await namespacesCleanupSendFailure(streamReader, writer, "session closed");
    return;
  }

  // 状態を登録して受信ループを開始する
  session.namespacePublications.set(requestId, {
    callbacks,
    state: "pending",
    namespace,
    stream,
    streamReader,
    controlReader,
    writer,
    // Session の終了時に未確立の Promise を reject するために保持する
    // (src/session/lifecycle.ts の sessionRejectPendingRequests)
    reject,
  });
  void namespacesStartPublicationStreamLoop(session, requestId, resolve, reject);
}

export function namespacesPublishNamespace(
  session: NamespacesSessionInternal,
  namespace: string[],
  callbacks?: NamespacePublicationCallbacks,
  options?: PublishNamespaceOptions,
): Promise<NamespacePublication> {
  if (session.sessionState === "closed") {
    throw new Error("session is closed");
  }

  // GOAWAY 受信後は新規リクエストを拒否
  if (session.receivedGoaway) {
    throw new Error("cannot publish namespace after receiving GOAWAY");
  }

  const requestId = session.nextRequestId;
  session.nextRequestId += 2n;

  const trackNamespace = createTrackNamespace(namespace);

  // draft-ietf-moq-transport-23 §2.4.3 / §6.5: 予約 namespace / .session の送信拒否
  validateTrackNamespaceForSend(namespace);

  // 送信前に throw し得る処理はすべて済ませ、Promise を作る前に失敗させる
  // (認可トークンの正規化・メッセージの構築・encode・デバッグコールバック)
  const normalizedOptions = requestsNormalizeAuthorizationToken(session, options);
  const publishNamespaceMsg = {
    type: MessageType.PUBLISH_NAMESPACE,
    requestId,
    trackNamespace,
    // AUTHORIZATION_TOKEN (0x03) - draft-ietf-moq-transport-23 Section 9.19.2
    // draft-ietf-moq-transport-23 §8.9 / §9.1.4: SETUP の登録成否に応じて
    // 正規化する (登録成功 → USE_ALIAS、登録失敗 → USE_VALUE)
    parameters:
      normalizedOptions?.authorizationToken !== undefined
        ? [encodeAuthorizationTokenParameter(normalizedOptions.authorizationToken)]
        : [],
  };

  // メッセージをエンコードする
  // draft-ietf-moq-transport-23 §9 (Control Messages):
  // Type (vi64) + Message Length (vi64) + Payload のフレーミングを
  // ControlStreamWriter に委譲する。
  const payload = encodePublishNamespacePayload(publishNamespaceMsg);
  const controlWriter = new ControlStreamWriter(session.peerMaxControlMessageSize);
  const framed = controlWriter.encode(MessageType.PUBLISH_NAMESPACE, payload);

  // デバッグコールバック
  session.callbacks.debug?.({
    direction: "send",
    type: MessageType.PUBLISH_NAMESPACE,
    typeName: getMessageTypeName(MessageType.PUBLISH_NAMESPACE),
    payload,
    decoded: {
      requestId: requestId.toString(),
      trackNamespace: namespace,
    },
    timestamp: Date.now(),
  });

  // REQUEST_OK / REQUEST_ERROR を待つ Promise を送信より先に作り、その reject を
  // pendingNamespacePublication に登録する。送信は detached に行い、呼び出し元へは
  // Promise をすぐ返す
  return new Promise<NamespacePublication>((resolve, reject) => {
    // デバッグコールバックが同期的に Session を閉じることがあるため、登録前に
    // 状態を再確認する。閉じていれば登録せず reject する
    if (session.sessionState === "closed") {
      reject(new Error("session closed"));
      return;
    }
    session.pendingNamespacePublication.set(requestId, { reject });
    void namespacesSendPublishNamespace(session, {
      requestId,
      namespace,
      framed,
      normalizedOptions,
      callbacks,
      resolve,
      reject,
    });
  });
}

export function namespacesCreateNamespaceSubscription(
  session: NamespacesSessionInternal,
  requestId: bigint,
): NamespaceSubscription {
  const getState = (): "active" | "closed" => {
    const sub = session.namespaceSubscriptions.get(requestId);
    return sub?.state ?? "closed";
  };

  const unsubscribe = async (): Promise<void> => {
    await namespacesCloseNamespaceSubscription(session, requestId);
  };

  // fire-and-forget で update() を呼び出しても、unsubscribe() / ピアの
  // FIN 等による reject が unhandled rejection にならないよう、catch を
  // 付けた promise を返す。async の wrapper 経由にすると wrapper 側の
  // 無観測 reject が unhandled になるため、ここで必ず捕まえる。
  const update = (options: NamespaceUpdateOptions): Promise<void> => {
    const promise = namespacesSendNamespaceRequestUpdate(session, requestId, "namespace", options);
    promise.catch(() => {});
    return promise;
  };

  return {
    get state() {
      return getState();
    },
    unsubscribe,
    update,
  };
}

export function namespacesCreateTracksSubscription(
  session: NamespacesSessionInternal,
  requestId: bigint,
): TracksSubscription {
  const getState = (): "active" | "closed" => {
    const sub = session.tracksSubscriptions.get(requestId);
    return sub?.state ?? "closed";
  };

  const unsubscribe = async (): Promise<void> => {
    await namespacesCloseTracksSubscription(session, requestId);
  };

  // createNamespaceSubscription の update と同様に、fire-and-forget 時の
  // 無観測 reject を抑制する (catch 付き promise を直接返す)。
  const update = (options: TracksUpdateOptions): Promise<void> => {
    const promise = namespacesSendNamespaceRequestUpdate(session, requestId, "tracks", options);
    promise.catch(() => {});
    return promise;
  };

  return {
    get state() {
      return getState();
    },
    unsubscribe,
    update,
  };
}

export function namespacesCreateNamespacePublication(
  session: NamespacesSessionInternal,
  requestId: bigint,
): NamespacePublication {
  // 内部状態の "pending" は REQUEST_OK 受信前のみで、外部に公開する前に "active" になる
  const getState = (): "active" | "closed" => {
    const pub = session.namespacePublications.get(requestId);
    if (!pub) return "closed";
    return pub.state === "active" ? "active" : "closed";
  };

  // done() は最後にエントリを削除するため、生成時点の値で固定する
  const namespace = [...(session.namespacePublications.get(requestId)?.namespace ?? [])];

  const done = async (): Promise<void> => {
    await namespacesCloseNamespacePublication(session, requestId);
  };

  return {
    get state() {
      return getState();
    },
    get namespace() {
      return namespace;
    },
    done,
  };
}

/**
 * Namespace サブスクリプションを閉じる
 *
 * draft-ietf-moq-transport-23 §4.2 / §6.4.2.3 (FIN はキャンセルではない点は §6.4.2.2):
 * SUBSCRIBE_NAMESPACE のキャンセルは、まだ開いている方向を RESET_STREAM と
 * STOP_SENDING で切ることで行う (FIN はキャンセルではない)。
 */
export async function namespacesCloseNamespaceSubscription(
  session: NamespacesSessionInternal,
  requestId: bigint,
): Promise<void> {
  const subscription = session.namespaceSubscriptions.get(requestId);
  if (!subscription || subscription.state === "closed") {
    return;
  }

  subscription.state = "closed";

  // 保留中の REQUEST_UPDATE (update() の Promise) を失敗させ、pendingPrefix を
  // クリアする。掃除しないと update() が未解決のまま残り、pendingRequestUpdate
  // エントリがセッション close まで残留する (MAX_REQUEST_UPDATES のカウント
  // 継続)。エラー文言は FIN 経路と共通の定数を使う。
  rejectPendingNamespaceUpdates(
    session as unknown as SessionInternal,
    requestId,
    subscription,
    new Error(REQUEST_UPDATE_STREAM_CLOSED_MESSAGE),
  );

  // draft-ietf-moq-transport-23 §4.2 / §6.4.2.3:
  // SUBSCRIBE_NAMESPACE の解除は RESET_STREAM (writer.abort()) と
  // STOP_SENDING (reader.cancel()) で行う。
  await namespacesCancelStream(
    subscription.streamReader,
    subscription.writer,
    "namespace subscription cancelled",
  );

  session.namespaceSubscriptions.delete(requestId);
}

/**
 * Tracks サブスクリプションを閉じる
 *
 * draft-ietf-moq-transport-23 §3.6 / §6.4.2.3 (FIN はキャンセルではない点は §6.4.2.2):
 * SUBSCRIBE_TRACKS のキャンセルは、まだ開いている方向を RESET_STREAM と
 * STOP_SENDING で切ることで行う (FIN はキャンセルではない)。
 */
export async function namespacesCloseTracksSubscription(
  session: NamespacesSessionInternal,
  requestId: bigint,
): Promise<void> {
  const subscription = session.tracksSubscriptions.get(requestId);
  if (!subscription || subscription.state === "closed") {
    return;
  }

  subscription.state = "closed";

  // 保留中の REQUEST_UPDATE (update() の Promise) を失敗させ、pendingPrefix を
  // クリアする (closeNamespaceSubscription と同様の理由)。
  rejectPendingNamespaceUpdates(
    session as unknown as SessionInternal,
    requestId,
    subscription,
    new Error(REQUEST_UPDATE_STREAM_CLOSED_MESSAGE),
  );

  // draft-ietf-moq-transport-23 §3.6 / §6.4.2.3:
  // SUBSCRIBE_TRACKS の解除は RESET_STREAM (writer.abort()) と
  // STOP_SENDING (reader.cancel()) で行う。
  await namespacesCancelStream(
    subscription.streamReader,
    subscription.writer,
    "tracks subscription cancelled",
  );

  session.tracksSubscriptions.delete(requestId);
}

/**
 * Namespace 公開を終了する
 *
 * draft-ietf-moq-transport-23 §4.1 / §6.4.2.3:
 * PUBLISH_NAMESPACE_DONE / PUBLISH_NAMESPACE_CANCEL は廃止され、公開の撤回は
 * request のキャンセル (RESET_STREAM と STOP_SENDING) で行う。
 * https://www.ietf.org/archive/id/draft-ietf-moq-transport-23.html#section-4.1
 */
export async function namespacesCloseNamespacePublication(
  session: NamespacesSessionInternal,
  requestId: bigint,
): Promise<void> {
  const publication = session.namespacePublications.get(requestId);
  if (!publication || publication.state === "closed") {
    return;
  }

  publication.state = "closed";

  // draft-ietf-moq-transport-23 §4.1 / §6.4.2.3:
  // PUBLISH_NAMESPACE の撤回は RESET_STREAM (writer.abort()) と
  // STOP_SENDING (reader.cancel()) で行う。
  await namespacesCancelStream(
    publication.streamReader,
    publication.writer,
    "namespace publication cancelled",
  );

  session.namespacePublications.delete(requestId);
}

/**
 * Namespace / Tracks サブスクリプションの Track Namespace Prefix を更新する
 *
 * draft-ietf-moq-transport-23 §9.5.2 (Updating Namespace Subscriptions):
 * REQUEST_UPDATE に TRACK_NAMESPACE_PREFIX パラメータを含めて送信する。
 * Tracks 系では draft-ietf-moq-transport-23 §9.19.18 の PAUSED も送り得る。
 * 送信と応答待ちは bidi.bidiSendNamespaceRequestUpdate が行う。
 * kind が namespace の場合、paused が混入しても送らない。
 */
export async function namespacesSendNamespaceRequestUpdate(
  session: NamespacesSessionInternal,
  requestId: bigint,
  kind: "namespace" | "tracks",
  options: TracksUpdateOptions,
): Promise<void> {
  const subscription =
    kind === "namespace"
      ? session.namespaceSubscriptions.get(requestId)
      : session.tracksSubscriptions.get(requestId);
  if (!subscription || subscription.state !== "active" || !subscription.writer) {
    throw new Error(`${kind} subscription is not active`);
  }
  return bidi.bidiSendNamespaceRequestUpdate(
    session as unknown as bidi.BidiSessionInternal,
    requestId,
    subscription.writer,
    options,
  );
}

export async function namespacesCleanupSendFailure(
  streamReader: ReadableStreamDefaultReader<Uint8Array>,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  reason = "namespace request send failed",
): Promise<void> {
  try {
    await streamReader.cancel(reason);
  } catch {
    // 閉じかけのストリーム操作の失敗は無視する
  } finally {
    streamReader.releaseLock();
  }
  try {
    await writer.abort(reason);
  } catch {
    // 閉じかけのストリーム操作の失敗は無視する
  } finally {
    writer.releaseLock();
  }
}

export async function namespacesCancelStream(
  streamReader: ReadableStreamDefaultReader<Uint8Array> | undefined,
  writer: WritableStreamDefaultWriter<Uint8Array> | undefined,
  reason: string,
): Promise<void> {
  if (streamReader !== undefined) {
    try {
      await streamReader.cancel(reason);
    } catch {
      // 既に閉じている / 解放済みの場合は無視
    }
  }
  if (writer !== undefined) {
    try {
      await writer.abort(reason);
    } catch {
      // 既に閉じている / abort 済みの場合は無視
    }
  }
}

export function namespacesStartNamespaceStreamLoop(
  session: NamespacesSessionInternal,
  requestId: bigint,
  resolve: (subscription: NamespaceSubscription) => void,
  reject: (err: Error) => void,
): Promise<void> {
  return namespaceStartNamespaceStreamLoop(
    session as unknown as SessionInternal,
    requestId,
    resolve,
    reject,
  );
}

export function namespacesStartTracksStreamLoop(
  session: NamespacesSessionInternal,
  requestId: bigint,
  resolve: (subscription: TracksSubscription) => void,
  reject: (err: Error) => void,
): Promise<void> {
  return namespaceStartTracksStreamLoop(
    session as unknown as SessionInternal,
    requestId,
    resolve,
    reject,
  );
}

export function namespacesStartPublicationStreamLoop(
  session: NamespacesSessionInternal,
  requestId: bigint,
  resolve: (publication: NamespacePublication) => void,
  reject: (err: Error) => void,
): Promise<void> {
  return namespaceStartPublicationStreamLoop(
    session as unknown as SessionInternal,
    requestId,
    resolve,
    reject,
  );
}
