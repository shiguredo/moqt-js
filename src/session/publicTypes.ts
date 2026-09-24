/**
 * moqt-js の公開型定義
 *
 * session.ts から公開 API の型 (ConnectOptions / SessionStatistics 以外の
 * コールバックとオプション、および購読 / 配信オブジェクトのインターフェース) を
 * まとめる。Session インターフェースと SessionImpl は session.ts に残し、
 * ここでは型のみを定義して session.ts から再エクスポートする。
 */

import type { AuthorizationToken, LocationFilter, Parameter, RangeFilterSpec } from "../message";
import type { MoqtObject } from "../dataStream";
import type { PendingSubgroupBufferOptions } from "../pendingSubgroupBuffer";

/**
 * fill fetch の要求内容
 * draft-ietf-moq-transport-21 Section 3.4 (Fill Semantics) /
 * Section 9.20.16 (FILL PARAMETERS Parameter)
 *
 * SUBSCRIBE / subscription の REQUEST_UPDATE に FILL_PARAMETERS (0x23) として
 * 載せ、live 手前の範囲を fill fetch ストリームで取得する。内側に載せられる
 * のは FILL_TIMEOUT / SUBSCRIBER_PRIORITY / LOCATION_FILTER / GROUP_ORDER /
 * Range Filters (0x25-0x28) のみ (§9.20.16 Table 6)。
 */
export interface FillRequestOptions {
  /**
   * fill 範囲の Location Filter
   *
   * 省略時は subscription の Location Filter、zero-length (reset) はトラック
   * 全体 (Largest Object まで) が fill 範囲になる (§3.4)。
   */
  filter?: LocationFilter;
  /**
   * Fill Timeout（ミリ秒）
   * draft-ietf-moq-transport-21 Section 9.20.6 (FILL TIMEOUT Parameter)
   */
  fillTimeout?: bigint;
  /**
   * Subscriber Priority（0-255）
   * draft-ietf-moq-transport-21 Section 9.20.8 (SUBSCRIBER PRIORITY Parameter)
   */
  subscriberPriority?: number;
  /**
   * Group Order
   * draft-ietf-moq-transport-21 Section 9.20.9 (GROUP ORDER Parameter)
   */
  groupOrder?: "Ascending" | "Descending";
  /**
   * Range Filters
   * draft-ietf-moq-transport-21 Section 3.3.2 (Range Filters)
   *
   * ピアの MAX_FILTER_RANGES が 0（未広告含む）の場合、および購読単位の Ranges
   * 合計が上限を超える場合に指定すると throw する。合計にはこの fill 内側の
   * Range Filter も含まれる（SUBSCRIBE / SUBSCRIBE_TRACKS の初回送信では外側の
   * rangeFilters との合計、REQUEST_UPDATE ではマージ後の購読フィルタ・in-flight の
   * 更新・in-flight の fill との合計）。
   */
  rangeFilters?: RangeFilterSpec[];
}

/**
 * セッション状態
 */
export type SessionState = "connected" | "closed";

/**
 * MOQT プロトコルメッセージをログ出力するためのデバッグメッセージ
 */
export interface DebugMessage {
  /** メッセージの方向 */
  direction: "send" | "recv";
  /** メッセージタイプ番号 */
  type: number;
  /** メッセージタイプ名 (例: "SETUP", "SUBSCRIBE") */
  typeName: string;
  /**
   * 生のペイロードバイト列。
   *
   * Uint8Array は moqt-js 内部のバッファとは独立しており、受信側は
   * コールバックを超えて保持してよい。ただし受信側はこれを変更してはならない。
   * コールバックの返却後も同一インスタンスが moqt-js 内部から参照される
   * 可能性があるためである (例: 再送やさらなるエンコードのため)。
   */
  payload: Uint8Array;
  /** デコードされたメッセージ内容 (利用可能な場合) */
  decoded?: Record<string, unknown>;
  /** ミリ秒単位のタイムスタンプ */
  timestamp: number;
}

/**
 * 接続コールバック
 */
export interface ConnectCallbacks {
  close?: (closeInfo: WebTransportCloseInfo) => void;
  error?: (error: Error) => void;
  /** MOQT プロトコルメッセージをログ出力するためのデバッグコールバック */
  debug?: (message: DebugMessage) => void;
  /**
   * GOAWAY 受信時のコールバック
   * draft-ietf-moq-transport-21 Section 9.2 (GOAWAY)
   * @param newSessionUri - 新しいセッション URI（セッションマイグレーション用）
   */
  goaway?: (newSessionUri: string) => void;
}

/**
 * 自己署名証明書用の証明書ハッシュ
 * WebTransport の serverCertificateHashes オプションと共に使用する
 * 注意: 証明書の有効期間は 14 日以下でなければならない
 */
export interface CertificateHash {
  algorithm: "sha-256";
  value: ArrayBuffer;
}

/**
 * 接続オプション
 */
export interface ConnectOptions {
  /**
   * 自己署名証明書用の証明書ハッシュ
   * 自己署名証明書を使ったローカル開発で使用する
   * 注意: 証明書の有効期間は 14 日以下でなければならない
   */
  serverCertificateHashes?: CertificateHash[];

  /**
   * SETUP Option (Option Type 0x03) として送信する Authorization Token
   * draft-ietf-moq-transport-21 Section 9.1.4 (AUTHORIZATION TOKEN Setup Option)
   *
   * SETUP では Alias Type DELETE (0x0) / USE_ALIAS (0x2) は仕様上禁止 (Section 9.1.4)。
   * REGISTER (0x1) または USE_VALUE (0x3) のみ指定できる。
   */
  authorizationToken?: AuthorizationToken;

