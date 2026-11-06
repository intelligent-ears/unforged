import path from "node:path";
import repoLinks, { DOCS_EXCLUDE, DOCS_INCLUDE, GITHUB_URL } from "./plugins/repo-links.mjs";

const REPO_ROOT = path.resolve(__dirname, "..");
const ROOT_README = path.join(REPO_ROOT, "README.md");

// One colour, plus quiet comments: green and red are reserved for verified and blocked.
const codeTheme = {
  plain: { color: "var(--uf-ink)", backgroundColor: "var(--uf-surface)" },
  styles: [{ types: ["comment", "prolog", "doctype", "cdata"], style: { color: "var(--uf-slate)", fontStyle: "italic" } }],
};

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: "Unforged",
  tagline: "Trust the source, not the server.",
  favicon: "img/logo.svg",
  url: "http://intelears.me",
  baseUrl: "/unforged/",
  organizationName: "intelligent-ears",
  projectName: "unforged",
  trailingSlash: false,
  onBrokenLinks: "throw",
  onBrokenAnchors: "throw",
  i18n: { defaultLocale: "en", locales: ["en"] },

  themes: ["@docusaurus/theme-mermaid"],
  markdown: {
    // Our .md files hold Safe{Wallet} and raw < characters, so they can't be MDX.
    format: "detect",
    mermaid: true,
    hooks: { onBrokenMarkdownLinks: "throw" },
    // Docusaurus would give the root README the slug "/", which is the landing page.
    // Set here so the markdown needs no front matter.
    parseFrontMatter: async (params) => {
      const result = await params.defaultParseFrontMatter(params);
      if (params.filePath === ROOT_README) result.frontMatter.slug ??= "/README";
      return result;
    },
  },

  presets: [
    [
      "classic",
      /** @type {import('@docusaurus/preset-classic').Options} */
      {
        docs: {
          path: "..",
          routeBasePath: "/",
          include: DOCS_INCLUDE,
          exclude: DOCS_EXCLUDE,
          sidebarPath: "./sidebars.js",
          // A function, because a string base would gain the ".." from `path` above.
          editUrl: ({ docPath }) => `${GITHUB_URL}/edit/main/${docPath}`,
          showLastUpdateTime: false,
          // Before the defaults, which would otherwise treat ../LICENSE as a bundled asset.
          beforeDefaultRemarkPlugins: [repoLinks],
        },
        blog: false,
        theme: { customCss: "./src/css/custom.css" },
      },
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      colorMode: { disableSwitch: true, respectPrefersColorScheme: true },
      navbar: {
        title: "Unforged",
        logo: { alt: "Unforged logo", src: "img/logo.svg" },
        items: [
          { to: "/README", label: "Docs", position: "left", activeBaseRegex: "/(README|docs/|study)" },
          { to: "/arkiv/schema", label: "Arkiv", position: "left", activeBaseRegex: "/arkiv/" },
          { href: GITHUB_URL, label: "GitHub", position: "right" },
        ],
      },
      footer: {
        links: [
          { label: "MIT", href: `${GITHUB_URL}/blob/main/LICENSE` },
          { label: "GitHub", href: GITHUB_URL },
        ],
        copyright: "Built at ETHGlobal Mumbai 2026",
      },
      prism: { theme: codeTheme, darkTheme: codeTheme, additionalLanguages: ["bash"] },
      mermaid: { theme: { light: "neutral", dark: "dark" } },
    }),
};

export default config;
