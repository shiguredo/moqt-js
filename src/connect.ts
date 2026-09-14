/**
 * MOQT サーバーへの接続
 *
 * draft-ietf-moq-transport-21 Section 6.2 (Session establishment)
 */

import { type ConnectCallbacks, type ConnectOptions, type Session, SessionImpl } from "./session";
import { normalizeMoqtUri } from "./moqtUri";
import { assertMsfConnectionSupported } from "./msf";

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

  // Create WebTransport connection
  const transportOptions: WebTransportOptions = {};

  if (options?.serverCertificateHashes && options.serverCertificateHashes.length > 0) {
    transportOptions.serverCertificateHashes = options.serverCertificateHashes;
  }

  // draft-ietf-moq-transport-21 §6.2 / §6.2.1:
  // "MOQT uses ALPN in QUIC and "WT-Available-Protocols" in WebTransport to
  //  perform version negotiation." / "The client includes MOQT protocol
  //  identifiers in the WT-Available-Protocols header."
  // draft 版の ALPN は "moqt-" + draft 番号であり、draft-21 は "moqt-21"。
  // WebTransport API の protocols オプションが WT-Available-Protocols に相当する。
  // protocols は TypeScript 6.0 の DOM 型で追加されたため、5.x でも通るようキャストする。
  (transportOptions as WebTransportOptions & { protocols?: string[] }).protocols = ["moqt-21"];

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
  // draft-ietf-moq-transport-21 Section 9.1.4 (AUTHORIZATION TOKEN Setup Option)
  // moqtImplementation は SETUP Option (0x07) の送信を制御する
  // draft-ietf-moq-transport-21 §9.1.5 / §15.8
  // grease: true は GREASE Setup Option (§13) を追加する
  // exactOptionalPropertyTypes では optional なフィールドに undefined を渡せないため、
  // 値がある場合だけ載せる
  await session.initialize({
    ...(options?.authorizationToken !== undefined
      ? { authorizationToken: options.authorizationToken }
      : {}),
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
  });

  return session;
}
