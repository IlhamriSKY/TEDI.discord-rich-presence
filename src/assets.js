// Discord asset-key resolution. Maps a file name to the asset key used for the
// small-image badge in the presence card. Pure data tables + lookup helpers,
// no shared state.

// File extension -> Discord asset key for the small-image badge. Keys must
// match assets uploaded to the Discord Developer Portal under app id
// 1506303762418110505 (see README "Asset keys"). Unknown extensions fall
// back to `tab_editor` so the badge still tells the viewer "this is a
// file" rather than disappearing.
//
// The 22 lang_* keys (12 brand + 10 semantic) all source from the same
// HugeIcons free set as TabBar.tsx to keep the visual style coherent.
// Many languages share `lang_code` because HugeIcons doesn't carry their
// brand mark - one generic code badge beats sending an asset key that
// silently fails on Discord's side.
const LANG_ASSET_BY_EXT = {
  // ===== Brand-specific (HugeIcons free has dedicated icons) =====
  // PHP
  php: "lang_php",
  // JavaScript family (incl. CoffeeScript which transpiles to JS)
  js: "lang_js",
  mjs: "lang_js",
  cjs: "lang_js",
  jsx: "lang_js",
  coffee: "lang_js",
  litcoffee: "lang_js",
  // TypeScript
  ts: "lang_ts",
  tsx: "lang_ts",
  // Python
  py: "lang_python",
  pyw: "lang_python",
  pyi: "lang_python",
  // Java
  java: "lang_java",
  // HTML
  html: "lang_html",
  htm: "lang_html",
  xhtml: "lang_html",
  // CSS family (incl. preprocessors)
  css: "lang_css",
  scss: "lang_css",
  sass: "lang_css",
  less: "lang_css",
  styl: "lang_css",
  // SQL
  sql: "lang_sql",
  // Shells (all terminal-y scripting goes here for visual coherence)
  sh: "lang_shell",
  bash: "lang_shell",
  zsh: "lang_shell",
  fish: "lang_shell",
  ps1: "lang_shell",
  psm1: "lang_shell",
  bat: "lang_shell",
  cmd: "lang_shell",
  // Dart
  dart: "lang_dart",
  // CSV / TSV
  csv: "lang_csv",
  tsv: "lang_csv",
  // XML family
  xml: "lang_xml",
  xsd: "lang_xml",
  xsl: "lang_xml",
  xslt: "lang_xml",
  svg: "lang_image", // SVG is rendered as image despite XML-being
  plist: "lang_xml",

  // ===== Semantic generic code (FileCode) =====
  // Systems / native
  rs: "lang_code",
  go: "lang_code",
  kt: "lang_code",
  kts: "lang_code",
  swift: "lang_code",
  c: "lang_code",
  h: "lang_code",
  cpp: "lang_code",
  cc: "lang_code",
  cxx: "lang_code",
  hpp: "lang_code",
  hxx: "lang_code",
  cs: "lang_code",
  rb: "lang_code",
  lua: "lang_code",
  // Frontend frameworks
  vue: "lang_code",
  svelte: "lang_code",
  astro: "lang_code",
  // Functional / niche
  ex: "lang_code",
  exs: "lang_code",
  erl: "lang_code",
  hrl: "lang_code",
  hs: "lang_code",
  lhs: "lang_code",
  clj: "lang_code",
  cljs: "lang_code",
  cljc: "lang_code",
  edn: "lang_code",
  scala: "lang_code",
  sc: "lang_code",
  fs: "lang_code",
  fsx: "lang_code",
  fsi: "lang_code",
  ml: "lang_code",
  mli: "lang_code",
  pl: "lang_code",
  pm: "lang_code",
  pod: "lang_code",
  r: "lang_code",
  rmd: "lang_code",
  jl: "lang_code",
  groovy: "lang_code",
  gradle: "lang_code",
  sol: "lang_code",
  zig: "lang_code",
  nim: "lang_code",
  nims: "lang_code",
  asm: "lang_code",
  s: "lang_code",
  // Build / infra DSL
  mk: "lang_code",
  mak: "lang_code",
  cmake: "lang_code",
  graphql: "lang_code",
  gql: "lang_code",
  prisma: "lang_code",
  tf: "lang_code",
  tfvars: "lang_code",
  hcl: "lang_code",
  nix: "lang_code",
  // Templating
  pug: "lang_code",
  jade: "lang_code",
  // Editor scripting
  vim: "lang_code",
  vimrc: "lang_code",
  el: "lang_code",
  // Data schema
  proto: "lang_code",
  ipynb: "lang_code",
  // Pseudo-extension for Dockerfile (see `fileExt`)
  dockerfile: "lang_code",

  // ===== JSON-style data =====
  json: "lang_json",
  jsonc: "lang_json",
  json5: "lang_json",
  jsonl: "lang_json",
  ndjson: "lang_json",

  // ===== Generic config =====
  toml: "lang_config",
  yaml: "lang_config",
  yml: "lang_config",
  ini: "lang_config",
  conf: "lang_config",
  cfg: "lang_config",
  properties: "lang_config",
  editorconfig: "lang_config",
  // .env files use a dedicated key for the key/lock icon
  env: "lang_env",

  // ===== Markdown / docs =====
  md: "lang_markdown",
  mdx: "lang_markdown",
  markdown: "lang_markdown",
  rst: "lang_markdown",
  adoc: "lang_markdown",
  asciidoc: "lang_markdown",
  tex: "lang_markdown",
  sty: "lang_markdown",
  cls: "lang_markdown",

  // ===== Plain text =====
  txt: "lang_text",
  text: "lang_text",
  log: "lang_text",
  rtf: "lang_text",
  nfo: "lang_text",

  // ===== Images =====
  png: "lang_image",
  jpg: "lang_image",
  jpeg: "lang_image",
  gif: "lang_image",
  webp: "lang_image",
  ico: "lang_image",
  bmp: "lang_image",
  tiff: "lang_image",
  tif: "lang_image",
  avif: "lang_image",
  heic: "lang_image",
  heif: "lang_image",
  apng: "lang_image",

  // ===== Video =====
  mp4: "lang_video",
  webm: "lang_video",
  mov: "lang_video",
  avi: "lang_video",
  mkv: "lang_video",
  flv: "lang_video",
  wmv: "lang_video",
  m4v: "lang_video",
  "3gp": "lang_video",
  mpg: "lang_video",
  mpeg: "lang_video",

  // ===== Audio =====
  mp3: "lang_audio",
  wav: "lang_audio",
  ogg: "lang_audio",
  flac: "lang_audio",
  m4a: "lang_audio",
  aac: "lang_audio",
  opus: "lang_audio",
  wma: "lang_audio",
  mid: "lang_audio",
  midi: "lang_audio",

  // ===== Archives =====
  zip: "lang_archive",
  tar: "lang_archive",
  gz: "lang_archive",
  tgz: "lang_archive",
  "7z": "lang_archive",
  rar: "lang_archive",
  bz2: "lang_archive",
  xz: "lang_archive",
  zst: "lang_archive",
  lz: "lang_archive",
  lzma: "lang_archive",
};

