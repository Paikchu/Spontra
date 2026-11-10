import { __unstable__loadDesignSystem as loadDesignSystem, compile } from "tailwindcss";
import themeCss from "tailwindcss/theme.css";
import utilitiesCss from "tailwindcss/utilities.css";
import shadcnCss from "shadcn/tailwind.css";
import siteTheme from "../../../../shared/analysis-contract/artifact-theme.css";

/**
 * Artifact classes are compiled with the business site's own Tailwind theme (docs/analysis-html-artifact.md §4.2):
 * the same `@theme` file the site imports, Tailwind's theme and utilities layers and shadcn's variants, and no
 * preflight, since the frame already loads the site's base styles. A class that compiles to nothing is not a class
 * of this design and is rejected when it is written.
 */
const ENTRY = `@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css" layer(utilities);
@import "shadcn/tailwind.css";
@import "artifact-theme.css";
@custom-variant dark (&:is(.dark *));
`;
const SHEETS: Record<string, string> = {
  "tailwindcss/theme.css": themeCss,
  "tailwindcss/utilities.css": utilitiesCss,
  "shadcn/tailwind.css": shadcnCss,
  "artifact-theme.css": siteTheme,
};
const options = {
  base: "/",
  loadStylesheet: async (id: string) => {
    const content = SHEETS[id];
    if (content === undefined) throw new Error(`artifact theme: no stylesheet ${id}`);
    return { path: id, base: "/", content };
  },
  loadModule: async (id: string): Promise<never> => { throw new Error(`artifact theme: no module ${id}`); },
};

type DesignSystem = Awaited<ReturnType<typeof loadDesignSystem>>;
let system: Promise<DesignSystem> | null = null;
const designSystem = () => (system ??= loadDesignSystem(ENTRY, options as never));

/** The classes that compile to no CSS in the site theme, each with a line saying so. */
export async function unknownClasses(classes: readonly string[]): Promise<string[]> {
  if (!classes.length) return [];
  const css = (await designSystem()).candidatesToCss([...classes]);
  return classes.flatMap((cls, i) => css[i] ? [] : [`${cls}: not a class of the site's design (no such utility or theme value)`]);
}

/** The CSS for exactly these classes, to ship beside the artifact's HTML. */
export async function compileArtifactCss(classes: readonly string[]): Promise<string> {
  const compiler = await compile(ENTRY, options as never);
  return compiler.build([...new Set(classes)].sort());
}
