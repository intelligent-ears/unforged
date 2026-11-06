import React from "react";
import { REPLAY_SCRIPT } from "./replay";

/** The manifest root both builders attested for Lido 0.161.0 (docs/demo.md). */
const ROOT = "13c7535a8b18401f36f176ebc74488ed5929e494b8d4e15f6a68a1bee9d26682";

/**
 * Illustrative only: nothing real hashes to this. It is sha256("tampered " + ROOT),
 * so it differs from the root the way a tampered file's hash would: almost
 * everywhere, with a few characters matching by chance.
 */
const TAMPERED = "ab660fd05d60c50e5f2ddab89940ce1f1e8fbec55ef9d6e5c3163da7d8c0a7e1";

function AssayRow({ label, hash, verdict, classFor }) {
  const statusClass = verdict === "Match" ? "uf-status uf-status-match" : "uf-status uf-status-mismatch";
  return (
    <div className="uf-assay-row">
      <div className="uf-assay-head">
        <span className="uf-assay-label">{label}</span>
        <span className={statusClass}>
          <span className="uf-status-waiting">Waiting</span>
          <span className="uf-status-final">{verdict}</span>
        </span>
      </div>
      <div className="uf-hash" aria-hidden="true">
        {[...hash].map((char, index) => (
          <span key={index} className={classFor(char, index)}>
            {char}
          </span>
        ))}
      </div>
      <span className="uf-sr-only">{hash}</span>
    </div>
  );
}

/**
 * Rendered in its final state, so it is correct with JS off and with reduced motion.
 * The inline script only replays how it got there, on a full page load.
 */
export default function AssayHero() {
  const matches = () => "ok";
  const differs = (char, index) => (char === ROOT[index] ? undefined : "bad");
  return (
    <>
      <figure
        className="uf-assay"
        aria-label="Two builders produce the same hash. The served file's hash differs, so it is blocked."
        suppressHydrationWarning
      >
        <AssayRow label="Builder 1 (Docker)" hash={ROOT} verdict="Match" classFor={matches} />
        <AssayRow label="Builder 2 (GitHub Action)" hash={ROOT} verdict="Match" classFor={matches} />
        <AssayRow label="Served file" hash={TAMPERED} verdict="No match" classFor={differs} />
        <p className="uf-verdict">Blocked before it ran</p>
        <figcaption>The builder rows show the real manifest root of Lido 0.161.0. The served-file hash is an illustration.</figcaption>
      </figure>
      <script dangerouslySetInnerHTML={{ __html: REPLAY_SCRIPT }} />
    </>
  );
}