  /**
   * SETUP Option (Option Type 0x04) として広告する MAX_AUTH_TOKEN_CACHE_SIZE
   * draft-ietf-moq-transport-21 §9.1.3 (MAX_AUTH_TOKEN_CACHE_SIZE)
   *
   * ピアが保持してよい Authorization Token Alias の最大バイト数。
   * 省略時は SETUP Option を送信せず、既定値 0（Alias 使用禁止）となる。
   */
  maxAuthTokenCacheSize?: number;

  /**
   * SETUP Option (Option Type 0x08) として広告する MAX_REQUEST_UPDATES
   * draft-ietf-moq-transport-21 §9.1.7 (MAX_REQUEST_UPDATES)
   *
   * リクエストストリームごとに未応答で許可する REQUEST_UPDATE の最大数。
   * 0 は無制限。省略時は SETUP Option を送信せず、既定値 0（無制限）となる。
   */
  maxRequestUpdates?: number;

  /**
   * SETUP Option (Option Type 0x06) として広告する MAX_FILTER_RANGES
   * draft-ietf-moq-transport-21 §9.1.6 (MAX FILTER RANGES)
   *
   * ピアが購読・FETCH ごとに送信できる Range Filter の合計 Ranges 数。
   * 省略時は SETUP Option を送信せず、既定値 0（Range Filter 受信拒否）となり、
   * ピアから REQUEST_UPDATE 等で Range Filter を受信した場合は
   * REQUEST_ERROR (INVALID_FILTER) で拒否する。
   */
  maxFilterRanges?: number;

  /**
   * Pending Subgroup Stream の buffer 設定
   * draft-ietf-moq-transport-21 §11.3.1 の "MAY ... choose to buffer it for a brief
   * period to handle reordering with the control message that establishes the Track
   * Alias" を実現する buffer の上限を制御する。
   *
   * 指定しなかった field は `DEFAULT_PENDING_SUBGROUP_BUFFER_OPTIONS` の値が使われる。
   */
  pendingSubgroup?: Partial<PendingSubgroupBufferOptions>;

  /**
   * 制御メッセージの受信タイムアウト (ミリ秒)
   *
   * draft-ietf-moq-transport-21 §12.2 の CONTROL_MESSAGE_TIMEOUT (0x11) に対応する。
   * 制御ストリームで半端なメッセージを保持したままこの時間が経過したら、
   * CONTROL_MESSAGE_TIMEOUT でセッションを閉じ、ストリームを打ち切る。
   * 0 以下を指定するとタイムアウトしない (既定は 10,000)。
   */
  controlMessageTimeoutMs?: number;

  /**
   * データストリームの受信タイムアウト (ミリ秒)
   *
   * draft-ietf-moq-transport-21 §12.2 の DATA_STREAM_TIMEOUT (0x12) に対応する。
   * Subgroup / Fetch のヘッダーまたは Object の途中バイトを保持したままこの
   * 時間が経過したら、DATA_STREAM_TIMEOUT でセッションを閉じ、当該ストリームを
   * 打ち切る。0 以下を指定するとタイムアウトしない (既定は 30,000)。
   */
  dataStreamTimeoutMs?: number;

  /**
   * 確立後の受信データストリームが保持してよいバッファの上限 (バイト)
   *
   * draft-ietf-moq-transport-21 §12.5 (EXCESSIVE_LOAD 0x9):
   * 完成前の Object の payload 全長を受けられる値を指定する。上限を超えた
   * データストリームは EXCESSIVE_LOAD として打ち切り、セッションは閉じない
   * (アプリへは失敗として通知する)。0 以下を指定すると上限を設けない
   * (既定は 33,554,432 バイト = 32 MiB)。
   */
  dataStreamMaxBufferBytes?: number;

  /**
   * MOQT_IMPLEMENTATION Setup Option (Option Type 0x07) の送信制御
   * draft-ietf-moq-transport-21 §9.1.5 (MOQT IMPLEMENTATION) /
   * §15.8 (Implementation Identification Fingerprinting)
   *
   * - 未指定（既定）: `moqt-js/${version}` を送信する。
   * - false: MOQT_IMPLEMENTATION Option を送信しない（opt-out）。
   * - 文字列: その値をそのまま送信する（override）。値の妥当性検証は行わないため、
   *   内容は呼び出し側の責任（§9.1.5 は実装名とバージョンに限定する SHOULD を定める）。
   */
  moqtImplementation?: string | false;

  /**
   * GREASE Setup Option の送信（opt-in）
   * draft-ietf-moq-transport-21 §13 (Grease)
   *
   * true のとき、SETUP に GREASE Setup Option（0x7f * N + 0x9D パターンの予約値）を
   * 1 つ追加する。対向が未知の Option を gracefully に扱えることを保証する。
   * 既定（未指定 / false）では送信しない。
   */
  grease?: boolean;
}

/**
 * SessionImpl のコンストラクタが受け取るオプション
 * `connect()` から `ConnectOptions` の該当フィールドが渡される
 */
/**
 * パブリッシュコールバック
 */
export interface PublishCallbacks {
  error?: (error: Error) => void;
  /**
   * Forward State が変更された時のコールバック
   * draft-ietf-moq-transport-21 Section 9.20.19 (FORWARD Parameter)
   *
   * REQUEST_UPDATE で Forward State が変更された時に呼ばれる。
   * PUBLISH 送信時の options.forward による初期設定で変化した場合も呼ばれる。
   * - true (1): Subscriber がいる（オブジェクトを送信すべき）
   * - false (0): Subscriber がいない（オブジェクト送信を止めても良い）
   */
  onForwardStateChange?: (forward: boolean) => void;
  /**
   * リクエストストリーム上で GOAWAY を受信した時のコールバック
   * draft-ietf-moq-transport-21 Section 9.2 (GOAWAY):
   * 当該リクエストのマイグレーション先 URI を通知する。
   */
  goaway?: (newSessionUri: string) => void;
}

