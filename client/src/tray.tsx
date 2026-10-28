import { useQuery } from "@tanstack/react-query";
import { api, notify } from "./api";
export function TrayPopover() {
  const { data } = useQuery({
    queryKey: ["tray-stats"],
    queryFn: () =>
      api<{ summary: { documents: number; pages: number; successes: number } }>(
        "/api/analytics?range=24h",
      ),
    refetchInterval: 5000,
  });
  return (
    <div className="tray-popover">
      <div className="section-line">
        <strong>● FreeOCRapi</strong>
        <span className="status ready">Running locally</span>
      </div>
      <p>One API for your OCR engines</p>
      <div className="metric-grid">
        <div>
          <span>Documents today</span>
          <strong>{data?.summary.documents || 0}</strong>
        </div>
        <div>
          <span>Pages today</span>
          <strong>{data?.summary.pages || 0}</strong>
        </div>
      </div>
      <div className="actions">
        <button
          className="primary"
          onClick={() => void window.freeocrapi?.openDashboard()}
        >
          Open dashboard
        </button>
        <button
          onClick={() =>
            void window.freeocrapi
              ?.copyKey()
              .then(() => notify("API key copied."))
          }
        >
          Copy API key
        </button>
      </div>
      <p className="small">
        Jobs and credentials stay in this desktop installation.
      </p>
    </div>
  );
}
