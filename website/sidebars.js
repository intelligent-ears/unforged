const doc = (id, label) => ({ type: "doc", id, label });
const group = (label, items) => ({ type: "category", label, collapsible: false, items });

/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = {
  docs: [
    group("Start", [doc("README", "Overview")]),
    group("How it works", [
      doc("docs/architecture", "Architecture"),
      doc("docs/threat-model", "Threat model"),
      doc("docs/demo", "Demo"),
    ]),
    group("Reference", [
      doc("docs/formats", "Formats"),
      doc("docs/extension", "Extension"),
      doc("docs/cli-registry", "CLI and registry"),
    ]),
    group("Arkiv", [
      doc("arkiv/schema", "Schema"),
      doc("arkiv/how-you-use-arkiv", "How we use Arkiv"),
      doc("arkiv/why-arkiv", "Why Arkiv"),
      doc("arkiv/reach", "Reach"),
      doc("arkiv/friction", "Friction log"),
    ]),
    group("Research", [doc("study/README", "Reproducibility study")]),
  ],
};

export default sidebars;