/**
 * パブリッシュオプション
 */
export interface PublishOptions {
  /**
   * キャッシュの最大保持時間（ミリ秒）
   * draft-ietf-moq-transport-21 Section 10.3 (MAX CACHE DURATION)
   *
   * Relay がオブジェクトをキャッシュして良い最大時間を指定する。
   * 0 を指定するとキャッシュを無効にする。
   */
  maxCacheDuration?: bigint;

  /**
   * Delivery Timeout（ミリ秒）
   * draft-ietf-moq-transport-21 Section 10.2 (OBJECT_DELIVERY_TIMEOUT)
   *
   * PUBLISH の Track Properties として送信される OBJECT_DELIVERY_TIMEOUT（Message Parameter の定義は Section 9.20.5）。
   *
   * オブジェクトを受信してから配信を試みる最大時間。
   * moqt-js はこの値の強制は行わない。比較と強制は Publisher 値と Subscriber 値の両方を持つ
   * エンドポイント（典型的にはリレー）の責務であり、詳細は Section 5.2
   * (Delivery Timeouts and Data Reliability) を参照。
   */
  deliveryTimeout?: bigint;

  /**
   * Subgroup Delivery Timeout（ミリ秒）
   * draft-ietf-moq-transport-21 Section 10.1 (SUBGROUP_DELIVERY_TIMEOUT)
   *
   * PUBLISH の Track Properties として送信される SUBGROUP_DELIVERY_TIMEOUT（Message Parameter の定義は Section 9.20.4）。
   *
   * Subgroup 内のオブジェクトを配信する最大時間。0 はタイムアウトなしを意味する。
   * moqt-js はこの値の強制は行わない。比較と強制は Publisher 値と Subscriber 値の両方を持つ
   * エンドポイント（典型的にはリレー）の責務であり、詳細は Section 5.2
   * (Delivery Timeouts and Data Reliability) を参照。
   */
  subgroupDeliveryTimeout?: bigint;

  /**
   * Publisher Priority（0-255）
   * draft-ietf-moq-transport-21 Section 10.4 (DEFAULT PUBLISHER PRIORITY)
   *
   * パブリッシュの優先度。小さい値ほど高優先度。
   * 指定しない場合は 128（デフォルト）
   */
  publisherPriority?: number;

  /**
   * Group Order
   * draft-ietf-moq-transport-21 Section 10.5 (DEFAULT PUBLISHER GROUP ORDER)
   *
   * グループの配信順序。
   * - "Ascending": 古いグループから順に配信
   * - "Descending": 新しいグループから順に配信
   */
  groupOrder?: "Ascending" | "Descending";

  /**
   * Dynamic Groups サポートの通知
   * draft-ietf-moq-transport-21 Section 10.6 (DYNAMIC GROUPS)
   *
   * true を設定すると、Subscriber が NEW_GROUP_REQUEST パラメータで
   * 新しいグループの生成を要求できることを通知する。
   */
  dynamicGroups?: boolean;

  /**
   * Expires（ミリ秒）
   * draft-ietf-moq-transport-21 Section 9.20.17 (EXPIRES Parameter)
   *
   * パブリッシュが自動終了するまでの時間（ミリ秒）。
   * 0 または未指定の場合は期限なし。
   */
  expires?: bigint;

  /**
   * Forward State
   * draft-ietf-moq-transport-21 Section 9.20.19 (FORWARD Parameter)
   *
   * オブジェクトの転送状態を指定する。
   * - true (1): オブジェクトを転送する（デフォルト）
   * - false (0): オブジェクトを転送しない
   *
   * 省略した場合は 1（転送する）がデフォルト。
   * 初期値は PUBLISH 送信時に宣言し、以後は REQUEST_UPDATE で更新する。
   */
  forward?: boolean;

  /**
   * LOC Timescale（Track Property として送信）
   * draft-ietf-moq-loc-04 Table 1 (TIMESCALE, Scope: Track, Object)
   *
   * 1 秒あたりの Timestamp 単位数。Track 初期化時に Track Property として広告し、
   * Object 単位の冗長送信を削減する。送らない場合は既存どおり Object Properties のみ。
   */
  locTimescale?: bigint;

  /**
   * LOC Video Config（Track Property として送信）
   * draft-ietf-moq-loc-04 Table 1 (VIDEO_CONFIG, Scope: Track, Object)
   *
   * VideoDecoderConfig の description。Track 初期化時に Track Property として広告する。
   */
  locVideoConfig?: Uint8Array;

  /**
   * LOC Audio Config（Track Property として送信）
   * draft-ietf-moq-loc-04 Table 1 (AUDIO_CONFIG, Scope: Track, Object)
   *
   * AudioDecoderConfig の description。Track 初期化時に Track Property として広告する。
   */
  locAudioConfig?: Uint8Array;
}

/**
 * サブスクライブコールバック
 */
/**
 * Subgroup の stream の終わり
 *
 * draft-ietf-moq-transport-21 Section 2.1 ("Objects can be delivered out of order"):
 * Group ごとに別の stream で届くため、前の Group の Object が次の Group の Object より後に
 * 届くことがある。stream が終わったことを知れば、アプリはそれ以上その Subgroup の Object が
 * 届かないと判断できる。
 */
