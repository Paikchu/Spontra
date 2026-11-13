import { copyFile, mkdir } from "node:fs/promises";

const target = new URL("../workers/analysis/.generated/", import.meta.url);
await mkdir(target, { recursive: true });
await copyFile(new URL(import.meta.resolve("unpdf/pdfjs")), new URL("pdfjs-source.txt", target));
