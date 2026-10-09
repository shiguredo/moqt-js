/**
 * MOQT サーバーへの接続
 *
 * draft-ietf-moq-transport-22 Section 6.2 (Session establishment)
 */

import { type ConnectCallbacks, type ConnectOptions, type Session, SessionImpl } from "./session";
import { normalizeMoqtUri } from "./moqtUri";
import { assertMsfConnectionSupported } from "./msf";
import { resolveMsfAuthorizationToken } from "./msf/c4mAuthorization";

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
 *   { object: (obj) => console.log(obj), end: () => console.log("track ended"), error: (e) => console.error(e) }
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

  // Create WebTransport connection
  const transportOptions: WebTransportOptions = {};

  if (options?.serverCertificateHashes && options.serverCertificateHashes.length > 0) {
    transportOptions.serverCertificateHashes = options.serverCertificateHashes;
  }

  // draft-ietf-moq-transport-22 §6.2 (Session establishment) / §6.2.1 (WebTransport):
  // "The client includes MOQT protocol identifiers in the WT-Available-Protocols
  //  header." ドラフト版の識別子は、同節の "ALPNs used to identify IETF drafts are
  //  created by appending the draft number to moqt-." に従い "moqt-" + ドラフト番号
  // になる (最終版の ALPN は "moqt"。この規則は RFC 編集者向けの注記の直後にあり、
  // 出版時に削除される箇所である)。
  // 実装が準拠するドラフトは draft-22 であるため "moqt-22" を提示する。ピアが
  // draft-22 の識別子に対応していない場合は接続できない (現行の実リレーは
  // draft-21 のため接続できない)。複数の draft を優先順で提示する運用が必要に
  // なった場合はここに追加する。
  // WebTransport API の protocols オプションが WT-Available-Protocols に相当する。
  // protocols は TypeScript 6.0 の DOM 型で追加されたため、5.x でも通るようキャストする。
  (transportOptions as WebTransportOptions & { protocols?: string[] }).protocols = ["moqt-22"];

  const transport = new WebTransport(httpsUrl, transportOptions);
  await transport.ready;

  // Create session
  // exactOptionalPropertyTypes では optional な pendingSubgroup に undefined を渡せないため、
  // 値がある場合だけ載せる (fragment は null を取り得るため常に載せる)
  const session = new SessionImpl(transport, callbacks ?? {}, {
    ...(options?.pendingSubgroup !== undefined ? { pendingSubgroup: options.pendingSubgroup } : {}),
    fragment,
  });

  // MOQT セッションを初期化する (SETUP メッセージの交換)
  // authorizationToken は SETUP Option (0x03) として送出する
  // draft-ietf-moq-transport-22 Section 9.1.4 (AUTHORIZATION TOKEN Setup Option)
  // moqtImplementation は SETUP Option (0x07) の送信を制御する
  // draft-ietf-moq-transport-22 §9.1.5 / §15.8
  // grease: true は GREASE Setup Option (§13) を追加する
  // exactOptionalPropertyTypes では optional なフィールドに undefined を渡せないため、
  // 値がある場合だけ載せる
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
    ...(options?.maxFilterRanges !== undefined ? { maxFilterRanges: options.maxFilterRanges } : {}),
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

  return session;
}