export interface SubgroupStreamEnd {
  /** stream の Group ID */
  groupId: bigint;
  /**
   * stream で確定した Subgroup ID。Subgroup ID を最初の Object から決める Subgroup Header の
   * stream で、Object を 1 つも受け取らずに終わった場合は未設定
   */
  subgroupId?: bigint;
  /** FIN で終わったら `"fin"`、ピアの RESET_STREAM で終わったら `"reset"` */
  reason: "fin" | "reset";
}

export interface SubscribeCallbacks {
  object: (object: MoqtObject) => void;
  /**
   * Datagram で受信したオブジェクトのコールバック
   * draft-ietf-moq-transport-21 Section 11.2 (Datagrams)
   *
   * 注意: Datagram は信頼性がなく、順序も保証されない
   */
  datagram?: (object: MoqtObject) => void;
  end?: () => void;
  error?: (error: Error) => void;
  /**
   * fill fetch ストリームが失敗した時のコールバック
   *
   * draft-ietf-moq-transport-21 §3.4.1 (Opening and Closing Fill Fetch Streams):
   * "Because there is no REQUEST_ERROR associated with a fill fetch stream, the
   *  publisher signals a fill failure by resetting the stream" および
   * "Resetting or cancelling a fill fetch stream, by either endpoint, does not
   *  affect the subscription, which continues to deliver objects using
   *  subscribe subgroups and datagrams."
   * fill の失敗は購読の継続を妨げないため、購読の終了を意味する error とは
   * 別のコールバックで通知する。アプリは fill が欠けたことを検知して
   * 再取得を判断できる。FIN による正常完了では呼ばない。
   */
  fillError?: (error: Error) => void;
  /**
   * リクエストストリーム上で GOAWAY を受信した時のコールバック
   * draft-ietf-moq-transport-21 Section 9.2 (GOAWAY):
   * 当該リクエストのマイグレーション先 URI を通知する。
   */
  goaway?: (newSessionUri: string) => void;
  /**
   * 購読の Subgroup の stream が終わった時のコールバック
   *
   * その stream で届いた最後の Object を object コールバックへ渡した後に呼ぶ。
   * FIN (§11.3.2) とピアの RESET_STREAM で呼び、購読の終了や打ち切り (Malformed Track、
   * バッファ上限) では呼ばない。draft-ietf-moq-transport-21 Section 2.1 のとおり Object は
   * 順不同で届きうるため、前の Group の stream が終わるまで次の Group の Object を保留する
   * アプリ (映像の復号順を守る受信側など) が使う。
   */
  subgroupEnd?: (end: SubgroupStreamEnd) => void;
}

/**
 * サブスクライブオプション
 */
export interface SubscribeOptions {
  /**
   * Location Filter
   * draft-ietf-moq-transport-21 Section 3.3.1, Section 9.20.10
   *
   * どのオブジェクトを受信するかを指定するフィルタ。フィールドの有無で意味が
   * 変わる (Length ベースのワイヤに対応、§9.20.10):
   * - { startGroup }: 相対指定。Start Group = LARGEST_OBJECT の Group + 1 - startGroup
   *   (startGroup = 0 は Next Group)。未配信時は {0, 0} から開始
   * - { startGroup, startObject }: 絶対開始（終了なし）。両方 0 は Next Object
   *   (LARGEST_OBJECT の次、未配信時は {0, 0})
   * - { startGroup, startObject, endGroupDelta }: 絶対範囲。End Group =
   *   StartGroup + endGroupDelta が 2^64-1 を超えると送信前に
   *   InvalidFilterError で throw する（§9.20.10）
   * - { startGroup, startObject, endGroupDelta, endObject }: 絶対範囲 +
   *   End Object
   * - { reset: true }: Length 0 (REQUEST_UPDATE でのフィルタ除去)
   *
   * 指定しない場合、フィルタなし（全オブジェクト）
   */
  filter?: LocationFilter;

  /**
   * Delivery Timeout（ミリ秒）
   * draft-ietf-moq-transport-21 Section 9.20.5 (OBJECT_DELIVERY_TIMEOUT Parameter)
   *
   * オブジェクトを受信してから配信を試みる最大時間。
   * moqt-js はこの値を SUBSCRIBE の Message Parameter として送信するが、この値の強制は行わない。
   * 比較と強制は Publisher 値と Subscriber 値の両方を持つエンドポイント（典型的にはリレー）の
   * 責務であり、詳細は Section 5.2 (Delivery Timeouts and Data Reliability) を参照。
   */
  deliveryTimeout?: bigint;

  /**
   * Subgroup Delivery Timeout（ミリ秒）
   * draft-ietf-moq-transport-21 Section 9.20.4 (SUBGROUP_DELIVERY_TIMEOUT Parameter)
   *
   * Subgroup 内のオブジェクトを配信する最大時間。0 はタイムアウトなしを意味する。
   * moqt-js はこの値を SUBSCRIBE の Message Parameter として送信するが、この値の強制は行わない。
   * 比較と強制は Publisher 値と Subscriber 値の両方を持つエンドポイント（典型的にはリレー）の
   * 責務であり、詳細は Section 5.2 (Delivery Timeouts and Data Reliability) を参照。
   */
  subgroupDeliveryTimeout?: bigint;

  /**
   * Subscriber Priority（0-255）
   * draft-ietf-moq-transport-21 Section 9.20.8 (SUBSCRIBER PRIORITY Parameter)
   *
   * サブスクリプションの優先度。小さい値ほど高優先度。
   * 指定しない場合は 128（デフォルト）
   */
  subscriberPriority?: number;