// Exact-filename mapping (case-insensitive, no extension or compound name).
// Wins over the extension table - checked first so `Dockerfile.prod` maps
// the same as bare `Dockerfile` and `LICENSE` doesn't get the empty-ext
// fallback.
const LANG_ASSET_BY_FILENAME = {
  dockerfile: "lang_code",
  makefile: "lang_code",
  gnumakefile: "lang_code",
  rakefile: "lang_code",
  gemfile: "lang_code",
  brewfile: "lang_code",
  vagrantfile: "lang_code",
  pipfile: "lang_code",
  procfile: "lang_text",
  "cmakelists.txt": "lang_code",
  license: "lang_text",
  "license.md": "lang_markdown",
  "license.txt": "lang_text",
  readme: "lang_text",
  "readme.md": "lang_markdown",
  "readme.txt": "lang_text",
  changelog: "lang_text",
  "changelog.md": "lang_markdown",
  authors: "lang_text",
  contributors: "lang_text",
  ".gitignore": "lang_config",
  ".gitattributes": "lang_config",
  ".dockerignore": "lang_config",
  ".npmignore": "lang_config",
  ".prettierrc": "lang_config",
  ".eslintrc": "lang_config",
  ".env": "lang_env",
};

function fileExt(name) {
  if (!name) return "";
  const lower = String(name).toLowerCase();
  // Special-case Dockerfile-style names (no real extension or compound).
  if (lower === "dockerfile" || lower.endsWith(".dockerfile")) return "dockerfile";
  const dot = lower.lastIndexOf(".");
  if (dot <= 0 || dot === lower.length - 1) return "";
  return lower.slice(dot + 1);
}

export function lookupLangAsset(name) {
  if (!name) return null;
  const lower = String(name).toLowerCase();
  // 1. Whole-filename match first (Makefile, Cargo.toml-like specials).
  if (LANG_ASSET_BY_FILENAME[lower]) return LANG_ASSET_BY_FILENAME[lower];
  // 2. Compound multi-dot stems (e.g. .env.local, .env.production) - try
  //    progressively stripping leading components until something matches.
  if (lower.startsWith(".env.")) return "lang_env";
  // 3. Plain extension.
  const ext = fileExt(name);
  return LANG_ASSET_BY_EXT[ext] || null;
}
