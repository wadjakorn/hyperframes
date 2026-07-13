/**
 * `hyperframes font` — font tooling for compositions. Currently one verb:
 * `freeze`, which downloads Google Fonts locally and rewrites the composition
 * to local `@font-face` for deterministic (network-free) renders.
 */

import { defineCommand } from "citty";
import type { Example } from "./_examples.js";
import { c } from "../ui/colors.js";

export const examples: Example[] = [
  ["Freeze a composition's Google Fonts locally", "hyperframes font freeze"],
  ["Preview the changes without downloading", "hyperframes font freeze --dry-run"],
];

const HELP = `
${c.bold("hyperframes font")} ${c.dim("<subcommand> [args]")}

${c.bold("SUBCOMMANDS:")}
  ${c.accent("freeze")}  ${c.dim("Download the composition's Google Fonts into assets/fonts/ and")}
          ${c.dim("rewrite to local @font-face, removing the Google Fonts <link>/@import.")}
          ${c.dim("Makes renders deterministic (no render-time network).")}
`;

export default defineCommand({
  meta: {
    name: "font",
    description: "Font tooling for compositions (freeze Google Fonts locally)",
  },
  subCommands: {
    freeze: () => import("./font/freeze.js").then((m) => m.default),
  },
  async run({ args }) {
    if (!args._?.[0]) console.log(HELP);
  },
});