  /**
   * Group Order
   * draft-ietf-moq-transport-21 Section 9.20.9 (GROUP ORDER Parameter)
   *
   * グループの配信順序の希望。
   * - "Ascending": 古いグループから順に配信
   * - "Descending": 新しいグループから順に配信
   *
   * 指定しない場合は Publisher の preference を使用
   */
  groupOrder?: "Ascending" | "Descending";

  /**
   * 新しいグループ（キーフレーム）を要求する
   * draft-ietf-moq-transport-21 Section 9.20.20 (NEW GROUP REQUEST Parameter)
   *
   * 0 を指定すると、Publisher は新しい Group を開始する
   * Publisher が DYNAMIC_GROUPS をサポートしていない場合は無視される
   */
  newGroupRequest?: bigint;

  /**
   * Forward State
   * draft-ietf-moq-transport-21 Section 9.20.19 (FORWARD Parameter)
   *
   * オブジェクトの転送状態を指定する。
   * - true (1): オブジェクトを転送する（デフォルト）
   * - false (0): オブジェクトを転送しない
   *
   * 省略した場合は 1（転送する）がデフォルト。
   */
  forward?: boolean;

  /**
   * Rendezvous Timeout（ミリ秒）
   * draft-ietf-moq-transport-21 Section 9.20.7 (RENDEZVOUS TIMEOUT Parameter)
   *
   * リレーが Publisher を待つ時間。
   * 0 は即時応答を要求。指定しない場合のデフォルトは 0。
   * draft-ietf-moq-transport-21 Section 9.20.7
   */
  rendezvousTimeout?: bigint;

  /**
   * Range Filters
   * draft-ietf-moq-transport-21 Section 3.3.2 (Range Filters)
   *
   * ピアの MAX_FILTER_RANGES が 0（未広告含む）の場合、および購読単位の Ranges
   * 合計（この rangeFilters と fill 内側の合計）が上限を超える場合に指定すると
   * throw する。
   */
  rangeFilters?: RangeFilterSpec[];

  /**
   * AUTHORIZATION_TOKEN Message Parameter (0x03) として送信する Authorization Token
   * draft-ietf-moq-transport-21 Section 9.20.3 (AUTHORIZATION TOKEN Parameter)
   *
   * draft-ietf-moq-msf-01 §11.4.3: track に関連するトークンは SUBSCRIBE に MUST 付与。
   * SETUP にトークンを載せていても免除されない。
   */
  authorizationToken?: AuthorizationToken;

  /**
   * fill fetch の要求
   * draft-ietf-moq-transport-21 Section 3.4 (Fill Semantics) /
   * Section 9.20.16 (FILL PARAMETERS Parameter)
   *
   * FILL_PARAMETERS (0x23) として送信し、live 手前の範囲を fill fetch
   * ストリームで取得する。対向が開いた fill fetch ストリームは購読に紐付けて
   * 受信する。fill 経由のオブジェクトは fillDelivered を true にして渡すため、
   * subscription 経由と区別できる。各 Object を一度だけ受け取りたい場合は、
   * Next Object の subscription (StartGroup = 0 かつ StartObject = 0) と
   * open-ended な fill を組み合わせる (publisher が fill を Largest Object で
   * 終えるため重複なくつながる。§3.4 の exactly-once パターン)。
   */
  fill?: FillRequestOptions;

  /**
   * Track Properties の受信要求
   * draft-ietf-moq-transport-21 Section 9.20.22 (INCLUDE_PROPERTIES Parameter)
   *
   * true (1) は応答に Track Properties を載せるよう要求し、
   * false (0) は空にするよう要求する。省略時はパラメータ自体を送らず、
   * 対向のデフォルト (1 と同等) に従う。
   */
  includeProperties?: boolean;
}

/**
 * SUBSCRIBE_TRACKS のオプション
 * draft-ietf-moq-transport-21 Section 9.18.1 (Parameters on SUBSCRIBE_TRACKS)
 *
 * SUBSCRIBE のパラメータのうち SUBSCRIBE_TRACKS で有効なもののサブセット。
 */
export interface SubscribeTracksOptions {
  /**
   * Group Order
   * draft-ietf-moq-transport-21 Section 9.20.9 (GROUP ORDER Parameter)
   */
  groupOrder?: "Ascending" | "Descending";

  /**
   * Forward State
   * draft-ietf-moq-transport-21 Section 9.20.19 (FORWARD Parameter)
   *
   * 省略した場合は 1（転送する）がデフォルト。
   * 明示的に false のときだけワイヤに FORWARD=0 を載せる。
   */
  forward?: boolean;

  /**
   * Range Filters
   * draft-ietf-moq-transport-21 Section 3.3.2 (Range Filters)
   *
   * ピアの MAX_FILTER_RANGES が 0（未広告含む）の場合、および購読単位の Ranges
   * 合計（この rangeFilters と fill 内側の合計）が上限を超える場合に指定すると
   * throw する。
   */
  rangeFilters?: RangeFilterSpec[];

  /**
   * Track Properties の受信要求
   * draft-ietf-moq-transport-21 Section 9.20.22 (INCLUDE_PROPERTIES Parameter)
   *
   * true (1) は結果 PUBLISH に Track Properties を載せるよう要求し、
   * false (0) は空にするよう要求する。省略時は送らない (デフォルト 1 と同等)。
   */
  includeProperties?: boolean;

  /**
   * Subscriber Priority
   * draft-ietf-moq-transport-21 Section 9.20.8 (SUBSCRIBER PRIORITY Parameter)
   *
   * 結果 PUBLISH の初期 Subscription Parameter になる (0-255、小さいほど高優先)。
   * 省略時は送らない。
   */
  subscriberPriority?: number;

