import Link from "@docusaurus/Link";
import AssayHero from "@site/src/components/AssayHero";
import Layout from "@theme/Layout";
import React from "react";

const GITHUB_URL = "https://github.com/intelligent-ears/unforged";
const EXPLORER = "https://rabdi.explorer.arkiv.network";

const DESCRIPTION =
  "A Firefox extension that blocks a dapp's code unless independent builders rebuilt it from the public source and got the same bytes.";

function Band({ id, title, wide, children }) {
  return (
    <section className={wide ? "uf-band uf-band-wide" : "uf-band"} aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

function Ledger({ rows }) {
  return (
    <dl className="uf-ledger">
      {rows.map(([term, description]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{description}</dd>
        </div>
      ))}
    </dl>
  );
}

function Address({ address }) {
  return (
    <Link href={`${EXPLORER}/address/${address}`}>
      <code>{address}</code>
    </Link>
  );
}

function Entity({ id, short }) {
  return (
    <Link href={`${EXPLORER}/entity/${id}`}>
      <code>{short}</code>
    </Link>
  );
}

export default function Home() {
  return (
    <Layout title="Trust the source, not the server" description={DESCRIPTION}>
      <main className="uf-landing">
        <section className="uf-hero">
          <div>
            <h1>Trust the source, not the server.</h1>
            <p className="uf-lede">{DESCRIPTION}</p>
            <p className="uf-actions">
              <Link className="uf-button uf-button-primary" to="/README">
                Read the docs
              </Link>
              <Link className="uf-button" href={GITHUB_URL}>
                View on GitHub
              </Link>
            </p>
          </div>
          <AssayHero />
        </section>

        <Band id="problem" title="The problem">
          <p>
            In February 2025, Bybit lost about $1.5B. One file was tampered with on {"Safe{Wallet}"}'s hosting, while the GitHub repo stayed clean.
          </p>
        </Band>

        <Band id="how" title="How it works">
          <ol className="uf-steps">
            <li>
              <h3>Builders rebuild from public source</h3>
              <p>Independent builders each rebuild the dapp from its public source, on their own machines or in their own GitHub organisation.</p>
            </li>
            <li>
              <h3>They sign attestations to Arkiv</h3>
              <p>Each builder signs what it got and publishes the attestation to Arkiv, under its own key.</p>
            </li>
            <li>
              <h3>The extension hashes every file before it runs</h3>
              <p>
                Anything that <i>k</i> builders didn't produce is blocked.
              </p>
            </li>
            <li>
              <h3>Blocked sites get a verified copy</h3>
              <p>The blocked page offers the verified copy from the mirror, so the dapp stays usable.</p>
            </li>
          </ol>
        </Band>

        <Band id="proof" title="Live proof" wide>
          <p className="uf-measure">The Lido 0.161.0 release is attested on Arkiv Rabdi by 2 of 2 builders. Both attestations carry the same manifest root:</p>
          <p className="uf-root">
            <code>13c7535a8b18401f36f176ebc74488ed5929e494b8d4e15f6a68a1bee9d26682</code>
          </p>
          <div className="uf-table-scroll" role="region" aria-label="Arkiv Rabdi entities for the Lido policy and attestations" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th scope="col">What</th>
                  <th scope="col">Who</th>
                  <th scope="col">Entity / tx</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Policy v1</td>
                  <td>
                    curator <Address address="0x60422cB6937125250f829ed2d06B02AE2679dE09" />
                  </td>
                  <td>
                    <Entity id="0x68842c8d4e3b756f717ec4175307b43c2bdfa121550f8bc4587dc13d0fbfae66" short="0x68842c8d…0fbfae66" />
                  </td>
                </tr>
                <tr>
                  <td>Attestation 1</td>
                  <td>
                    builder 1, Docker <Address address="0x723eE223ffAEEe90312E158E11FE75763262C5D3" />
                  </td>
                  <td>
                    <Entity id="0xaa51c3cc9f5f63838b7a55afd4a8f84980637dc8f411458883b9e323ae7ef90d" short="0xaa51c3cc…ae7ef90d" />
                  </td>
                </tr>
                <tr>
                  <td>Attestation 2</td>
                  <td>
                    builder 2, GitHub Action <Address address="0x9125c7F8A2001c3f0C902f4eEAEFC414Db339ACD" />
                  </td>
                  <td>
                    <Entity id="0xd3782c8131b21e334e252c65b9293b4bec3c8848b9b4b29ea0cccddf621c1b25" short="0xd3782c81…621c1b25" /> (
                    <Link href={`${EXPLORER}/tx/0x02249a35548dbd834dce5cdcf55b2375687941a7c4ad6f5d2f14a458192c65ed`}>tx</Link>)
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="uf-measure">
            <Link to="/docs/demo#live-on-arkiv-rabdi">See this evidence in the demo doc</Link>
          </p>
        </Band>

        <Band id="blocks" title="What it blocks">
          <Ledger
            rows={[
              ["Swap", "A tampered copy of one JS chunk is served, as at Bybit."],
              ["Inject", "An extra third-party script is added to the page, as at BadgerDAO and KyberSwap."],
              ["Hijack", "Every file comes from a cloned site with a modified bundle, as at Curve, Aerodrome and CoW Swap."],
              [
                "Config flip",
                <>
                  A config value that looks valid is hostile, such as a flipped <code>ipfsMode</code>, and fails the curator's pins.
                </>,
              ],
            ]}
          />
        </Band>

        <Band id="study" title="The study">
          <dl className="uf-tally">
            <div>
              <dt>13</dt>
              <dd>dapp frontends tried</dd>
            </div>
            <div>
              <dt>7</dt>
              <dd>of them build</dd>
            </div>
            <div>
              <dt>4</dt>
              <dd>of those are reproducible as published: Lido, ENS, Curve and Safe Transaction Builder</dd>
            </div>
            <div>
              <dt>3</dt>
              <dd>more are reproducible with small fixes</dd>
            </div>
          </dl>
          <p>
            <Link to="/study">Read the reproducibility study</Link>
          </p>
        </Band>

        <Band id="crops" title="CROPS">
          <Ledger
            rows={[
              ["Censorship resistance", "If a site is taken down, the user can still open the verified copy on the mirror."],
              ["Open source", "The code is MIT licensed, and every accepted release is rebuilt from public source."],
              ["Privacy", "The extension syncs in bulk, with no lookups per site visit."],
              ["Security", "Code is checked before it runs, and the check works without the dapp team."],
            ]}
          />
          <p>
            <Link to="/README#crops">Read the CROPS section</Link>
          </p>
        </Band>
      </main>
    </Layout>
  );
}
