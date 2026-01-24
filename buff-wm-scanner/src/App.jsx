// src/App.jsx
import React, { useMemo, useState } from "react";

export default function App() {
  const [limit, setLimit] = useState(30);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [items, setItems] = useState([]);

  const fx = useMemo(() => items?.[0]?.fx ?? 0.14, [items]);

  const rows = useMemo(() => {
    // Compute simple spread using FX (CNY -> USD)
    // spread% = (wmPrice - buffUsd) / buffUsd
    return (items || []).map((it) => {
      const buffUsd = (Number(it.buffPrice) || 0) * (Number(it.fx) || fx || 0.14);
      const wmUsd = Number(it.wmPrice) || 0;
      const spread = buffUsd > 0 ? ((wmUsd - buffUsd) / buffUsd) * 100 : 0;
      const net = wmUsd - buffUsd;
      return { ...it, buffUsd, wmUsd, spread, net };
    });
  }, [items, fx]);

  async function runScan() {
    setLoading(true);
    setErr("");
    try {
      const res = await fetch(`/.netlify/functions/scan?limit=${encodeURIComponent(limit)}`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Scan failed");
      setItems(data.items || []);
    } catch (e) {
      setItems([]);
      setErr(String(e?.message || e));
      alert(`Scan failed: ${String(e?.message || e)}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div>
          <div style={styles.title}>ArbitrageScanner</div>
          <div style={styles.subTitle}>Buff163 → WhiteMarket (Buy offers)</div>
        </div>

        <div style={styles.controls}>
          <input
            style={styles.input}
            type="number"
            min={1}
            max={100}
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
          />
          <button style={styles.btn} onClick={runScan} disabled={loading}>
            {loading ? "Scanning..." : "Scan"}
          </button>
        </div>
      </div>

      <div style={styles.metaRow}>
        <div style={styles.card}>
          <div style={styles.cardLabel}>FX CNY→USD</div>
          <div style={styles.cardValue}>{Number(fx).toFixed(2)}</div>
        </div>
        <div style={styles.card}>
          <div style={styles.cardLabel}>Items</div>
          <div style={styles.cardValue}>{rows.length}</div>
        </div>
        <div style={styles.card}>
          <div style={styles.cardLabel}>Errors</div>
          <div style={styles.cardValue}>
            {(rows || []).filter((r) => r.wmError).length}
          </div>
        </div>
      </div>

      {err ? <div style={styles.error}>{err}</div> : null}

      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Item</th>
              <th style={styles.thRight}>BUFF (CNY)</th>
              <th style={styles.thRight}>BUFF (USD)</th>
              <th style={styles.thRight}>WM Buy Offer (USD)</th>
              <th style={styles.thRight}>Spread</th>
              <th style={styles.thRight}>Net</th>
              <th style={styles.th}>Link</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((it, idx) => (
              <tr key={it.id ?? idx} style={styles.tr}>
                <td style={styles.td}>
                  <div style={styles.itemCell}>
                    <img
                      src={it.image}
                      alt=""
                      style={styles.icon}
                      onError={(e) => (e.currentTarget.style.display = "none")}
                    />
                    <div>
                      <div style={styles.itemName}>{it.name}</div>
                      {it.wmError ? (
                        <div style={styles.miniErr}>WM: {it.wmError}</div>
                      ) : null}
                    </div>
                  </div>
                </td>

                <td style={styles.tdRight}>{Number(it.buffPrice || 0).toFixed(2)}</td>
                <td style={styles.tdRight}>${Number(it.buffUsd || 0).toFixed(2)}</td>
                <td style={styles.tdRight}>
                  {Number(it.wmUsd || 0) > 0 ? `$${Number(it.wmUsd).toFixed(2)}` : "$0.00"}
                </td>
                <td style={styles.tdRight}>
                  <span style={badge(it.spread)}>
                    {Number.isFinite(it.spread) ? `${it.spread.toFixed(2)}%` : "0.00%"}
                  </span>
                </td>
                <td style={styles.tdRight}>
                  <span style={{ color: it.net >= 0 ? "#22c55e" : "#ef4444" }}>
                    {it.net >= 0 ? "+" : "-"}${Math.abs(it.net).toFixed(2)}
                  </span>
                </td>
                <td style={styles.td}>
                  {it.wmUrl ? (
                    <a style={styles.link} href={it.wmUrl} target="_blank" rel="noreferrer">
                      Open
                    </a>
                  ) : (
                    <span style={{ opacity: 0.6 }}>—</span>
                  )}
                </td>
              </tr>
            ))}

            {!rows.length ? (
              <tr>
                <td colSpan={7} style={{ padding: 20, opacity: 0.7 }}>
                  No items found. Click “Scan”.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function badge(spread) {
  const ok = Number(spread) > 0;
  return {
    display: "inline-block",
    padding: "4px 10px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.10)",
    background: ok ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)",
    color: ok ? "#22c55e" : "#ef4444",
    fontWeight: 600,
    fontSize: 12,
  };
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "radial-gradient(1200px 600px at 50% 10%, #0c1a3a 0%, #070b16 55%)",
    color: "#e7eefc",
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial",
    padding: 22,
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    gap: 16,
    alignItems: "center",
    marginBottom: 16,
  },
  title: { fontSize: 22, fontWeight: 800 },
  subTitle: { fontSize: 12, opacity: 0.7, marginTop: 2 },
  controls: { display: "flex", gap: 10, alignItems: "center" },
  input: {
    width: 90,
    padding: "10px 12px",
    borderRadius: 10,
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.10)",
    color: "#e7eefc",
    outline: "none",
  },
  btn: {
    padding: "10px 14px",
    borderRadius: 10,
    background: "#3b6cff",
    border: "none",
    color: "white",
    fontWeight: 700,
    cursor: "pointer",
  },
  metaRow: { display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 },
  card: {
    flex: "0 0 auto",
    minWidth: 160,
    padding: 14,
    borderRadius: 14,
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.10)",
  },
  cardLabel: { fontSize: 11, opacity: 0.7 },
  cardValue: { fontSize: 20, fontWeight: 800, marginTop: 6 },
  error: {
    padding: 12,
    borderRadius: 12,
    border: "1px solid rgba(239,68,68,0.35)",
    background: "rgba(239,68,68,0.12)",
    marginBottom: 14,
  },
  tableWrap: {
    overflow: "auto",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.10)",
    background: "rgba(0,0,0,0.20)",
  },
  table: { width: "100%", borderCollapse: "collapse", minWidth: 980 },
  th: {
    textAlign: "left",
    fontSize: 12,
    opacity: 0.75,
    padding: "14px 12px",
    borderBottom: "1px solid rgba(255,255,255,0.10)",
    position: "sticky",
    top: 0,
    background: "rgba(7,11,22,0.95)",
    backdropFilter: "blur(6px)",
  },
  thRight: {
    textAlign: "right",
    fontSize: 12,
    opacity: 0.75,
    padding: "14px 12px",
    borderBottom: "1px solid rgba(255,255,255,0.10)",
    position: "sticky",
    top: 0,
    background: "rgba(7,11,22,0.95)",
    backdropFilter: "blur(6px)",
  },
  tr: { borderBottom: "1px solid rgba(255,255,255,0.06)" },
  td: { padding: "12px 12px", verticalAlign: "middle" },
  tdRight: { padding: "12px 12px", textAlign: "right", verticalAlign: "middle" },
  itemCell: { display: "flex", gap: 12, alignItems: "center" },
  icon: { width: 44, height: 34, objectFit: "cover", borderRadius: 8, background: "rgba(255,255,255,0.04)" },
  itemName: { fontWeight: 700, fontSize: 13 },
  miniErr: { fontSize: 11, opacity: 0.75, marginTop: 2, color: "#f59e0b" },
  link: { color: "#93c5fd", fontWeight: 700, textDecoration: "none" },
};