  /**
   * Location Filter
   * draft-ietf-moq-transport-21 Section 9.18.1 (Parameters on SUBSCRIBE_TRACKS):
   * "To join Tracks initiated via the resulting PUBLISHes, the subscriber can
   *  specify a Location Filter and optionally include FILL_PARAMETERS, as
   *  described in Section 3.5."
   *
   * 結果 PUBLISH の初期 Location Filter になる。
   */
  filter?: LocationFilter;

  /**
   * Fill Parameters
   * draft-ietf-moq-transport-21 Section 9.20.16 (FILL_PARAMETERS Parameter)
   *
   * 結果 PUBLISH の購読で fill fetch を要求する。省略時は送らない。
   */
  fill?: FillRequestOptions;

  /**
   * 認可トークン
   * draft-ietf-moq-transport-21 Section 9.20.3 (AUTHORIZATION TOKEN Parameter)
   *
   * 省略時は送らない。
   */
  authorizationToken?: AuthorizationToken;
}

/**
 * フェッチコールバック
 */
export interface FetchCallbacks {
  object: (object: MoqtObject) => void;
  end?: () => void;
  error?: (error: Error) => void;
  /**
   * リクエストストリーム上で GOAWAY を受信した時のコールバック
   * draft-ietf-moq-transport-21 Section 9.2 (GOAWAY):
   * 当該リクエストのマイグレーション先 URI を通知する。
   */
  goaway?: (newSessionUri: string) => void;
}

/**
 * フェッチオプション
 */
export interface FetchOptions {
  /**
   * Fill Timeout（ミリ秒）
   * draft-ietf-moq-transport-21 Section 9.20.6 (FILL TIMEOUT Parameter)
   *
   * relay が欠損 object の fill 待機に費やす最大時間。
   * 0 は即座に利用可能な object のみを要求。
   */
  fillTimeout?: bigint;

  /**
   * Subscriber Priority
   * draft-ietf-moq-transport-21 Section 9.20.9 (SUBSCRIBER PRIORITY Parameter)
   *
   * FETCH 応答の優先度 (0-255、小さいほど高優先)。
   * "It MAY appear in a SUBSCRIBE, PUBLISH, FETCH, or REQUEST_UPDATE"。
   * 省略時は送らない (受信側は既定値として扱う)。
   */
  subscriberPriority?: number;

  /**
   * Group Order
   * draft-ietf-moq-transport-21 Section 9.20.9 (GROUP ORDER Parameter)
   *
   * FETCH 応答で Object を Group 順に並べる順序を要求する。
   * "It MAY appear in a SUBSCRIBE, PUBLISH, SUBSCRIBE_TRACKS, or FETCH"。
   * 省略時は送らない (FETCH_OK に出現できるパラメータではないため、
   * 応答でエコーされることはない)。
   */
  groupOrder?: "Ascending" | "Descending";

  /**
   * Location Filter
   * draft-ietf-moq-transport-21 Section 3.3.1 / Section 9.20.10
   *
   * 取得する範囲を指定する。フィールドの有無で意味が変わる (Length
   * ベースのワイヤに対応、§9.20.10):
   * - { startGroup }: 相対指定。Start Group = LARGEST_OBJECT の Group + 1 - startGroup
   * - { startGroup, startObject }: 絶対開始。両方 0 は Next Object
   * - { startGroup, startObject, endGroupDelta }: 絶対範囲。End Group =
   *   StartGroup + endGroupDelta が 2^64-1 を超えると送信前に
   *   InvalidFilterError で throw する（§9.20.10 は超過時に PROTOCOL_VIOLATION
   *   を要求するため、ワイヤに載せる前にローカルで拒否する）
   * - { startGroup, startObject, endGroupDelta, endObject }: 絶対範囲 +
   *   End Object
   * - { reset: true }: Length 0 (フィルタなし。FETCH では省略と等価)
   *
   * 指定しない場合、フィルタなしとして {0, 0} から Largest Object までの
   * 全オブジェクトを要求する (§9.20.10。Fetch では End Group / End Object を
   * 省略した場合の終端が Largest Object になる)。
   */
  filter?: LocationFilter;

  /**
   * Range Filters
   * draft-ietf-moq-transport-21 Section 3.3.2 (Range Filters)
   *
   * ピアの MAX_FILTER_RANGES が 0（未広告含む）の場合、および Ranges の合計が
   * 上限を超える場合に指定すると throw する。
   */
  rangeFilters?: RangeFilterSpec[];

  /**
   * AUTHORIZATION_TOKEN Message Parameter (0x03) として送信する Authorization Token
   * draft-ietf-moq-transport-21 Section 9.20.3 (AUTHORIZATION TOKEN Parameter)
   *
   * draft-ietf-moq-msf-01 §11.4.3: track に関連するトークンは FETCH に MUST 付与。
   */
  authorizationToken?: AuthorizationToken;

  /**
   * Track Properties の受信要求
   * draft-ietf-moq-transport-21 Section 9.20.22 (INCLUDE_PROPERTIES Parameter)
   *
   * true (1) は応答に Track Properties を載せるよう要求し、
   * false (0) は空にするよう要求する。省略時は送らない (デフォルト 1 と同等)。
   */
  includeProperties?: boolean;
}

/**
 * TRACK_STATUS のオプション
 * draft-ietf-moq-transport-21 Section 9.20.22 (INCLUDE_PROPERTIES Parameter)
 */
export interface TrackStatusOptions {
  /**
   * Track Properties の受信要求
   * draft-ietf-moq-transport-21 Section 9.20.22 (INCLUDE_PROPERTIES Parameter)
   *
   * true (1) は応答に Track Properties を載せるよう要求し、
   * false (0) は空にするよう要求する。省略時は送らない (デフォルト 1 と同等)。
   */
  includeProperties?: boolean;

