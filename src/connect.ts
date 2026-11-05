/**
 * MOQT サーバーへの接続
 *
 * draft-ietf-moq-transport-23 Section 6.2 (Session establishment)
 */

import { type ConnectCallbacks, type ConnectOptions, type Session, SessionImpl } from "./session";
import { SessionErrorCode } from "./error";
import { normalizeMoqtUri } from "./moqtUri";
import { assertMaxControlMessageSize } from "./message";
import { assertMsfConnectionSupported } from "./msf";
import { resolveMsfAuthorizationToken } from "./msf/c4mAuthorization";

/**
 * 実装が準拠するドラフトの MOQT ALPN
 *
 * draft-ietf-moq-transport-23 §6.2: "ALPNs used to identify IETF drafts are
 * created by appending the draft number to moqt-." に従い、draft-23 は
 * "moqt-23" になる (最終版の ALPN は "moqt")。
 */
const MOQT_ALPN = "moqt-23";

/**
 * Connect to a MOQT server
 *
 * @param url - MOQT URI (例: `moqt://example.com/moqt`)
 * @param callbacks - Connection callbacks
 * @param options - Connection options
 * @returns Session object
 *
 * @example
 * ```typescript
 * import { connect } from "moqt-js"
 *
 * const session = await connect(
 *   "moqt://example.com/moqt",
 *   { close: (info) => console.log(`disconnected: closeCode=${info.closeCode}, reason=${info.reason}`), error: (e) => console.error(e) }
 * )
 *
 * // Publish
 * const publisher = await session.publish(
 *   ["room", "123"],
 *   "video",
 *   { error: (e) => console.error(e) }
 * )
 * publisher.sendObject({ groupId: 0, objectId: 0, payload })
 *
 * // Subscribe
 * const subscriber = await session.subscribe(
 *   ["room", "123"],
 *   "video",
 *   {
 *     object: (obj) => console.log(obj),
 *     // PUBLISH_DONE による購読の終了。statusCode が終了の理由 (draft-ietf-moq-transport-23 §12.4)
 *     end: (publishDone) => console.log(`track ended: 0x${publishDone.statusCode.toString(16)}`),
 *     error: (e) => console.error(e),
 *   }
 * )
 * ```
 */
