import { formatPanelHttpVersion, type PanelHttpVersion } from "../utils/httpVersion";

/**
 * 確立した WebTransport が HTTP/2 上か HTTP/3 上かを、Ready / Connected と同じ丸いバッジで出す。
 * 文言は WT-H2 / WT-H3。ページの HTTP バージョンではない。
 *
 * 白地にして、緑の Publisher ヘッダーと青の Subscriber ヘッダーのどちらでも読めるようにする。
 * WT-H3 は緑、WT-H2 は琥珀色で、並んだときに種類が区別できるようにする。
 */
export function HttpVersionBadge({
  version,
  testId,
}: {
  version: PanelHttpVersion;
  testId: string;
}) {
  const http3 = version === "H3";
  return (
    <span
      data-testid={testId}
      class={`inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-semibold rounded-full bg-white shadow-sm ${
        http3 ? "text-emerald-700" : "text-amber-800"
      }`}
    >
      <span
        aria-hidden="true"
        class={`w-1.5 h-1.5 rounded-full ${http3 ? "bg-emerald-500" : "bg-amber-500"}`}
      />
      {formatPanelHttpVersion(version)}
    </span>
  );
}