  /**
   * 認可トークン
   * draft-ietf-moq-transport-21 Section 9.20.3 (AUTHORIZATION TOKEN Parameter)
   *
   * "It MAY appear in a PUBLISH, SUBSCRIBE, REQUEST_UPDATE, SUBSCRIBE_NAMESPACE,
   *  SUBSCRIBE_TRACKS, PUBLISH_NAMESPACE, TRACK_STATUS or FETCH message."
   * 省略時は送らない。
   */
  authorizationToken?: AuthorizationToken;
}

/**
 * TRACK_STATUS の結果
 * draft-ietf-moq-transport-21 Section 9.13 (TRACK_STATUS)
 */
export interface TrackStatusResult {
  /**
   * 応答パラメータ（SUBSCRIBE_OK と同様）
   */
  parameters: Parameter[];
}

/**
 * Namespace サブスクリプションのコールバック
 *
 * draft-ietf-moq-transport-21 §9.15 (SUBSCRIBE_NAMESPACE):
 * SUBSCRIBE_NAMESPACE への応答として、NAMESPACE / NAMESPACE_DONE が送信される。
 * draft-18 で旧 SUBSCRIBE_NAMESPACE (0x11) が SUBSCRIBE_NAMESPACE (0x50) と
 * SUBSCRIBE_TRACKS (0x51) に分割され、PUBLISH_SKIPPED は SUBSCRIBE_TRACKS 応答に移動した。
 */
export interface NamespaceSubscriptionCallbacks {
  /**
   * NAMESPACE を受信したときに呼ばれる
   * draft-ietf-moq-transport-21 §9.16 (NAMESPACE)
   *
   * @param namespaceSuffix - Track Namespace Prefix を除いた Suffix
   */
  onNamespace?: (namespaceSuffix: string[]) => void;
  /**
   * NAMESPACE_DONE を受信したときに呼ばれる
   * draft-ietf-moq-transport-21 §9.17 (NAMESPACE_DONE)
   *
   * @param namespaceSuffix - Track Namespace Prefix を除いた Suffix
   */
  onNamespaceDone?: (namespaceSuffix: string[]) => void;
  /**
   * エラー時のコールバック
   */
  error?: (error: Error) => void;
  /**
   * GOAWAY 受信時に呼ばれる
   * draft-ietf-moq-transport-21 §9.2 (GOAWAY):
   * リクエストストリーム上の GOAWAY は当該リクエストの
   * マイグレーションのみを目的とする。
   *
   * @param newSessionUri - 新しいセッション URI
   */
  goaway?: (newSessionUri: string) => void;
}

/**
 * Namespace サブスクリプションの更新オプション
 *
 * draft-ietf-moq-transport-21 §9.5.2 (Updating Namespace Subscriptions):
 * REQUEST_UPDATE に TRACK_NAMESPACE_PREFIX パラメータ (0x34) を含めて
 * 確立済みの SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS の Track Namespace Prefix を
 * 更新する。
 */
export interface NamespaceUpdateOptions {
  /**
   * 更新後の Track Namespace Prefix
   * draft-ietf-moq-transport-21 §9.20.21 (TRACK_NAMESPACE_PREFIX Parameter)
   */
  trackNamespacePrefix: string[];
}

/**
 * Tracks 更新のオプション
 * draft-ietf-moq-transport-21 §9.20.19 (FORWARD Parameter):
 * SUBSCRIBE_TRACKS の REQUEST_UPDATE に FORWARD が許可された。
 * FORWARD は prefix に一致する将来の購読の Forwarding State を指定し、
 * 既存購読には影響しない。省略時は不変。
 */
export interface TracksUpdateOptions extends NamespaceUpdateOptions {
  /**
   * 将来の購読の Forward State
   * draft-ietf-moq-transport-21 §9.20.19 (FORWARD Parameter)
   *
   * true (1) / false (0) を明示送信する。省略時は不変。
   * SUBSCRIBE_NAMESPACE 向け REQUEST_UPDATE では許可されないため、
   * NamespaceSubscription.update には露出させない。
   */
  forward?: boolean;
}

/**
 * Namespace サブスクリプション
 */
export interface NamespaceSubscription {
  readonly state: "active" | "closed";
  /**
   * サブスクリプションを解除する
   */
  unsubscribe(): Promise<void>;
  /**
   * Track Namespace Prefix を更新する (REQUEST_UPDATE を送信)
   *
   * draft-ietf-moq-transport-21 §9.5.2 (Updating Namespace Subscriptions):
   * REQUEST_OK 受信で resolve、REQUEST_ERROR (PREFIX_OVERLAP 等) / ストリーム
   * クローズで reject する。
   *
   * 以下の場合はローカル検証として throw する:
   * - サブスクリプションが active でない
   * - GOAWAY 受信後 (ストリーム移行中)
   * - ピアの MAX_REQUEST_UPDATES を超える送信
   * - 前の更新が in-flight (REQUEST_OK 未受信) のうちの 2 件目
   *   (前の update() の settle を待ってから呼ぶこと)
   * - 予約 namespace / .session への更新
   * - 同一型のアクティブなサブスクリプション (更新対象自身を除く) と
   *   共通 prefix を持つ更新
   *
   * @param options - 更新内容 (TRACK_NAMESPACE_PREFIX)
   */
  update(options: NamespaceUpdateOptions): Promise<void>;
}