export async function connect(
  url: string,
  callbacks?: ConnectCallbacks,
  options?: ConnectOptions,
): Promise<Session> {
  const { url: httpsUrl, fragment } = normalizeMoqtUri(url);

  // draft-ietf-moq-msf-01 §11.1.1: connection=q|wt は transport 選択を強制する。
  // msf fragment の connection パラメータを接続開始前に解釈・適用する。
  assertMsfConnectionSupported(fragment);

  // draft-ietf-moq-msf-01 §11.1.1 / §11.4.2 / §11.4.3:
  // msf fragment の c4m は SETUP で提示する C4M のトークン (AUTHORIZATION TOKEN Setup Option)。
  // fragment はサーバーへ送信されないため、クライアントが取り出して SETUP に載せる。
  // 呼び出し元が options.authorizationToken を明示した場合はそちらを優先する
  // (?? は左辺が undefined のときだけ右辺を評価するため、明示時は c4m を読まない)。
  const authorizationToken = options?.authorizationToken ?? resolveMsfAuthorizationToken(fragment);

  // draft-ietf-moq-transport-23 §9.1.8:
  // 広告値の検証を WebTransport 接続の確立前に行う。接続後に initialize() で
  // 検出すると、connect() が reject しても接続が開いたまま残るためである。
  if (options?.maxControlMessageSize !== undefined) {
    assertMaxControlMessageSize(options.maxControlMessageSize);
  }

  // Create WebTransport connection
  const transportOptions: WebTransportOptions = {};

  if (options?.serverCertificateHashes && options.serverCertificateHashes.length > 0) {
    transportOptions.serverCertificateHashes = options.serverCertificateHashes;
  }

  // draft-ietf-moq-transport-23 §6.2 (Session establishment) / §6.2.1 (WebTransport):
  // "The client includes MOQT protocol identifiers in the WT-Available-Protocols
  //  header." ドラフト版の識別子は、同節の "ALPNs used to identify IETF drafts are
  //  created by appending the draft number to moqt-." に従い "moqt-" + ドラフト番号
  // になる (最終版の ALPN は "moqt"。この規則は RFC 編集者向けの注記の直後にあり、
  // 出版時に削除される箇所である)。
  // 実装が準拠するドラフトは draft-23 であるため "moqt-23" を提示する。サーバーが
  // この識別子を選択したかは transport.ready の解決後に transport.protocol で
  // 検証する (下記)。複数の draft を優先順で提示する運用が必要になった場合は
  // ここに追加する。
  // WebTransport API の protocols オプションが WT-Available-Protocols に相当する。
  transportOptions.protocols = [MOQT_ALPN];

  const transport = new WebTransport(httpsUrl, transportOptions);
  await transport.ready;

  // draft-ietf-moq-transport-23 §6.2 (Session establishment) / §6.2.1 (WebTransport):
  // WT-Available-Protocols で提示した MOQT の識別子をサーバーが選択したことを
  // 検証する。WebTransport はサーバーがプロトコルを選択しなくても接続が成立し、
  // その場合 transport.protocol は空文字列になる。バージョン未交渉のまま
  // draft-23 の SETUP を送らないよう、ここで接続を閉じて reject する。
  if (transport.protocol !== MOQT_ALPN) {
    // MOQT セッション確立前のため §12.2 の Session Termination コードは本来
    // 適用されない。VERSION_NEGOTIATION_FAILED (0x15) は draft-20 で削除された
    // (§A.4) ため、汎用の PROTOCOL_VIOLATION を close code に使う。
    const reason =
      transport.protocol === ""
        ? `MOQT protocol negotiation failed: the server did not select "${MOQT_ALPN}"`
        : `MOQT protocol negotiation failed: the server selected "${transport.protocol}" instead of "${MOQT_ALPN}"`;
    try {
      transport.close({ closeCode: SessionErrorCode.PROTOCOL_VIOLATION, reason });
    } catch {
      // 既に閉じている場合は無視する
    }
    throw new Error(reason);
  }

  // Create session
  // exactOptionalPropertyTypes では optional な pendingSubgroup に undefined を渡せないため、
  // 値がある場合だけ載せる (fragment は null を取り得るため常に載せる)
  const session = new SessionImpl(transport, callbacks ?? {}, {
    ...(options?.pendingSubgroup !== undefined ? { pendingSubgroup: options.pendingSubgroup } : {}),
    fragment,
  });

  // MOQT セッションを初期化する (SETUP メッセージの交換)
  // authorizationToken は SETUP Option (0x03) として送出する
  // draft-ietf-moq-transport-23 Section 9.1.4 (AUTHORIZATION TOKEN Setup Option)
  // moqtImplementation は SETUP Option (0x07) の送信を制御する
  // draft-ietf-moq-transport-23 §9.1.5 / §15.8
  // grease: true は GREASE Setup Option (§13) を追加する
  // exactOptionalPropertyTypes では optional なフィールドに undefined を渡せないため、
  // 値がある場合だけ載せる
  try {
    await session.initialize({
      ...(authorizationToken !== undefined ? { authorizationToken } : {}),
      ...(options?.moqtImplementation !== undefined
        ? { moqtImplementation: options.moqtImplementation }
        : {}),
      ...(options?.grease !== undefined ? { grease: options.grease } : {}),
      ...(options?.maxAuthTokenCacheSize !== undefined
        ? { maxAuthTokenCacheSize: options.maxAuthTokenCacheSize }
        : {}),
      ...(options?.maxRequestUpdates !== undefined
        ? { maxRequestUpdates: options.maxRequestUpdates }
        : {}),
      ...(options?.maxFilterRanges !== undefined
        ? { maxFilterRanges: options.maxFilterRanges }
        : {}),
      ...(options?.maxControlMessageSize !== undefined
        ? { maxControlMessageSize: options.maxControlMessageSize }
        : {}),
      ...(options?.controlMessageTimeoutMs !== undefined
        ? { controlMessageTimeoutMs: options.controlMessageTimeoutMs }
        : {}),
      ...(options?.dataStreamTimeoutMs !== undefined
        ? { dataStreamTimeoutMs: options.dataStreamTimeoutMs }
        : {}),
      ...(options?.dataStreamMaxBufferBytes !== undefined
        ? { dataStreamMaxBufferBytes: options.dataStreamMaxBufferBytes }
        : {}),
      ...(options?.dataStreamMaxTotalBufferBytes !== undefined
        ? { dataStreamMaxTotalBufferBytes: options.dataStreamMaxTotalBufferBytes }
        : {}),
    });
  } catch (error) {
    // 初期化に失敗すると Session を返せず、呼び出し元は WebTransport を閉じられない。
    // 接続を開いたまま残さないよう、ここで閉じる (閉鎖済みなら close は no-op)。
    try {
      transport.close({
        closeCode: SessionErrorCode.INTERNAL_ERROR,
        reason: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // 既に閉じている場合は無視する
    }
    throw error;
  }

  return session;
}