/**
 * Tracks サブスクリプションのコールバック
 *
 * draft-ietf-moq-transport-21 §9.18 (SUBSCRIBE_TRACKS):
 * SUBSCRIBE_TRACKS への応答として PUBLISH メッセージが新規双方向ストリームで
 * 送信される。応答ストリームでは PUBLISH_SKIPPED が送られる。
 */
export interface TracksSubscriptionCallbacks {
  /**
   * サーバーから PUBLISH メッセージを受信したときに呼ばれる
   * draft-ietf-moq-transport-21 §9.18 / §9.8
   *
   * @param namespaceSuffix - Track Namespace Prefix を除いた Suffix
   * @param trackName - PUBLISH に含まれる Track Name
   * @returns SubscribeCallbacks — 内部的に SubscriberImpl を生成しコールバックを伝搬する
   */
  onPublish?: (
    namespaceSuffix: string[],
    trackName: string,
  ) => SubscribeCallbacks | Promise<SubscribeCallbacks>;
  /**
   * PUBLISH_SKIPPED を受信したときに呼ばれる
   * draft-ietf-moq-transport-21 §9.19 (PUBLISH_SKIPPED):
   *
   * > The publisher sends the PUBLISH_SKIPPED control message to indicate
   * > it cannot send a PUBLISH message to initiate a new Subscription for a
   * > Track in the SUBSCRIBE_TRACKS's Track Namespace.
   *
   * @param namespaceSuffix - Track Namespace Prefix を除いた Suffix
   * @param trackName - 確立できなかった Subscription の Track Name
   */
  onPublishSkipped?: (namespaceSuffix: string[], trackName: string) => void;
  /**
   * エラー時のコールバック
   */
  error?: (error: Error) => void;
  /**
   * GOAWAY 受信時に呼ばれる
   * draft-ietf-moq-transport-21 §9.2 (GOAWAY):
   * リクエストストリーム上の GOAWAY は当該リクエストの
   * マイグレーションのみを目的とする。
   *
   * @param newSessionUri - 新しいセッション URI
   */
  goaway?: (newSessionUri: string) => void;
}

/**
 * Tracks サブスクリプション
 *
 * draft-ietf-moq-transport-21 §9.18 (SUBSCRIBE_TRACKS)
 */
export interface TracksSubscription {
  readonly state: "active" | "closed";
  /**
   * サブスクリプションを解除する
   */
  unsubscribe(): Promise<void>;
  /**
   * Track Namespace Prefix と Forward State を更新する (REQUEST_UPDATE を送信)
   *
   * draft-ietf-moq-transport-21 §9.5.2 (Updating Namespace Subscriptions):
   * "Updating the prefix of a SUBSCRIBE_TRACKS has no effect on existing
   *  subscriptions." (既存の確立済み SubscriberImpl には影響しない)
   * draft-ietf-moq-transport-21 §9.20.19 (FORWARD Parameter):
   * SUBSCRIBE_TRACKS の REQUEST_UPDATE に FORWARD が許可された。
   * 将来の購読の Forwarding State を指定し、既存購読には影響しない。
   *
   * REQUEST_OK 受信で resolve、REQUEST_ERROR (PREFIX_OVERLAP 等) / ストリーム
   * クローズで reject する。
   *
   * 以下の場合はローカル検証として throw する:
   * - サブスクリプションが active でない
   * - GOAWAY 受信後 (ストリーム移行中)
   * - ピアの MAX_REQUEST_UPDATES を超える送信
   * - 前の更新が in-flight (REQUEST_OK 未受信) のうちの 2 件目
   *   (前の update() の settle を待ってから呼ぶこと)
   * - 予約 namespace / .session への更新
   * - 同一型のアクティブなサブスクリプション (更新対象自身を除く) と
   *   共通 prefix を持つ更新
   *
   * @param options - 更新内容 (TRACK_NAMESPACE_PREFIX + FORWARD)
   */
  update(options: TracksUpdateOptions): Promise<void>;
}

/**
 * Namespace 公開のコールバック
 * draft-ietf-moq-transport-21 Section 9.14 (PUBLISH_NAMESPACE)
 */
export interface NamespacePublicationCallbacks {
  /**
   * エラー時のコールバック
   */
  error?: (error: Error) => void;
  /**
   * GOAWAY 受信時に呼ばれる
   * draft-ietf-moq-transport-21 §9.2 (GOAWAY):
   * リクエストストリーム上の GOAWAY は当該リクエストの
   * マイグレーションのみを目的とする。
   *
   * @param newSessionUri - 新しいセッション URI
   */
  goaway?: (newSessionUri: string) => void;
}

/**
 * Namespace 公開のオプション
 * draft-ietf-moq-transport-21 Section 9.14 (PUBLISH_NAMESPACE)
 */
export interface PublishNamespaceOptions {
  /**
   * 認可トークン
   * draft-ietf-moq-transport-21 Section 9.20.3 (AUTHORIZATION TOKEN Parameter)
   *
   * "It MAY appear in a PUBLISH, SUBSCRIBE, REQUEST_UPDATE, SUBSCRIBE_NAMESPACE,
   *  SUBSCRIBE_TRACKS, PUBLISH_NAMESPACE, TRACK_STATUS or FETCH message."
   * 省略時は送らない。
   */
  authorizationToken?: AuthorizationToken;
}

/**
 * Namespace 公開
 * draft-ietf-moq-transport-21 Section 9.14 (PUBLISH_NAMESPACE)
 */
export interface NamespacePublication {
  readonly state: "active" | "closed";
  /**
   * 公開している Namespace
   */
  readonly namespace: string[];
  /**
   * 公開を終了する
   * draft-ietf-moq-transport-21: ストリームの close で終了を通知する。
   */
  done(): Promise<void>;
}
